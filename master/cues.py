"""Modulation, fades and the cue stack — the "show tool" layer on top of the engine.

Everything here is master-side only: the renderers keep receiving plain parameter values, so nothing
in the packet or on the Pis changes.

Modulation  (engine.mods, persisted in config.local.json "mods")
    {"key": "zoom", "src": "bass", "amount": 0.15, "attack": 0.02, "release": 0.25, "enabled": true}
    src: energy · bass · beat (decaying pulse on every beat) · band0..band15 (the 16 analyser bands)
    Each tick: env follows the source with separate attack/release times; out[key] += env × amount ×
    (param range). Applied after auto-drift, before the packet is built.

Fades  (engine.fades)
    fade_to(key, value, seconds): base[key] glides linearly; discrete params jump at the start.

Cues  (engine.cues, persisted in master/cues.json)
    {"id": 3, "name": "Drop", "fade_bars": 2, "follow_bars": 16, "colour": "#e37c59",
     "actions": {"preset": "Deep purple", "scene": 8, "params": {"hue": 0.6}, "pm": {"random": 1},
                 "video": {"play": "clouds"}, "live_mix": 0.5, "show": null, "blackout": false}}
    go() fires the next cue (or a given index); back() the previous. fade_bars converts to seconds at the
    current BPM (120 when there is no tempo). follow_bars > 0 auto-fires the next cue after that many bars.
"""
import json
import math
import os
import time

from params import PARAMS, KEYS, INDEX

HERE = os.path.dirname(os.path.abspath(__file__))
CUE_FILE = os.path.join(HERE, "cues.json")
MOD_SOURCES = ["energy", "bass", "beat"] + [f"band{i}" for i in range(16)]


def clamp(v, a, b):
    return a if v < a else b if v > b else v


class ShowLayer:
    def __init__(self, engine, cfg):
        self.e, self.cfg = engine, cfg
        self.mods = [m for m in (cfg.get("mods") or []) if isinstance(m, dict) and m.get("key") in INDEX]
        self._env = {}                      # mod index → envelope value
        self._beat_env = 0.0
        self.fades = {}                     # key → (from, to, t0, dur)
        self.cues = self._load_cues()
        self.cue_pos = -1                   # index of the cue that is "live"
        self.cue_fired_t = 0.0
        self.cue_follow_due = None          # monotonic time when the follow fires
        self._next_id = max([c.get("id", 0) for c in self.cues] + [0]) + 1

    # ------------------------------------------------------------ tempo helpers
    def bar_seconds(self, bars):
        bpm = self.e.bpm if self.e.bpm > 0 else 120.0
        return float(bars) * 4.0 * 60.0 / bpm

    # ------------------------------------------------------------ modulation
    def set_mods(self, mods):
        out = []
        for m in mods[:32]:
            if not isinstance(m, dict) or m.get("key") not in INDEX or m.get("src") not in MOD_SOURCES:
                continue
            out.append(dict(key=m["key"], src=m["src"], amount=clamp(float(m.get("amount", 0.2)), -1, 1),
                            attack=clamp(float(m.get("attack", 0.02)), 0.001, 2), release=clamp(float(m.get("release", 0.25)), 0.001, 5),
                            enabled=bool(m.get("enabled", True))))
        self.mods = out
        self._env = {}
        self.cfg["mods"] = out
        return out

    def _source_value(self, m):
        e = self.e
        s = m["src"]
        if s == "beat":
            return self._beat_env
        if not e.audio_ok:
            return 0.0
        if s == "energy":
            return e.audio_energy
        if s == "bass":
            return e.audio_bass
        if s.startswith("band"):
            i = int(s[4:])
            return e.audio_bands[i] if i < len(e.audio_bands) else 0.0
        return 0.0

    def apply_mods(self, dt, beat_now):
        """Called from Engine.tick after auto-drift: modulates engine.out in place."""
        e = self.e
        if beat_now:
            self._beat_env = 1.0
        else:
            self._beat_env *= math.exp(-dt / 0.18)
        for n, m in enumerate(self.mods):
            if not m.get("enabled", True):
                continue
            x = clamp(self._source_value(m), 0, 1)
            env = self._env.get(n, 0.0)
            tau = m["attack"] if x > env else m["release"]
            env += (x - env) * (1.0 - math.exp(-dt / tau))
            self._env[n] = env
            i = INDEX[m["key"]]
            p = PARAMS[i]
            v = e.out[i] + env * m["amount"] * (p[3] - p[2])
            e.out[i] = float(round(v)) if p[5] == 'i' else clamp(v, p[2], p[3])

    def mod_levels(self):
        return [round(self._env.get(n, 0.0), 3) for n in range(len(self.mods))]

    # ------------------------------------------------------------ fades
    def fade_to(self, key, value, seconds, source="cue"):
        i = INDEX.get(key)
        if i is None:
            return
        p = PARAMS[i]
        value = clamp(float(value), p[2], p[3])
        if seconds <= 0.05 or p[5] == 'i':
            self.fades.pop(key, None)
            self.e.set(key, value, source)
            return
        self.fades[key] = (self.e.base[i], value, time.monotonic(), float(seconds))

    def apply_fades(self):
        if not self.fades:
            return
        now = time.monotonic()
        done = []
        for k, (a, b, t0, dur) in self.fades.items():
            u = clamp((now - t0) / dur, 0, 1)
            u = u * u * (3 - 2 * u)                       # smoothstep — no click at either end
            self.e.base[INDEX[k]] = a + (b - a) * u
            self.e._dirty = True
            if now - t0 >= dur:
                done.append(k)
        for k in done:
            self.fades.pop(k, None)

    def apply_values(self, values, seconds, source="cue"):
        for k, v in values.items():
            if k in INDEX:
                self.fade_to(k, v, seconds, source)

    # ------------------------------------------------------------ cues
    def _load_cues(self):
        try:
            if os.path.exists(CUE_FILE):
                return [c for c in json.load(open(CUE_FILE)) if isinstance(c, dict)]
        except Exception:
            pass
        return []

    def save_cues(self):
        json.dump(self.cues, open(CUE_FILE, "w"), indent=1)

    def _clean(self, c):
        a = c.get("actions") or {}
        acts = {}
        if a.get("preset"): acts["preset"] = str(a["preset"])[:64]
        if a.get("show"): acts["show"] = str(a["show"])[:64]
        if a.get("scene") is not None and a.get("scene") != "": acts["scene"] = int(clamp(int(a["scene"]), 0, 9))
        if isinstance(a.get("params"), dict): acts["params"] = {k: float(v) for k, v in a["params"].items() if k in INDEX}
        if isinstance(a.get("pm"), dict): acts["pm"] = {k: a["pm"][k] for k in ("index", "random", "next", "prev", "name") if k in a["pm"]}
        if isinstance(a.get("video"), dict): acts["video"] = {k: a["video"][k] for k in ("play", "live", "next", "prev", "restart") if k in a["video"]}
        if a.get("live_mix") is not None and a.get("live_mix") != "": acts["live_mix"] = clamp(float(a["live_mix"]), 0, 1)
        if a.get("blackout"): acts["blackout"] = True
        if a.get("brightness") is not None and a.get("brightness") != "": acts["brightness"] = clamp(float(a["brightness"]), 0, 2)
        if a.get("auto") in ("on", "off"): acts["auto"] = a["auto"]
        return dict(id=int(c.get("id") or 0), name=str(c.get("name") or "cue")[:48], colour=str(c.get("colour") or "")[:9],
                    fade_bars=clamp(float(c.get("fade_bars", 0) or 0), 0, 64), follow_bars=clamp(float(c.get("follow_bars", 0) or 0), 0, 512),
                    notes=str(c.get("notes") or "")[:200], actions=acts)

    def cue_add(self, c, at=None):
        c = self._clean(c); c["id"] = self._next_id; self._next_id += 1
        if at is None or at < 0 or at > len(self.cues):
            self.cues.append(c)
        else:
            self.cues.insert(at, c)
        self.save_cues()
        return c

    def cue_update(self, cid, c):
        for n, old in enumerate(self.cues):
            if old["id"] == cid:
                new = self._clean(c); new["id"] = cid
                self.cues[n] = new
                self.save_cues()
                return new
        return None

    def cue_delete(self, cid):
        n = next((i for i, c in enumerate(self.cues) if c["id"] == cid), None)
        if n is None:
            return False
        self.cues.pop(n)
        if self.cue_pos >= len(self.cues):
            self.cue_pos = len(self.cues) - 1
        self.save_cues()
        return True

    def cue_move(self, cid, delta):
        n = next((i for i, c in enumerate(self.cues) if c["id"] == cid), None)
        if n is None:
            return
        m = clamp(n + int(delta), 0, len(self.cues) - 1)
        self.cues.insert(m, self.cues.pop(n))
        self.save_cues()

    def cue_index_of(self, cid):
        return next((i for i, c in enumerate(self.cues) if c["id"] == cid), None)

    def capture_cue(self, name):
        """A new cue holding the current look (every param) — the quick way to build a stack."""
        e = self.e
        return self.cue_add(dict(name=name, fade_bars=1, actions=dict(
            scene=int(e.base[INDEX["mode"]]),
            params={k: e.base[i] for i, k in enumerate(KEYS) if k not in ("mode", "video_t0", "out_res")})))

    def go(self, index=None, why="go"):
        if not self.cues:
            return False
        if index is None:
            index = self.cue_pos + 1
        if index >= len(self.cues):
            index = 0                       # wrap — a set is a loop more often than not
        index = int(clamp(index, 0, len(self.cues) - 1))
        self._fire_cue(self.cues[index], index, why)
        return True

    def back(self):
        if not self.cues:
            return False
        index = int(clamp(self.cue_pos - 1, 0, len(self.cues) - 1))
        self._fire_cue(self.cues[index], index, "back")
        return True

    def _fire_cue(self, c, index, why):
        e = self.e
        a = c.get("actions") or {}
        secs = self.bar_seconds(c.get("fade_bars", 0))
        if a.get("show") and e.shows:
            e.shows.apply(a["show"])
        if a.get("preset"):
            p = e.presets.get(a["preset"])
            if p:
                vals = {k: v for k, v in p.items() if k != "_auto"}
                if "_auto" in p:
                    auto = set(p["_auto"])
                    for i, kk in enumerate(KEYS):
                        e.auto[i] = kk in auto
                if "mode" in vals:
                    e.set("mode", vals.pop("mode"), why)
                self.apply_values(vals, secs)
        if "scene" in a:
            e.set("mode", a["scene"], why)
        if a.get("params"):
            self.apply_values(a["params"], secs)
        if a.get("pm"):
            q = a["pm"]
            if q.get("random"): e.pm_random(why)
            elif q.get("next"): e.pm_step(1, why)
            elif q.get("prev"): e.pm_step(-1, why)
            elif q.get("name") and q["name"] in e.pm_presets: e.pm_set(e.pm_presets.index(q["name"]))
            elif q.get("index") is not None: e.pm_set(int(q["index"]))
        if a.get("video"):
            q = a["video"]
            if "play" in q: e.video_play_name(str(q["play"]), why) if isinstance(q["play"], str) else e.video_play(int(q["play"]), why)
            if q.get("live"): e.video_play(255, why)
            if q.get("next"): e.video_step(1, why)
            if q.get("prev"): e.video_step(-1, why)
            if q.get("restart"): e.video_restart(why)
        if "live_mix" in a:
            self.fade_to("live_mix", a["live_mix"], secs)
        if a.get("blackout"):
            self.fade_to("brightness", 0.0, secs)
        elif "brightness" in a:
            self.fade_to("brightness", a["brightness"], secs)
        if a.get("auto") in ("on", "off"):
            e.auto_enabled = a["auto"] == "on"
        self.cue_pos = index
        self.cue_fired_t = time.monotonic()
        fb = float(c.get("follow_bars", 0) or 0)
        self.cue_follow_due = (self.cue_fired_t + self.bar_seconds(fb)) if fb > 0 else None
        e.event(f"cue {index + 1}/{len(self.cues)}: {c.get('name')}" + (f" (fade {c.get('fade_bars')} bars)" if c.get("fade_bars") else "") + (f" → next in {fb:g} bars" if fb else ""))
        e._fire("cue", index, c)

    def tick(self):
        if self.cue_follow_due is not None and time.monotonic() >= self.cue_follow_due:
            self.cue_follow_due = None
            self.go(None, "auto-follow")

    def snapshot(self):
        due = self.cue_follow_due
        return dict(pos=self.cue_pos, count=len(self.cues), follow_in=(round(due - time.monotonic(), 1) if due else None),
                    fired_ago=round(time.monotonic() - self.cue_fired_t, 1) if self.cue_fired_t else None,
                    fading=sorted(self.fades.keys()), mods=self.mod_levels())
