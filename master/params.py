"""
FRACTAL RIG — single source of truth for the synced parameter set.

Every parameter the master broadcasts and every slave renders is listed here,
IN ORDER. The index is the wire position in the UDP packet, the uniform slot in
the shader (u_p[i]) and the slider order in the web UI.

Run `python3 gen_params.py` after editing — it regenerates:
    renderer/params.h            (C enum + names for the Pi renderer)
    renderer/shaders/params.glsl (P_* defines, prepended to fractal.frag)
    web/params.js                (same table for the browser UI / preview)

Never edit those three by hand.

Fields: key, label, min, max, default, kind, auto, group, tip
  kind  : 'f' float (smoothed on slaves) | 'i' integer/discrete (snapped)
  auto  : True if the auto-drift LFO may wander this param
"""

PROTOCOL_VERSION = 1
MAGIC = b"FRX1"

PARAMS = [
    # key            label             min    max    default kind auto  group     tip
    ("mode",         "Scene",          0,     7,     0,     'i', False, "shape",  "0 Mandelbrot · 1 Julia · 2 Burning Ship · 3 Tricorn · 4 Plasma · 5 Tunnel · 6 Starfield · 7 Waves"),
    ("iterations",   "Iterations",     16,    1024,  160,   'i', False, "shape",  "Detail. Pi 5 is happy to ~300 at 1080p half-res"),
    ("zoom",         "Zoom (log2)",    -2,    28,    0.6,   'f', True,  "shape",  "log2 magnification. Float precision runs out ~22–24"),
    ("center_x",     "Centre X",       -2.5,  2.5,   -0.55, 'f', True,  "shape",  ""),
    ("center_y",     "Centre Y",       -2,    2,     0.0,   'f', True,  "shape",  ""),
    ("julia_x",      "Julia Re",       -2,    2,     -0.75, 'f', True,  "shape",  "Julia seed (modes 1 & 3)"),
    ("julia_y",      "Julia Im",       -2,    2,     0.12,  'f', True,  "shape",  ""),
    ("rotation",     "Rotation",       0,     6.2832,0.0,   'f', True,  "shape",  "radians"),
    ("kaleido",      "Kaleidoscope",   0,     16,    0,     'i', False, "shape",  "0 = off, else number of mirror segments"),
    ("warp",         "Domain warp",    0,     1,     0.0,   'f', True,  "shape",  "sinusoidal warp of the plane"),
    ("hue",          "Hue",            0,     1,     0.62,  'f', True,  "colour", ""),
    ("hue_spread",   "Hue spread",     0,     4,     1.2,   'f', True,  "colour", "how many hue cycles across the escape gradient"),
    ("hue_speed",    "Hue cycle",      -1,    1,     0.08,  'f', False, "colour", "colour cycling rate"),
    ("contrast",     "Contrast",       0.2,   3,     1.1,   'f', False, "colour", ""),
    ("brightness",   "Brightness",     0,     2,     1.0,   'f', False, "colour", ""),
    ("glow",         "Trap glow",      0,     1,     0.35,  'f', True,  "colour", "orbit-trap glow inside/around the set"),
    ("beat_pulse",   "Beat pulse",     0,     1,     0.4,   'f', False, "music",  "zoom/brightness kick on every beat"),
    ("bar_swing",    "Bar swing",      0,     1,     0.2,   'f', False, "music",  "slow rotation/hue sway over each bar"),
    ("energy",       "Energy",         0,     1,     0.0,   'f', False, "music",  "live audio level (auto from mic) or manual"),
    ("bass",         "Bass",           0,     1,     0.0,   'f', False, "music",  "live low-band level"),
]

NPARAMS = len(PARAMS)
KEYS = [p[0] for p in PARAMS]
INDEX = {k: i for i, k in enumerate(KEYS)}
DEFAULTS = [float(p[4]) for p in PARAMS]

# Wire format (little-endian), see PROTOCOL.md
#   4s  magic 'FRX1'
#   H   protocol version
#   H   nparams
#   I   seq
#   I   flags (bit0 = beat this tick, bit1 = master has Pro DJ Link lock, bit2 = master has audio)
#   d   t        master animation clock (seconds)
#   d   beat_t   animation-clock time of the most recent beat
#   f   bpm
#   f   bar_beat beat-within-bar at beat_t (1..4, 0 = unknown)
#   f[nparams]
import struct
HEADER = struct.Struct("<4sHHIIddff")
BODY = struct.Struct("<%df" % NPARAMS)
PACKET_SIZE = HEADER.size + BODY.size

FLAG_BEAT = 1
FLAG_PRODJ = 2
FLAG_AUDIO = 4


def pack(seq, flags, t, beat_t, bpm, bar_beat, values):
    return HEADER.pack(MAGIC, PROTOCOL_VERSION, NPARAMS, seq, flags, t, beat_t, bpm, bar_beat) + BODY.pack(*values)


def unpack(data):
    magic, ver, n, seq, flags, t, beat_t, bpm, bar_beat = HEADER.unpack_from(data, 0)
    if magic != MAGIC or ver != PROTOCOL_VERSION or n != NPARAMS:
        raise ValueError("bad packet")
    vals = list(BODY.unpack_from(data, HEADER.size))
    return dict(seq=seq, flags=flags, t=t, beat_t=beat_t, bpm=bpm, bar_beat=bar_beat, values=vals)
