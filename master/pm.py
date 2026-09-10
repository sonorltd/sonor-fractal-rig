"""projectM helpers for the master: the preset list (MUST sort identically to renderer/pm_bridge.c)
and the multicast PCM stream that feeds libprojectM on every Pi."""
import os, socket, struct, time

EXTS = (".milk", ".prjm")


def scan_presets(root):
    """Recursive, relative paths with '/', sorted by UTF-8 bytes — same order as the C renderer's strcmp."""
    out = []
    if not root or not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            if f.startswith(".") or not f.lower().endswith(EXTS):
                continue
            out.append(os.path.relpath(os.path.join(dirpath, f), root).replace(os.sep, "/"))
    out.sort(key=lambda s: s.encode("utf-8"))
    return out


class AudioStream:
    """Sends the master's captured PCM to the renderers: 'FRXA' + seq u32 + rate u32 + n u16 + channels u16 + int16[n]."""
    HDR = struct.Struct("<4sIIHH")

    def __init__(self, cfg):
        self.dest = (cfg["multicast_group"], int(cfg.get("pm_audio_port", 5007)))
        self.rate = int(cfg.get("audio_samplerate", 44100))
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self.s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
        self.s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
        if cfg.get("multicast_iface"):
            self.s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(cfg["multicast_iface"]))
        self.seq = 0
        self.packets = 0
        self.bytes = 0
        self.last = 0.0

    def send_float(self, mono_f32):
        """mono_f32: numpy float32 array in [-1, 1]. Chunks to <= 1024 samples per packet."""
        import numpy as np
        pcm = np.clip(mono_f32 * 32767.0, -32768, 32767).astype("<i2")
        for i in range(0, len(pcm), 1024):
            chunk = pcm[i:i + 1024]
            pkt = self.HDR.pack(b"FRXA", self.seq & 0xFFFFFFFF, self.rate, len(chunk), 1) + chunk.tobytes()
            try:
                self.s.sendto(pkt, self.dest)
                self.seq += 1; self.packets += 1; self.bytes += len(pkt); self.last = time.time()
            except OSError:
                pass

    def stats(self):
        return dict(packets=self.packets, kbps=None, last_age=None if not self.last else round(time.time() - self.last, 1),
                    dest=f"{self.dest[0]}:{self.dest[1]}", rate=self.rate)
