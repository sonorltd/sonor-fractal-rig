"""
Input adapters for the master. Each one is optional and degrades gracefully
(missing library / no device = logged once, rig carries on).

  ProDJLink  — PASSIVE Pioneer Pro DJ Link beat listener (XDJ-RX2, CDJs, DJM).
               No virtual-CDJ handshake, no device number to steal: we just
               listen to the beat broadcasts every player already sends on
               UDP 50001. Needs the Pi on the same subnet as the LINK port.
  Midi       — mido/python-rtmidi. CC -> param via config midi_map, notes 36+
               recall presets.
  Osc        — python-osc. /frx/<param> f, /frx/tap, /frx/preset s, /frx/bpm f
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
        if len(data) < 0x60 or data[:10] != PRODJ_HEADER or data[0x0a] != PRODJ_BEAT:
            return
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
                    engine.source("midi", last=f"CC {msg.control} = {msg.value}")
                    key = ccmap.get(msg.control)
                    if key:
                        engine.set_norm(key, msg.value / 127.0, "midi")
                elif msg.type == "note_on" and msg.velocity > 0:
                    if msg.note >= 36:
                        engine.load_preset_index(msg.note - 36)
                    elif msg.note == 35:
                        engine.tap()
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
        engine.source("osc", ok=True, last=f"{addr} {args[0]}", seen=time.time())
        if key == "tap":
            engine.tap()
        elif key == "bpm":
            engine.set_bpm(args[0])
        elif key == "preset":
            engine.load_preset(str(args[0])) if isinstance(args[0], str) else engine.load_preset_index(int(args[0]))
        elif key.startswith("auto_"):
            engine.set_auto(key[5:], bool(args[0]))
        else:
            engine.set(key, args[0], "osc")

    d.map("/frx/*", on_param)
    try:
        server = AsyncIOOSCUDPServer(("0.0.0.0", int(cfg.get("osc_port", 9000))), d, asyncio.get_running_loop())
        await server.create_serve_endpoint()
        engine.event("OSC listening on udp/%d  (/frx/<param> f)" % int(cfg.get("osc_port", 9000)))
        engine.source("osc", detail="listening on udp/%d" % int(cfg.get("osc_port", 9000)))
    except Exception as ex:
        engine.event(f"OSC failed: {ex}")
        engine.source("osc", enabled=False, ok=False, detail=f"failed: {ex}")


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
            engine.audio_stream = stream
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
        if engine.audio_stream is not None:
            try:
                engine.audio_stream.stop(); engine.audio_stream.close()
            except Exception:
                pass
        engine.audio_stream = None
        engine.audio_ok = False
        engine.source("audio", enabled=False, ok=False, detail="off")
        engine.event("Audio stopped")

    @staticmethod
    def devices():
        try:
            import sounddevice as sd
            return [dict(index=i, name=d["name"]) for i, d in enumerate(sd.query_devices()) if d["max_input_channels"] > 0]
        except Exception:
            return []
