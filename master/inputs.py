"""
Input adapters for the master. Each one is optional and degrades gracefully
(missing library / no device = logged once, rig carries on).

  ProDJLink  — PASSIVE Pioneer Pro DJ Link beat listener (XDJ-RX2, CDJs, DJM).
               No virtual-CDJ handshake, no device number to steal: we just
               listen to the beat broadcasts every player already sends on
               UDP 50001. Needs the Pi on the same subnet as the LINK port.
  Midi       — mido/python-rtmidi. CC -> param via config midi_map, notes 36+
               recall presets.
  Osc        — python-osc. /frx/<param> f, /frx/tap, /frx/preset s, /frx/bpm f, /frx/video i|s, /frx/video_next|prev|restart|live
  Audio      — sounddevice + numpy. RMS energy + low band -> energy/bass params,
               optional onset->beat when no Pro DJ Link is present.
"""
import asyncio, struct, time, math

PRODJ_HEADER = bytes([0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c])  # "Qspt1WmJOL"
PRODJ_BEAT = 0x28


# ============================================================ Pro DJ Link
class ProDJLink(asyncio.DatagramProtocol):
    """
    Beat packet layout (per Deep Symmetry's protocol analysis, 96 bytes):
      0x00  10-byte header      0x0a type (0x28 = beat)   0x0b device name (20)
      0x21  device number       0x24.. next-beat timing table
      0x54  u32 pitch, 0x100000 == +0%     0x5a  u16 track BPM x100
      0x5c  u8 beat within bar (1..4)      0x5f  device number again
    Effective BPM = bpm/100 * pitch/0x100000.
    """
    def __init__(self, engine, cfg):
        self.engine = engine
        self.cfg = cfg
        self.last_dev = None

    @property
    def follow(self):
        return int(self.cfg.get("prodj_follow_device", 0) or 0)   # 0 = auto (most recent deck)

    def datagram_received(self, data, addr):
        raw = self.engine.prodj_raw
        if len(data) < 0x0b or data[:10] != PRODJ_HEADER:
            raw["bad"] += 1
            return
        raw["packets"] += 1
        raw["last_type"] = "0x%02x" % data[0x0a]
        raw["last_from"] = addr[0]
        raw["last_seen"] = time.time()
        if data[0x0a] != PRODJ_BEAT or len(data) < 0x60:
            raw["other"] += 1
            return
        raw["beats"] += 1
        if not self.engine.sources["prodj"]["enabled"]:
            return
        dev = data[0x21]
        pitch = struct.unpack_from(">I", data, 0x54)[0]
        bpm100 = struct.unpack_from(">H", data, 0x5a)[0]
        beat = data[0x5c]
        if bpm100 == 0xFFFF or bpm100 == 0:
            return
        bpm = bpm100 / 100.0 * (pitch / 1048576.0 if pitch else 1.0)
        e = self.engine
        e.prodj_decks[str(dev)] = dict(bpm=round(bpm, 2), beat=beat, seen=time.time(), ip=addr[0])
        if self.follow and dev != self.follow:
            return
        if self.last_dev != dev:
            e.event(f"Pro DJ Link: following deck {dev} ({addr[0]})")
            self.last_dev = dev
        e.beat(bpm, beat, source="prodj", device=dev)

    @staticmethod
    async def start(engine, cfg):
        loop = asyncio.get_running_loop()
        try:
            await loop.create_datagram_endpoint(lambda: ProDJLink(engine, cfg),
                                                local_addr=("0.0.0.0", int(cfg.get("prodj_port", 50001))),
                                                reuse_port=True, allow_broadcast=True)
            engine.event("Pro DJ Link listener on udp/%d" % int(cfg.get("prodj_port", 50001)))
        except Exception as ex:
            engine.event(f"Pro DJ Link disabled: {ex}")
            engine.source("prodj", enabled=False, ok=False, detail=f"failed: {ex}")


# ============================================================ MIDI
async def midi_task(engine, cfg):
    try:
        import mido
    except ImportError:
        engine.event("MIDI disabled: pip install mido python-rtmidi")
        engine.source("midi", ok=False, detail="mido not installed (pip install mido python-rtmidi)")
        return
    want = (cfg.get("midi_port_contains") or "").lower()
    chan = int(cfg.get("midi_channel", 0))
    ccmap = {int(k): v for k, v in cfg.get("midi_map", {}).items() if k.isdigit()}
    port = None
    while True:
        if not engine.sources["midi"]["enabled"]:
            if port is not None:
                try: port.close()
                except Exception: pass
                port = None
            engine.source("midi", ok=False, detail="disabled")
            await asyncio.sleep(1)
            continue
        if port is None:
            names = mido.get_input_names()
            engine.source("midi", ok=False, detail=("no controller found" if not names else "found: " + ", ".join(names)[:60]))
            match = [n for n in names if want in n.lower()] if want else names
            if match:
                try:
                    port = mido.open_input(match[0])
                    engine.event(f"MIDI in: {match[0]}")
                    engine.source("midi", ok=True, detail=match[0])
                except Exception as ex:
                    engine.event(f"MIDI open failed: {ex}")
                    port = None
            if port is None:
                await asyncio.sleep(5)
                continue
        try:
            for msg in port.iter_pending():
                if hasattr(msg, "channel") and chan and msg.channel != chan - 1:
                    continue
                if msg.type == "control_change":
                    engine.last_cc = msg.control                      # for MIDI-learn in the UI
                    engine.source("midi", last=f"CC {msg.control} = {msg.value}", seen=time.time())
                    key = ccmap.get(msg.control)
                    if key:
                        engine.set_norm(key, msg.value / 127.0, "midi")
                elif msg.type == "note_on" and msg.velocity > 0:
                    engine.source("midi", last=f"note {msg.note} vel {msg.velocity}", seen=time.time())
                    if msg.note >= 36:
                        engine.load_preset_index(msg.note - 36)
                    elif msg.note == 35:
                        engine.tap()
                    elif msg.note == 34:
                        engine.beat_one()
                    elif msg.note == 33:
                        engine.pm_step(1, "midi")
                    elif msg.note == 32:
                        engine.pm_step(-1, "midi")
                    elif msg.note == 31:
                        engine.video_step(1, "midi")
                    elif msg.note == 30:
                        engine.video_step(-1, "midi")
                    elif msg.note == 29:
                        engine.video_restart("midi")
                    elif msg.note == 28:
                        engine.video_play(255, "midi")
        except Exception as ex:
            engine.event(f"MIDI error: {ex} — reconnecting")
            engine.source("midi", ok=False, detail="reconnecting")
            try:
                port.close()
            except Exception:
                pass
            port = None
        await asyncio.sleep(0.005)


# ============================================================ OSC
async def osc_start(engine, cfg):
    try:
        from pythonosc.dispatcher import Dispatcher
        from pythonosc.osc_server import AsyncIOOSCUDPServer
    except ImportError:
        engine.event("OSC disabled: pip install python-osc")
        engine.source("osc", ok=False, detail="python-osc not installed")
        return
    d = Dispatcher()

    def on_param(addr, *args):
        key = addr.split("/")[-1]
        if not args or not engine.sources["osc"]["enabled"]:
            return
        engine.source("osc", ok=True, last=f"{addr} {round(args[0], 4) if isinstance(args[0], float) else args[0]}", seen=time.time())
        if key == "tap":
            engine.tap()
        elif key == "beat1":
            engine.beat_one()
        elif key == "pm_next":
            engine.pm_step(1, "osc")
        elif key == "pm_prev":
            engine.pm_step(-1, "osc")
        elif key == "pm_random":
            engine.pm_random("osc")
        elif key == "video":            # /frx/video <index|name> — switches to scene 9
            engine.video_play_name(str(args[0]), "osc") if isinstance(args[0], str) else engine.video_play(int(args[0]), "osc")
        elif key == "video_next":
            engine.video_step(1, "osc")
        elif key == "video_prev":
            engine.video_step(-1, "osc")
        elif key == "video_restart":
            engine.video_restart("osc")
        elif key == "video_live":
            engine.video_play(255, "osc")
        elif key == "bpm":
            engine.set_bpm(args[0])
        elif key == "preset":
            engine.load_preset(str(args[0])) if isinstance(args[0], str) else engine.load_preset_index(int(args[0]))
        elif key.startswith("auto_"):
            engine.set_auto(key[5:], bool(args[0]))
        else:
            engine.set(key, args[0], "osc")

    d.map("/frx/*", on_param)

    # Anything that is NOT /frx/… is treated as "Resolume (or another app) talking to us": Resolume Arena/Avenue
    # can send every parameter change as OSC (Preferences → OSC → OSC output). We remember the last address seen
    # (for the learn button on the Resolume tab) and apply cfg["osc_in_map"] = {address: param_key}: Resolume's
    # 0..1 floats land on the param's full range, like a MIDI CC. `engine.osc_in_map` lives on the engine so the UI
    # and shows can edit it; it is persisted in config.local.json by master.py.
    def on_other(addr, *args):
        if not engine.sources["osc"]["enabled"] or not args:
            return
        v = args[0]
        engine.osc_last = dict(addr=addr, value=(round(v, 4) if isinstance(v, float) else v), t=time.time())
        engine.source("osc", ok=True, last=f"{addr} {engine.osc_last['value']}", seen=time.time())
        key = (engine.osc_in_map or {}).get(addr)
        if key and isinstance(v, (int, float)):
            engine.set_norm(key, float(v), "resolume")
    d.set_default_handler(on_other)
    try:
        server = AsyncIOOSCUDPServer(("0.0.0.0", int(cfg.get("osc_port", 9000))), d, asyncio.get_running_loop())
        await server.create_serve_endpoint()
        engine.event("OSC listening on udp/%d  (/frx/<param> f)" % int(cfg.get("osc_port", 9000)))
        engine.source("osc", detail="listening on udp/%d" % int(cfg.get("osc_port", 9000)))
    except Exception as ex:
        engine.event(f"OSC failed: {ex}")
        engine.source("osc", enabled=False, ok=False, detail=f"failed: {ex}")


# ============================================================ Ableton Link (Resolume, Ableton, Traktor, …)
class AbletonLink:
    """
    mode 'follow': the rig's tempo + bar phase come from the Link session (Resolume/Ableton lead).
    mode 'lead'  : the rig pushes its tempo (from Pro DJ Link / tap) INTO the Link session and forces
                   the bar phase on SET BEAT 1 — so Resolume follows the CDJs via us.
    Uses aalink (pip). Degrades to a disabled source if it is not installed.
    """
    def __init__(self, engine, cfg):
        self.e = engine
        self.cfg = cfg
        self.link = None
        self.mode = (cfg.get("link_mode") or "follow")
        self.enabled = bool(cfg.get("link_enabled", True))
        self._last_beat_int = None
        self._last_push_bpm = None

    async def start(self):
        try:
            import aalink
        except ImportError:
            self.e.source("link", enabled=False, ok=False, detail="aalink not installed (pip install aalink)")
            self.e.event("Ableton Link disabled: pip install aalink")
            return
        try:
            self.link = aalink.Link(self.e.bpm or 120.0, asyncio.get_running_loop())
            self.link.quantum = 4
            self.link.enabled = self.enabled
            self.e.source("link", enabled=self.enabled, ok=False, detail="waiting for peers")
            self.e.event("Ableton Link ready (%s)" % self.mode)
            asyncio.create_task(self._loop())
        except Exception as ex:
            self.e.source("link", enabled=False, ok=False, detail=f"failed: {ex}")

    def set_enabled(self, on):
        self.enabled = bool(on); self.cfg["link_enabled"] = self.enabled
        if self.link: self.link.enabled = self.enabled
        self.e.source("link", enabled=self.enabled)

    def set_mode(self, mode):
        self.mode = "lead" if mode == "lead" else "follow"; self.cfg["link_mode"] = self.mode
        self.e.event(f"Ableton Link mode: {self.mode}")

    def push_beat1(self):
        """SET BEAT 1 pressed / Pro DJ Link bar 1 while leading: force Link's bar phase to 0 now."""
        if self.link and self.enabled and self.mode == "lead":
            try:
                self.link.force_beat(0.0)
            except Exception:
                pass

    async def _loop(self):
        e = self.e
        while True:
            try:
                if self.link and self.enabled:
                    peers = self.link.num_peers
                    tempo = float(self.link.tempo)
                    beat = float(self.link.beat)
                    phase = float(self.link.phase)          # 0..quantum
                    e.source("link", ok=peers > 0, detail=f"{peers} peer{'s' if peers != 1 else ''} · {tempo:.2f} BPM · {self.mode}" + ("" if peers else " — no peers yet"), peers=peers, tempo=round(tempo, 2), phase=round(phase, 2), mode=self.mode)
                    if self.mode == "follow" and peers > 0:
                        # emit a beat to the engine each time Link crosses an integer beat; bar_beat from phase
                        b = int(math.floor(beat))
                        if self._last_beat_int is None or b != self._last_beat_int:
                            self._last_beat_int = b
                            e.beat(tempo, int(math.floor(phase)) % 4 + 1, source="link")
                    elif self.mode == "lead" and e.bpm > 0:
                        if self._last_push_bpm is None or abs(e.bpm - self._last_push_bpm) > 0.01:
                            self._last_push_bpm = e.bpm
                            self.link.tempo = float(e.bpm)
                else:
                    e.source("link", ok=False, detail="off" if not self.enabled else "not started")
            except Exception as ex:
                e.source("link", ok=False, detail=f"error: {ex}")
            await asyncio.sleep(0.02)


# ============================================================ Audio
class Audio:
    """Runs in sounddevice's callback thread; publishes smoothed levels to the engine."""
    def __init__(self, engine, cfg):
        self.e = engine
        self.cfg = cfg
        self.gain = float(cfg.get("audio_gain", 1.0))
        self.energy = 0.0
        self.bass = 0.0
        self.slow = 1e-3
        self.last_onset = 0.0
        self.onsets = []

    def callback(self, indata, frames, t, status):
        import numpy as np
        x = indata[:, 0].astype("float32")
        if self.e.audio_stream is not None:
            try:
                self.e.audio_stream.send_float(x * self.gain)
            except Exception:
                pass
        rms = float(np.sqrt(np.mean(x * x))) * self.gain
        spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
        sr = self.cfg.get("audio_samplerate", 44100)
        bins = np.fft.rfftfreq(len(x), 1.0 / sr)
        low = float(spec[(bins > 30) & (bins < 150)].mean()) / len(x) * 40 * self.gain
        # auto-gain: track a slow envelope so the sliders sit around 0.5 regardless of level
        self.slow = max(self.slow * 0.999, rms * 0.02 + self.slow * 0.98, 1e-4)
        e = min(1.0, rms / (self.slow * 3.0 + 1e-6))
        b = min(1.0, low / (self.slow * 4.0 + 1e-6))
        self.energy += (e - self.energy) * (0.5 if e > self.energy else 0.15)
        self.bass += (b - self.bass) * (0.6 if b > self.bass else 0.2)
        self.e.audio_energy = round(self.energy, 3)
        self.e.audio_bass = round(self.bass, 3)
        # compact visualiser data for the UI: 96-point waveform + 16 log bands (auto-gained)
        try:
            step = max(1, len(x) // 96)
            self.e.audio_wave = [round(float(v), 2) for v in np.clip(x[::step][:96] * self.gain * 3.0, -1, 1)]
            edges = np.geomspace(40, min(16000, sr / 2), 17)
            bands = []
            for i in range(16):
                sel = spec[(bins >= edges[i]) & (bins < edges[i + 1])]
                bands.append(float(sel.mean()) if len(sel) else 0.0)
            bands = np.array(bands) / len(x) * (1.0 + np.arange(16) * 0.5)          # tilt: treble bands are naturally quieter
            self._bmax = max(getattr(self, "_bmax", 1e-4) * 0.995, float(bands.max()), 1e-4)
            self.e.audio_bands = [round(min(1.0, float(b) / self._bmax), 2) for b in bands]
        except Exception:
            pass
        # crude onset -> beat, only when Pioneer isn't driving
        now = time.monotonic()
        if b > 0.8 and now - self.last_onset > 0.25 and not self.e.prodj_ok:
            self.last_onset = now
            self.onsets = [o for o in self.onsets if now - o < 4.0] + [now]
            if len(self.onsets) >= 4:
                iv = sorted(b2 - a for a, b2 in zip(self.onsets, self.onsets[1:]))
                med = iv[len(iv) // 2]
                if 0.3 < med < 1.0:
                    self.e.bpm = 60.0 / med
            self.e.beat_t = self.e.t
            self.e.tempo_source = "audio"
            self.e.tempo_seen = now
            self.e._beat_flag = True

    @staticmethod
    def start(engine, cfg):
        try:
            import sounddevice as sd
            import numpy  # noqa
        except ImportError:
            engine.event("Audio disabled: pip install sounddevice numpy (+ apt libportaudio2)")
            engine.source("audio", enabled=False, ok=False, detail="sounddevice/numpy not installed")
            return None
        a = Audio(engine, cfg)
        try:
            stream = sd.InputStream(device=cfg.get("audio_device"), channels=1,
                                    samplerate=cfg.get("audio_samplerate", 44100),
                                    blocksize=cfg.get("audio_blocksize", 1024), callback=a.callback)
            stream.start()
            engine.audio_ok = True
            engine._sd_stream = stream
            if cfg.get("pm_audio_stream", True):
                from pm import AudioStream
                engine.audio_stream = AudioStream(cfg)
            name = sd.query_devices(stream.device)['name']
            engine.event(f"Audio in: {name}")
            engine.source("audio", enabled=True, ok=True, detail=name, device=name)
            return stream
        except Exception as ex:
            engine.event(f"Audio failed: {ex}")
            engine.source("audio", enabled=False, ok=False, detail=f"failed: {ex}")
            return None

    @staticmethod
    def stop(engine):
        st = getattr(engine, "_sd_stream", None)
        if st is not None:
            try:
                st.stop(); st.close()
            except Exception:
                pass
        engine._sd_stream = None
        engine.audio_stream = None
        engine.audio_ok = False
        engine.source("audio", enabled=False, ok=False, detail="off")
        engine.event("Audio stopped")

    @staticmethod
    def midi_ports():
        try:
            import mido
            return mido.get_input_names()
        except Exception:
            return []

    @staticmethod
    def devices():
        try:
            import sounddevice as sd
            return [dict(index=i, name=d["name"]) for i, d in enumerate(sd.query_devices()) if d["max_input_channels"] > 0]
        except Exception:
            return []
