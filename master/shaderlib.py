"""Shader library (scene 18) on the master: the byte-sorted list of Shadertoy / ISF fragment shaders every renderer
compiles from the same files. Two folders, exactly like renderer/shaderlib.c scans them:

    <repo>/renderer/shaders/lib      the seed pack that ships with the code (same on every Pi at the same version)
    master/shaders/                  uploads (gitignored) — fractal-media-sync copies them to /var/lib/fractal-rig/shaders
                                     on every renderer; a file here with the same name as a pack file wins

Index contract (cross-language, like clips and Milkdrop presets): names de-duplicated (uploads first), sorted by UTF-8
bytes = C strcmp order. `shader_idx` in the packet is an index into that list, so the list must be identical on every
Pi — the sync script mirrors uploads byte-for-byte and removes files the master no longer has."""
import hashlib, os, re, json

EXTS = (".fs", ".frag", ".glsl")
NAME_RE = re.compile(r"[^A-Za-z0-9._ -]+")


def clean_name(name):
    base = os.path.basename(name or "").strip()
    base = NAME_RE.sub("_", base).strip(" ._") or "shader"
    stem, ext = os.path.splitext(base)
    if ext.lower() not in EXTS:
        ext = ".frag"
    return stem[:96] + ext.lower()


def sha1_text(data):
    return hashlib.sha1(data).hexdigest()[:16]


def classify(src):
    """('isf'|'shadertoy'|None, description) from the file head — mirrors the C detector."""
    head = src.lstrip()
    desc = ""
    if head.startswith("/*") and "*/" in head[:8000]:
        hdr = head[: head.index("*/")]
        if '"ISFVSN"' in hdr or '"INPUTS"' in hdr or '"DESCRIPTION"' in hdr:
            m = re.search(r'"DESCRIPTION"\s*:\s*"([^"]*)"', hdr)
            desc = m.group(1) if m else ""
            inputs = re.findall(r'"NAME"\s*:\s*"([^"]+)"', hdr)
            return "isf", desc, inputs
    if "mainImage" in src:
        m = re.search(r"^\s*//\s*(.+)$", src, re.M)
        desc = (m.group(1).strip() if m else "")[:160]
        return "shadertoy", desc, []
    return None, "", []


class ShaderLib:
    def __init__(self, pack_dir, user_dir):
        self.pack_dir = pack_dir
        self.user_dir = user_dir
        os.makedirs(user_dir, exist_ok=True)
        self._items = []
        self._sig = None
        self.scan()

    # ---- listing
    def _files(self):
        seen, out = set(), []
        for src, d in (("user", self.user_dir), ("pack", self.pack_dir)):
            if not d or not os.path.isdir(d):
                continue
            for fn in os.listdir(d):
                if fn.startswith(".") or not fn.lower().endswith(EXTS) or fn in seen:
                    continue
                seen.add(fn)
                out.append((fn, src, os.path.join(d, fn)))
        out.sort(key=lambda t: t[0].encode("utf-8"))
        return out

    def scan(self):
        items = []
        for fn, src, path in self._files():
            try:
                data = open(path, "rb").read()
            except OSError:
                continue
            kind, desc, inputs = classify(data.decode("utf-8", "replace"))
            items.append(dict(name=fn, src=src, size=len(data), sha1=sha1_text(data), kind=kind or "unknown", desc=desc, inputs=inputs))
        self._items = items
        self._sig = tuple((i["name"], i["sha1"]) for i in items)
        return items

    def changed(self):
        """Cheap poll: rescan when the folder listing or any mtime moved; True when the list changed."""
        old = self._sig
        self.scan()
        return self._sig != old

    def items(self):
        return self._items

    def names(self):
        return [i["name"] for i in self._items]

    def index_of(self, name):
        for i, it in enumerate(self._items):
            if it["name"] == name:
                return i
        return None

    def name(self, i):
        return self._items[i % len(self._items)]["name"] if self._items else None

    def path(self, name):
        for it in self._items:
            if it["name"] == name:
                return os.path.join(self.user_dir if it["src"] == "user" else self.pack_dir, name)
        return None

    def manifest(self):
        return dict(shaders=self._items, count=len(self._items), user_dir=self.user_dir, pack_dir=self.pack_dir)

    # ---- uploads
    def put(self, name, data):
        """Store an upload. Returns (ok, message)."""
        if isinstance(data, str):
            data = data.encode("utf-8")
        if len(data) > 512 * 1024:
            return False, "too big (512 KB max)"
        kind, _, _ = classify(data.decode("utf-8", "replace"))
        if not kind:
            return False, "not a Shadertoy (mainImage) or ISF (JSON header) fragment shader"
        fn = clean_name(name)
        tmp = os.path.join(self.user_dir, "." + fn + ".part")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, os.path.join(self.user_dir, fn))
        os.utime(self.user_dir)
        self.scan()
        return True, fn

    def delete(self, name):
        for it in self._items:
            if it["name"] == name and it["src"] == "user":
                try:
                    os.remove(os.path.join(self.user_dir, name))
                except OSError:
                    pass
                os.utime(self.user_dir)
                self.scan()
                return True
        return False
