# STUDIO - Fractal Rig (v0.2.0)

> Current version: 0.2.0 · Repo: `sonor-fractal-rig` · Pages: https://sonorltd.github.io/sonor-fractal-rig/
> Type: side-project (STUDIO class, like STUDIO - Hub). Not a customer-facing Sonor product.

Multi-Raspberry-Pi fractal projection rig: one master broadcasting a 120-byte UDP multicast
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

## App-specific rules
- Renderer must stay single-threaded C with no deps beyond SDL2 + GLES — it has to be boring.
- Never send anything TO the Pioneer network (no virtual CDJ) without an explicit decision.
- Version sites: `renderer/fractal.c APP_VERSION`, `master/master.py APP_VERSION`,
  `web/index.html #pill-ver`, this banner. Bump all four together.
- Protocol changes: bump `PROTOCOL_VERSION` in `params.py` only when the header changes.
- GLSL gotcha (learned v0.2.0): `smoothstep(a, b, x)` with a > b is undefined on Mesa — always
  write `1.0 - smoothstep(b, a, x)`.
