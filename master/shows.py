"""Shows — a whole rig setup saved under a name, per venue or scenario.

One file per show in master/shows/<name>.json (gitignored). A show captures everything you would
otherwise set up again on the night:
    params + auto flags        the current look (every synced parameter, which ones drift)
    presets                    the whole scene-preset bank
    mappings                   projection mapping for every projector (keystone, masks, blend…)
    video                      playlist, auto-advance, bar sync, loop, speed, last LIVE source
    pm                         projectM auto-cycle bars / shuffle
    outputs                    Resolume OSC config, LED strips, Ableton Link mode
    out_res                    the Output resolution selector
    notes / venue              free text for the operator
Loading a show applies all of it (mappings for projectors not in the show are reset to identity,
so a show is a complete description, not a patch). "Update" re-captures into an existing show.
"""
import json
import os
import re
import time

_NAME = re.compile(r"[^A-Za-z0-9 ._()-]+")
SHOW_VERSION = 1


def clean(name):
    return _NAME.sub("", str(name or "")).strip()[:64]


class Shows:
    def __init__(self, engine, cfg, root, hooks):
        """hooks: dict with callables the master provides —
             outputs()            → dict(osc_out=OscOut|None, led=LedOutput|None, link=AbletonLink|None)
             save_local_config()  → persist cfg keys
             apply_video(dict)    → set playlist / cycle / … on the engine + cfg
        """
        self.e, self.cfg, self.root, self.hooks = engine, cfg, root, hooks
        os.makedirs(root, exist_ok=True)

    # ------------------------------------------------------------ files
    def path(self, name):
        return os.path.join(self.root, clean(name) + ".json")

    def list(self):
        out = []
        for f in sorted(os.listdir(self.root)):
            if not f.endswith(".json"):
                continue
            try:
                d = json.load(open(os.path.join(self.root, f)))
                out.append(dict(name=d.get("name", f[:-5]), venue=d.get("venue", ""), notes=d.get("notes", ""),
                                saved=d.get("saved", 0), projectors=sorted((d.get("mappings") or {}).keys()),
                                presets=len(d.get("presets") or {}), clips=len((d.get("video") or {}).get("playlist") or []),
                                scene=(d.get("params") or {}).get("mode"), out_res=d.get("out_res", 0), file=f))
            except Exception:
                out.append(dict(name=f[:-5], broken=True, file=f))
        return out

    def get(self, name):
        p = self.path(name)
        return json.load(open(p)) if os.path.exists(p) else None

    def delete(self, name):
        p = self.path(name)
        if os.path.exists(p):
            os.remove(p)
            self.e.event(f"show deleted: {clean(name)}")
            if self.e.cloud:
                self.e.cloud.delete("show", clean(name))
            return True
        return False

    def rename(self, old, new):
        a, b = self.path(old), self.path(new)
        if not os.path.exists(a) or os.path.exists(b) or not clean(new):
            return False
        d = json.load(open(a)); d["name"] = clean(new)
        json.dump(d, open(b, "w"), indent=1); os.remove(a)
        if self.e.cloud:
            self.e.cloud.delete("show", clean(old)); self.e.cloud.put("show", clean(new), d)
        return True

    # ------------------------------------------------------------ capture
    def capture(self, name, venue="", notes="", keep_meta_from=None):
        from params import KEYS
        e = self.e
        o = self.hooks["outputs"]()
        show = dict(
            version=SHOW_VERSION, app=self.cfg.get("_app_version", ""), name=clean(name), venue=venue, notes=notes,
            saved=time.time(),
            params={k: e.base[i] for i, k in enumerate(KEYS)},
            auto=[k for i, k in enumerate(KEYS) if e.auto[i]],
            master=dict(clock_speed=e.clock_speed, auto_depth=e.auto_depth, auto_rate=e.auto_rate, auto_enabled=e.auto_enabled, bpm=e.bpm),
            presets=json.loads(json.dumps(e.presets)),
            mappings={n: e.mapping.get(n) for n in e.mapping.names()} if e.mapping else {},
            video=dict(playlist=list(e.video_playlist), cycle=e.video_cycle, cycle_bars=e.video_cycle_bars, bar_sync=e.video_bar_sync,
                       live=dict((e.media.live or {}) if e.media else {}).get("source", "")),
            pm=dict(cycle_bars=e.pm_cycle_bars, shuffle=e.pm_shuffle, preset_name=(e.pm_presets[int(e.base[KEYS.index("pm_preset")])] if e.pm_presets and 0 <= int(e.base[KEYS.index("pm_preset")]) < len(e.pm_presets) else None)),
            outputs=dict(osc_out=dict(o["osc_out"].cfg) if o.get("osc_out") else None,
                         led=json.loads(json.dumps(o["led"].cfg)) if o.get("led") else None,
                         link=dict(enabled=bool(o["link"].enabled), mode=o["link"].mode) if o.get("link") else None,
                         osc_in_map=dict(getattr(e, "osc_in_map", {}) or {}), resolume_grid=self.cfg.get("resolume_grid")),
            out_res=int(round(e.base[KEYS.index("out_res")])),
            cues=json.loads(json.dumps(e.show.cues)), mods=json.loads(json.dumps(e.show.mods)),
            palettes=json.loads(json.dumps(e.palettes)), palette_lock=e.palette_lock,
        )
        if keep_meta_from:
            show["created"] = keep_meta_from.get("created", keep_meta_from.get("saved"))
            if not venue: show["venue"] = keep_meta_from.get("venue", "")
            if not notes: show["notes"] = keep_meta_from.get("notes", "")
        else:
            show["created"] = show["saved"]
        json.dump(show, open(self.path(name), "w"), indent=1)
        self.e.event(f"show saved: {show['name']} ({len(show['mappings'])} projectors, {len(show['presets'])} presets)")
        if self.e.cloud:
            self.e.cloud.put("show", show["name"], show)
        return show

    def store_raw(self, name, d, mirror=True):
        """Write a show document that came from the cloud / an import without re-capturing."""
        d = dict(d); d["name"] = clean(name)
        json.dump(d, open(self.path(name), "w"), indent=1)
        if mirror and self.e.cloud:
            self.e.cloud.put("show", d["name"], d)
        return d

    # ------------------------------------------------------------ apply
    def apply(self, name, parts=None):
        """parts: None = everything, else a set of section names to apply."""
        from params import KEYS
        show = self.get(name)
        if not show:
            return False
        want = lambda s: parts is None or s in parts
        e, cfg = self.e, self.cfg
        o = self.hooks["outputs"]()
        if want("presets") and isinstance(show.get("palettes"), dict):
            e.replace_palettes(show["palettes"]); e.palette_lock = bool(show.get("palette_lock", False)); cfg["palette_lock"] = e.palette_lock
        if want("presets") and isinstance(show.get("presets"), dict):
            e.presets = json.loads(json.dumps(show["presets"]))
            try:
                from engine import PRESET_FILE
                json.dump(e.presets, open(PRESET_FILE, "w"), indent=1)
            except Exception:
                pass
        if want("mappings") and e.mapping is not None:
            maps = show.get("mappings") or {}
            for n in set(e.mapping.names()) | set(maps.keys()):
                e.mapping.put(n, maps.get(n, {}))
        if want("video"):
            self.hooks["apply_video"](show.get("video") or {})
        if want("pm"):
            pm = show.get("pm") or {}
            if "cycle_bars" in pm: e.pm_cycle_bars = int(pm["cycle_bars"]); cfg["pm_cycle_bars"] = e.pm_cycle_bars
            if "shuffle" in pm: e.pm_shuffle = bool(pm["shuffle"]); cfg["pm_shuffle"] = e.pm_shuffle
        if want("outputs"):
            oc = show.get("outputs") or {}
            if oc.get("osc_out") and o.get("osc_out"):
                c = oc["osc_out"]
                for k, v in c.items():
                    o["osc_out"].cfg[k] = v
                o["osc_out"].reconfigure(host=c.get("host"), port=c.get("port"), enabled=c.get("enabled"))
                cfg["osc_out"] = o["osc_out"].cfg
            if oc.get("led") and o.get("led"):
                o["led"].cfg.clear(); o["led"].cfg.update(json.loads(json.dumps(oc["led"])))
                o["led"].last_colors.clear()
                e.source("led", enabled=bool(o["led"].cfg.get("enabled")))
            if oc.get("link") and o.get("link"):
                o["link"].set_mode(oc["link"].get("mode", "follow")); o["link"].set_enabled(bool(oc["link"].get("enabled")))
            if isinstance(oc.get("osc_in_map"), dict):
                e.osc_in_map = dict(oc["osc_in_map"]); cfg["osc_in_map"] = e.osc_in_map
            if oc.get("resolume_grid"):
                cfg["resolume_grid"] = oc["resolume_grid"]
        if want("params"):
            params = show.get("params") or {}
            # scene/params last so the packet flips once everything else is in place; mode first so the
            # video/projectM cards see the right engine
            for k in KEYS:
                if k in params and k not in ("out_res",):
                    e.set(k, params[k], "show")
            auto = set(show.get("auto") or [])
            for k in KEYS:
                e.set_auto(k, k in auto)
            m = show.get("master") or {}
            if "clock_speed" in m: e.clock_speed = float(m["clock_speed"])
            if "auto_depth" in m: e.auto_depth = float(m["auto_depth"])
            if "auto_rate" in m: e.auto_rate = float(m["auto_rate"])
            if "auto_enabled" in m: e.auto_enabled = bool(m["auto_enabled"])
            pmname = (show.get("pm") or {}).get("preset_name")
            if pmname and e.pm_presets and pmname in e.pm_presets:
                e.set("pm_preset", e.pm_presets.index(pmname), "show")
        if want("out_res"):
            e.set("out_res", int(show.get("out_res", 0) or 0), "show")
        if want("cues"):
            if isinstance(show.get("cues"), list):
                e.show.cues = [e.show._clean(c) for c in show["cues"]]; e.show.cue_pos = -1; e.show.cue_follow_due = None; e.show.save_cues()
            if isinstance(show.get("mods"), list):
                e.show.set_mods(show["mods"]); cfg["mods"] = e.show.mods
        self.hooks["save_local_config"]()
        cfg["last_show"] = show["name"]
        self.e.event(f"show loaded: {show['name']}" + (f" ({', '.join(sorted(parts))})" if parts else ""))
        return True
