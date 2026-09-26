# STUDIO - Fractal Rig (v0.8.0)

> Current version: 0.8.0 · Repo: `sonor-fractal-rig` · Pages: https://sonorltd.github.io/sonor-fractal-rig/
> Type: side-project (STUDIO class, like STUDIO - Hub). Not a customer-facing Sonor product.

Multi-Raspberry-Pi fractal projection rig: one master broadcasting a 164-byte UDP multicast
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
  udp/5006; renderer thumbnails → master udp/5008; master → Resolume OSC (udp, configurable), Ableton
  Link (udp 20808 multicast), LED controllers (DDP 4048 / Art-Net 6454 / sACN 5568); renderer → NDI (opt). Persisted locally only: `master/state.json`, `master/presets.json` (gitignored).
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
- 2026-09-10 v0.4.1 — in-browser projectM simulation: vendored Butterchurn (Milkdrop 2 in WebGL,
  `web/vendor/`, ~2 MB, lazy-loaded on scene 8) fed the same synthetic beat audio as the Pis; preset
  matched by name to the Pi's current preset (exact / closest / stand-in, labelled). Master serves
  `/vendor/`. Not a pixel copy of the Pis — a simulation.
- 2026-09-10 v0.4.2 — Engine switch card (Shader scenes ⇄ projectM) at the top of Control; extended
  projectM UI when active (big preset name, PREV/RANDOM/NEXT, filterable browse list with ★ favourites
  in localStorage, recent chips, hold, auto-cycle); card reorders under the preview; params tab jumps
  to projectM. Pages demo seeds the preset list from Butterchurn's packs and auto-cycles locally.
- 2026-09-16 v0.5.0 — Outputs: `master/outputs.py` (OscOut→Resolume with normalised tempo/resync/
  scene-column/param map; ThumbReceiver FRXT udp/5008; LedOutput DDP/Art-Net/sACN sampling the
  thumbnails along strip lines, gamma LUT, test patterns), `inputs.AbletonLink` (aalink, follow/lead,
  force_beat on SET BEAT 1), engine hooks (tempo/beat1/scene/params), `config.local.json` persistence
  via `save_local_config`. Renderer: FRXT thumbnail sender, `ndi_out.c` behind HAVE_NDI (SDK not
  vendored; `install-ndi.sh`), heartbeat v4 with ndi state, `--display`. Web: Outputs tab (thumbnails,
  Resolume/Link, NDI, LED strip editor + matrix builder + canvas preview), Perform mode (`#perf`,
  swipeable big-button pages, `?perf=1`, key P/Esc), `install-kiosk.sh` (cage or desktop autostart).
- 2026-09-18 v0.6.0 — Inputs monitor card (Control tab, under Tempo): canvas drawn every frame from the
  same anchored clock as the preview — 4-bar beat grid + playhead, lock badge (prodj deck / link peers /
  free-running) with BPM-spread readout, per-deck lanes, Link phase bar, audio waveform + 16 log bands +
  E/B meters, MIDI/OSC/Pro DJ Link activity chips; slim grid on the Perform Show page. Master:
  `Audio.callback` fills `engine.audio_wave` (96 samples) / `audio_bands` (16, auto-gained); snapshot
  carries `audio_wave`, `audio_bands`, `audio_levels`, `prodj_dev`; MIDI/OSC sources stamp `seen`.
- 2026-09-25 v0.6.1 — first real Pi 4 slave (`fractal1`, Pi OS Lite): SDL KMSDRM opened /dev/dri/card0 (the v3d
  render node, no outputs) → "KMSDRM not available" restart loop. Renderer now picks the DRM card with a
  connected connector from sysfs (`SDL_KMSDRM_DEVICE_INDEX`), falls back to trying card0..3; operator can
  still pin the index. Lesson: on Pi 4 card0=v3d, card1=vc4 display; on Pi 5 the order differs. Slave and
  master must share a switch — Wi-Fi ↔ Wi-Fi multicast through an AP is unreliable.
  Second Pi 4 finding: with a screen attached the renderer ran but every frame failed with
  `Could not queue pageflip: -13` (EACCES) — a systemd service user has no logind seat, so no DRM master.
  `fractal-renderer.service` now sets `AmbientCapabilities=CAP_SYS_ADMIN` + `SupplementaryGroups=video render
  input`. Measured 53 % multicast packet loss Wi-Fi→Wi-Fi through the studio AP — wire the renderers.
  Root cause of the -13 on `fractal1` turned out to be a **Desktop** image: labwc owned the DRM device. The
  slave installer now detects `graphical.target` and switches to console boot (`raspi-config B2`,
  `KEEP_DESKTOP=1` to opt out). The capability lines stay — harmless and correct for Lite.

- 2026-09-25 v0.7.0 — **Video scene 9**: `master/media.py` (upload → ffmpeg convert/remux, thumbnails, byte-sorted
  clip index, LIVE multicast MPEG-TS from file / v4l2 / HDMI UVC dongle / test bars), engine video state
  (playlist, auto-cycle end|bars|off, bar sync), `renderer/video_bridge.c` (libmpv render API, HAVE_MPV optional,
  seek >0.35 s else ±8 % speed trim against `(t − t0) × speed`), `setup/fractal-media-sync` (stdlib Python on every
  Pi: pulls clips + mapping.txt from the master using the renderer's state file; status page on :8082),
  OSC `/frx/video*`, MIDI 31/30/29/28. NDI in: `setup/ndi-recv.c` (SDK receiver → UYVY pipe → ffmpeg, kind `ndi`,
  `--low` proxy, exit 3 on size change; built by install-ndi.sh / install.sh when the SDK is present). **Projection mapping**: `renderer/mapping.c` + `shaders/warp.frag` (inverse
  homography, 512×288 mask texture with box-blur feather, edge blend ^1.6, bright/gamma, test grid), `master/mapping.py`
  store + `/api/mapping/{name}(.txt)` + canvas editor in Outputs (drag corners, draw masks, nudge keys, copy-from,
  live apply with 150 ms debounce; rect + polygon tools, whole-mask drag, edge double-click inserts a vertex, undo).
  Mask texture gotcha: rows are uploaded top-first, so warp.frag samples it at `o` (top-left uv), NOT `1-o.y` —
  the first cut mirrored every mask vertically on the projector. **Output resolution** param `out_res` (top-bar selector): KMSDRM renderer
  remembers the request in `<state>.res`, exits 3, systemd restarts it in the new mode; `--out-res` pins.
  Heartbeat v5 adds `media:` `map:` `video:` tokens; fleet table shows a media column. Perform pages scroll
  (`.ppage overflow-y:auto`). Tabs: Control · Shows · Inputs · Media · Outputs · LEDs · Rig · Info — Sources/MIDI-OSC
  moved to Inputs, Projectors+Log into Rig, LED strips own tab with colour-coded draggable zones (canvas pointer
  handlers write the draft rows). **Shows** (`master/shows.py`, `master/shows/<name>.json`, `/api/shows…`): capture/apply
  params+auto, preset bank, every mapping, video playlist settings, pm cycling, osc_out/led/link cfg, out_res; partial
  load by parts; import/download as `.fractalshow.json`. `--headless` renderer (SDL offscreen, paced 60 fps) for a
  master whose HDMI is taken (the test rig; defaults 720p — it shares the GPU with the kiosk). **Resolume tab**: `live_mix` +
  `live_blend` params → renderer `mix.frag` blends the LIVE feed (vb clip 255 kept decoding while mix > 0, scene ≠ 9)
  into `mix_fbo`, final pass reads `out_tex`; OSC generic send (`/composition/*` only) for clip pad / layers / master;
  Resolume OSC *output* learned into `engine.osc_in_map` (default OSC handler, `set_norm`), persisted + in shows.
  Perform: rail nav, one scrolling page, no swipe; preview/Butterchurn stops while Perform is up (was killing the
  Pi 5 kiosk session when projectM was selected). Master-loss behaviour: renderers already freewheel on the last
  state (own clock, last params, clips loop locally); v0.7.0 adds a LIVE-feed stall fallback (`vb_frame_age()` >
  FEED_STALL 3 s → last shader scene, feed mix suspended) so a dead master never leaves a black/frozen projector.
  Packet 164 bytes / 31 params.
- 2026-09-26 v0.8.0 — **Cue stack + fades + modulation** (`master/cues.py ShowLayer`, wired into `Engine.tick`: fades before
  drift, mods after; `engine.show`): cues in `master/cues.json` (actions: preset/show/scene/params/pm/video/live_mix/
  blackout/brightness/auto; fade_bars → seconds at current BPM (120 fallback), follow_bars auto-GO), WS `cue`/`mods`,
  OSC `/frx/go|back|cue`, MIDI 27/26, keys G/B; mods {key, src ∈ energy|bass|beat|band0..15, amount (fraction of
  range), attack, release} with per-mod envelope, persisted in config.local `mods`; both captured in shows (`cues`
  part). **Rig maintenance**: `setup/rig-update` (reads role/args from the units, git pull, reinstall), sudoers.d rule
  written by install.sh, status service POST `/update|/restart|/reboot` + `/update.log`, master `/api/rig/self/<act>`
  and `/api/rig/<name>/<act>` proxy; Rig tab buttons + version column. Mapping: `gain r g b` (mapping.c/warp.frag/
  mapping.py; identity check includes it), `test_all` (Align all), photo overlay (browser-only). Shows bundle
  `?bundle=1` zip (show.json + referenced clips) and `POST /api/shows-import`. `out_res` default 1 + forced at boot
  (`out_res_boot`). Test rig `sonor-rig update` now skips unreachable private repos instead of dying.

## App-specific rules
- Renderer must stay single-threaded C with no deps beyond SDL2 + GLES — it has to be boring.
  libprojectM is the ONE optional extra, isolated behind `pm_bridge.h` and `HAVE_PROJECTM`; the
  renderer must always build and run without it.
- libmpv is the SECOND optional extra (`video_bridge.h`, `HAVE_MPV`), same rule: renderer builds and runs without it.
- Clip index is a cross-language contract like presets: `master/media.py clips()` ⇄ `renderer/video_bridge.c vb_scan()`
  (byte-sorted `*.mp4`). Mapping text is a cross-language contract too: `master/mapping.py to_text()` bytes ⇄
  `renderer/mapping.c` FNV-1a hash — change the format on both sides or the "applied" pill lies.
- Preset list ordering is a cross-language contract: `master/pm.py scan_presets` and
  `renderer/pm_bridge.c pm_scan_presets` (recursive, relative path, byte order). Change both or neither.
- Rendering-side outputs must never block the frame loop: thumbnails/NDI are readbacks of the low-res
  fbo on a timer; LED sampling and all network sending happen on the master in Python.
- UI rule (learned v0.5.0): never rebuild input-bearing DOM on every snapshot — signature-check
  (strips, maps, columns) or clobbered inputs and stolen focus follow.
- Never send anything TO the Pioneer network (no virtual CDJ) without an explicit decision.
- Version sites: `renderer/fractal.c APP_VERSION`, `master/master.py APP_VERSION`,
  `web/index.html #pill-ver`, this banner. Bump all four together.
- Protocol changes: bump `PROTOCOL_VERSION` in `params.py` only when the header changes.
- GLSL gotcha (learned v0.2.0): `smoothstep(a, b, x)` with a > b is undefined on Mesa — always
  write `1.0 - smoothstep(b, a, x)`.
