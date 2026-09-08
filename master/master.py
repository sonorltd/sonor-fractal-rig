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
import argparse, asyncio, json, os, socket, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "web")
sys.path.insert(0, HERE)

from engine import Engine
from params import PARAMS, KEYS, PACKET_SIZE
import inputs

APP_VERSION = "0.1.0"


def load_config(args):
    cfg = json.load(open(os.path.join(HERE, "config.json")))
    local = os.path.join(HERE, "config.local.json")
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
            for p in PARAMS]))
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
                if "midi_learn" in m:
                    cc = getattr(engine, "last_cc", None)
                    if cc is not None:
                        cfg.setdefault("midi_map", {})[str(cc)] = m["midi_learn"]
                        engine.event(f"MIDI CC {cc} -> {m['midi_learn']} (edit config.json to make permanent)")
        finally:
            clients.discard(ws)
        return ws

    async def pusher():
        while True:
            if clients:
                snap = engine.snapshot()
                snap["last_cc"] = getattr(engine, "last_cc", None)
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

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/state", api_state)
    app.router.add_get("/params.js", lambda r: web.FileResponse(os.path.join(WEB, "params.js")))
    app.router.add_static("/web/", WEB)
    app.router.add_static("/shaders/", os.path.join(ROOT, "renderer", "shaders"))
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, cfg.get("http_host", "0.0.0.0"), int(cfg.get("http_port", 8080)))
    await site.start()
    engine.event(f"web UI on http://{local_ip()}:{cfg.get('http_port', 8080)}/")
    asyncio.create_task(pusher())


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
    engine.event(f"Fractal Rig master v{APP_VERSION} — {len(KEYS)} params")

    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(lambda: HeartbeatProto(engine),
                                        local_addr=("0.0.0.0", int(cfg.get("heartbeat_port", 5006))))
    await web_app(engine, cfg)
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
