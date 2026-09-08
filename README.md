# Fractal Rig

One Raspberry Pi is the **master**. Four (or forty) Raspberry Pis are **renderers**,
each driving a projector over HDMI. The master broadcasts every parameter of the
fractal 60 times a second over the LAN; every renderer draws the *same*
GPU shader from the *same* numbers, so the wall moves as one — same image on every
projector, one giant tiled canvas, or a family of variations. The master takes
its cues from the web UI on your phone, a MIDI controller, OSC (TouchOSC etc.),
the Pioneer **Pro DJ Link** beat grid from an XDJ / CDJ, a microphone, or just
drifts on its own.

**Live demo of the control surface (no Pis needed):** https://sonorltd.github.io/sonor-fractal-rig/
— runs the identical shader in your browser, in "demo mode".

![Fractal Rig web UI](docs/screenshot-live.png)

```
              phone / laptop ── http :8080 ──┐
              MIDI controller ── USB ────────┤
              TouchOSC ───────── OSC :9000 ──┤        UDP multicast 239.255.42.1:5005 @ 60 Hz
    XDJ-RX2 / CDJ ── Pro DJ Link :50001 ─────┤            120 bytes: clock + beat + 20 params
              mic / line-in ─── (optional) ──┤                          │
                                             ▼                          ▼
                                    ┌─────────────────┐     ┌──────────┬──────────┬──────────┬──────────┐
                                    │  fractal-master │ ──▶ │ fractal-2│ fractal-3│ fractal-4│ fractal-5│
                                    │  master.py      │     │ ./fractal│ ./fractal│ ./fractal│ ./fractal│
                                    │  + ./fractal    │     └────┬─────┴────┬─────┴────┬─────┴────┬─────┘
                                    └────────┬────────┘          │          │          │          │
                                          HDMI ▼              HDMI ▼     HDMI ▼     HDMI ▼     HDMI ▼
                                        projector 1              2          3          4          5
```

## What's in the box

| path | what | runs on |
|---|---|---|
| `renderer/` | `fractal.c` — 350-line C/SDL2/GLES3 fullscreen renderer. Multicast in, HDMI out, tiling, freewheel, heartbeat. | every Pi |
| `renderer/shaders/fractal.frag` | **The** shader: Mandelbrot / Julia / Burning Ship / Tricorn, orbit-trap glow, kaleidoscope, domain warp, beat pulse, bar sway. Byte-identical on Pis and in the web preview. | GPU |
| `master/` | `master.py` + `engine.py` + `inputs.py` — asyncio param engine, 60 Hz broadcaster, web UI + WebSocket, Pro DJ Link / MIDI / OSC / audio inputs, presets, fleet heartbeat. | master Pi (or a laptop) |
| `master/params.py` | Single source of truth for the parameter table → generates `params.h`, `params.glsl`, `params.js`. | — |
| `web/` | `index.html` — phone-friendly control surface with a live WebGL2 preview. Live when served by the master, demo mode on GitHub Pages. | browser |
| `setup/` | `install.sh` (role = master or slave), systemd units, host naming examples. | Pi |
| `PROTOCOL.md` | The wire format and the sync reasoning. | — |

## Hardware

* **Raspberry Pi 5** (recommended) or **Pi 4**, one per projector. The Pi 5's VideoCore VII
  does 1080p at ~60 fps with the default `--scale 0.6` (renders 1152×648 and upscales — on a
  projector you can't tell) and 150–300 iterations. Pi 4: use `--scale 0.5` and ~120 iterations.
  Pi Zero 2 / Pi 3 work at `--scale 0.35` for slower, simpler scenes.
* Each Pi has **two** micro-HDMI ports — a Pi can feed two projectors with the same picture
  via a splitter, or (future) two independent tiles.
* **Wired gigabit switch.** Multicast over Wi-Fi works but jitters; a £15 8-port switch and
  five patch leads is the single biggest reliability win.
* Official 27 W (Pi 5) / 15 W (Pi 4) PSUs. Under-powered Pis throttle the GPU.
* Master extras: the Pi's own USB for a MIDI controller; a USB audio interface or the XDJ's
  USB audio for live energy (optional); an Ethernet path to the **XDJ-RX2 LINK port**.

## Install (each Pi, Raspberry Pi OS Bookworm Lite or Desktop)

```bash
sudo apt install -y git
git clone https://github.com/sonorltd/sonor-fractal-rig.git ~/fractal-rig
cd ~/fractal-rig

# projector Pis
sudo bash setup/install.sh slave
# the brain (also renders → projector #1)
sudo bash setup/install.sh master
```

That builds the renderer, creates a venv for the master, installs systemd units that start
at boot (`fractal-renderer`, `fractal-master`), and adds the user to the video/render groups.
On Pi OS **Lite** the renderer draws straight to the HDMI output through KMSDRM — no desktop
needed. On Pi OS **Desktop** remove the `SDL_VIDEODRIVER=KMSDRM` line from the unit and it
runs as a fullscreen Wayland/X window instead.

Open the web UI from any phone on the LAN: **`http://<master-ip>:8080/`** (the master logs
the URL: `journalctl -fu fractal-master`).

### Layouts

Renderer arguments go on the install line (or `sudo systemctl edit fractal-renderer`):

```bash
sudo bash setup/install.sh slave                          # same image on every projector (default)
sudo bash setup/install.sh slave --tile 2 2 1 0           # this Pi = top-right of a 2×2 canvas
sudo bash setup/install.sh slave --view 0.7 1.57 0.15     # same fractal, +0.7 log2 zoom, 90°, +0.15 hue
sudo bash setup/install.sh slave --scale 0.5 --name stage-left
```

See `setup/hosts.example.txt` for a full 5-Pi naming plan. Mix freely — a 2×2 tiled wall plus
a fifth projector showing a rotated variation is one line per Pi.

## Controlling it

| input | how |
|---|---|
| **Web UI** | sliders for all 20 params with per-param **auto-drift** toggles, 4 fractal modes, presets (save/load/delete), tap tempo (space bar too), BPM entry, clock speed, drift depth/rate, fleet table, MIDI learn. |
| **Pro DJ Link** | Plug the master Pi into the same network as the XDJ-RX2 / CDJ **LINK** port. The master listens *passively* to the beat packets every player already broadcasts on UDP 50001 — no virtual-CDJ handshake, no player number to steal, nothing shows up on the decks. Locks BPM + beat-in-bar; `prodj_follow_device` in `config.json` pins a deck (0 = follow whichever deck beat most recently). |
| **MIDI** | Any class-compliant controller. `config.json → midi_map` maps CC → param (defaults for CC 1–12), notes 36+ recall presets in order, note 35 = tap. "Map last CC →" in the UI does MIDI-learn for the session. |
| **OSC** | udp/9000: `/frx/<param> f` · `/frx/tap` · `/frx/bpm f` · `/frx/preset s|i` · `/frx/auto_<param> 0|1`. TouchOSC / Lemur / Ableton Max-for-Live all speak this. |
| **Audio** | `python3 master.py --audio` (or `"audio_enabled": true`). Drives the `energy` and `bass` params from RMS + a 30–150 Hz band with auto-gain; falls back to onset-detected beats when no Pro DJ Link is present. |
| **Autonomous** | Everything with the pink toggle drifts on smooth noise. Depth/rate live in the Master panel. Leave it and walk away. |

Master state (`state.json`) and presets (`presets.json`) persist across restarts.

### Pro DJ Link networking notes

* Pioneer gear on a LINK network without DHCP self-assigns `169.254.x.x`. Either put a small
  router/DHCP on the LINK switch (the Pis and decks then share one subnet) or give the master
  Pi a second address on `169.254.0.0/16` (`sudo nmcli con mod "Wired connection 1" +ipv4.addresses 169.254.42.10/16`).
* Beat packets are **broadcast**, so the master only has to be on the same L2 segment. Nothing
  is sent to the decks.
* Verified against the packet layout documented by Deep Symmetry's *dysentery* / *beat-link*
  projects (device number at 0x21, pitch at 0x54, BPM×100 at 0x5A, beat-in-bar at 0x5C).
  If your firmware ever moves a field, `inputs.py → ProDJLink` is 30 lines.
* Want full player status (which deck is *master*, track names, on-air)? Run
  [Beat Link Trigger](https://github.com/Deep-Symmetry/beat-link-trigger) on a laptop and have
  it send OSC (`/frx/bpm`, `/frx/tap`) to the master — the OSC input is already there.

## Development

```bash
# master on your laptop, renderer in a window on the same machine
cd master && pip install -r requirements.txt && python3 master.py --no-midi
cd renderer && make && ./fractal --window 960x540 --scale 1 --novsync

# edit the shader → both the Pis (on restart) and the web preview (on reload) pick it up
# add a parameter → master/params.py, then: python3 master/gen_params.py && make -C renderer
```

Only the renderer needs rebuilding when the parameter table changes; everything else
reads the generated tables at start-up.

## Roadmap

- [ ] second HDMI output per Pi as an independent tile (`--out 1`)
- [ ] edge-blend feathering for overlapping projectors (`--blend L R T B` in px)
- [ ] more scenes (Mandelbulb slices, Lyapunov, IFS ferns) behind the same `mode` param
- [ ] master failover — any renderer promotes itself if no packets for 10 s
- [ ] Beat Link Trigger recipe for track-name → preset switching

## Credits / why these choices

* **Custom GLSL, not projectM/Milkdrop** — every parameter is ours to sync, and the picture is a
  pure function of the packet, so N Pis are pixel-identical by construction.
* **Plain C + SDL2 on the Pi, Python on the master** — the renderer has to be boring and fast;
  the master has to be easy to hack at 1 a.m. at a gig.
* **Multicast + full-state packets** — no sessions, no reconnect logic, hot-plug any Pi.

Part of the Sonor workspace as a side-project (`STUDIO - Fractal Rig`). Not a Sonor product;
the UI is deliberately dark/stage-themed rather than Sonor slate.
