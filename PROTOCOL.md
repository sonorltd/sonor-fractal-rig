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

## Packet (164 bytes, little-endian)

```
offset  type   field       meaning
0       4s     magic       'FRX1'
4       u16    version     1
6       u16    nparams     31 — receivers reject packets whose count differs
8       u32    seq         wraps; renderers count gaps as "lost"
12      u32    flags       bit0 beat this tick · bit1 Pro DJ Link locked · bit2 audio live
16      f64    t           master animation clock, seconds
24      f64    beat_t      animation-clock time of the most recent beat
32      f32    bpm         0 = no tempo
36      f32    bar_beat    beat-within-bar (1..4) at beat_t, 0 = unknown
40      f32×31 params      in the order defined in master/params.py
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

## Live thumbnail (renderer → master, udp/5008)

```
4s 'FRXT'  u16 w  u16 h  u32 seq  u32 t_ms  16s name   then RGB8 rows top-to-bottom (80×45 = 10.8 KB)
```

20 per second per renderer. Shown in the Outputs tab and used as the LED sampling source.

## Heartbeat (renderer → master)

```
HB 5 <name> <fps> <WxH> <cols> <rows> <x> <y> <packets> <lost> <version> <cpuTempC> <pmPresets> <pmCurrent> <audioPkts> ndi:<off|on|live|unavailable> media:<N> map:<hash8> video:<ok|idle|none>
```

`pmPresets` = −1 when the renderer was built without libprojectM. Everything after
`<audioPkts>` is `key:value` and order-free: `media` = number of synced clips (−1 when
built without libmpv), `map` = FNV-1a hash of the applied `mapping.txt` (00000000 =
identity), `video` = whether a frame is being decoded. Older heartbeats with fewer
fields are still accepted.

The master lists live renderers in the web UI (name, IP, fps, tile, loss, age).

## Video (scene 9) — files, not frames

The packet carries `video_clip` (index), `video_t0` (master-clock start), `video_speed`,
`video_loop`. Every renderer has the same files: `fractal-media-sync` (setup/) reads the
renderer's state file (`/var/lib/fractal-rig/state`, written by `fractal` once it hears the
master: `master=<ip> name=… media_dir=… mapping=…`), then polls the master's HTTP API
(ports 8080 then 8081): `GET /api/media` → `{clips:[{file,size,sha1,…}]}`, downloads
`/media/<file>` when size or fingerprint (sha1 of size + first/last MB) differ, deletes
local files the master no longer lists. **Index contract:** both sides byte-sort `*.mp4`
file names (`master/media.py clips()` ⇄ `renderer/video_bridge.c vb_scan()`).
Clip **255 = LIVE**: the master's ffmpeg multicasts MPEG-TS to `udp://239.255.42.2:5010`
(pkt_size 1316); renderers open that URL with mpv's low-latency profile.

## Projection mapping

`GET /api/mapping/<name>.txt` (404 = identity) → written by the sync helper to
`/var/lib/fractal-rig/mapping.txt`; `renderer/mapping.c` re-reads it on change. Format
(top-left-origin 0..1): `quad x0 y0 x1 y1 x2 y2 x3 y3` (TL TR BR BL), `mask x y …`
(output-space polygon, any number of lines), `feather f`, `edge l r t b`, `bright b`,
`gamma g`, `test 0|1`. The renderer reports the file's FNV-1a hash in the heartbeat;
`master/mapping.py to_text()` must stay byte-identical to what the Pi hashes.

## Feed mix

`live_mix` (0..1) and `live_blend` (0 crossfade · 1 add · 2 multiply · 3 screen · 4 difference) blend
the LIVE multicast feed over whatever the renderer draws (renderer `shaders/mix.frag`). While scene 9
plays a file the single decoder is busy, so the mix is skipped there; clip 255 is the feed itself.

## Output resolution

`out_res` (0 auto, 1 1080p, 2 4K) is an ordinary param. A KMSDRM renderer that sees a
different value than it started with for 1.5 s writes it to `<state_file>.res` and exits
(code 3); systemd restarts it and it picks the largest mode ≤ the target at ≤ 60 Hz.
`--out-res` pins a renderer and makes it ignore the param.

## Extending

Add a row to `PARAMS` in `master/params.py`, run `python3 master/gen_params.py`,
use `P_YOURNAME` in `fractal.frag`, rebuild the renderer, restart the master.
Bump `PROTOCOL_VERSION` only when you change the header layout — adding params
is already guarded by the `nparams` field.


### Heartbeat token `out:` (v0.8.0)
`out:<mode>/<displays>` — which HDMI port(s) the renderer drives: `1`, `2`, `mirror` (both, same picture) or `dual` (both, two side-by-side tiles), and how many displays KMSDRM enumerated. Chosen by `--outputs` or the `<state>.out` file the master writes through the Pi's status service (`POST :8082/outputs {mode}`), followed by a renderer restart.
