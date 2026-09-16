"""
Outputs — everything the master pushes OUT besides the renderer multicast.

  OscOut         OSC to Resolume (or anything): tempo, bar resync, scene/preset changes,
                 and a param -> address map. Resolume expects range params NORMALISED 0..1.
  ThumbReceiver  small live frames from every renderer (FRXT, udp/5008) — shown in the UI
                 and used as the LED sampling source.
  LedOutput      samples the shared canvas at strip positions and sends DDP / Art-Net / sACN
                 to pixel controllers (WLED, Advatek, PixLite, Falcon …).
  AbletonLink    lives in inputs.py (it is both a source and an output).
"""
import asyncio, math, socket, struct, time, uuid

# ============================================================ OSC out (Resolume)
class OscOut:
    RESOLUME_TEMPO_MIN, RESOLUME_TEMPO_MAX = 20.0, 500.0     # Resolume tempo controller range

    def __init__(self, engine, cfg):
        self.e = engine
        self.cfg = cfg.get("osc_out", {}) or {}
        self.enabled = bool(self.cfg.get("enabled", False))
        self.host = self.cfg.get("host", "192.168.1.20")
        self.port = int(self.cfg.get("port", 7000))
        self.client = None
        self.sent = 0
        self.last = None
        self.last_bpm = None
        self.last_vals = {}
        self._connect()

    def _connect(self):
        try:
            from pythonosc.udp_client import SimpleUDPClient
            self.client = SimpleUDPClient(self.host, self.port)
            self.e.source("resolume", detail=f"OSC → {self.host}:{self.port}", ok=False)
        except Exception as ex:
            self.client = None
            self.e.source("resolume", detail=f"python-osc missing: {ex}", ok=False)

    def reconfigure(self, host=None, port=None, enabled=None):
        if host: self.host = host
        if port: self.port = int(port)
        if enabled is not None: self.enabled = bool(enabled)
        self.cfg.update(host=self.host, port=self.port, enabled=self.enabled)
        self._connect()
        self.e.source("resolume", enabled=self.enabled)

    def send(self, addr, *args):
        if not (self.enabled and self.client):
            return
        try:
            self.client.send_message(addr, list(args) if len(args) != 1 else args[0])
            self.sent += 1
            self.last = (addr, args, time.time())
            self.e.source("resolume", ok=True, last=f"{addr} {args[0] if args else ''}", seen=time.time())
        except Exception as ex:
            self.e.source("resolume", ok=False, detail=f"send failed: {ex}")

    # ---- events called by the engine
    def on_tempo(self, bpm):
        if not self.cfg.get("send_tempo", True) or bpm <= 0:
            return
        if self.last_bpm is not None and abs(bpm - self.last_bpm) < 0.01:
            return
        self.last_bpm = bpm
        n = (bpm - self.RESOLUME_TEMPO_MIN) / (self.RESOLUME_TEMPO_MAX - self.RESOLUME_TEMPO_MIN)
        self.send(self.cfg.get("tempo_address", "/composition/tempocontroller/tempo"), max(0.0, min(1.0, n)))
        for a in self.cfg.get("tempo_bpm_addresses", []):     # for receivers that want raw BPM
            self.send(a, float(bpm))

    def on_beat1(self):
        if self.cfg.get("resync_on_beat1", True):
            self.send(self.cfg.get("resync_address", "/composition/tempocontroller/resync"), 1)

    def on_beat(self, bar_beat):
        if self.cfg.get("send_beats", False):
            self.send(self.cfg.get("beat_address", "/frx/beat"), int(bar_beat or 0))

    def on_scene(self, mode):
        col = (self.cfg.get("scene_columns") or {}).get(str(int(mode)))
        if col:
            self.send(f"/composition/columns/{int(col)}/connect", 1)

    def on_params(self, keys, base, out):
        """Param map: {"hue": "/composition/layers/1/video/effects/hue/effect/hue", ...} — normalised 0..1."""
        m = self.cfg.get("params") or {}
        if not m or not self.enabled:
            return
        from params import PARAMS, INDEX
        for k, addr in m.items():
            i = INDEX.get(k)
            if i is None:
                continue
            p = PARAMS[i]
            v = (out[i] - p[2]) / (p[3] - p[2]) if p[3] != p[2] else 0.0
            v = round(max(0.0, min(1.0, v)), 3)
            if self.last_vals.get(k) != v:
                self.last_vals[k] = v
                self.send(addr, v)

    def stats(self):
        return dict(enabled=self.enabled, host=self.host, port=self.port, sent=self.sent,
                    last=None if not self.last else f"{self.last[0]} {self.last[1]}",
                    last_age=None if not self.last else round(time.time() - self.last[2], 1), map=self.cfg.get("params") or {},
                    send_tempo=self.cfg.get("send_tempo", True), resync_on_beat1=self.cfg.get("resync_on_beat1", True))


# ============================================================ live thumbnails from renderers
class ThumbReceiver(asyncio.DatagramProtocol):
    """FRXT packets: 4s magic, u16 w, u16 h, u32 seq, u32 t_ms, 16s name, then RGB bytes. One frame per packet (≤ ~64 KB)."""
    HDR = struct.Struct("<4sHHII16s")

    def __init__(self, engine):
        self.e = engine
        self.frames = {}           # name -> dict(w, h, rgb(bytes), seq, seen, ip, fps)
        self._cnt = {}

    def datagram_received(self, data, addr):
        if len(data) < self.HDR.size or data[:4] != b"FRXT":
            return
        magic, w, h, seq, tms, name = self.HDR.unpack_from(data, 0)
        rgb = data[self.HDR.size:]
        if len(rgb) != w * h * 3 or w > 320 or h > 180:
            return
        name = name.split(b"\0")[0].decode("ascii", "replace")
        now = time.time()
        c = self._cnt.setdefault(name, [now, 0, 0.0])
        c[1] += 1
        if now - c[0] >= 2:
            c[2] = c[1] / (now - c[0]); c[0] = now; c[1] = 0
        self.frames[name] = dict(w=w, h=h, rgb=rgb, seq=seq, seen=now, ip=addr[0], fps=round(c[2], 1))

    def get(self, name=None):
        if not self.frames:
            return None
        if name and name in self.frames:
            return self.frames[name]
        # default: the freshest
        return max(self.frames.values(), key=lambda f: f["seen"])

    def summary(self):
        now = time.time()
        return {n: dict(w=f["w"], h=f["h"], ip=f["ip"], fps=f["fps"], age=round(now - f["seen"], 1)) for n, f in self.frames.items() if now - f["seen"] < 10}


# ============================================================ LED pixel output
class LedOutput:
    """
    Layout (config 'led'):
      { "enabled": true, "fps": 40, "brightness": 0.8, "gamma": 2.2, "source": "" (renderer name, "" = freshest),
        "strips": [ { "name": "booth-front", "ip": "192.168.1.50", "protocol": "ddp|artnet|sacn", "universe": 0,
                      "order": "GRB", "count": 150, "x0": 0.0, "y0": 0.95, "x1": 1.0, "y1": 0.95, "start_channel": 0 }, ... ] }
    Coordinates are canvas UV, origin top-left, 0..1 — the same canvas the projectors tile.
    """
    def __init__(self, engine, cfg, thumbs):
        self.e = engine
        self.t = thumbs
        self.cfg = cfg.setdefault("led", {})
        self.cfg.setdefault("enabled", False); self.cfg.setdefault("fps", 40); self.cfg.setdefault("brightness", 0.8)
        self.cfg.setdefault("gamma", 2.2); self.cfg.setdefault("source", ""); self.cfg.setdefault("strips", []); self.cfg.setdefault("test", "off")
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self.cid = uuid.uuid5(uuid.NAMESPACE_DNS, "fractal-rig-sacn").bytes
        self.seq = 0
        self.packets = 0
        self.frames = 0
        self.last_colors = {}      # strip name -> list of (r,g,b) for the UI preview
        self.errors = {}
        self._lut_gamma = None
        self._lut = None

    # ---- helpers
    def _lut_for(self, gamma, brightness):
        key = (round(gamma, 3), round(brightness, 3))
        if self._lut_gamma != key:
            self._lut = bytes(int(round(255 * brightness * ((i / 255.0) ** gamma))) for i in range(256))
            self._lut_gamma = key
        return self._lut

    def sample(self, frame, strip):
        w, h, rgb = frame["w"], frame["h"], frame["rgb"]
        n = max(1, int(strip.get("count", 1)))
        x0, y0, x1, y1 = (float(strip.get(k, d)) for k, d in (("x0", 0), ("y0", 0.5), ("x1", 1), ("y1", 0.5)))
        out = []
        for i in range(n):
            f = (i + 0.5) / n
            x = min(w - 1, max(0, int((x0 + (x1 - x0) * f) * w)))
            y = min(h - 1, max(0, int((y0 + (y1 - y0) * f) * h)))
            o = (y * w + x) * 3
            out.append((rgb[o], rgb[o + 1], rgb[o + 2]))
        return out

    def test_pattern(self, strip, t):
        n = max(1, int(strip.get("count", 1))); mode = self.cfg.get("test", "off")
        if mode == "white": return [(255, 255, 255)] * n
        if mode == "rgb":
            k = int(t) % 3; return [((255, 0, 0), (0, 255, 0), (0, 0, 255))[k]] * n
        if mode == "chase":
            pos = int((t * 30) % n); return [(255, 255, 255) if abs(i - pos) < 3 else (12, 0, 24) for i in range(n)]
        return None

    @staticmethod
    def reorder(px, order):
        order = (order or "RGB").upper()
        idx = {"R": 0, "G": 1, "B": 2}
        sel = [idx.get(c, 0) for c in order[:3]]
        return bytes(b for p in px for b in (p[sel[0]], p[sel[1]], p[sel[2]]))

    # ---- protocols
    def send_ddp(self, ip, data, port=4048):
        # DDP: flags(0x40 ver1 | 0x01 push on last), seq, type 0x01 (RGB 8-bit), dest 1, offset u32 BE, len u16 BE
        off = 0
        while off < len(data) or off == 0:
            chunk = data[off:off + 1440]
            last = off + len(chunk) >= len(data)
            hdr = struct.pack(">BBBBIH", 0x40 | (0x01 if last else 0), self.seq & 0x0F, 0x01, 0x01, off, len(chunk))
            self.sock.sendto(hdr + chunk, (ip, port)); self.packets += 1
            off += len(chunk)
            if not chunk: break

    def send_artnet(self, ip, data, universe, port=6454):
        # 512 channels per universe, 170 RGB pixels; consecutive universes for longer strips
        u = int(universe)
        for off in range(0, len(data), 510):
            chunk = data[off:off + 510]
            if len(chunk) % 2: chunk += b"\0"
            # ArtDmx: ID, OpCode (LE), ProtVer 14 (BE), Sequence, Physical, Universe (LE: SubUni, Net), Length (BE)
            pkt = b"Art-Net\0" + struct.pack("<H", 0x5000) + struct.pack(">H", 14) + struct.pack("<BBH", self.seq & 0xFF, 0, u) + struct.pack(">H", len(chunk))
            self.sock.sendto(pkt + chunk, (ip, port)); self.packets += 1
            u += 1

    def send_sacn(self, ip, data, universe, priority=100, port=5568):
        u = int(universe)
        for off in range(0, len(data), 510):
            chunk = data[off:off + 510]
            dmp_len = 10 + 1 + len(chunk)
            dmp = struct.pack(">HBBHHH", 0x7000 | dmp_len, 0x02, 0xA1, 0x0000, 0x0001, len(chunk) + 1) + b"\x00" + chunk
            frame_len = 77 + len(dmp)
            framing = struct.pack(">HI", 0x7000 | frame_len, 0x00000002) + b"Fractal Rig".ljust(64, b"\0") + struct.pack(">BHBBH", priority, 0, self.seq & 0xFF, 0, u) + dmp
            root_len = 22 + len(framing)
            root = struct.pack(">HH", 0x0010, 0x0000) + b"ASC-E1.17\x00\x00\x00" + struct.pack(">HI", 0x7000 | root_len, 0x00000004) + self.cid + framing
            dest = ip if ip and not ip.startswith("239.") and ip != "multicast" else f"239.255.{(u >> 8) & 0xFF}.{u & 0xFF}"
            self.sock.sendto(root, (dest, port)); self.packets += 1
            u += 1

    # ---- main loop
    async def run(self):
        while True:
            period = 1.0 / max(1.0, float(self.cfg.get("fps", 40)))
            try:
                if self.cfg.get("enabled") and self.cfg.get("strips"):
                    self.tick()
            except Exception as ex:
                self.errors["loop"] = str(ex)
            await asyncio.sleep(period)

    def tick(self):
        frame = self.t.get(self.cfg.get("source") or None)
        lut = self._lut_for(float(self.cfg.get("gamma", 2.2)), float(self.cfg.get("brightness", 0.8)))
        now = time.time()
        self.seq = (self.seq + 1) & 0xFF
        for strip in self.cfg["strips"]:
            if not strip.get("ip") or strip.get("enabled", True) is False:
                continue
            px = self.test_pattern(strip, now) if self.cfg.get("test", "off") != "off" else (self.sample(frame, strip) if frame else [(0, 0, 0)] * int(strip.get("count", 1)))
            self.last_colors[strip.get("name", "?")] = px[:: max(1, len(px) // 64)]     # decimated for the UI
            data = self.reorder([(lut[r], lut[g], lut[b]) for r, g, b in px], strip.get("order", "GRB"))
            sc = int(strip.get("start_channel", 0) or 0)
            if sc: data = b"\0" * sc + data
            proto = (strip.get("protocol") or "ddp").lower()
            try:
                if proto == "artnet": self.send_artnet(strip["ip"], data, strip.get("universe", 0))
                elif proto == "sacn": self.send_sacn(strip["ip"], data, strip.get("universe", 1))
                else: self.send_ddp(strip["ip"], data)
                self.errors.pop(strip.get("name", "?"), None)
            except OSError as ex:
                self.errors[strip.get("name", "?")] = str(ex)
        self.frames += 1

    def stats(self):
        return dict(enabled=self.cfg.get("enabled"), fps=self.cfg.get("fps"), brightness=self.cfg.get("brightness"), gamma=self.cfg.get("gamma"),
                    source=self.cfg.get("source"), test=self.cfg.get("test"), strips=self.cfg.get("strips"), packets=self.packets, frames=self.frames,
                    pixels=sum(int(s.get("count", 0)) for s in self.cfg.get("strips", [])), errors=self.errors,
                    colors={k: v for k, v in self.last_colors.items()})
