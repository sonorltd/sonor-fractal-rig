"""
Engine — the ONE place the rig's state lives on the master.

Holds base values (what a human/MIDI/OSC set), auto-drift offsets, the animation
clock, tempo (beat_t / bpm / bar_beat from Pro DJ Link, tap or audio), audio
levels, and packs the outgoing UDP packet. Inputs call engine.set(); the
broadcaster calls engine.tick(); the web UI reads engine.snapshot().
"""
import json, math, os, time
from params import PARAMS, KEYS, INDEX, DEFAULTS, NPARAMS, pack, FLAG_BEAT, FLAG_PRODJ, FLAG_AUDIO
import random
from pm import scan_presets

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, "state.json")
PRESET_FILE = os.path.join(HERE, "presets.json")


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def _noise(x, seed):
    """Cheap smooth 1-D noise in [-1, 1]: three incommensurate sines."""
    return (math.sin(x * 1.0 + seed) * 0.5
            + math.sin(x * 2.618 + seed * 1.7) * 0.3
            + math.sin(x * 0.382 + seed * 3.1) * 0.2)


class Engine:
    def __init__(self, cfg):
        self.cfg = cfg
        self.base = list(DEFAULTS)                     # human-set values
        self.auto = [bool(p[6]) for p in PARAMS]        # auto-drift enabled per param
        self.out = list(DEFAULTS)                       # what actually goes on the wire
        self.clock_speed = float(cfg.get("clock_speed", 1.0))
        self.auto_depth = float(cfg.get("auto_depth", 0.35))
        self.auto_rate = float(cfg.get("auto_rate", 0.05))
        self.t = 0.0                                    # animation clock (s)
        self.seq = 0
        self.last_tick = time.monotonic()
        # tempo
        self.bpm = 0.0
        self.beat_t = 0.0
        self.bar_beat = 0.0
        self.tempo_source = "none"                      # none | prodj | tap | audio
        self.tempo_seen = 0.0                           # monotonic time of last external beat
        self._beat_flag = False
        self._taps = []
        self._prodj_dev = None
        # live audio
        self.audio_energy = 0.0
        self.audio_bass = 0.0
        self.audio_ok = False
        self.audio_wave = []
        self.audio_bands = []
        self.prodj_ok = False
        self.prodj_decks = {}                           # device -> dict(bpm, beat, seen)
        # input sources: name -> dict(enabled, ok, detail). Inputs update these; UI toggles them.
        self.auto_enabled = True
        self.sources = {
            "web":   dict(enabled=True,  ok=True,  detail="serving", clients=0),
            "prodj": dict(enabled=bool(cfg.get("prodj_enabled", True)), ok=False, detail="waiting for beat packets on udp/%d" % int(cfg.get("prodj_port", 50001))),
            "audio": dict(enabled=bool(cfg.get("audio_enabled", False)), ok=False, detail="off"),
            "midi":  dict(enabled=bool(cfg.get("midi_enabled", True)),  ok=False, detail="no controller"),
            "osc":   dict(enabled=bool(cfg.get("osc_enabled", True)),   ok=False, detail="udp/%d" % int(cfg.get("osc_port", 9000))),
            "auto":  dict(enabled=True,  ok=True,  detail="drifting"),
            "link":  dict(enabled=bool(cfg.get("link_enabled", True)), ok=False, detail="Ableton Link (Resolume / Ableton)"),
            # outputs (shown in the Outputs tab, same status shape)
            "resolume": dict(enabled=bool((cfg.get("osc_out") or {}).get("enabled", False)), ok=False, detail="OSC out"),
            "led":   dict(enabled=bool((cfg.get("led") or {}).get("enabled", False)), ok=False, detail="pixel output"),
        }
        self.hooks = dict(tempo=[], beat1=[], scene=[], params=[])    # outputs subscribe here
        self.audio_stream = None
        self.diag = {}                                  # slow-changing diagnostics, refreshed by master.diag_task
        self.started = time.time()
        self.packets_sent = 0
        self.tick_gap_max = 0.0                         # worst tick interval in the current window (s)
        self.tick_count = 0
        self.tick_hz = 0.0
        self._tick_win = time.monotonic()
        self.prodj_raw = dict(packets=0, beats=0, other=0, last_type=None, last_from=None, last_seen=0.0, bad=0)
        # projectM (scene 8)
        self.pm_dir = cfg.get("pm_preset_dir", "")
        self.pm_presets = scan_presets(self.pm_dir)
        self.pm_cycle_bars = int(cfg.get("pm_cycle_bars", 0) or 0)
        self.pm_shuffle = bool(cfg.get("pm_shuffle", True))
        self.pm_history = []
        self._pm_last_bar = None
        self._pm_last_switch = 0.0
        # video (scene 9) — the Media object (master.media) owns the files; the engine owns playback state
        self.media = None                               # set by master.py
        self.mapping = None                             # MappingStore, set by master.py
        self.shows = None                               # Shows store, set by master.py
        self.cloud = None                               # cloud.Cloud mirror, set by master.py
        self.osc_in_map = dict(cfg.get("osc_in_map", {}) or {})   # Resolume OSC address → param key
        self.osc_last = None                            # last non-/frx OSC message (for learn)
        self.video_playlist = list(cfg.get("video_playlist", []))   # clip names, in order
        self.video_cycle = cfg.get("video_cycle", "end")             # "end" = advance when the clip ends · "bars" = every N bars · "off"
        self.video_cycle_bars = int(cfg.get("video_cycle_bars", 8) or 8)
        self.video_bar_sync = bool(cfg.get("video_bar_sync", False))  # restart the clip on SET BEAT 1 / Pro DJ Link bar 1
        self._video_last_bar = None
        self._video_pl_pos = 0
        self.audio_stream = None                        # pm.AudioStream when audio is running
        # fleet
        self.fleet = {}                                 # name -> heartbeat dict
        self.log = []                                   # recent events for the UI
        self.presets = self._load_presets()
        self.palettes = self._load_palettes()
        self.palette_lock = bool(cfg.get("palette_lock", False))
        self.palette_current = None
        self._dirty = False
        self._last_save = 0.0
        self._load_state()
        from cues import ShowLayer
        self.show = ShowLayer(self, cfg)               # modulation, fades, cue stack (master-side only)

    # ------------------------------------------------------------ inputs
    def set(self, key, value, source="ui"):
        i = INDEX.get(key)
        if i is None:
            return False
        p = PARAMS[i]
        v = clamp(float(value), p[2], p[3])
        if p[5] == 'i':
            v = float(round(v))
        if key == "mode" and v != self.base[i]:
            self._fire("scene", v)
        self.base[i] = v
        self._dirty = True
        return True

    def set_norm(self, key, norm01, source="midi"):
        """Set from a 0..1 controller value (MIDI CC etc.)."""
        i = INDEX.get(key)
        if i is None:
            return False
        p = PARAMS[i]
        return self.set(key, p[2] + (p[3] - p[2]) * clamp(norm01, 0, 1), source)

    def set_auto(self, key, enabled):
        i = INDEX.get(key)
        if i is not None:
            self.auto[i] = bool(enabled)
            self._dirty = True

    def source(self, name, **kw):
        """Update a source's status line (enabled / ok / detail / extra fields)."""
        self.sources.setdefault(name, {}).update(kw)

    def event(self, msg):
        self.log.append((time.time(), msg))
        del self.log[:-60]
        if getattr(self, "verbose", True):
            print(time.strftime("%H:%M:%S"), msg, flush=True)

    # ------------------------------------------------------------ tempo
    def _fire(self, name, *a):
        for h in self.hooks.get(name, []):
            try:
                h(*a)
            except Exception as ex:
                self.event(f"hook {name} failed: {ex}")

    def beat(self, bpm, bar_beat=0, source="prodj", device=None):
        """An external beat happened NOW."""
        if abs(float(bpm) - self.bpm) > 0.01:
            self._fire("tempo", float(bpm))
        self.bpm = float(bpm)
        self.beat_t = self.t
        self.bar_beat = float(bar_beat or 0)
        self.tempo_source = source
        self.tempo_seen = time.monotonic()
        self._prodj_dev = device
        self._beat_flag = True

    def tap(self):
        now = time.monotonic()
        self._taps = [x for x in self._taps if now - x < 3.0] + [now]
        if len(self._taps) >= 2:
            iv = [b - a for a, b in zip(self._taps, self._taps[1:])]
            bpm = 60.0 / (sum(iv) / len(iv))
            self.bpm = bpm
        self.beat_t = self.t
        self.bar_beat = float(((len(self._taps) - 1) % 4) + 1)
        self.tempo_source = "tap"
        self.tempo_seen = now
        self._beat_flag = True
        self._fire("tempo", self.bpm)

    def beat_one(self):
        """Mark NOW as beat 1 of the bar without touching BPM (manual bar resync)."""
        self.beat_t = self.t
        self.bar_beat = 1.0
        if self.tempo_source == "none" and self.bpm == 0:
            return
        if self.tempo_source == "prodj":
            self.tempo_source = "tap"          # a human override wins until the next Pioneer beat
        self.tempo_seen = time.monotonic()
        self._beat_flag = True
        self.event("bar resync: beat 1")
        self._fire("beat1")
        if self.video_bar_sync and int(self.base[INDEX["mode"]]) == 9:
            self.video_restart("beat 1")

    def set_bpm(self, bpm):
        self.bpm = clamp(float(bpm), 0, 300)
        self._fire("tempo", self.bpm)
        if self.bpm == 0:
            self.tempo_source = "none"
        elif self.tempo_source in ("none", "audio"):
            self.tempo_source = "tap"
            if not self.beat_t:
                self.beat_t = self.t

    # ------------------------------------------------------------ projectM
    def pm_count(self):
        return len(self.pm_presets)

    def pm_index(self):
        return int(self.base[INDEX["pm_preset"]])

    def pm_name(self, i=None):
        i = self.pm_index() if i is None else i
        return self.pm_presets[i % len(self.pm_presets)] if self.pm_presets else None

    def pm_set(self, i, why="ui"):
        if not self.pm_presets:
            return
        i = int(i) % len(self.pm_presets)
        self.set("pm_preset", i, why)
        self.pm_history = (self.pm_history + [i])[-50:]
        self._pm_last_switch = time.monotonic()
        self.event(f"projectM preset {i}: {self.pm_presets[i]} ({why})")

    def pm_step(self, d=1, why="ui"):
        self.pm_set(self.pm_index() + d, why)

    def pm_random(self, why="ui"):
        if len(self.pm_presets) > 1:
            choices = [i for i in range(len(self.pm_presets)) if i not in self.pm_history[-10:]]
            self.pm_set(random.choice(choices or range(len(self.pm_presets))), why)

    def pm_find(self, text):
        t = text.lower()
        return [i for i, n in enumerate(self.pm_presets) if t in n.lower()][:50]

    # ------------------------------------------------------------ video (scene 9)
    def video_clips(self):
        return self.media.clips() if self.media else []

    def video_index(self):
        return int(self.base[INDEX["video_clip"]])

    def video_name(self, i=None):
        i = self.video_index() if i is None else i
        if i == 255:
            return "LIVE"
        clips = self.video_clips()
        return clips[i]["name"] if 0 <= i < len(clips) else None

    def video_play(self, i, why="ui", switch_scene=True):
        """Start clip i (or 255 = live stream) from its beginning NOW on the shared clock."""
        clips = self.video_clips()
        if i != 255:
            if not clips:
                return False
            i = int(i) % len(clips)
        self.set("video_clip", i, why)
        self.set("video_t0", self.t, why)
        if switch_scene:
            self.set("mode", 9, why)
        self._video_last_bar = None
        if i != 255 and self.video_playlist and self.video_name(i) in self.video_playlist:
            self._video_pl_pos = self.video_playlist.index(self.video_name(i))
        self.event(f"video: ▶ {self.video_name(i)} ({why})")
        return True

    def video_play_name(self, name, why="ui"):
        if name == "LIVE":
            return self.video_play(255, why)
        idx = self.media.index_of(name) if self.media else None
        return self.video_play(idx, why) if idx is not None else False

    def video_restart(self, why="ui"):
        self.set("video_t0", self.t, why)
        self.event(f"video: restart ({why})")

    def video_step(self, d=1, why="ui"):
        """Next/previous — through the playlist if one is set, else through the whole library."""
        names = [n for n in self.video_playlist if self.media and self.media.index_of(n) is not None] if self.video_playlist else [c["name"] for c in self.video_clips()]
        if not names:
            return False
        cur = self.video_name()
        pos = names.index(cur) if cur in names else (self._video_pl_pos if self.video_playlist else -1)
        nxt = names[(pos + d) % len(names)]
        self._video_pl_pos = names.index(nxt)
        return self.video_play_name(nxt, why)

    def video_position(self):
        """(position seconds, duration seconds, ended?) for the UI — the same maths the renderers do."""
        i = self.video_index()
        clips = self.video_clips()
        if i == 255 or not (0 <= i < len(clips)):
            return 0.0, 0.0, False
        dur = float(clips[i].get("duration") or 0)
        el = max(0.0, self.t - self.base[INDEX["video_t0"]]) * self.base[INDEX["video_speed"]]
        if dur <= 0:
            return el, 0.0, False
        if self.base[INDEX["video_loop"]] >= 0.5:
            return el % dur, dur, False
        return min(el, dur), dur, el >= dur

    def _video_autocycle(self, now):
        if int(self.out[INDEX["mode"]]) != 9 or self.video_cycle == "off" or self.video_index() == 255:
            return
        if self.video_cycle == "end":
            pos, dur, _ = self.video_position()
            el = max(0.0, self.t - self.base[INDEX["video_t0"]]) * self.base[INDEX["video_speed"]]
            if dur > 0 and el >= dur - 0.05 and (self.video_playlist or len(self.video_clips()) > 1):
                self.video_step(1, "auto: clip ended")
        elif self.video_cycle == "bars" and self.bpm > 0:
            bars = math.floor((self.t - self.beat_t) * self.bpm / 60.0 / 4.0)
            if self._video_last_bar is None:
                self._video_last_bar = bars
            if bars - self._video_last_bar >= self.video_cycle_bars:
                self._video_last_bar = bars
                self.video_step(1, f"auto: {self.video_cycle_bars} bars")

    def _pm_autocycle(self, now):
        """Switch preset every N bars (or every ~N*2 s without a tempo) while scene 8 is showing."""
        if not self.pm_cycle_bars or int(self.out[INDEX["mode"]]) != 8 or not self.pm_presets:
            return
        if self.bpm > 0:
            bars = math.floor((self.t - self.beat_t) * self.bpm / 60.0 / 4.0)
            if self._pm_last_bar is None:
                self._pm_last_bar = bars
            if bars - self._pm_last_bar >= self.pm_cycle_bars:
                self._pm_last_bar = bars
                (self.pm_random if self.pm_shuffle else self.pm_step)(why="auto-cycle")
        elif now - self._pm_last_switch > self.pm_cycle_bars * 2.0:
            (self.pm_random if self.pm_shuffle else self.pm_step)(why="auto-cycle")

    # ------------------------------------------------------------ tick
    def tick(self):
        now = time.monotonic()
        raw_dt = now - self.last_tick
        dt = min(raw_dt, 0.25)
        self.last_tick = now
        self.tick_count += 1
        if raw_dt > self.tick_gap_max:
            self.tick_gap_max = raw_dt
        if now - self._tick_win >= 1.0:
            self.tick_hz = self.tick_count / (now - self._tick_win)
            self.tick_count = 0
            self._tick_win = now
            self._tick_gap_last = self.tick_gap_max
            self.tick_gap_max = 0.0
        self.t += dt * self.clock_speed

        # keep beat_t within float32 comfort by re-anchoring to a predicted beat
        if self.bpm > 0 and self.t - self.beat_t > 60.0:
            period = 60.0 / self.bpm
            n = math.floor((self.t - self.beat_t) / period)
            self.beat_t += n * period
            if self.bar_beat:
                self.bar_beat = ((self.bar_beat - 1 + n) % 4) + 1

        self.show.apply_fades()
        self.show.tick()
        # auto drift
        depth = self.auto_depth if self.auto_enabled else 0.0
        x = self.t * self.auto_rate
        for i, p in enumerate(PARAMS):
            v = self.base[i]
            if self.auto[i] and depth > 0:
                rng = (p[3] - p[2])
                # zoom wanders slower and shallower — deep zooms explode otherwise
                d = depth * (0.06 if p[0] == "zoom" else 0.15)
                v = clamp(v + _noise(x, i * 12.9898) * rng * d, p[2], p[3])
                if p[5] == 'i':
                    v = float(round(v))
            self.out[i] = v

        # live audio overrides the manual sliders while audio is running
        if self.audio_ok and self.sources["audio"]["enabled"] and self.cfg.get("audio_drive_params", True):
            self.out[INDEX["energy"]] = self.audio_energy
            self.out[INDEX["bass"]] = self.audio_bass
        self.show.apply_mods(dt, self._beat_flag)

        self._pm_autocycle(now)
        self._video_autocycle(now)
        if now - getattr(self, "_params_hook_t", 0) > 0.05:
            self._params_hook_t = now
            self._fire("params", KEYS, self.base, self.out)

        self.prodj_ok = (self.tempo_source == "prodj" and now - self.tempo_seen < 5.0)
        src = self.sources
        src["prodj"]["ok"] = self.prodj_ok
        if src["prodj"]["enabled"]:
            live = {d: x for d, x in self.prodj_decks.items() if time.time() - x["seen"] < 5}
            src["prodj"]["detail"] = ("locked · deck %s · %.1f BPM" % (self._prodj_dev, self.bpm)) if self.prodj_ok else \
                ("decks seen: " + ", ".join(sorted(live)) if live else "waiting for beat packets on udp/%d" % int(self.cfg.get("prodj_port", 50001)))
        else:
            src["prodj"]["detail"] = "disabled"
        src["auto"]["enabled"] = self.auto_enabled
        src["auto"]["ok"] = self.auto_enabled and depth > 0 and any(self.auto)
        n_auto = sum(1 for a in self.auto if a)
        src["auto"]["detail"] = ("%d params drifting · depth %.2f" % (n_auto, self.auto_depth)) if self.auto_enabled else "paused"
        if self.audio_ok:
            src["audio"]["detail"] = "energy %.2f · bass %.2f" % (self.audio_energy, self.audio_bass)
        flags = (FLAG_BEAT if self._beat_flag else 0) | (FLAG_PRODJ if self.prodj_ok else 0) | (FLAG_AUDIO if self.audio_ok else 0)
        self._beat_flag = False
        self.seq = (self.seq + 1) & 0xFFFFFFFF
        pkt = pack(self.seq, flags, self.t, self.beat_t, self.bpm, self.bar_beat, self.out)

        if self._dirty and now - self._last_save > 5.0:
            self._save_state()
        return pkt

    # ------------------------------------------------------------ fleet
    def heartbeat(self, addr, text):
        try:
            parts = text.split()
            if parts[0] != "HB":
                return
            _, ver, name, fps, res, tc, tr, tx, ty, pk, lost, appver = parts[:12]
            temp = float(parts[12]) if len(parts) > 12 else None
            pm_n = int(parts[13]) if len(parts) > 13 else None       # -1 = renderer built without projectM
            pm_cur = int(parts[14]) if len(parts) > 14 else None
            audio_pk = int(parts[15]) if len(parts) > 15 else None
            # v4+: trailing key:value tokens — ndi:on|off|live|none, v5: media:N (clip count, -1 = no libmpv),
            # map:%08x (mapping.txt hash, 0 = identity/none), video:ok|idle|none
            kv = dict(p.split(":", 1) for p in parts[16:] if ":" in p)
            ndi = ("ndi:" + kv["ndi"]) if "ndi" in kv else None
            media_n = int(kv["media"]) if "media" in kv else None
            map_hash = kv.get("map")
            video = kv.get("video")
            prev = self.fleet.get(name, {})
            now = time.time()
            # heartbeat-interval stats — a jittery/late HB on a Pi that is otherwise fine usually means the LAN
            # (Wi-Fi, a saturated switch port) rather than the renderer; worst-of-recent decays so it recovers
            gap = (now - prev["seen"]) if prev.get("seen") else None
            hb_worst = max(gap or 0, prev.get("hb_worst", 0) * 0.97)
            lost_i, pk_i = int(lost), int(pk)
            lost_recent = max(0, lost_i - prev.get("lost", lost_i))       # new losses since the previous heartbeat
            loss_rate = prev.get("loss_rate", 0.0) * 0.9 + lost_recent      # ~10 s decayed count
            self.fleet[name] = dict(ip=addr[0], fps=float(fps), res=res, tile=f"{tx},{ty} of {tc}x{tr}",
                                    hb_gap=round(gap, 2) if gap else None, hb_worst=round(hb_worst, 2), loss_rate=round(loss_rate, 1),
                                    loss_pct=round(100.0 * lost_i / max(1, pk_i + lost_i), 3), fps_min=round(min(float(fps), prev.get("fps_min", 999) * 1.002 + 0.05), 1),
                                    packets=pk_i, lost=lost_i, version=appver, seen=now,
                                    temp=temp, first_seen=prev.get("first_seen", time.time()), hb=prev.get("hb", 0) + 1,
                                    pm_presets=pm_n, pm_current=pm_cur, audio_packets=audio_pk, ndi=ndi,
                                    media=media_n, map=map_hash, video=video)
        except Exception:
            pass

    # ------------------------------------------------------------ presets
    def _load_presets(self):
        if os.path.exists(PRESET_FILE):
            try:
                bank = json.load(open(PRESET_FILE))
                for k, v in DEFAULT_PRESETS.items():      # new built-ins appear on upgrade; yours are never touched
                    bank.setdefault(k, dict(v))
                return bank
            except Exception:
                pass
        return DEFAULT_PRESETS.copy()

    def save_preset(self, name):
        self.presets[name] = {k: self.base[i] for i, k in enumerate(KEYS)}
        self.presets[name]["_auto"] = [k for i, k in enumerate(KEYS) if self.auto[i]]
        json.dump(self.presets, open(PRESET_FILE, "w"), indent=1)
        self.event(f"preset saved: {name}")
        self._mirror_presets()

    def load_preset(self, name):
        p = self.presets.get(name)
        if not p:
            return False
        for k, v in p.items():
            if k == "_auto":
                auto = set(v)
                for i, kk in enumerate(KEYS):
                    if self.palette_lock and kk in PALETTE_KEYS:
                        continue
                    self.auto[i] = kk in auto
            elif self.palette_lock and k in PALETTE_KEYS:
                continue                                   # palette lock: keep the colours you are on
            else:
                self.set(k, v, "preset")
        self.event(f"preset: {name}" + (" (palette locked)" if self.palette_lock else ""))
        return True

    # ------------------------------------------------------------ palettes (colour group only)
    def _load_palettes(self):
        if os.path.exists(PALETTE_FILE):
            try:
                return json.load(open(PALETTE_FILE))
            except Exception:
                pass
        return DEFAULT_PALETTES.copy()

    def _save_palettes(self, mirror=True):
        json.dump(self.palettes, open(PALETTE_FILE, "w"), indent=1)
        if mirror and self.cloud:
            self.cloud.put("palette_bank", "default", self.palettes)

    def palette_values(self):
        return {k: self.base[INDEX[k]] for k in PALETTE_KEYS}

    def save_palette(self, name):
        self.palettes[str(name)[:40]] = self.palette_values()
        self._save_palettes()
        self.palette_current = str(name)[:40]
        self.event(f"palette saved: {name}")

    def load_palette(self, name, fade=None):
        p = self.palettes.get(name)
        if not p:
            return False
        for k, v in p.items():
            if k in PALETTE_KEYS:
                if fade is not None and hasattr(self, "show"):
                    self.show.fade_to(k, v, fade, "palette")
                else:
                    self.set(k, v, "palette")
        self.palette_current = name
        self.event(f"palette: {name}")
        return True

    def delete_palette(self, name):
        if name in self.palettes:
            del self.palettes[name]
            self._save_palettes()

    def replace_palettes(self, bank):
        if isinstance(bank, dict):
            self.palettes = json.loads(json.dumps(bank))
            self._save_palettes(mirror=False)

    def load_preset_index(self, idx):
        names = list(self.presets.keys())
        if 0 <= idx < len(names):
            return self.load_preset(names[idx])
        return False

    def delete_preset(self, name):
        if name in self.presets:
            del self.presets[name]
            json.dump(self.presets, open(PRESET_FILE, "w"), indent=1)
            self._mirror_presets()

    def _mirror_presets(self):
        if self.cloud:
            self.cloud.put("preset_bank", "default", self.presets)

    def replace_presets(self, bank):
        """From the cloud / a show: whole bank at once (no mirror back — it came from there)."""
        if isinstance(bank, dict):
            self.presets = json.loads(json.dumps(bank))
            json.dump(self.presets, open(PRESET_FILE, "w"), indent=1)

    # ------------------------------------------------------------ persistence
    def _save_state(self):
        try:
            json.dump(dict(base=self.base, auto=self.auto, clock_speed=self.clock_speed,
                           auto_depth=self.auto_depth, auto_rate=self.auto_rate, bpm=self.bpm),
                      open(STATE_FILE, "w"))
            self._dirty = False
            self._last_save = time.monotonic()
        except Exception as e:
            self.event(f"state save failed: {e}")

    def _load_state(self):
        if not os.path.exists(STATE_FILE):
            return
        try:
            s = json.load(open(STATE_FILE))
            if len(s.get("base", [])) == NPARAMS:
                self.base = [float(v) for v in s["base"]]
            if len(s.get("auto", [])) == NPARAMS:
                self.auto = [bool(v) for v in s["auto"]]
            # output resolution always starts at 1080p (config "out_res_boot": 0 auto / 1 1080p / 2 4K to change);
            # the top-bar selector still works within the session — this just stops a 4K TV surprising a Pi 4 at boot
            self.base[INDEX["out_res"]] = float(self.cfg.get("out_res_boot", 1))
            self.clock_speed = float(s.get("clock_speed", self.clock_speed))
            self.auto_depth = float(s.get("auto_depth", self.auto_depth))
            self.auto_rate = float(s.get("auto_rate", self.auto_rate))
            self.bpm = float(s.get("bpm", 0))
            if self.bpm:
                self.tempo_source = "tap"
        except Exception as e:
            self.event(f"state load failed: {e}")

    def _video_snapshot(self):
        pos, dur, ended = self.video_position()
        return dict(index=self.video_index(), name=self.video_name(), position=round(pos, 2), duration=dur, ended=ended,
                    playlist=self.video_playlist, cycle=self.video_cycle, cycle_bars=self.video_cycle_bars, bar_sync=self.video_bar_sync,
                    count=len(self.video_clips()), live=(self.media.live if self.media else None))

    # ------------------------------------------------------------ snapshot for UI
    def snapshot(self):
        now = time.time()
        fleet = {n: dict(h, age=round(now - h["seen"], 1)) for n, h in self.fleet.items() if now - h["seen"] < 15}
        return dict(
            type="state", t=round(self.t, 2), seq=self.seq,
            base={k: self.base[i] for i, k in enumerate(KEYS)},
            out={k: round(self.out[i], 4) for i, k in enumerate(KEYS)},
            auto={k: self.auto[i] for i, k in enumerate(KEYS)},
            bpm=round(self.bpm, 2), bar_beat=self.bar_beat, beat_t=self.beat_t,
            tempo_source=self.tempo_source, prodj=self.prodj_ok, audio=self.audio_ok, prodj_dev=getattr(self, "_prodj_dev", None),
            decks=self.prodj_decks, clock_speed=self.clock_speed, auto_depth=self.auto_depth,
            auto_rate=self.auto_rate, auto_enabled=self.auto_enabled, presets=list(self.presets.keys()), preset_modes={k: int(v.get("mode", 0)) for k, v in self.presets.items()}, fleet=fleet,
            sources=self.sources, diag=self.diag, packets_sent=self.packets_sent, tick_hz=round(self.tick_hz, 1),
            tick_gap_ms=round(getattr(self, "_tick_gap_last", 0.0) * 1000, 1), uptime=round(time.time() - self.started),
            prodj_raw=self.prodj_raw, audio_wave=self.audio_wave if self.audio_ok else [], audio_bands=self.audio_bands if self.audio_ok else [],
            audio_levels=dict(energy=round(self.audio_energy, 3), bass=round(self.audio_bass, 3)) if self.audio_ok else None,
            video=self._video_snapshot(), osc_in_map=self.osc_in_map, osc_last=self.osc_last,
            cue=self.show.snapshot(), cues=self.show.cues, mods=self.show.mods,
            cloud=self.cloud.status() if self.cloud else None,
            palettes=self.palettes, palette_lock=self.palette_lock, palette_current=self.palette_current, favs=self.cfg.get("favs", {}),
            pm=dict(count=len(self.pm_presets), dir=self.pm_dir, index=self.pm_index(), name=self.pm_name(),
                    cycle_bars=self.pm_cycle_bars, shuffle=self.pm_shuffle,
                    audio=self.audio_stream.stats() if self.audio_stream else None),
            log=[m for _, m in self.log],
        )


DEFAULT_PRESETS = {
    "Seahorse valley": dict(mode=0, iterations=260, zoom=6.5, center_x=-0.7435, center_y=0.1314, rotation=0.0, hue=0.62, hue_spread=1.4, glow=0.3, warp=0.0, kaleido=0),
    "Julia spiral":    dict(mode=1, iterations=180, zoom=0.4, center_x=0.0, center_y=0.0, julia_x=-0.7885, julia_y=0.1, hue=0.05, hue_spread=2.0, glow=0.5, kaleido=0),
    "Burning ship":    dict(mode=2, iterations=200, zoom=3.2, center_x=-1.755, center_y=-0.03, rotation=3.1416, hue=0.9, hue_spread=0.8, glow=0.25, kaleido=0),
    "Kaleido dendrite": dict(mode=1, iterations=140, zoom=1.0, center_x=0.0, center_y=0.0, julia_x=0.0, julia_y=1.0, hue=0.35, hue_spread=1.0, glow=0.6, kaleido=8, warp=0.15),
    "Tricorn bloom":   dict(mode=3, iterations=160, zoom=0.5, center_x=0.0, center_y=0.0, julia_x=-0.2, julia_y=0.7, hue=0.75, hue_spread=1.6, glow=0.4, kaleido=6),
    "Deep purple":     dict(mode=0, iterations=400, zoom=12.0, center_x=-0.748, center_y=0.1, hue=0.72, hue_spread=0.6, brightness=0.9, glow=0.2, kaleido=0),
    "Plasma lava":     dict(mode=4, iterations=200, zoom=0.0, center_x=0.0, center_y=0.0, rotation=0.0, hue=0.0, hue_spread=0.7, glow=0.5, warp=0.3, kaleido=0),
    "AVS tunnel":      dict(mode=5, iterations=256, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.55, hue_spread=1.0, glow=0.7, warp=0.2, kaleido=0, beat_pulse=0.6),
    "Hyperspace":      dict(mode=6, iterations=320, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.6, hue_spread=1.5, glow=0.8, warp=0.6, kaleido=0, beat_pulse=0.5),
    "Scope waves":     dict(mode=7, iterations=256, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.3, hue_spread=1.2, glow=0.5, warp=0.1, kaleido=0, energy=0.3),
    "Kaleido plasma":  dict(mode=4, iterations=160, zoom=-0.5, center_x=0.4, center_y=0.2, hue=0.8, hue_spread=1.0, glow=0.4, warp=0.2, kaleido=6),
    # v0.8 — more looks, spread across the scenes and the palette range
    "Elephant valley": dict(mode=0, iterations=300, zoom=7.2, center_x=0.2705, center_y=0.0052, rotation=0.0, hue=0.12, hue_spread=1.8, glow=0.35, warp=0.0, kaleido=0),
    "Spiral arm":      dict(mode=0, iterations=360, zoom=9.5, center_x=-0.7453, center_y=0.1127, rotation=0.6, hue=0.55, hue_spread=2.4, glow=0.25, kaleido=0, hue_speed=0.15),
    "Mini brot":       dict(mode=0, iterations=480, zoom=14.0, center_x=-1.7687, center_y=0.0017, rotation=0.0, hue=0.85, hue_spread=1.0, glow=0.45, kaleido=0),
    "Ice feathers":    dict(mode=0, iterations=220, zoom=5.0, center_x=-0.1592, center_y=1.0317, hue=0.58, hue_spread=0.5, contrast=1.4, brightness=1.1, glow=0.15, kaleido=0),
    "Julia lightning": dict(mode=1, iterations=220, zoom=0.6, center_x=0.0, center_y=0.0, julia_x=-0.8, julia_y=0.156, hue=0.6, hue_spread=0.4, contrast=1.6, glow=0.7, kaleido=0),
    "Julia rabbit":    dict(mode=1, iterations=160, zoom=0.5, center_x=0.0, center_y=0.0, julia_x=-0.123, julia_y=0.745, hue=0.95, hue_spread=1.3, glow=0.5, kaleido=0),
    "Julia siegel":    dict(mode=1, iterations=200, zoom=0.7, center_x=0.0, center_y=0.0, julia_x=-0.391, julia_y=-0.587, hue=0.42, hue_spread=2.2, glow=0.35, kaleido=0, hue_speed=-0.1),
    "Julia mandala":   dict(mode=1, iterations=150, zoom=0.9, center_x=0.0, center_y=0.0, julia_x=0.285, julia_y=0.01, hue=0.08, hue_spread=1.5, glow=0.6, kaleido=12, warp=0.1),
    "Ship armada":     dict(mode=2, iterations=240, zoom=5.5, center_x=-1.7527, center_y=-0.0284, rotation=3.1416, hue=0.02, hue_spread=1.2, contrast=1.3, glow=0.3, kaleido=0),
    "Ship kaleido":    dict(mode=2, iterations=180, zoom=2.0, center_x=-1.75, center_y=-0.03, rotation=3.1416, hue=0.68, hue_spread=1.0, glow=0.4, kaleido=6, warp=0.05),
    "Tricorn crown":   dict(mode=3, iterations=200, zoom=1.2, center_x=0.0, center_y=0.0, julia_x=-0.5, julia_y=0.55, hue=0.25, hue_spread=1.1, glow=0.45, kaleido=0),
    "Plasma ocean":    dict(mode=4, iterations=200, zoom=0.3, center_x=0.0, center_y=0.0, hue=0.55, hue_spread=0.5, contrast=1.2, glow=0.4, warp=0.5, kaleido=0, hue_speed=0.05),
    "Plasma acid":     dict(mode=4, iterations=200, zoom=-0.3, center_x=0.0, center_y=0.0, hue=0.28, hue_spread=2.6, contrast=1.5, glow=0.6, warp=0.8, kaleido=0, hue_speed=0.4),
    "Tunnel neon":     dict(mode=5, iterations=256, zoom=0.5, center_x=0.0, center_y=0.0, hue=0.85, hue_spread=0.6, contrast=1.4, glow=0.9, warp=0.0, kaleido=0, beat_pulse=0.8),
    "Tunnel kaleido":  dict(mode=5, iterations=256, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.4, hue_spread=1.8, glow=0.6, warp=0.3, kaleido=8, beat_pulse=0.5),
    "Starfield warp":  dict(mode=6, iterations=320, zoom=0.4, center_x=0.0, center_y=0.0, hue=0.0, hue_spread=0.3, contrast=1.3, glow=0.9, warp=0.9, kaleido=0, beat_pulse=0.7),
    "Starfield slow":  dict(mode=6, iterations=320, zoom=-0.4, center_x=0.0, center_y=0.0, hue=0.62, hue_spread=0.8, brightness=0.8, glow=0.6, warp=0.2, kaleido=0, beat_pulse=0.2),
    "Waves sunset":    dict(mode=7, iterations=256, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.06, hue_spread=0.9, glow=0.5, warp=0.3, kaleido=0, energy=0.5, beat_pulse=0.4),
    "Waves kaleido":   dict(mode=7, iterations=256, zoom=0.2, center_x=0.0, center_y=0.0, hue=0.5, hue_spread=1.6, glow=0.6, warp=0.2, kaleido=10, energy=0.4),
    # v0.8.0 scenes 10-15
    "Menger tunnel":   dict(mode=10, iterations=240, zoom=0.0, center_x=0.0, center_y=0.0, rotation=0.0, hue=0.6, hue_spread=0.8, glow=0.5, warp=0.1, kaleido=0, beat_pulse=0.3),
    "Menger gold":     dict(mode=10, iterations=320, zoom=0.2, center_x=0.0, center_y=0.0, hue=0.1, hue_spread=0.4, contrast=1.3, glow=0.8, warp=0.4, kaleido=0),
    "Menger kaleido":  dict(mode=10, iterations=200, zoom=-0.2, center_x=0.0, center_y=0.0, hue=0.78, hue_spread=1.2, glow=0.6, warp=0.0, kaleido=6),
    "Stained glass":   dict(mode=11, iterations=220, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.0, hue_spread=2.2, glow=0.6, warp=0.3, kaleido=0),
    "Cells slow":      dict(mode=11, iterations=120, zoom=0.5, center_x=0.0, center_y=0.0, hue=0.5, hue_spread=0.6, glow=0.3, warp=0.1, kaleido=0, brightness=0.9),
    "Cells kaleido":   dict(mode=11, iterations=300, zoom=-0.3, center_x=0.0, center_y=0.0, hue=0.85, hue_spread=1.4, glow=0.8, warp=0.5, kaleido=8),
    "Turing coral":    dict(mode=12, iterations=200, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.02, hue_spread=0.5, glow=0.5, warp=0.3, kaleido=0),
    "Turing ink":      dict(mode=12, iterations=300, zoom=0.4, center_x=0.0, center_y=0.0, hue=0.6, hue_spread=0.2, contrast=1.5, glow=0.9, warp=0.6, kaleido=0),
    "Turing zebra":    dict(mode=12, iterations=140, zoom=-0.4, center_x=0.0, center_y=0.0, hue=0.33, hue_spread=1.6, glow=0.2, warp=0.1, kaleido=4),
    "Scope lissajous": dict(mode=13, iterations=200, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.35, hue_spread=1.0, glow=0.5, warp=0.2, kaleido=0, beat_pulse=0.6),
    "Scope neon":      dict(mode=13, iterations=400, zoom=0.2, center_x=0.0, center_y=0.0, hue=0.9, hue_spread=0.5, glow=0.9, warp=0.6, kaleido=0),
    "Scope kaleido":   dict(mode=13, iterations=120, zoom=-0.2, center_x=0.0, center_y=0.0, hue=0.55, hue_spread=1.8, glow=0.4, warp=0.0, kaleido=6),
    "Mandala temple":  dict(mode=14, iterations=240, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.08, hue_spread=0.7, glow=0.6, warp=0.1, kaleido=0),
    "Mandala bloom":   dict(mode=14, iterations=400, zoom=0.3, center_x=0.0, center_y=0.0, hue=0.8, hue_spread=1.4, glow=0.9, warp=0.4, kaleido=0, beat_pulse=0.5),
    "Mandala ice":     dict(mode=14, iterations=160, zoom=-0.3, center_x=0.0, center_y=0.0, hue=0.55, hue_spread=0.3, contrast=1.3, glow=0.4, warp=0.0, kaleido=0),
    "Truchet flow":    dict(mode=15, iterations=200, zoom=0.0, center_x=0.0, center_y=0.0, hue=0.45, hue_spread=1.0, glow=0.5, warp=0.2, kaleido=0),
    "Truchet circuit": dict(mode=15, iterations=400, zoom=0.4, center_x=0.0, center_y=0.0, hue=0.3, hue_spread=0.4, contrast=1.4, glow=0.9, warp=0.0, kaleido=0),
    "Truchet kaleido": dict(mode=15, iterations=150, zoom=-0.2, center_x=0.0, center_y=0.0, hue=0.95, hue_spread=1.6, glow=0.6, warp=0.5, kaleido=8),
    "Mono ice":        dict(mode=0, iterations=260, zoom=6.5, center_x=-0.7435, center_y=0.1314, hue=0.58, hue_spread=0.15, contrast=1.5, brightness=1.1, glow=0.2, kaleido=0, hue_speed=0.0),
}

# ---- palettes: the colour group only (hue, spread, cycle, contrast, brightness, glow). Recalled on their own, and
# with palette lock on, kept when a preset with a different colour theme is loaded.
PALETTE_KEYS = ("hue", "hue_spread", "hue_speed", "contrast", "brightness", "glow")
PALETTE_FILE = os.path.join(HERE, "palettes.json")
DEFAULT_PALETTES = {
    "Ember":     dict(hue=0.02, hue_spread=0.7, hue_speed=0.03, contrast=1.2, brightness=1.0, glow=0.45),
    "Sunset":    dict(hue=0.06, hue_spread=1.1, hue_speed=0.05, contrast=1.1, brightness=1.0, glow=0.4),
    "Gold":      dict(hue=0.12, hue_spread=0.4, hue_speed=0.0, contrast=1.3, brightness=1.05, glow=0.35),
    "Acid":      dict(hue=0.28, hue_spread=2.4, hue_speed=0.35, contrast=1.5, brightness=1.0, glow=0.6),
    "Forest":    dict(hue=0.33, hue_spread=0.6, hue_speed=0.02, contrast=1.2, brightness=0.95, glow=0.3),
    "Ocean":     dict(hue=0.55, hue_spread=0.6, hue_speed=0.04, contrast=1.2, brightness=1.0, glow=0.4),
    "Ice":       dict(hue=0.58, hue_spread=0.2, hue_speed=0.0, contrast=1.5, brightness=1.1, glow=0.2),
    "Deep blue": dict(hue=0.66, hue_spread=0.5, hue_speed=0.02, contrast=1.1, brightness=0.9, glow=0.3),
    "UV":        dict(hue=0.75, hue_spread=0.5, hue_speed=0.08, contrast=1.4, brightness=1.0, glow=0.5),
    "Magenta":   dict(hue=0.88, hue_spread=0.8, hue_speed=0.06, contrast=1.2, brightness=1.0, glow=0.45),
    "Rainbow":   dict(hue=0.0, hue_spread=3.0, hue_speed=0.2, contrast=1.1, brightness=1.0, glow=0.4),
    "Mono":      dict(hue=0.6, hue_spread=0.05, hue_speed=0.0, contrast=1.6, brightness=1.0, glow=0.15),
    "Dark room": dict(hue=0.7, hue_spread=0.6, hue_speed=0.03, contrast=1.3, brightness=0.6, glow=0.25),
}
