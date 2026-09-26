#!/usr/bin/env python3
"""
FRACTAL RIG — master controller.

    python3 master.py                 # uses config.json (+ config.local.json overrides)
    python3 master.py --port 8080     # web UI port
    python3 master.py --no-midi --no-osc --no-prodj --audio

Runs on the master Pi (which also runs the renderer, so it is projector #1),
or on a laptop on the same LAN. One asyncio loop:

    60 Hz  engine.tick()  -> UDP multicast packet to every renderer
    15 Hz  state snapshot -> every WebSocket client (phone / laptop UI)
    inputs: Pro DJ Link beats, MIDI, OSC, audio, web UI
"""
import argparse, asyncio, json, os, socket, struct, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "web")
sys.path.insert(0, HERE)

from engine import Engine
from params import PARAMS, KEYS, PACKET_SIZE
import inputs, outputs

APP_VERSION = "0.8.0"
osc_out = led = thumbs = link = None


LOCAL_CFG = os.path.join(HERE, "config.local.json")


def save_local_config(cfg, keys=("osc_out", "led", "link_enabled", "link_mode", "ndi", "pm_cycle_bars", "pm_shuffle", "prodj_follow_device", "audio_device", "video_playlist", "video_cycle", "video_cycle_bars", "video_bar_sync", "last_show", "osc_in_map", "resolume_grid", "mods", "palette_lock", "supabase_url", "supabase_key", "rig_id", "cloud_enabled", "out_res_boot", "favs")):
    """Persist the UI-editable parts of the config to config.local.json (config.json stays pristine in git)."""
    try:
        cur = json.load(open(LOCAL_CFG)) if os.path.exists(LOCAL_CFG) else {}
        for k in keys:
            if k in cfg:
                cur[k] = cfg[k]
        json.dump(cur, open(LOCAL_CFG, "w"), indent=1)
        cl = getattr(_ENGINE_REF[0], "cloud", None) if _ENGINE_REF else None
        if cl:   # per-rig backup of the local config (never auto-applied — restored on request from the Rig tab)
            cl.put("config", "local", {k: v for k, v in cur.items() if k not in ("supabase_key",)})
    except Exception as ex:
        print("config save failed:", ex)


_ENGINE_REF = []


def load_config(args):
    cfg = json.load(open(os.path.join(HERE, "config.json")))
    local = LOCAL_CFG
    if os.path.exists(local):
        cfg.update(json.load(open(local)))
    if args.port:
        cfg["http_port"] = args.port
    if args.no_midi:
        cfg["midi_enabled"] = False
    if args.no_osc:
        cfg["osc_enabled"] = False
    if args.no_prodj:
        cfg["prodj_enabled"] = False
    if args.audio:
        cfg["audio_enabled"] = True
    if args.group:
        cfg["multicast_group"] = args.group
    return cfg


# ------------------------------------------------------------------ broadcaster
async def broadcaster(engine, cfg):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)       # local renderer hears us too
    if cfg.get("multicast_iface"):
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(cfg["multicast_iface"]))
    s.setblocking(False)
    dest = (cfg["multicast_group"], int(cfg["multicast_port"]))
    period = 1.0 / float(cfg.get("tick_hz", 60))
    engine.event(f"broadcasting {PACKET_SIZE}-byte packets to {dest[0]}:{dest[1]} @ {1/period:.0f} Hz")
    next_t = time.monotonic()
    while True:
        pkt = engine.tick()
        try:
            s.sendto(pkt, dest)
            engine.packets_sent += 1
        except OSError as ex:
            engine.event(f"send failed: {ex}")
            await asyncio.sleep(1)
        next_t += period
        delay = next_t - time.monotonic()
        if delay < -0.5:           # fell far behind (suspend?) — resync
            next_t = time.monotonic()
        await asyncio.sleep(max(0.0, delay))


# ------------------------------------------------------------------ heartbeats from renderers
class HeartbeatProto(asyncio.DatagramProtocol):
    def __init__(self, engine):
        self.engine = engine

    def datagram_received(self, data, addr):
        self.engine.heartbeat(addr, data.decode("ascii", "replace"))


# ------------------------------------------------------------------ diagnostics (slow, every 2 s)
def _read(path):
    try:
        return open(path).read().strip()
    except Exception:
        return None


def _run(cmd):
    import subprocess
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=2).stdout.strip()
    except Exception:
        return None


def _ips():
    out = []
    try:
        import subprocess, json as _j
        data = _j.loads(subprocess.run(["ip", "-j", "-4", "addr"], capture_output=True, text=True, timeout=2).stdout)
        for itf in data:
            for a in itf.get("addr_info", []):
                if itf["ifname"] != "lo":
                    out.append(f"{itf['ifname']} {a['local']}/{a['prefixlen']}")
    except Exception:
        out.append(local_ip())
    return out


async def diag_task(engine, cfg):
    import platform, shutil
    static = dict(
        host=platform.node(), python=platform.python_version(), machine=platform.machine(),
        os=(_read("/etc/os-release") or "").split("PRETTY_NAME=")[-1].split("\n")[0].strip('"'),
        pi_model=(_read("/proc/device-tree/model") or "").replace("\x00", "") or None,
        app=APP_VERSION, config=dict(cfg), pid=os.getpid(),
        has_vcgencmd=bool(shutil.which("vcgencmd")), has_tcpdump=bool(shutil.which("tcpdump")),
    )
    while True:
        try:
            d = dict(static)
            d["ips"] = _ips()
            d["time"] = time.strftime("%Y-%m-%d %H:%M:%S")
            d["uptime_s"] = float((_read("/proc/uptime") or "0 0").split()[0])
            d["load"] = _read("/proc/loadavg")
            temp = _read("/sys/class/thermal/thermal_zone0/temp")
            d["cpu_temp"] = round(int(temp) / 1000, 1) if temp and temp.isdigit() else None
            d["throttled"] = _run(["vcgencmd", "get_throttled"]) if static["has_vcgencmd"] else None
            mem = _read("/proc/meminfo") or ""
            try:
                tot = int(mem.split("MemTotal:")[1].split()[0]); avail = int(mem.split("MemAvailable:")[1].split()[0])
                d["mem"] = f"{(tot - avail) // 1024} / {tot // 1024} MB"
            except Exception:
                d["mem"] = None
            d["midi_ports"] = inputs.Audio.midi_ports()
            d["audio_devices"] = inputs.Audio.devices()
            octs = cfg["multicast_group"].split(".")
            hexs = ("".join(f"{int(o):02X}" for o in reversed(octs)), "".join(f"{int(o):02X}" for o in octs))
            d["igmp_joined"] = [l.split()[0] if l.split() else l for l in (_read("/proc/net/igmp") or "").splitlines() if any(h in l.upper() for h in hexs)]
            d["igmp_joined"] = len(d["igmp_joined"])
            d["ws_clients"] = engine.sources["web"].get("clients", 0)
            engine.diag = d
        except Exception as ex:
            engine.diag = dict(error=str(ex))
        await asyncio.sleep(2)


from media import VIDEO_EXT, clean_name   # noqa: E402
from mapping import MappingStore, to_text, is_identity   # noqa: E402
from shows import Shows, clean as clean_show   # noqa: E402

def inputs_pm_scan(engine):
    from pm import scan_presets
    lst = scan_presets(engine.pm_dir)
    engine.event(f"projectM: {len(lst)} presets in {engine.pm_dir}")
    return lst


# ------------------------------------------------------------------ web + websocket
async def web_app(engine, cfg):
    from aiohttp import web, WSMsgType
    clients = set()

    async def ws_handler(request):
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        clients.add(ws)
        await ws.send_json(dict(type="hello", version=APP_VERSION, params=[
            dict(key=p[0], label=p[1], min=p[2], max=p[3], def_=p[4], kind=p[5], auto=p[6], group=p[7], tip=p[8])
            for p in PARAMS], pm_presets=engine.pm_presets, resolume_grid=cfg.get("resolume_grid") or dict(layers=4, columns=8, names={})))
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                if "set" in m:
                    for k, v in m["set"].items():
                        engine.set(k, v, "ui")
                if "auto" in m:
                    for k, v in m["auto"].items():
                        engine.set_auto(k, v)
                if "tap" in m:
                    engine.tap()
                if "beat1" in m:
                    engine.beat_one()
                if "video" in m:
                    q = m["video"]; media = engine.media
                    if "play" in q: (engine.video_play_name(q["play"]) if isinstance(q["play"], str) else engine.video_play(int(q["play"])))
                    if q.get("live"): engine.video_play(255)
                    if q.get("next"): engine.video_step(1)
                    if q.get("prev"): engine.video_step(-1)
                    if q.get("restart"): engine.video_restart()
                    if "loop" in q: engine.set("video_loop", 1 if q["loop"] else 0, "ui")
                    if "speed" in q: engine.set("video_speed", float(q["speed"]), "ui")
                    if "playlist" in q: engine.video_playlist = [str(x) for x in q["playlist"]][:64]; cfg["video_playlist"] = engine.video_playlist; save_local_config(cfg)
                    if "cycle" in q: engine.video_cycle = q["cycle"] if q["cycle"] in ("end", "bars", "off") else "end"; cfg["video_cycle"] = engine.video_cycle; save_local_config(cfg)
                    if "cycle_bars" in q: engine.video_cycle_bars = max(1, int(q["cycle_bars"])); cfg["video_cycle_bars"] = engine.video_cycle_bars; save_local_config(cfg)
                    if "bar_sync" in q: engine.video_bar_sync = bool(q["bar_sync"]); cfg["video_bar_sync"] = engine.video_bar_sync; save_local_config(cfg)
                    if q.get("delete") and media: media.delete(str(q["delete"]))
                    if q.get("rename") and media: media.rename(str(q["rename"].get("old")), str(q["rename"].get("new")))
                    if q.get("live_start") and media: await media.live_start(str(q["live_start"].get("source", "")), q["live_start"].get("kind", "file"), q["live_start"])
                    if q.get("live_stop") and media: await media.live_stop()
                    if q.get("rethumb") and media: await media.thumbnail(str(q["rethumb"]))
                if "palette" in m:
                    q = m["palette"]
                    if q.get("load"): engine.load_palette(str(q["load"]), engine.show.bar_seconds(float(q["fade_bars"])) if q.get("fade_bars") else None)
                    if q.get("save"): engine.save_palette(str(q["save"]))
                    if q.get("delete"): engine.delete_palette(str(q["delete"]))
                    if "lock" in q: engine.palette_lock = bool(q["lock"]); cfg["palette_lock"] = engine.palette_lock; save_local_config(cfg); engine.event(f"palette lock {'on' if engine.palette_lock else 'off'}")
                if "cue" in m:
                    q = m["cue"]; sh = engine.show
                    if q.get("go"): sh.go(None if q["go"] is True else int(q["go"]) - 1, "ui")
                    if q.get("back"): sh.back()
                    if q.get("jump") is not None: sh.go(int(q["jump"]), "ui")
                    if q.get("capture"): sh.capture_cue(str(q["capture"]))
                    if "add" in q: sh.cue_add(q["add"], q.get("at"))
                    if "update" in q and q.get("id") is not None: sh.cue_update(int(q["id"]), q["update"])
                    if q.get("delete") is not None: sh.cue_delete(int(q["delete"]))
                    if q.get("move") is not None and q.get("id") is not None: sh.cue_move(int(q["id"]), int(q["move"]))
                    if q.get("clear"): sh.cues = []; sh.cue_pos = -1; sh.save_cues()
                    if q.get("stop_follow"): sh.cue_follow_due = None
                    if q.get("reset"): sh.cue_pos = -1; sh.cue_follow_due = None
                    if "fade" in q and isinstance(q["fade"], dict):      # {key, value, bars} — a manual timed fade
                        f = q["fade"]; sh.fade_to(str(f.get("key")), float(f.get("value", 0)), sh.bar_seconds(float(f.get("bars", 1))), "ui")
                if "mods" in m and isinstance(m["mods"], list):
                    engine.show.set_mods(m["mods"]); save_local_config(cfg)
                if "resolume" in m:
                    q = m["resolume"]
                    # generic send, restricted to Resolume's own namespace so the UI can drive clips/layers/master
                    if q.get("send") and isinstance(q["send"], dict) and str(q["send"].get("addr", "")).startswith("/composition"):
                        a = q["send"].get("args", [])
                        osc_out.send(str(q["send"]["addr"]), *(a if isinstance(a, list) else [a]))
                    if "map" in q and isinstance(q["map"], dict):          # {addr: param} replaces the whole map
                        engine.osc_in_map = {str(k): str(v) for k, v in q["map"].items() if str(v) in KEYS}
                        cfg["osc_in_map"] = engine.osc_in_map; save_local_config(cfg)
                    if q.get("learn") and engine.osc_last and str(q["learn"]) in KEYS:
                        engine.osc_in_map[engine.osc_last["addr"]] = str(q["learn"]); cfg["osc_in_map"] = engine.osc_in_map; save_local_config(cfg)
                        engine.event(f"Resolume OSC in: {engine.osc_last['addr']} → {q['learn']}")
                    if q.get("unmap"):
                        engine.osc_in_map.pop(str(q["unmap"]), None); cfg["osc_in_map"] = engine.osc_in_map; save_local_config(cfg)
                    if "grid" in q and isinstance(q["grid"], dict):        # layers / columns the clip pad shows + names
                        cfg["resolume_grid"] = dict(layers=max(1, min(16, int(q["grid"].get("layers", 4)))), columns=max(1, min(32, int(q["grid"].get("columns", 8)))),
                                                    names=dict(q["grid"].get("names", {}) or {})); save_local_config(cfg)
                        for c in list(clients):
                            try: await c.send_json(dict(type="resolume_grid", resolume_grid=cfg["resolume_grid"]))
                            except Exception: pass
                if "mapping" in m and engine.mapping:
                    q = m["mapping"]
                    if "put" in q and q.get("name"): engine.mapping.put(q["name"], q["put"])
                    if q.get("copy_from") and q.get("name"): engine.mapping.put(q["name"], engine.mapping.get(q["copy_from"]))
                    if q.get("clear") and q.get("name"): engine.mapping.put(q["name"], {})
                    if "test_all" in q: engine.mapping.test_all(bool(q["test_all"]))
                    await ws.send_json(dict(type="mapping", mapping=engine.mapping.manifest()))
                if "pm" in m:
                    q = m["pm"]
                    if "index" in q: engine.pm_set(q["index"])
                    if q.get("next"): engine.pm_step(1)
                    if q.get("prev"): engine.pm_step(-1)
                    if q.get("random"): engine.pm_random()
                    if "cycle_bars" in q: engine.pm_cycle_bars = max(0, int(q["cycle_bars"]))
                    if "shuffle" in q: engine.pm_shuffle = bool(q["shuffle"])
                    if q.get("rescan"):
                        engine.pm_presets = inputs_pm_scan(engine)
                        await ws.send_json(dict(type="pm_presets", pm_presets=engine.pm_presets))
                if "bpm" in m:
                    engine.set_bpm(m["bpm"])
                if "clock_speed" in m:
                    engine.clock_speed = max(0.0, min(4.0, float(m["clock_speed"])))
                if "auto_depth" in m:
                    engine.auto_depth = max(0.0, min(1.0, float(m["auto_depth"])))
                if "auto_rate" in m:
                    engine.auto_rate = max(0.0, min(1.0, float(m["auto_rate"])))
                if "preset" in m:
                    p = m["preset"]
                    if "load" in p:
                        engine.load_preset(p["load"])
                    if "save" in p:
                        engine.save_preset(p["save"])
                    if "delete" in p:
                        engine.delete_preset(p["delete"])
                if "source" in m:
                    name, on = m["source"].get("name"), bool(m["source"].get("enabled", True))
                    if name == "audio":
                        if on:
                            if m["source"].get("device") is not None:
                                cfg["audio_device"] = m["source"]["device"]
                            inputs.Audio.start(engine, cfg)
                        else:
                            inputs.Audio.stop(engine)
                    elif name == "auto":
                        engine.auto_enabled = on
                    elif name == "link":
                        if link: link.set_enabled(on)
                        if m["source"].get("mode") and link: link.set_mode(m["source"]["mode"])
                        save_local_config(cfg)
                    elif name == "resolume":
                        osc_out.reconfigure(host=m["source"].get("host"), port=m["source"].get("port"), enabled=on)
                        for k in ("send_tempo", "resync_on_beat1", "params", "scene_columns"):
                            if k in m["source"]: osc_out.cfg[k] = m["source"][k]
                        cfg["osc_out"] = osc_out.cfg; save_local_config(cfg)
                        if on: osc_out.last_bpm = None; osc_out.on_tempo(engine.bpm)
                    elif name == "led":
                        led.cfg["enabled"] = on; engine.source("led", enabled=on); save_local_config(cfg)
                    elif name == "prodj" and "follow" in m["source"]:
                        cfg["prodj_follow_device"] = int(m["source"]["follow"] or 0)
                        engine.event(f"Pro DJ Link: follow deck {cfg['prodj_follow_device'] or 'auto'}")
                    elif name in engine.sources:
                        engine.source(name, enabled=on)
                        engine.event(f"{name} {'enabled' if on else 'disabled'}")
                        if name == "prodj" and not on:
                            engine.prodj_decks.clear()
                            if engine.tempo_source == "prodj":
                                engine.tempo_source = "tap" if engine.bpm else "none"
                if "fav" in m:
                    # favourites: {"fav": {"kind": "preset|palette|pm|show|led_config|cue", "name": "...", "on": true}} — kept in
                    # config (so the kiosk Pi and a laptop agree) and mirrored to the cloud with the rest of the config
                    q = m["fav"]; kind = str(q.get("kind", ""))[:24]; name = str(q.get("name", ""))[:128]
                    if kind and name:
                        favs = cfg.setdefault("favs", {}); lst = [x for x in favs.get(kind, []) if x != name]
                        if q.get("on", True): lst.append(name)
                        favs[kind] = lst[-400:]; save_local_config(cfg)
                if "ping" in m:
                    await ws.send_json(dict(type="pong", ping=m["ping"], t=time.time()))
                    continue
                if "led" in m:
                    q = m["led"]
                    for k in ("fps", "brightness", "gamma", "source", "test"):
                        if k in q: led.cfg[k] = q[k]
                    if "strips" in q and isinstance(q["strips"], list):
                        led.cfg["strips"] = [dict(name=str(x.get("name", f"strip{i+1}"))[:32], ip=str(x.get("ip", "")), protocol=str(x.get("protocol", "ddp")), universe=int(x.get("universe", 0) or 0),
                                                  order=str(x.get("order", "GRB")).upper(), count=max(1, min(4096, int(x.get("count", 1) or 1))), start_channel=int(x.get("start_channel", 0) or 0),
                                                  x0=float(x.get("x0", 0)), y0=float(x.get("y0", 0.5)), x1=float(x.get("x1", 1)), y1=float(x.get("y1", 0.5)), enabled=bool(x.get("enabled", True)))
                                             for i, x in enumerate(q["strips"])]
                        led.last_colors.clear()
                    if "enabled" in q: led.cfg["enabled"] = bool(q["enabled"]); engine.source("led", enabled=led.cfg["enabled"])
                    save_local_config(cfg)
                if "resolume_test" in m:
                    osc_out.send(m["resolume_test"].get("address", "/composition/tempocontroller/resync"), m["resolume_test"].get("value", 1))
                if "midi_learn" in m:
                    cc = getattr(engine, "last_cc", None)
                    if cc is not None:
                        cfg.setdefault("midi_map", {})[str(cc)] = m["midi_learn"]
                        engine.event(f"MIDI CC {cc} -> {m['midi_learn']} (edit config.json to make permanent)")
        finally:
            clients.discard(ws)
        return ws

    dev_cache = dict(t=0.0, list=[])

    async def pusher():
        while True:
            if clients:
                engine.source("web", clients=len(clients), detail=f"{len(clients)} client{'s' if len(clients) != 1 else ''} connected")
                snap = engine.snapshot()
                snap["last_cc"] = getattr(engine, "last_cc", None)
                if time.monotonic() - dev_cache["t"] > 5:
                    dev_cache.update(t=time.monotonic(), list=inputs.Audio.devices())
                snap["audio_devices"] = dev_cache["list"]
                snap["prodj_follow"] = int(cfg.get("prodj_follow_device", 0) or 0)
                snap["outputs"] = dict(resolume=osc_out.stats(), led=led.stats(), thumbs=thumbs.summary(),
                                       link=dict(mode=link.mode if link else None, available=bool(link and link.link), enabled=bool(link and link.enabled)),
                                       ndi=dict(name=cfg.get("ndi", {}).get("name", "Fractal Rig"), renderers={n: h.get("ndi") for n, h in engine.fleet.items()}))
                snap["audio_device"] = cfg.get("audio_device")
                data = json.dumps(snap)
                for ws in list(clients):
                    try:
                        await ws.send_str(data)
                    except Exception:
                        clients.discard(ws)
            await asyncio.sleep(1 / 15)

    async def index(request):
        return web.FileResponse(os.path.join(WEB, "index.html"))

    async def api_state(request):
        return web.json_response(engine.snapshot())

    async def api_diag(request):
        return web.json_response(dict(diag=engine.diag, sources=engine.sources, fleet=engine.fleet,
                                      prodj_raw=engine.prodj_raw, log=[m for _, m in engine.log]))

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/state", api_state)
    app.router.add_get("/api/diag", api_diag)

    async def api_thumb(request):
        f = thumbs.get(request.match_info.get("name") or None)
        if not f:
            raise web.HTTPNotFound()
        return web.Response(body=_png(f["w"], f["h"], f["rgb"]), content_type="image/png", headers={"Cache-Control": "no-store"})
    app.router.add_get("/thumb/{name}", api_thumb)
    app.router.add_get("/thumb", api_thumb)

    # ---- media library (Video scene): manifest for the UI and the renderers' sync script, uploads, files
    media = engine.media
    async def api_media(request):
        return web.json_response(media.manifest() if media else dict(clips=[], jobs=[], live=None, ffmpeg=False))
    async def api_media_devices(request):
        if not media:
            return web.json_response(dict(v4l2=[], ndi=[], have_ndi=False))
        ndi = await media.ndi_sources() if request.query.get("ndi", "1") != "0" else []
        return web.json_response(dict(v4l2=media.v4l2_devices(), ndi=ndi, have_ndi=media.have_ndi()))
    async def api_media_upload(request):
        if not media:
            raise web.HTTPServiceUnavailable(text="media disabled")
        reader = await request.multipart()
        jobs = []
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name != "file" or not part.filename:
                continue
            ext = os.path.splitext(part.filename)[1].lower()
            if ext not in VIDEO_EXT:
                jobs.append(dict(name=part.filename, state="failed", msg=f"not a video ({ext or 'no extension'})")); continue
            tmp = os.path.join(media.incoming, f"{int(time.time()*1000)}-{clean_name(part.filename)}{ext}")
            size = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = await part.read_chunk(1 << 20)
                    if not chunk:
                        break
                    size += len(chunk); f.write(chunk)
            mode = "force" if request.query.get("force") else "convert"
            jobs.append(await media.enqueue(tmp, part.filename, mode))
        return web.json_response(dict(jobs=jobs))
    async def api_media_file(request):
        name = request.match_info["name"]
        if "/" in name or name.startswith(".") or not name.endswith(".mp4"):
            raise web.HTTPNotFound()
        p = os.path.join(media.root, name) if media else ""
        if not p or not os.path.exists(p):
            raise web.HTTPNotFound()
        return web.FileResponse(p, headers={"Cache-Control": "no-cache"})
    async def api_media_thumb(request):
        name = request.match_info["name"]
        p = os.path.join(media.thumbs, name) if media and "/" not in name else ""
        if not p or not os.path.exists(p):
            raise web.HTTPNotFound()
        return web.FileResponse(p, headers={"Cache-Control": "max-age=60"})
    async def api_mapping(request):
        return web.json_response(dict(renderers=engine.mapping.manifest() if engine.mapping else []))

    async def api_mapping_get(request):
        name = request.match_info["name"]
        if name.endswith(".txt"):          # what fractal-media-sync fetches; 404 = identity → delete the local file
            name = name[:-4]
            if not engine.mapping or is_identity(engine.mapping.get(name)):
                raise web.HTTPNotFound(text="identity")
            return web.Response(text=engine.mapping.text(name), content_type="text/plain")
        return web.json_response(engine.mapping.get(name) if engine.mapping else {})

    async def api_mapping_put(request):
        if not engine.mapping:
            raise web.HTTPServiceUnavailable(text="mapping store disabled")
        name = request.match_info["name"]
        try:
            body = await request.json()
        except Exception:
            raise web.HTTPBadRequest(text="json body expected")
        return web.json_response(engine.mapping.put(name, body))

    # ---- LED configurations (named saves of the strip layout + output settings), local files + cloud mirror
    LED_DIR = os.path.join(ROOT, "master", "led_configs"); os.makedirs(LED_DIR, exist_ok=True)
    def led_cfg_path(name): return os.path.join(LED_DIR, clean_show(name) + ".json")
    def led_cfg_list():
        out = []
        for f in sorted(os.listdir(LED_DIR)):
            if f.endswith(".json"):
                try:
                    d = json.load(open(os.path.join(LED_DIR, f)))
                    out.append(dict(name=d.get("name", f[:-5]), saved=d.get("saved", 0), strips=len((d.get("led") or {}).get("strips") or []), pixels=sum(int(x.get("count", 0)) for x in (d.get("led") or {}).get("strips") or []), notes=d.get("notes", "")))
                except Exception:
                    pass
        return out
    def led_cfg_save(name, notes="", body=None, mirror=True):
        d = body if isinstance(body, dict) and body.get("led") else dict(name=clean_show(name), saved=time.time(), notes=notes, led=json.loads(json.dumps(led.cfg)) if led else {})
        d["name"] = clean_show(name)
        json.dump(d, open(led_cfg_path(name), "w"), indent=1)
        engine.event(f"LED config saved: {d['name']} ({len((d.get('led') or {}).get('strips') or [])} zones)")
        if mirror and engine.cloud:
            engine.cloud.put("led_config", d["name"], d)
        return d
    def led_cfg_apply(d):
        if not led or not isinstance(d.get("led"), dict):
            return False
        led.cfg.clear(); led.cfg.update(json.loads(json.dumps(d["led"]))); led.last_colors.clear()
        engine.source("led", enabled=bool(led.cfg.get("enabled"))); cfg["led"] = led.cfg; save_local_config(cfg)
        engine.event(f"LED config loaded: {d.get('name')}")
        return True

    async def api_led_configs(request):
        return web.json_response(dict(configs=led_cfg_list(), current_strips=len((led.cfg.get("strips") if led else []) or [])))
    async def api_led_config_get(request):
        p = led_cfg_path(request.match_info["name"])
        if not os.path.exists(p): raise web.HTTPNotFound()
        resp = web.FileResponse(p)
        if request.query.get("download"): resp.headers["Content-Disposition"] = f'attachment; filename="{clean_show(request.match_info["name"])}.fractalleds.json"'
        return resp
    async def api_led_config_save(request):
        try: body = await request.json()
        except Exception: body = {}
        d = led_cfg_save(request.match_info["name"], str(body.get("notes", "")), body.get("import"))
        return web.json_response(dict(ok=True, config=d, configs=led_cfg_list()))
    async def api_led_config_load(request):
        p = led_cfg_path(request.match_info["name"])
        if not os.path.exists(p): raise web.HTTPNotFound()
        return web.json_response(dict(ok=led_cfg_apply(json.load(open(p)))))
    async def api_led_config_delete(request):
        p = led_cfg_path(request.match_info["name"])
        if os.path.exists(p):
            os.remove(p)
            if engine.cloud: engine.cloud.delete("led_config", clean_show(request.match_info["name"]))
        return web.json_response(dict(ok=True, configs=led_cfg_list()))
    app.router.add_get("/api/led/configs", api_led_configs)
    app.router.add_get("/api/led/configs/{name}", api_led_config_get)
    app.router.add_post("/api/led/configs/{name}", api_led_config_save)
    app.router.add_post("/api/led/configs/{name}/load", api_led_config_load)
    app.router.add_delete("/api/led/configs/{name}", api_led_config_delete)

    # ---- projection-mapping presets: a named copy of one projector's mapping (keystone, masks, blend, gain) that can
    #      be loaded onto any projector — "Warehouse left wall", "Studio bench 4:3 screen". Local files + cloud mirror
    #      (shared between rigs, like shows and LED configs).
    MAPP_DIR = os.path.join(ROOT, "master", "mapping_presets"); os.makedirs(MAPP_DIR, exist_ok=True)
    def mapp_path(name): return os.path.join(MAPP_DIR, clean_show(name) + ".json")
    def mapp_list():
        from mapping import normalise, is_identity
        out = []
        for f in sorted(os.listdir(MAPP_DIR)):
            if f.endswith(".json"):
                try:
                    d = json.load(open(os.path.join(MAPP_DIR, f))); m = normalise(d.get("mapping"))
                    out.append(dict(name=d.get("name", f[:-5]), saved=d.get("saved", 0), notes=d.get("notes", ""), source=d.get("source", ""),
                                    masks=len(m["masks"]), identity=is_identity(m), blend=any(v > 0 for v in m["edge"]), keystone=m["quad"] != [0, 0, 1, 0, 1, 1, 0, 1]))
                except Exception:
                    pass
        return out
    def mapp_save(name, mapping=None, notes="", source="", body=None, mirror=True):
        from mapping import normalise
        d = body if isinstance(body, dict) and isinstance(body.get("mapping"), dict) else dict(name=clean_show(name), saved=time.time(), notes=notes, source=source, mapping=normalise(mapping))
        d["name"] = clean_show(name); d["mapping"] = normalise(d.get("mapping"))
        json.dump(d, open(mapp_path(name), "w"), indent=1)
        engine.event(f"mapping preset saved: {d['name']}" + (f" (from {source})" if source else ""))
        if mirror and engine.cloud:
            engine.cloud.put("mapping_preset", d["name"], d)
        return d
    async def api_mapp_list(request):
        return web.json_response(dict(presets=mapp_list()))
    async def api_mapp_get(request):
        p = mapp_path(request.match_info["name"])
        if not os.path.exists(p): raise web.HTTPNotFound()
        resp = web.FileResponse(p)
        if request.query.get("download"): resp.headers["Content-Disposition"] = f'attachment; filename="{clean_show(request.match_info["name"])}.fractalmap.json"'
        return resp
    async def api_mapp_save(request):
        try: body = await request.json()
        except Exception: body = {}
        name = request.match_info["name"]
        if isinstance(body.get("import"), dict):
            d = mapp_save(name, body=body["import"])
        elif isinstance(body.get("mapping"), dict):        # the editor's current (possibly unsaved) mapping
            d = mapp_save(name, body["mapping"], str(body.get("notes", "")), str(body.get("source", "")))
        else:                                                # from a projector's stored mapping
            src = str(body.get("from", ""))
            if not engine.mapping or not src: raise web.HTTPBadRequest(text="from or mapping required")
            d = mapp_save(name, engine.mapping.get(src), str(body.get("notes", "")), src)
        return web.json_response(dict(ok=True, preset=d, presets=mapp_list()))
    async def api_mapp_load(request):
        p = mapp_path(request.match_info["name"])
        if not os.path.exists(p) or not engine.mapping: raise web.HTTPNotFound()
        try: body = await request.json()
        except Exception: body = {}
        to = str(body.get("to", ""))
        if not to: raise web.HTTPBadRequest(text="to (projector name) required")
        d = json.load(open(p)); m = engine.mapping.put(to, d.get("mapping"))
        engine.event(f"mapping preset loaded: {d.get('name')} → {to}")
        return web.json_response(dict(ok=True, to=to, mapping=m))
    async def api_mapp_delete(request):
        p = mapp_path(request.match_info["name"])
        if os.path.exists(p):
            os.remove(p)
            if engine.cloud: engine.cloud.delete("mapping_preset", clean_show(request.match_info["name"]))
        return web.json_response(dict(ok=True, presets=mapp_list()))
    # registered BEFORE /api/mapping/{name} so "presets" is not taken for a projector name
    app.router.add_get("/api/mapping/presets", api_mapp_list)
    app.router.add_get("/api/mapping/presets/{name}", api_mapp_get)
    app.router.add_post("/api/mapping/presets/{name}", api_mapp_save)
    app.router.add_post("/api/mapping/presets/{name}/load", api_mapp_load)
    app.router.add_delete("/api/mapping/presets/{name}", api_mapp_delete)

    # ---- saved cue lists: the whole cue stack (+ audio modulation) under a name, so a set can be rebuilt on any rig.
    #      The LIVE stack stays cues.json (cloud kind cue_stack/current, per rig); these are documents (kind cuelist, shared).
    CUEL_DIR = os.path.join(ROOT, "master", "cue_lists"); os.makedirs(CUEL_DIR, exist_ok=True)
    def cuel_path(name): return os.path.join(CUEL_DIR, clean_show(name) + ".json")
    def cuel_list():
        out = []
        for f in sorted(os.listdir(CUEL_DIR)):
            if f.endswith(".json"):
                try:
                    d = json.load(open(os.path.join(CUEL_DIR, f)))
                    out.append(dict(name=d.get("name", f[:-5]), saved=d.get("saved", 0), notes=d.get("notes", ""), cues=len(d.get("cues") or []), mods=len(d.get("mods") or []),
                                    first=((d.get("cues") or [{}])[0]).get("name", "")))
                except Exception:
                    pass
        return out
    def cuel_save(name, notes="", body=None, mirror=True):
        d = body if isinstance(body, dict) and isinstance(body.get("cues"), list) else dict(name=clean_show(name), saved=time.time(), notes=notes,
                                                                                               cues=json.loads(json.dumps(engine.show.cues)), mods=json.loads(json.dumps(engine.show.mods)))
        d["name"] = clean_show(name)
        json.dump(d, open(cuel_path(name), "w"), indent=1)
        engine.event(f"cue list saved: {d['name']} ({len(d.get('cues') or [])} cues)")
        if mirror and engine.cloud:
            engine.cloud.put("cuelist", d["name"], d)
        return d
    async def api_cuel_list(request):
        return web.json_response(dict(lists=cuel_list(), current=len(engine.show.cues)))
    async def api_cuel_get(request):
        p = cuel_path(request.match_info["name"])
        if not os.path.exists(p): raise web.HTTPNotFound()
        resp = web.FileResponse(p)
        if request.query.get("download"): resp.headers["Content-Disposition"] = f'attachment; filename="{clean_show(request.match_info["name"])}.fractalcues.json"'
        return resp
    async def api_cuel_save(request):
        try: body = await request.json()
        except Exception: body = {}
        d = cuel_save(request.match_info["name"], str(body.get("notes", "")), body.get("import"))
        return web.json_response(dict(ok=True, list=d, lists=cuel_list()))
    async def api_cuel_load(request):
        p = cuel_path(request.match_info["name"])
        if not os.path.exists(p): raise web.HTTPNotFound()
        d = json.load(open(p))
        engine.show.cues = [engine.show._clean(c) for c in (d.get("cues") or [])]; engine.show.cue_pos = -1; engine.show.cue_follow_due = None; engine.show.save_cues()
        if isinstance(d.get("mods"), list): engine.show.set_mods(d["mods"]); cfg["mods"] = engine.show.mods; save_local_config(cfg)
        engine.event(f"cue list loaded: {d.get('name')} ({len(engine.show.cues)} cues)")
        return web.json_response(dict(ok=True, cues=len(engine.show.cues)))
    async def api_cuel_delete(request):
        p = cuel_path(request.match_info["name"])
        if os.path.exists(p):
            os.remove(p)
            if engine.cloud: engine.cloud.delete("cuelist", clean_show(request.match_info["name"]))
        return web.json_response(dict(ok=True, lists=cuel_list()))
    app.router.add_get("/api/cues/lists", api_cuel_list)
    app.router.add_get("/api/cues/lists/{name}", api_cuel_get)
    app.router.add_post("/api/cues/lists/{name}", api_cuel_save)
    app.router.add_post("/api/cues/lists/{name}/load", api_cuel_load)
    app.router.add_delete("/api/cues/lists/{name}", api_cuel_delete)

    # ---- cloud (Supabase mirror): status, settings, sync, browse
    async def api_cloud(request):
        return web.json_response(engine.cloud.status() if engine.cloud else dict(enabled=False, configured=False))
    async def api_cloud_config(request):
        body = await request.json()
        if engine.cloud:
            engine.cloud.configure(url=body.get("url"), key=body.get("key") or None, rig_id=body.get("rig_id") or None, enabled=body.get("enabled"))
            save_local_config(cfg)
            await engine.cloud.sync_once()
        return web.json_response(engine.cloud.status() if engine.cloud else {})
    async def api_cloud_sync(request):
        try: body = await request.json()
        except Exception: body = {}
        ok = await engine.cloud.sync_once(full=bool(body.get("full"))) if engine.cloud else False
        return web.json_response(dict(ok=ok, **(engine.cloud.status() if engine.cloud else {})))
    async def api_cloud_list(request):
        rows = await engine.cloud.list_kind(request.match_info["kind"]) if engine.cloud else []
        return web.json_response(dict(rows=rows, online=bool(engine.cloud and engine.cloud.online)))
    async def api_cloud_fetch(request):
        """Pull one document from the cloud into the local store now (a show or LED config from the menu)."""
        kind, name = request.match_info["kind"], request.match_info["name"]
        if not engine.cloud: raise web.HTTPServiceUnavailable(text="cloud disabled")
        try:
            row = await engine.cloud.fetch(kind, name)
        except Exception as ex:
            raise web.HTTPBadGateway(text=f"cloud unreachable: {ex}")
        if not row: raise web.HTTPNotFound(text="not in the cloud")
        h = engine.cloud.handlers.get(kind)
        applied = h(name, row["data"], row["updated_at"]) if h else False
        return web.json_response(dict(ok=bool(applied), name=name))
    app.router.add_get("/api/cloud", api_cloud)
    app.router.add_post("/api/cloud/config", api_cloud_config)
    app.router.add_post("/api/cloud/sync", api_cloud_sync)
    app.router.add_get("/api/cloud/list/{kind}", api_cloud_list)
    app.router.add_post("/api/cloud/fetch/{kind}/{name}", api_cloud_fetch)

    # what a pulled row does locally (newer-than-local only; deleted rows remove the local file)
    def _mtime(p):
        try: return os.path.getmtime(p)
        except OSError: return 0
    def _ts(iso):
        try: return time.mktime(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
        except Exception: return 0
    if engine.cloud:
        def h_show(name, data, upd):
            if not engine.shows: return False
            p = engine.shows.path(name)
            if data is None:
                if os.path.exists(p): os.remove(p); return True
                return False
            if _ts(upd) <= _mtime(p): return False
            engine.shows.store_raw(name, data, mirror=False); return True
        def h_led(name, data, upd):
            p = led_cfg_path(name)
            if data is None:
                if os.path.exists(p): os.remove(p); return True
                return False
            if _ts(upd) <= _mtime(p): return False
            json.dump(dict(data, name=clean_show(name)), open(p, "w"), indent=1); return True
        def h_presets(name, data, upd):
            from engine import PRESET_FILE
            if data is None or _ts(upd) <= _mtime(PRESET_FILE): return False
            engine.replace_presets(data); return True
        def h_palettes(name, data, upd):
            from engine import PALETTE_FILE
            if data is None or _ts(upd) <= _mtime(PALETTE_FILE): return False
            engine.replace_palettes(data); return True
        def h_cues(name, data, upd):
            from cues import CUE_FILE
            if data is None or _ts(upd) <= _mtime(CUE_FILE) or not isinstance(data, list): return False
            engine.show.cues = [engine.show._clean(c) for c in data]; engine.show.save_cues(mirror=False); return True
        def h_mapping(name, data, upd):
            if not engine.mapping: return False
            p = engine.mapping.path(name)
            if data is None:
                if os.path.exists(p): engine.mapping.put(name, {}, mirror=False); return True
                return False
            if _ts(upd) <= _mtime(p): return False
            engine.mapping.put(name, data, mirror=False); return True
        def h_mapp(name, data, upd):
            p = mapp_path(name)
            if data is None:
                if os.path.exists(p): os.remove(p); return True
                return False
            if _ts(upd) <= _mtime(p): return False
            mapp_save(name, body=data, mirror=False); return True
        def h_cuel(name, data, upd):
            p = cuel_path(name)
            if data is None:
                if os.path.exists(p): os.remove(p); return True
                return False
            if _ts(upd) <= _mtime(p): return False
            cuel_save(name, body=data, mirror=False); return True
        def h_config(name, data, upd):
            if data is not None:
                json.dump(data, open(os.path.join(HERE, "config.cloud.json"), "w"), indent=1)   # kept for manual restore
            return False
        for k, h in (("show", h_show), ("led_config", h_led), ("preset_bank", h_presets), ("palette_bank", h_palettes), ("cue_stack", h_cues), ("mapping", h_mapping), ("mapping_preset", h_mapp), ("cuelist", h_cuel), ("config", h_config)):
            engine.cloud.on(k, h)

    # ---- rig maintenance: update / restart the master itself, or any renderer through its status service (:8082)
    async def api_rig_self(request):
        act = request.match_info["act"]
        import subprocess
        if act == "update":
            subprocess.Popen(["bash", os.path.join(ROOT, "setup", "rig-update")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            engine.event("update requested from the web UI — pulling GitHub and re-running the installer (the master restarts itself)")
            return web.json_response(dict(ok=True, msg="updating — this page will reconnect when the master comes back"))
        if act == "restart":
            engine.event("restart requested from the web UI")
            subprocess.Popen(["sudo", "-n", "systemctl", "restart", "fractal-master"], start_new_session=True)
            return web.json_response(dict(ok=True, msg="restarting the master"))
        if act == "restart-renderer":
            r = subprocess.run(["sudo", "-n", "systemctl", "restart", "fractal-renderer"], capture_output=True, text=True)
            return web.json_response(dict(ok=r.returncode == 0, msg=r.stderr.strip() or "renderer restarted"))
        if act == "reboot":
            engine.event("REBOOT requested from the web UI")
            subprocess.Popen(["sudo", "-n", "reboot"], start_new_session=True)
            return web.json_response(dict(ok=True, msg="rebooting"))
        raise web.HTTPNotFound()

    async def api_rig_log(request):
        try:
            txt = open("/var/lib/fractal-rig/update.log", errors="ignore").read()[-8000:]
        except OSError:
            txt = "(no update log yet)"
        return web.Response(text=txt, content_type="text/plain")

    async def api_rig_remote(request):
        name = request.match_info["name"]
        act = request.match_info.get("act") or ("projector/config" if request.path.endswith("/projector/config") else "projector")
        r = engine.fleet.get(name)
        if not r:
            raise web.HTTPNotFound(text="renderer not heard from")
        if act not in ("update", "restart", "reboot", "update.log", "projector", "projector/config", "outputs"):
            raise web.HTTPNotFound()
        import aiohttp
        url = f"http://{r['ip']}:8082/{act}"
        try:
            body = await request.json() if request.can_read_body else {}
        except Exception:
            body = {}
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as sess:
                if act == "update.log":
                    async with sess.get(url) as resp:
                        return web.Response(text=await resp.text(), content_type="text/plain")
                if act == "projector" and request.method == "GET":
                    async with sess.get(url) as resp:
                        return web.json_response(await resp.json())
                async with sess.post(url, json=body) as resp:
                    j = await resp.json()
        except Exception as ex:
            return web.json_response(dict(ok=False, msg=f"{name}: status service not reachable ({ex}) — is fractal-media-sync running on it?"))
        if act == "outputs":
            engine.event(f"{name}: HDMI outputs → {body.get('mode')} · {j.get('msg', '')}")
        elif act.startswith("projector"):
            if isinstance(j.get("cached"), dict): engine.fleet[name]["proj"] = dict(j["cached"], msg=j.get("msg", ""))
            engine.event(f"{name}: projector {body.get('cmd', act)} → {j.get('msg', '')}")
        else:
            engine.event(f"{name}: {act} → {j.get('msg', '')}")
        return web.json_response(j)

    async def api_projectors_all(request):
        """POST /api/rig/projectors/{cmd} — the same projector command to every renderer that is online (on / off / hdmi1 …)."""
        cmd = request.match_info["cmd"]
        import aiohttp
        out = {}
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as sess:
            for name, r in list(engine.fleet.items()):
                if time.time() - r.get("seen", 0) > 15: continue
                try:
                    async with sess.post(f"http://{r['ip']}:8082/projector", json=dict(cmd=cmd)) as resp:
                        j = await resp.json()
                    out[name] = j.get("msg", "ok" if j.get("ok") else "failed")
                    if isinstance(j.get("cached"), dict): r["proj"] = dict(j["cached"], msg=j.get("msg", ""))
                except Exception as ex:
                    out[name] = f"unreachable ({ex.__class__.__name__})"
        engine.event((f"projectors {cmd}: " + ", ".join(f"{k}: {v}" for k, v in out.items())) if out else f"projectors {cmd}: no renderers online")
        return web.json_response(dict(ok=True, results=out))

    async def projector_poller():
        """Every 15 s ask each online renderer's status service how its projector is (cached there; no serial on the request path)."""
        import aiohttp
        while True:
            await asyncio.sleep(15)
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=4)) as sess:
                    for name, r in list(engine.fleet.items()):
                        if time.time() - r.get("seen", 0) > 15: continue
                        try:
                            async with sess.get(f"http://{r['ip']}:8082/projector") as resp:
                                j = await resp.json()
                            r["proj"] = dict(power=j.get("power", "unknown"), source=j.get("source"), msg=j.get("msg", ""), port=j.get("port"), protocol=(j.get("config") or {}).get("protocol"), at=j.get("at"))
                        except Exception:
                            r["proj"] = dict(power="unknown", msg="status service not reachable", port=None)
            except Exception:
                pass
    asyncio.get_event_loop().create_task(projector_poller())
    app.router.add_post("/api/rig/projectors/{cmd}", api_projectors_all)      # before {name}/{act}
    app.router.add_post("/api/rig/self/{act}", api_rig_self)
    app.router.add_get("/api/rig/self/update.log", api_rig_log)
    app.router.add_post("/api/rig/{name}/projector/config", api_rig_remote)
    app.router.add_get("/api/rig/{name}/projector", api_rig_remote)
    app.router.add_post("/api/rig/{name}/{act}", api_rig_remote)
    app.router.add_get("/api/rig/{name}/update.log", api_rig_remote)

    # ---- shows (whole-rig setups per venue / scenario)
    async def api_shows(request):
        return web.json_response(dict(shows=engine.shows.list() if engine.shows else [], last=cfg.get("last_show")))

    async def api_show_get(request):
        d = engine.shows.get(request.match_info["name"]) if engine.shows else None
        if not d:
            raise web.HTTPNotFound(text="no such show")
        if request.query.get("bundle"):
            # .fractalshow.zip = show.json + every clip the show refers to (playlist + cue video actions), so a
            # venue setup moves to another master with its media. Written to a temp file, then streamed.
            import zipfile, tempfile
            names = set(str(x) for x in (d.get("video") or {}).get("playlist") or [])
            for c in d.get("cues") or []:
                v = (c.get("actions") or {}).get("video") or {}
                if isinstance(v.get("play"), str):
                    names.add(v["play"])
            tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
                z.writestr("show.json", json.dumps(d, indent=1))
                if media:
                    for n in sorted(names):
                        pth = os.path.join(media.root, clean_name(n) + ".mp4")
                        if os.path.exists(pth):
                            z.write(pth, "media/" + clean_name(n) + ".mp4")
            tmp.close()
            resp = web.FileResponse(tmp.name, headers={"Content-Disposition": f'attachment; filename="{clean_show(d["name"])}.fractalshow.zip"', "Content-Type": "application/zip"})
            async def _cleanup(_):
                try: os.remove(tmp.name)
                except OSError: pass
            request.task.add_done_callback(lambda t: asyncio.ensure_future(_cleanup(t)))
            return resp
        resp = web.json_response(d)
        if request.query.get("download"):
            resp.headers["Content-Disposition"] = f'attachment; filename="{clean_show(d["name"])}.fractalshow.json"'
        return resp

    async def api_show_save(request):
        if not engine.shows:
            raise web.HTTPServiceUnavailable(text="shows disabled")
        name = clean_show(request.match_info["name"])
        if not name:
            raise web.HTTPBadRequest(text="name required")
        try:
            body = await request.json()
        except Exception:
            body = {}
        if body.get("import"):                       # a .fractalshow.json uploaded from the browser
            d = body["import"]
            if not isinstance(d, dict) or "params" not in d:
                raise web.HTTPBadRequest(text="not a show file")
            d["name"] = name; d["saved"] = time.time()
            json.dump(d, open(engine.shows.path(name), "w"), indent=1)
            engine.event(f"show imported: {name}")
            return web.json_response(dict(ok=True, shows=engine.shows.list()))
        prev = engine.shows.get(name) if body.get("update") else None
        engine.shows.capture(name, venue=str(body.get("venue", "")), notes=str(body.get("notes", "")), keep_meta_from=prev)
        return web.json_response(dict(ok=True, shows=engine.shows.list()))

    async def api_show_load(request):
        if not engine.shows:
            raise web.HTTPServiceUnavailable(text="shows disabled")
        try:
            body = await request.json()
        except Exception:
            body = {}
        parts = set(body["parts"]) if isinstance(body.get("parts"), list) else None
        ok = engine.shows.apply(request.match_info["name"], parts)
        if not ok:
            raise web.HTTPNotFound(text="no such show")
        return web.json_response(dict(ok=True, last=cfg.get("last_show")))

    async def api_show_delete(request):
        ok = engine.shows.delete(request.match_info["name"]) if engine.shows else False
        return web.json_response(dict(ok=ok, shows=engine.shows.list() if engine.shows else []))

    async def api_show_rename(request):
        body = await request.json()
        ok = engine.shows.rename(request.match_info["name"], body.get("new", "")) if engine.shows else False
        return web.json_response(dict(ok=ok, shows=engine.shows.list() if engine.shows else []))

    async def api_show_import_bundle(request):
        """multipart upload of a .fractalshow.zip: clips go into the library (skipping identical ones), show is saved."""
        import zipfile, tempfile, shutil
        if not engine.shows:
            raise web.HTTPServiceUnavailable(text="shows disabled")
        reader = await request.multipart()
        field = await reader.next()
        tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
        while True:
            chunk = await field.read_chunk(1 << 20)
            if not chunk:
                break
            tmp.write(chunk)
        tmp.close()
        added, skipped = [], []
        try:
            with zipfile.ZipFile(tmp.name) as z:
                d = json.loads(z.read("show.json").decode())
                name = clean_show(request.query.get("name") or d.get("name") or "imported")
                for info in z.infolist():
                    if not info.filename.startswith("media/") or not info.filename.endswith(".mp4") or not media:
                        continue
                    fn = clean_name(os.path.basename(info.filename)[:-4]) + ".mp4"
                    dest = os.path.join(media.root, fn)
                    if os.path.exists(dest) and os.path.getsize(dest) == info.file_size:
                        skipped.append(fn); continue
                    with z.open(info) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
                    added.append(fn)
                    asyncio.ensure_future(media.thumbnail(fn[:-4]))
                d["name"] = name; d["saved"] = time.time()
                json.dump(d, open(engine.shows.path(name), "w"), indent=1)
        except Exception as ex:
            raise web.HTTPBadRequest(text=f"not a show bundle: {ex}")
        finally:
            try: os.remove(tmp.name)
            except OSError: pass
        if media and added:
            media._cache.clear() if hasattr(media, "_cache") else None
        engine.event(f"show bundle imported: {name} (+{len(added)} clips, {len(skipped)} already here)")
        return web.json_response(dict(ok=True, name=name, added=added, skipped=skipped, shows=engine.shows.list()))

    app.router.add_post("/api/shows-import", api_show_import_bundle)
    app.router.add_get("/api/shows", api_shows)
    app.router.add_get("/api/shows/{name}", api_show_get)
    app.router.add_post("/api/shows/{name}", api_show_save)
    app.router.add_post("/api/shows/{name}/load", api_show_load)
    app.router.add_post("/api/shows/{name}/rename", api_show_rename)
    app.router.add_delete("/api/shows/{name}", api_show_delete)
    app.router.add_get("/api/mapping", api_mapping)
    app.router.add_get("/api/mapping/{name}", api_mapping_get)
    app.router.add_put("/api/mapping/{name}", api_mapping_put)
    app.router.add_get("/api/media", api_media)
    app.router.add_get("/api/media/devices", api_media_devices)
    app.router.add_post("/api/media/upload", api_media_upload)
    app.router.add_get("/media/thumb/{name}", api_media_thumb)
    app.router.add_get("/media/{name}", api_media_file)
    app.router.add_get("/params.js", lambda r: web.FileResponse(os.path.join(WEB, "params.js")))
    app.router.add_static("/web/", WEB)
    app.router.add_static("/css/", os.path.join(WEB, "css"))
    app.router.add_static("/js/", os.path.join(WEB, "js"))
    app.router.add_static("/vendor/", os.path.join(WEB, "vendor"))
    app.router.add_static("/shaders/", os.path.join(ROOT, "renderer", "shaders"))
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, cfg.get("http_host", "0.0.0.0"), int(cfg.get("http_port", 8080)))
    await site.start()
    engine.event(f"web UI on http://{local_ip()}:{cfg.get('http_port', 8080)}/")
    asyncio.create_task(pusher())


def _png(w, h, rgb):
    """Minimal PNG encoder (pure python) for the tiny renderer thumbnails."""
    import zlib
    raw = b"".join(b"\x00" + rgb[y * w * 3:(y + 1) * w * 3] for y in range(h))
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ------------------------------------------------------------------ main
async def main():
    ap = argparse.ArgumentParser(description="Fractal Rig master")
    ap.add_argument("--port", type=int)
    ap.add_argument("--group")
    ap.add_argument("--no-midi", action="store_true")
    ap.add_argument("--no-osc", action="store_true")
    ap.add_argument("--no-prodj", action="store_true")
    ap.add_argument("--audio", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    cfg = load_config(args)
    engine = Engine(cfg)
    engine.verbose = not args.quiet
    _ENGINE_REF.append(engine)
    try:
        from media import Media
        engine.media = Media(engine, cfg, cfg.get("media_dir") or os.path.join(ROOT, "master", "media"))
        asyncio.get_running_loop().create_task(engine.media.worker())
        engine.event(f"video: {len(engine.media.clips())} clips in {engine.media.root} · ffmpeg {'ok' if engine.media.have_ffmpeg else 'MISSING (sudo apt install ffmpeg)'}")
    except Exception as ex:
        engine.event(f"video: media library disabled ({ex})")
    try:
        engine.mapping = MappingStore(engine, cfg.get("mapping_dir") or os.path.join(ROOT, "master", "mapping"))
    except Exception as ex:
        engine.mapping = None
        engine.event(f"mapping: store disabled ({ex})")

    def _apply_video(v):
        if "playlist" in v: engine.video_playlist = [str(x) for x in v["playlist"]][:64]; cfg["video_playlist"] = engine.video_playlist
        if "cycle" in v: engine.video_cycle = v["cycle"] if v["cycle"] in ("end", "bars", "off") else "end"; cfg["video_cycle"] = engine.video_cycle
        if "cycle_bars" in v: engine.video_cycle_bars = max(1, int(v["cycle_bars"])); cfg["video_cycle_bars"] = engine.video_cycle_bars
        if "bar_sync" in v: engine.video_bar_sync = bool(v["bar_sync"]); cfg["video_bar_sync"] = engine.video_bar_sync
    cfg["_app_version"] = APP_VERSION
    try:
        from cloud import Cloud
        engine.cloud = Cloud(engine, cfg)
        asyncio.get_running_loop().create_task(engine.cloud.loop())
        engine.event(f"cloud: {'enabled → ' + engine.cloud.url.split('//')[-1] + ' (rig ' + engine.cloud.rig + ')' if engine.cloud.enabled else 'not configured (Rig tab → Cloud)'}")
    except Exception as ex:
        engine.cloud = None
        engine.event(f"cloud: disabled ({ex})")
    try:
        engine.shows = Shows(engine, cfg, cfg.get("shows_dir") or os.path.join(ROOT, "master", "shows"),
                             dict(outputs=lambda: dict(osc_out=osc_out, led=led, link=link), save_local_config=lambda: save_local_config(cfg), apply_video=_apply_video))
    except Exception as ex:
        engine.shows = None
        engine.event(f"shows: disabled ({ex})")
    engine.event(f"Fractal Rig master v{APP_VERSION} — {len(KEYS)} params")
    engine.event(f"projectM: {len(engine.pm_presets)} presets in {engine.pm_dir}" if engine.pm_presets else
                 f"projectM: no presets in {engine.pm_dir} (run setup/install-projectm.sh) — scene 8 shows plasma")

    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(lambda: HeartbeatProto(engine),
                                        local_addr=("0.0.0.0", int(cfg.get("heartbeat_port", 5006))))
    # ---- outputs
    global osc_out, led, thumbs, link
    thumbs = outputs.ThumbReceiver(engine)
    await loop.create_datagram_endpoint(lambda: thumbs, local_addr=("0.0.0.0", int(cfg.get("thumb_port", 5008))))
    osc_out = outputs.OscOut(engine, cfg)
    engine.hooks["tempo"].append(osc_out.on_tempo); engine.hooks["beat1"].append(osc_out.on_beat1)
    engine.hooks["scene"].append(osc_out.on_scene); engine.hooks["params"].append(osc_out.on_params)
    led = outputs.LedOutput(engine, cfg, thumbs)
    asyncio.create_task(led.run())
    link = inputs.AbletonLink(engine, cfg)
    await link.start()
    engine.hooks["beat1"].append(link.push_beat1)
    engine.event(f"outputs: OSC→Resolume {'on' if osc_out.enabled else 'off'} ({osc_out.host}:{osc_out.port}) · LED {'on' if led.cfg.get('enabled') else 'off'} ({len(led.cfg.get('strips', []))} strips) · thumbs udp/{cfg.get('thumb_port', 5008)}")
    await web_app(engine, cfg)
    asyncio.create_task(diag_task(engine, cfg))
    if cfg.get("prodj_enabled", True):
        await inputs.ProDJLink.start(engine, cfg)
    if cfg.get("osc_enabled", True):
        await inputs.osc_start(engine, cfg)
    if cfg.get("midi_enabled", True):
        asyncio.create_task(inputs.midi_task(engine, cfg))
    if cfg.get("audio_enabled", False):
        inputs.Audio.start(engine, cfg)

    await broadcaster(engine, cfg)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
