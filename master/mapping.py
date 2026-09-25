"""Per-renderer projection mapping — stored on the master, edited in the web UI, pulled by the Pis.

One JSON file per renderer name in master/mapping/<name>.json (gitignored):
    {"quad": [x0,y0, x1,y1, x2,y2, x3,y3],     corners TL TR BR BL, 0..1, top-left origin
     "masks": [[x,y, x,y, x,y, ...], ...],       black-out polygons in OUTPUT space
     "feather": 0.0, "edge": [l, r, t, b], "bright": 1.0, "gamma": 1.0, "test": 0}

`to_text()` renders the renderer's mapping.txt (renderer/mapping.c parses it); the renderer reports
the FNV-1a hash of that exact text in its heartbeat (map:%08x) so the UI can show "applied" vs
"pending". The text is byte-identical on both ends, so keep the formatting here stable.
"""
import json
import os
import re
import time

IDENTITY = dict(quad=[0, 0, 1, 0, 1, 1, 0, 1], masks=[], feather=0.0, edge=[0, 0, 0, 0], bright=1.0, gamma=1.0, test=0)
_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def clean(name):
    return _NAME.sub("_", str(name or ""))[:48] or "renderer"


def normalise(m):
    """Clamp + coerce a mapping dict from the UI into the stored shape."""
    out = json.loads(json.dumps(IDENTITY))
    if not isinstance(m, dict):
        return out
    try:
        q = [float(v) for v in m.get("quad", out["quad"])][:8]
        if len(q) == 8:
            out["quad"] = [min(1.5, max(-0.5, v)) for v in q]
        masks = []
        for poly in (m.get("masks") or [])[:32]:
            pts = [min(1.5, max(-0.5, float(v))) for v in poly][:128]
            if len(pts) >= 6 and len(pts) % 2 == 0:
                masks.append(pts)
        out["masks"] = masks
        out["feather"] = min(0.3, max(0.0, float(m.get("feather", 0))))
        e = [float(v) for v in m.get("edge", [0, 0, 0, 0])][:4]
        out["edge"] = [min(0.5, max(0.0, v)) for v in (e + [0, 0, 0, 0])[:4]]
        out["bright"] = min(3.0, max(0.0, float(m.get("bright", 1))))
        out["gamma"] = min(4.0, max(0.2, float(m.get("gamma", 1))))
        out["test"] = 1 if m.get("test") else 0
    except (TypeError, ValueError):
        pass
    return out


def is_identity(m):
    return normalise(m) == IDENTITY


def to_text(m):
    m = normalise(m)
    lines = ["# fractal rig mapping — written by the master, do not edit by hand",
             "quad " + " ".join(f"{v:.5f}" for v in m["quad"])]
    for poly in m["masks"]:
        lines.append("mask " + " ".join(f"{v:.5f}" for v in poly))
    lines.append(f"feather {m['feather']:.4f}")
    lines.append("edge " + " ".join(f"{v:.4f}" for v in m["edge"]))
    lines.append(f"bright {m['bright']:.4f}")
    lines.append(f"gamma {m['gamma']:.4f}")
    lines.append(f"test {m['test']}")
    return "\n".join(lines) + "\n"


def fnv1a(text):
    """Same hash as renderer/mapping.c (FNV-1a over the file bytes, 32-bit)."""
    h = 2166136261
    for b in text.encode("utf-8"):
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h


class MappingStore:
    def __init__(self, engine, root):
        self.engine, self.root = engine, root
        os.makedirs(root, exist_ok=True)

    def path(self, name):
        return os.path.join(self.root, clean(name) + ".json")

    def names(self):
        return sorted(f[:-5] for f in os.listdir(self.root) if f.endswith(".json"))

    def get(self, name):
        p = self.path(name)
        if os.path.exists(p):
            try:
                return normalise(json.load(open(p)))
            except Exception:
                pass
        return json.loads(json.dumps(IDENTITY))

    def put(self, name, m):
        m = normalise(m)
        p = self.path(name)
        if m == IDENTITY and os.path.exists(p):
            os.remove(p)            # identity = no file; renderer falls back to the plain blit
        elif m != IDENTITY:
            json.dump(m, open(p, "w"), indent=0)
        self.engine.event(f"mapping saved: {clean(name)}{' (identity)' if m == IDENTITY else ''}")
        return m

    def text(self, name):
        return to_text(self.get(name))

    def hash(self, name):
        """Hash the renderer will report once this mapping is applied (0 when no file)."""
        return 0 if is_identity(self.get(name)) else fnv1a(self.text(name))

    def manifest(self):
        """For the UI: every known renderer (stored or live) with its expected hash + applied state."""
        fleet = getattr(self.engine, "fleet", {})
        names = set(self.names()) | set(fleet.keys())
        out = []
        for n in sorted(names):
            m = self.get(n)
            want = 0 if m == IDENTITY else fnv1a(to_text(m))
            r = fleet.get(n)
            have = None
            if r and r.get("map") is not None:
                try:
                    have = int(r["map"], 16)
                except ValueError:
                    have = None
            out.append(dict(name=n, mapping=m, identity=m == IDENTITY, hash=f"{want:08x}",
                            applied=(have == want) if have is not None else None,
                            online=bool(r and time.time() - r.get("seen", 0) < 5)))
        return out
