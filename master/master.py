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

APP_VERSION = "0.7.0"
osc_out = led = thumbs = link = None


LOCAL_CFG = os.path.join(HERE, "config.local.json")


def save_local_config(cfg, keys=("osc_out", "led", "link_enabled", "link_mode", "ndi", "pm_cycle_bars", "pm_shuffle", "prodj_follow_device", "audio_device", "video_playlist", "video_cycle", "video_cycle_bars", "video_bar_sync", "last_show", "osc_in_map", "resolume_grid")):
    """Persist the UI-editable parts of the config to config.local.json (config.json stays pristine in git)."""
    try:
        cur = json.load(open(LOCAL_CFG)) if os.path.exists(LOCAL_CFG) else {}
        for k in keys:
            if k in cfg:
                cur[k] = cfg[k]
        json.dump(cur, open(LOCAL_CFG, "w"), indent=1)
    except Exception as ex:
        print("config save failed:", ex)


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

    # ---- shows (whole-rig setups per venue / scenario)
    async def api_shows(request):
        return web.json_response(dict(shows=engine.shows.list() if engine.shows else [], last=cfg.get("last_show")))

    async def api_show_get(request):
        d = engine.shows.get(request.match_info["name"]) if engine.shows else None
        if not d:
            raise web.HTTPNotFound(text="no such show")
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
