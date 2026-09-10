# Fractal Rig — sync protocol (v1)

One master, N renderers, one UDP multicast stream. No handshakes, no TCP, no
state on the wire except *the whole state, every tick*. A renderer can be
powered on at any moment and is in sync within one packet (16 ms).

## Transport

| what | value |
|---|---|
| group / port | `239.255.42.1:5005` (config `multicast_group` / `--group`) |
| rate | 60 Hz, one packet per master tick |
| TTL | 1 (never leaves the LAN) |
| heartbeat back | renderer → master unicast UDP `5006`, 1 Hz, ASCII |

Multicast means one send serves 4 or 40 projectors and adding a Pi is zero
config. Wired gigabit switch strongly recommended; on Wi-Fi many APs throttle
multicast to 1–6 Mbps and drop it under load (our stream is 58 kbit/s, so it
usually still works, but jitter goes from <1 ms to 20–50 ms).

## Packet (136 bytes, little-endian)

```
offset  type   field       meaning
0       4s     magic       'FRX1'
4       u16    version     1
6       u16    nparams     20 — receivers reject packets whose count differs
8       u32    seq         wraps; renderers count gaps as "lost"
12      u32    flags       bit0 beat this tick · bit1 Pro DJ Link locked · bit2 audio live
16      f64    t           master animation clock, seconds
24      f64    beat_t      animation-clock time of the most recent beat
32      f32    bpm         0 = no tempo
36      f32    bar_beat    beat-within-bar (1..4) at beat_t, 0 = unknown
40      f32×24 params      in the order defined in master/params.py
```

`master/params.py` is the single source of truth for the parameter table.
`gen_params.py` emits `renderer/params.h`, `renderer/shaders/params.glsl` and
`web/params.js` from it, so the three consumers cannot disagree on index order.

## How renderers stay in sync

* **Clock** — every packet carries the master's `t`. A renderer stores
  `(t, local_arrival)` and renders at `t + (now − local_arrival)`. That is
  re-anchored 60× a second, so there is no drift to correct, and between packets
  it extrapolates with its own monotonic clock. Arrival jitter on a wired LAN is
  well under a millisecond — far below one 16.7 ms frame.
* **Params** — continuous params are exponentially smoothed on the renderer
  (τ = 60 ms) so slider moves and packet loss never step; discrete params
  (`mode`, `iterations`, `kaleido`) snap. Because every renderer applies the
  same filter to the same target stream they converge identically.
* **Beats** — the master never sends a "phase"; it sends `beat_t` + `bpm` and the
  shader computes `fract((t − beat_t) · bpm / 60)` itself. Phase therefore
  never wraps mid-interpolation and all projectors kick on the same frame.
* **Freewheel** — after 3 s without packets a renderer keeps animating on its
  own clock with the last params, then re-locks silently when the master returns.
* **No frame-lock (genlock)** — HDMI outputs are not scan-synchronised; adjacent
  projectors can be up to one frame (16 ms) apart. For a tiled canvas that is
  invisible at normal motion speeds; if you ever need true genlock, that is a
  hardware problem (Datapath/Decklink), not a software one.

## Audio stream (master → renderers, optional, for projectM)

`239.255.42.1:5007`, sent from the master's audio callback whenever audio input is running:

```
4s  'FRXA'   u32 seq   u32 sample_rate   u16 n_samples (≤1024)   u16 channels (1)   int16[n] pcm
```

~86 packets/s at 44.1 kHz mono (≈ 700 kbit/s). Renderers feed it straight into
libprojectM; if no FRXA packet arrives for 1 s they synthesise a beat-locked
kick/hat from `t`, `beat_t` and `bpm` instead — identical on every Pi.

## Heartbeat (renderer → master)

```
HB 3 <name> <fps> <WxH> <cols> <rows> <x> <y> <packets> <lost> <version> <cpuTempC> <pmPresets> <pmCurrent> <audioPkts>
```

`pmPresets` = −1 when the renderer was built without libprojectM. v1/v2
heartbeats with fewer fields are still accepted.

The master lists live renderers in the web UI (name, IP, fps, tile, loss, age).

## Extending

Add a row to `PARAMS` in `master/params.py`, run `python3 master/gen_params.py`,
use `P_YOURNAME` in `fractal.frag`, rebuild the renderer, restart the master.
Bump `PROTOCOL_VERSION` only when you change the header layout — adding params
is already guarded by the `nparams` field.
