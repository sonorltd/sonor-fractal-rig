"""
FRACTAL RIG — media library for the Video scene (scene 9).

Design: identical files on every Pi, one shared clock. The master keeps the library in
`master/media/` (gitignored), converts whatever gets uploaded into a Pi-friendly H.264 MP4,
and serves it over HTTP; every renderer's `fractal-media-sync` pulls new/changed clips and
keeps the same byte-sorted list, so `video_clip` (an index) means the same file everywhere.

    Library:   media/<clean-name>.mp4            playable clips (what the index counts)
    Thumbs:    media/.thumbs/<clean-name>.jpg    one frame at 10 % for the UI
    Incoming:  media/.incoming/                  uploads while they are being converted
    Manifest:  GET /api/media → {clips:[{name,file,size,mtime,duration,sha1,thumb}], jobs:[…], live:{…}}

Transcode: ffmpeg → 1920x1080 max (keeps aspect, pads nothing), H.264 High@4.1 yuv420p, CRF 20,
GOP 60 (2 s at 30 fps → seeks land quickly), no audio (renderers have no speakers), +faststart.
Pi 4 hardware-decodes that; Pi 5 decodes it in software comfortably at 1080p30.

Live stream: the master can push an H.264 stream to `udp://239.255.42.2:5010` (MPEG-TS over
multicast) from a file, a V4L2 capture device or a screen. Renderers show it as clip 255.
"""
import asyncio, hashlib, json, os, re, shutil, subprocess, time

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".m4v", ".avi", ".webm", ".mpg", ".mpeg", ".ts", ".mts", ".wmv", ".flv", ".gif"}
LIVE_URL = "udp://239.255.42.2:5010?pkt_size=1316"
LIVE_INDEX = 255


def clean_name(name):
    base = os.path.splitext(os.path.basename(name))[0]
    base = re.sub(r"[^A-Za-z0-9._ -]+", "", base).strip().replace(" ", "_")
    return (base or "clip")[:60]


def sha1_of(path, blocks=64):
    """Cheap fingerprint: size + first/last 1 MB — renderers use it to decide whether to re-download."""
    h = hashlib.sha1()
    try:
        st = os.stat(path)
        h.update(str(st.st_size).encode())
        with open(path, "rb") as f:
            h.update(f.read(1 << 20))
            if st.st_size > (2 << 20):
                f.seek(-(1 << 20), 2)
                h.update(f.read(1 << 20))
    except OSError:
        return ""
    return h.hexdigest()[:16]


def ffprobe_duration(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=width,height,r_frame_rate",
                              "-of", "json", path], capture_output=True, text=True, timeout=20).stdout
        j = json.loads(out or "{}")
        dur = float((j.get("format") or {}).get("duration") or 0)
        v = next((s for s in j.get("streams", []) if s.get("width")), {})
        return dur, int(v.get("width") or 0), int(v.get("height") or 0)
    except Exception:
        return 0.0, 0, 0


class Media:
    def __init__(self, engine, cfg, root):
        self.e = engine
        self.cfg = cfg
        self.root = root
        self.thumbs = os.path.join(root, ".thumbs")
        self.incoming = os.path.join(root, ".incoming")
        for d in (root, self.thumbs, self.incoming):
            os.makedirs(d, exist_ok=True)
        self.jobs = {}          # id -> dict(name, state, progress, msg, started)
        self._queue = asyncio.Queue()
        self._cache = {}        # file -> (mtime, size, info)
        self.have_ffmpeg = shutil.which("ffmpeg") is not None
        self.live = dict(running=False, source="", url=LIVE_URL, started=0.0, msg="", pid=None)
        self._live_proc = None

    # ------------------------------------------------------------ library
    def clips(self):
        """Byte-sorted list — the index contract shared with every renderer (see PROTOCOL.md)."""
        names = sorted(f for f in os.listdir(self.root) if f.lower().endswith(".mp4") and not f.startswith("."))
        out = []
        for f in names:
            p = os.path.join(self.root, f)
            try:
                st = os.stat(p)
            except OSError:
                continue
            key = (st.st_mtime, st.st_size)
            if self._cache.get(f, (None,))[0] != key:
                dur, w, h = ffprobe_duration(p)
                self._cache[f] = (key, dict(duration=round(dur, 2), width=w, height=h, sha1=sha1_of(p)))
            info = self._cache[f][1]
            out.append(dict(name=f[:-4], file=f, size=st.st_size, mtime=int(st.st_mtime),
                            thumb=f"/media/thumb/{f[:-4]}.jpg" if os.path.exists(os.path.join(self.thumbs, f[:-4] + ".jpg")) else None, **info))
        return out

    def manifest(self):
        return dict(clips=self.clips(), jobs=sorted(self.jobs.values(), key=lambda j: j["started"], reverse=True)[:20],
                    live=dict(self.live), ffmpeg=self.have_ffmpeg, live_index=LIVE_INDEX)

    def index_of(self, name):
        for i, c in enumerate(self.clips()):
            if c["name"] == name or c["file"] == name:
                return i
        return None

    def delete(self, name):
        for p in (os.path.join(self.root, name + ".mp4"), os.path.join(self.thumbs, name + ".jpg")):
            try:
                os.remove(p)
            except OSError:
                pass
        self._cache.pop(name + ".mp4", None)
        self.e.event(f"video: deleted {name}")

    def rename(self, old, new):
        new = clean_name(new)
        src, dst = os.path.join(self.root, old + ".mp4"), os.path.join(self.root, new + ".mp4")
        if not os.path.exists(src) or os.path.exists(dst):
            return False
        os.rename(src, dst)
        ts, td = os.path.join(self.thumbs, old + ".jpg"), os.path.join(self.thumbs, new + ".jpg")
        if os.path.exists(ts):
            os.rename(ts, td)
        self.e.event(f"video: renamed {old} → {new}")
        return new

    # ------------------------------------------------------------ uploads → transcode queue
    def unique_name(self, name):
        base = clean_name(name); n = base; k = 2
        while os.path.exists(os.path.join(self.root, n + ".mp4")) or any(j["name"] == n and j["state"] in ("queued", "converting") for j in self.jobs.values()):
            n = f"{base}-{k}"; k += 1
        return n

    async def enqueue(self, tmp_path, orig_name, mode="convert"):
        name = self.unique_name(orig_name)
        self._seq = getattr(self, "_seq", 0) + 1
        jid = f"{int(time.time())%1000000:06d}{self._seq:03d}"
        self.jobs[jid] = dict(id=jid, name=name, orig=os.path.basename(orig_name), state="queued", progress=0.0, msg="", started=time.time(), mode=mode)
        await self._queue.put((jid, tmp_path))
        self.e.event(f"video: queued {orig_name} → {name}.mp4")
        return self.jobs[jid]

    async def worker(self):
        """One conversion at a time — a Pi 5 has four cores and the master still has to tick at 60 Hz."""
        while True:
            jid, tmp = await self._queue.get()
            job = self.jobs.get(jid)
            if not job:
                continue
            try:
                await self._convert(job, tmp)
            except Exception as ex:
                job.update(state="failed", msg=str(ex)[:200])
                self.e.event(f"video: {job['name']} failed: {ex}")
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            # prune old finished jobs
            for k in [k for k, j in self.jobs.items() if j["state"] in ("done", "failed") and time.time() - j["started"] > 3600]:
                self.jobs.pop(k, None)

    async def _convert(self, job, tmp):
        out = os.path.join(self.root, job["name"] + ".mp4")
        dur, w, h = ffprobe_duration(tmp)
        job.update(state="converting", duration=dur, src=f"{w}x{h}")
        if not self.have_ffmpeg:
            raise RuntimeError("ffmpeg not installed on the master (sudo apt install ffmpeg)")
        maxh = int(self.cfg.get("video_max_height", 1080))
        crf = str(self.cfg.get("video_crf", 20))
        # already a friendly H.264 MP4 and small enough? keep it as is (remux only) — much faster
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,height,level",
                                "-of", "json", tmp], capture_output=True, text=True).stdout
        try:
            v = json.loads(probe)["streams"][0]
        except Exception:
            v = {}
        friendly = (v.get("codec_name") == "h264" and v.get("pix_fmt") == "yuv420p" and int(v.get("height") or 9999) <= maxh
                    and tmp.lower().endswith((".mp4", ".mov", ".m4v")) and job.get("mode") != "force")
        if friendly:
            cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-i", tmp,
                   "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", out]
        else:
            vf = f"scale='min({int(maxh*16/9)},iw)':'min({maxh},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"
            cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-i", tmp,
                   "-map", "0:v:0", "-vf", vf, "-c:v", "libx264", "-preset", str(self.cfg.get("video_preset", "veryfast")), "-crf", crf,
                   "-profile:v", "high", "-level", "4.1", "-g", "60", "-keyint_min", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
                   "-an", "-movflags", "+faststart", out]
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            s = line.decode(errors="ignore").strip()
            if s.startswith("out_time_ms=") and dur > 0:
                try:
                    job["progress"] = min(0.99, int(s.split("=")[1]) / 1e6 / dur)
                except ValueError:
                    pass
        await proc.wait()
        err = (await proc.stderr.read()).decode(errors="ignore")[-300:] if proc.stderr else ""
        if proc.returncode != 0 or not os.path.exists(out):
            raise RuntimeError(err or f"ffmpeg exit {proc.returncode}")
        await self.thumbnail(job["name"])
        job.update(state="done", progress=1.0, msg="remuxed" if friendly else "converted")
        self._cache.pop(job["name"] + ".mp4", None)
        self.e.event(f"video: ready {job['name']}.mp4 ({'remux' if friendly else 'h264 ' + str(maxh) + 'p'})")

    async def thumbnail(self, name):
        src = os.path.join(self.root, name + ".mp4"); dst = os.path.join(self.thumbs, name + ".jpg")
        dur, _, _ = ffprobe_duration(src)
        at = max(0.0, dur * 0.1)
        proc = await asyncio.create_subprocess_exec("ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{at:.2f}", "-i", src,
                                                    "-frames:v", "1", "-vf", "scale=320:-2", dst)
        await proc.wait()
        return os.path.exists(dst)

    # ------------------------------------------------------------ live stream (master → multicast, renderers show as clip 255)
    # ---- NDI in (Resolume → LIVE): setup/ndi-recv (built by install-ndi.sh) pipes UYVY frames into ffmpeg
    NDI_RECV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "setup", "ndi-recv")

    def have_ndi(self):
        return os.access(self.NDI_RECV, os.X_OK)

    async def ndi_sources(self, wait_ms=2500):
        """NDI sources visible on the LAN (name + url), [] when ndi-recv isn't built."""
        if not self.have_ndi():
            return []
        try:
            p = await asyncio.create_subprocess_exec(self.NDI_RECV, "--list", "--wait", str(wait_ms),
                                                     stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(p.communicate(), wait_ms / 1000 + 5)
            return json.loads(out.decode() or "[]")
        except Exception as ex:
            self.e.event(f"video: NDI list failed ({ex})")
            return []

    async def _ndi_probe(self, name, low):
        cmd = [self.NDI_RECV, "--source", name, "--probe", "--wait", "8000"] + (["--low"] if low else [])
        p = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(p.communicate(), 20)
        except asyncio.TimeoutError:
            p.kill(); return None, "NDI probe timed out"
        if p.returncode != 0:
            return None, (err.decode(errors="ignore").strip().splitlines() or ["ndi-recv failed"])[-1]
        try:
            return json.loads(out.decode()), ""
        except ValueError:
            return None, "NDI probe gave no frame info"

    async def live_start(self, source, kind="file", extra=None):
        """kind: file (loop a clip), v4l2/hdmi (/dev/videoN capture), ndi (NDI source by name), test (colour bars)."""
        await self.live_stop()
        if not self.have_ffmpeg:
            self.live.update(msg="ffmpeg not installed"); return False
        url = self.cfg.get("video_live_url", LIVE_URL)
        enc = ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "30", "-b:v", str(self.cfg.get("video_live_bitrate", "6M")),
               "-maxrate", str(self.cfg.get("video_live_bitrate", "6M")), "-bufsize", "2M", "-pix_fmt", "yuv420p", "-an", "-f", "mpegts", url]
        if kind == "file":
            path = os.path.join(self.root, source + ".mp4")
            if not os.path.exists(path):
                self.live.update(msg=f"no such clip {source}"); return False
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", path, "-c:v", "copy", "-an", "-f", "mpegts", url]
        elif kind in ("v4l2", "hdmi"):
            # USB HDMI capture dongles (UVC) and webcams. Most HDMI dongles only reach 1080p30 in MJPEG, so that
            # is the default input format for kind=hdmi; kind=v4l2 leaves the driver's default (usually YUYV).
            x = extra or {}
            fmt = x.get("input_format") or ("mjpeg" if kind == "hdmi" else None)
            size = str(x.get("size") or ("1920x1080" if kind == "hdmi" else "1280x720"))
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "v4l2", "-thread_queue_size", "512"]
            if fmt:
                cmd += ["-input_format", fmt]
            cmd += ["-framerate", str(x.get("fps", 30)), "-video_size", size, "-i", source] + enc
        elif kind == "test":
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30"] + enc
        elif kind == "ndi":
            # Resolume (or anything) → NDI → ndi-recv (UYVY on a pipe) → ffmpeg → multicast. Probe first so ffmpeg
            # knows the frame size; ndi-recv exits 3 if the source changes size and _live_watch reports it.
            if not self.have_ndi():
                self.live.update(msg="NDI receiver not built — sudo bash setup/install-ndi.sh <SDK.tar.gz> on the master"); return False
            x = extra or {}
            low = bool(x.get("low"))
            if not source or source.startswith("auto"):
                # Engine card → RESOLUME: pick the Resolume sender automatically (name contains RESOLUME/ARENA/AVENUE), else the first NDI source
                srcs = await self.ndi_sources()
                pick = next((d["name"] for d in srcs if any(w in d["name"].upper() for w in ("RESOLUME", "ARENA", "AVENUE"))), None) or (srcs[0]["name"] if srcs else None)
                if not pick:
                    self.live.update(msg="no NDI sources on the network — enable Output → NDI in Resolume"); return False
                source = pick
            self.live.update(msg=f"connecting to NDI '{source}'…")
            info, err = await self._ndi_probe(source, low)
            if not info:
                self.live.update(msg=err); return False
            fps = max(1.0, min(60.0, float(info.get("fps") or 30)))
            recv = [self.NDI_RECV, "--source", source] + (["--low"] if low else [])
            ff = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "uyvy422", "-s", f"{info['width']}x{info['height']}",
                  "-r", f"{fps:.3f}", "-use_wallclock_as_timestamps", "1", "-thread_queue_size", "64", "-i", "-"] + enc
            import shlex
            cmd = ["bash", "-o", "pipefail", "-c", " ".join(shlex.quote(c) for c in recv) + " | " + " ".join(shlex.quote(c) for c in ff)]
            self.e.event(f"video: NDI '{source}' {info['width']}x{info['height']} @ {fps:.0f} fps{' (proxy)' if low else ''}")
        else:
            self.live.update(msg=f"unknown source kind {kind}"); return False
        self._live_proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        self.live.update(running=True, source=f"{kind}:{source}", url=url, started=time.time(), msg="", pid=self._live_proc.pid)
        self.e.event(f"video: LIVE stream started ({kind}:{source} → {url})")
        asyncio.ensure_future(self._live_watch(self._live_proc))
        return True

    async def _live_watch(self, proc):
        err = (await proc.stderr.read()).decode(errors="ignore")[-200:] if proc.stderr else ""
        await proc.wait()
        if self._live_proc is proc:
            msg = err.strip() or f"ffmpeg exited {proc.returncode}"
            if proc.returncode == 3:
                msg = "NDI source changed resolution — press START again"
            self.live.update(running=False, msg=msg, pid=None)
            self.e.event(f"video: LIVE stream ended ({self.live['msg'][:80]})")

    async def live_stop(self):
        p, self._live_proc = self._live_proc, None
        if p and p.returncode is None:
            p.terminate()
            try:
                await asyncio.wait_for(p.wait(), 3)
            except asyncio.TimeoutError:
                p.kill()
        self.live.update(running=False, pid=None)

    def v4l2_devices(self):
        """Capture-capable /dev/video* nodes with their names (HDMI dongles show as e.g. 'USB Video: USB Video')."""
        out = []
        for d in sorted(os.listdir("/dev"), key=lambda x: (len(x), x)) if os.path.isdir("/dev") else []:
            if not d.startswith("video"):
                continue
            name = ""
            try:
                name = open(f"/sys/class/video4linux/{d}/name").read().strip()
            except OSError:
                pass
            # skip the Pi's own codec/ISP nodes — they are not capture sources
            if any(k in name.lower() for k in ("bcm2835", "rpivid", "pispbe", "rp1-cfe", "codec", "isp")):
                continue
            out.append(dict(dev=f"/dev/{d}", name=name, hdmi=any(k in name.lower() for k in ("usb video", "hdmi", "cam link", "capture", "ms2109", "macrosilicon"))))
        return out
