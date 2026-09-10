# STUDIO - Fractal Rig (v0.4.0)

> Current version: 0.4.0 · Repo: `sonor-fractal-rig` · Pages: https://sonorltd.github.io/sonor-fractal-rig/
> Type: side-project (STUDIO class, like STUDIO - Hub). Not a customer-facing Sonor product.

Multi-Raspberry-Pi fractal projection rig: one master broadcasting a 136-byte UDP multicast
state packet at 60 Hz, N Pi renderers (C + SDL2 + GLES3) drawing the same GLSL shader to
projectors over HDMI. Inputs: web UI, MIDI, OSC, Pioneer Pro DJ Link (passive beat listener),
optional audio, autonomous drift. **Read `README.md` and `PROTOCOL.md` first.**

## Spine
- Spine version: n/a — **exempt**. Not a browser app in the Sonor family (no Supabase, no
  sonor-db.js, runs on embedded Pis off-LAN). Same isolation class as `STUDIO - Hub` /
  Hartley & Co: registered in `workspace-apps.tsv` as `type=side-project, isolation=full`.
- HARMONY §4 note: nothing here is shareable with the Sonor app family except the 10 service
  colours used decoratively in the web UI header strip. Deliberately an island.

## Shared seams consumed
- None at runtime. Web UI uses DM Sans / DM Mono (same web faces as the Sonor apps) and the
  10 service colours as a decorative strip only.

## Brand overrides
- **Theme: custom dark "stage" palette** (`web/index.html :root`). Deviates from SLATE-FIRST
  because this is a side-project control surface used next to a DJ booth in the dark, not a
  Sonor staff app. Reason logged 2026-09-08. Inline `:root` is acceptable here (S-4.1 does not
  apply to non-Spine side-projects).

## Data flows
- Upstream: Pro DJ Link beat packets (udp/50001, passive), MIDI CC/notes, OSC (udp/9000),
  audio input, web UI WebSocket.
- Downstream: multicast `239.255.42.1:5005` → every renderer; renderer heartbeats → master
  udp/5006. Persisted locally only: `master/state.json`, `master/presets.json` (gitignored).
- No Supabase. No Xero. No outbound email. No customer data.

## Single source of truth
- `master/params.py` = the parameter table. `python3 master/gen_params.py` regenerates
  `renderer/params.h`, `renderer/shaders/params.glsl`, `web/params.js`. Never hand-edit those.
- `renderer/shaders/fractal.frag` is loaded by the Pi renderer AND fetched by the web preview —
  one file, two consumers.

## Feature timeline
- 2026-09-08 v0.1.0 — first cut: renderer, master, web UI (live + Pages demo), Pro DJ Link
  passive parser, MIDI/OSC/audio adapters, install script + systemd units, PROTOCOL.md.
- 2026-09-08 v0.2.0 — 4 non-fractal scenes (plasma, tunnel, starfield, waves) behind the same
  `mode` param; Sources panel in the web UI with live link status + enable/disable toggles,
  audio device picker and Pro DJ Link deck-follow; runtime source toggles over WebSocket;
  Info tab (sources, scenes, Pi setup, layouts, network, protocol, troubleshooting).
- 2026-09-08 v0.3.0 — Status tab (browser/link RTT, master system + throttle decode, clock/broadcast
  stats, per-source detail incl. Pro DJ Link raw packet counters, decks, renderer fleet detail with
  temps, effective config, full log, copy-diagnostics JSON); heartbeat v2 carries CPU temp;
  `setup/selftest.sh` on-Pi pass/fail checker; SET BEAT 1 bar resync (UI, key `1`, OSC
  `/frx/beat1`, MIDI note 34); mobile-adaptive layout for all three tabs.
- 2026-09-10 v0.4.0 — projectM scene 8: `renderer/pm_bridge.c` (libprojectM 4 C API, optional at
  build time via pkg-config), `shaders/post.frag` post-pass (tiling/kaleido/zoom/hue over the
  projectM frame, `pm_mix`), master-owned preset selection (`pm_preset` index into a byte-sorted
  list — `master/pm.py` and `pm_bridge.c` must sort identically), PCM multicast stream udp/5007
  (`FRXA`) with synthetic beat-locked fallback on the Pis, auto-cycle every N bars, UI card with
  search/prev/next/random, heartbeat v3 (preset count / current / audio pkts), `install-projectm.sh`.
  libprojectM 4.1 always presents to framebuffer 0 → renderer lets it, then blits fb0 → pm_tex.

## App-specific rules
- Renderer must stay single-threaded C with no deps beyond SDL2 + GLES — it has to be boring.
  libprojectM is the ONE optional extra, isolated behind `pm_bridge.h` and `HAVE_PROJECTM`; the
  renderer must always build and run without it.
- Preset list ordering is a cross-language contract: `master/pm.py scan_presets` and
  `renderer/pm_bridge.c pm_scan_presets` (recursive, relative path, byte order). Change both or neither.
- Never send anything TO the Pioneer network (no virtual CDJ) without an explicit decision.
- Version sites: `renderer/fractal.c APP_VERSION`, `master/master.py APP_VERSION`,
  `web/index.html #pill-ver`, this banner. Bump all four together.
- Protocol changes: bump `PROTOCOL_VERSION` in `params.py` only when the header changes.
- GLSL gotcha (learned v0.2.0): `smoothstep(a, b, x)` with a > b is undefined on Mesa — always
  write `1.0 - smoothstep(b, a, x)`.
