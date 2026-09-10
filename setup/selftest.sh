#!/usr/bin/env bash
# Fractal Rig — on-Pi self-test. Run on ANY Pi (master or renderer):
#     cd ~/fractal-rig && bash setup/selftest.sh
# Prints PASS / WARN / FAIL per check. Safe: read-only, listens for a few seconds, changes nothing.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$REPO/master/config.json"
GROUP=$(python3 -c "import json;print(json.load(open('$CFG'))['multicast_group'])" 2>/dev/null || echo 239.255.42.1)
PORT=$(python3 -c "import json;print(json.load(open('$CFG'))['multicast_port'])" 2>/dev/null || echo 5005)
PRODJ=$(python3 -c "import json;print(json.load(open('$CFG')).get('prodj_port',50001))" 2>/dev/null || echo 50001)
LISTEN=${LISTEN:-4}
G='\033[32m'; Y='\033[33m'; R='\033[31m'; D='\033[2m'; N='\033[0m'
pass(){ printf "  ${G}PASS${N}  %s\n" "$1"; }
warn(){ printf "  ${Y}WARN${N}  %s\n" "$1"; }
fail(){ printf "  ${R}FAIL${N}  %s\n" "$1"; }
note(){ printf "  ${D}      %s${N}\n" "$1"; }
hdr(){ printf "\n%s\n" "== $1"; }

hdr "System"
MODEL=$( { tr -d '\0' < /proc/device-tree/model; } 2>/dev/null); [ -n "$MODEL" ] && pass "$MODEL" || warn "not a Raspberry Pi ($(uname -m)) — fine for a laptop master"
note "$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME") · kernel $(uname -r) · host $(hostname)"
IPS=$(hostname -I 2>/dev/null); [ -n "$IPS" ] && pass "IP: $IPS" || fail "no IP address — cable / DHCP?"
ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | grep -q '^eth\|^en' && { ip -o link show | grep -E '^[0-9]+: (eth|en)' | grep -q 'state UP' && pass "wired Ethernet is UP" || warn "wired Ethernet present but DOWN — multicast over Wi-Fi jitters"; } || warn "no wired interface found"
if command -v vcgencmd >/dev/null; then
  T=$(vcgencmd get_throttled | cut -d= -f2)
  if [ "$T" = "0x0" ]; then pass "throttling: 0x0 (healthy)"; else
    [ $(( T & 0xF )) -ne 0 ] && fail "throttling NOW: $T (bit0 under-voltage, bit1 freq cap, bit2 throttled, bit3 soft temp)" || warn "throttling occurred since boot: $T — check PSU / cooling"; fi
  TEMP=$(vcgencmd measure_temp | tr -dc '0-9.'); awk "BEGIN{exit !($TEMP<70)}" && pass "CPU ${TEMP}°C" || warn "CPU ${TEMP}°C — hot"
else
  TZ=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null); [ -n "$TZ" ] && note "CPU $((TZ/1000))°C"
fi
FREE=$(df -h "$REPO" | awk 'NR==2{print $4}'); note "free disk at repo: $FREE"

hdr "Renderer build"
[ -x "$REPO/renderer/fractal" ] && pass "renderer binary present" || fail "renderer not built — run: make -C $REPO/renderer  (or setup/install.sh)"
[ -f "$REPO/renderer/shaders/fractal.frag" ] && [ -f "$REPO/renderer/shaders/params.glsl" ] && pass "shaders present" || fail "shaders missing"
python3 - "$REPO" <<'EOF' 2>/dev/null && pass "params tables in sync (params.py ↔ params.h ↔ params.js)" || fail "params tables out of sync — run: python3 master/gen_params.py && make -C renderer"
import sys, os, re
r = sys.argv[1]; sys.path.insert(0, os.path.join(r, "master")); import params
h = open(os.path.join(r, "renderer/params.h")).read(); js = open(os.path.join(r, "web/params.js")).read()
assert f"FRX_NPARAMS {params.NPARAMS}" in h and js.count('"key"') == params.NPARAMS
EOF
SDLV=$(sdl2-config --version 2>/dev/null); if [ -n "$SDLV" ]; then
  python3 -c "import sys;v=tuple(map(int,'$SDLV'.split('.')));sys.exit(0 if v>=(2,30,0) else 1)" && pass "SDL2 $SDLV" || warn "SDL2 $SDLV — Pi 5 KMSDRM needs ≥ 2.30 (apt full-upgrade) or run under the desktop"
else warn "sdl2-config not found (libsdl2-dev missing?)"; fi
id -nG | tr ' ' '\n' | grep -qx video && pass "user in 'video' group" || fail "user not in 'video' group — sudo usermod -aG video,render,input $(id -un), then re-login"
id -nG | tr ' ' '\n' | grep -qx render && pass "user in 'render' group" || warn "user not in 'render' group"
ls /dev/dri/card* >/dev/null 2>&1 && pass "DRM device: $(ls /dev/dri/card* | tr '\n' ' ')" || fail "no /dev/dri/card* — GPU driver not loaded"
pgrep -x Xorg >/dev/null || pgrep -x labwc >/dev/null || pgrep -x wayfire >/dev/null && warn "a desktop compositor is running — KMSDRM renderer will fail to grab the display; remove SDL_VIDEODRIVER=KMSDRM from the unit" || pass "no desktop compositor (KMSDRM can own the display)"

hdr "projectM (scene 8, optional)"
if pkg-config --exists projectM-4 2>/dev/null; then pass "libprojectM $(pkg-config --modversion projectM-4)"; else note "libprojectM not installed — scene 8 shows plasma (setup/install-projectm.sh to add it)"; fi
if [ -x "$REPO/renderer/fractal" ]; then "$REPO/renderer/fractal" --version | grep -q "projectM: built in" && pass "renderer built with projectM" || note "renderer built WITHOUT projectM (re-run make after installing libprojectM)"; fi
PMDIR=$(python3 -c "import json;print(json.load(open('$CFG')).get('pm_preset_dir',''))" 2>/dev/null)
if [ -d "$PMDIR" ]; then NPM=$(find "$PMDIR" -name '*.milk' -o -name '*.prjm' | wc -l); [ "$NPM" -gt 0 ] && pass "$NPM presets in $PMDIR  (must match every other Pi + master)" || warn "preset dir $PMDIR is empty"; else note "no preset dir at $PMDIR"; fi

hdr "Services"
for svc in fractal-renderer fractal-master; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^$svc.service"; then
    ST=$(systemctl is-active $svc); EN=$(systemctl is-enabled $svc 2>/dev/null)
    [ "$ST" = active ] && pass "$svc: active ($EN)" || { [ "$svc" = fractal-master ] && warn "$svc: $ST ($EN) — fine on a renderer-only Pi" || fail "$svc: $ST ($EN) — journalctl -u $svc -n 30"; }
  else note "$svc: not installed on this Pi"; fi
done
FPS=$(journalctl -u fractal-renderer -n 200 --no-pager 2>/dev/null | grep -o '\[fps\] [0-9.]*' | tail -1 | awk '{print $2}')
if [ -n "$FPS" ]; then awk "BEGIN{exit !($FPS>=45)}" && pass "renderer fps (last log line): $FPS" || warn "renderer fps: $FPS — lower --scale / iterations"; fi
journalctl -u fractal-renderer -n 200 --no-pager 2>/dev/null | grep -q 'master acquired' && pass "renderer log shows 'master acquired'" || note "renderer log has no 'master acquired' yet"

hdr "Multicast from master ($GROUP:$PORT, listening ${LISTEN}s)"
python3 - "$GROUP" "$PORT" "$LISTEN" <<'EOF'
import socket, struct, sys, time
g, p, secs = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try: s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
except Exception: pass
s.bind(("", p)); s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, socket.inet_aton(g) + socket.inet_aton("0.0.0.0")); s.settimeout(0.5)
n = 0; first = last = None; seqs = []; src = None; t0 = time.time()
while time.time() - t0 < secs:
    try: d, a = s.recvfrom(2048)
    except socket.timeout: continue
    if d[:4] != b"FRX1": continue
    n += 1; src = a[0]; seq = struct.unpack_from("<I", d, 8)[0]; seqs.append(seq)
    first = first or time.time(); last = time.time()
G='\033[32m'; Y='\033[33m'; R='\033[31m'; N='\033[0m'
if n == 0:
    print(f"  {R}FAIL{N}  no packets from a master in {secs:.0f}s"); print("        → master not running, different subnet, IGMP snooping, or wrong interface (renderer --iface / master multicast_iface)"); sys.exit(0)
rate = (n - 1) / max(last - first, 1e-6); lost = (seqs[-1] - seqs[0] + 1) - n if len(seqs) > 1 else 0
ver, npar = struct.unpack_from("<HH", d, 4); t, beat_t, bpm = struct.unpack_from("<ddf", d, 16)
print(f"  {G}PASS{N}  {n} packets from {src} @ {rate:.1f} Hz · lost {lost} · protocol v{ver} · {npar} params · t={t:.1f}s · bpm={bpm:.1f}")
if rate < 50: print(f"  {Y}WARN{N}  rate below 60 Hz — master overloaded or network dropping")
if lost: print(f"  {Y}WARN{N}  {lost} packets missing in {secs:.0f}s — Wi-Fi? switch? (renderers smooth over it, but wired should be 0)")
EOF

hdr "Pro DJ Link traffic (udp/$PRODJ, listening ${LISTEN}s)"
python3 - "$PRODJ" "$LISTEN" <<'EOF'
import socket, struct, sys, time
p, secs = int(sys.argv[1]), float(sys.argv[2])
G='\033[32m'; Y='\033[33m'; R='\033[31m'; D='\033[2m'; N='\033[0m'
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try: s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
except Exception: pass
try: s.bind(("", p))
except OSError as e: print(f"  {Y}WARN{N}  cannot bind udp/{p}: {e} (master may hold it without SO_REUSEPORT — check the Status tab instead)"); sys.exit(0)
s.settimeout(0.5); hdr = bytes([0x51,0x73,0x70,0x74,0x31,0x57,0x6d,0x4a,0x4f,0x4c])
pk = beats = 0; decks = {}; types = {}; t0 = time.time()
while time.time() - t0 < secs:
    try: d, a = s.recvfrom(2048)
    except socket.timeout: continue
    if d[:10] != hdr: continue
    pk += 1; types[d[0x0a]] = types.get(d[0x0a], 0) + 1
    if d[0x0a] == 0x28 and len(d) >= 0x60:
        beats += 1; dev = d[0x21]; pitch = struct.unpack_from(">I", d, 0x54)[0]; bpm = struct.unpack_from(">H", d, 0x5a)[0]
        decks[dev] = (bpm / 100 * (pitch / 1048576 if pitch else 1), d[0x5c], a[0], d[0x0b:0x1f].split(b"\0")[0].decode("ascii", "replace"))
if pk == 0: print(f"  {Y}WARN{N}  no Pioneer packets — LINK cable to the same switch? same subnet (169.254.x.x vs DHCP)? (fine if no decks are connected)")
elif beats == 0: print(f"  {Y}WARN{N}  {pk} Pioneer packets but no beats — decks idle/paused? types seen: " + ", ".join(f"0x{t:02x}×{c}" for t, c in types.items()))
else:
    print(f"  {G}PASS{N}  {pk} Pioneer packets, {beats} beats in {secs:.0f}s")
    for dev, (bpm, beat, ip, name) in sorted(decks.items()): print(f"  {D}      deck {dev} ({name}, {ip}): {bpm:.2f} BPM, beat {beat}{N}")
EOF

hdr "MIDI"
if command -v aconnect >/dev/null; then
  M=$(aconnect -l 2>/dev/null | grep -v 'System\|Midi Through' | grep '^client' | sed 's/^client [0-9]*: //'); [ -n "$M" ] && pass "MIDI devices: $(echo "$M" | tr '\n' ';')" || warn "no MIDI controller connected (ok if not using one)"
else note "aconnect not installed (apt install alsa-utils) — skipping"; fi
"$REPO/master/.venv/bin/python" -c "import mido, rtmidi" 2>/dev/null && pass "mido + python-rtmidi importable in master venv" || note "mido/rtmidi not in master venv (only matters on the master)"

hdr "Audio input"
if command -v arecord >/dev/null; then
  A=$(arecord -l 2>/dev/null | grep '^card'); [ -n "$A" ] && pass "capture devices: $(echo "$A" | sed 's/, device.*//' | tr '\n' ';')" || warn "no audio capture device (ok if not using audio)"
else note "arecord not installed (apt install alsa-utils) — skipping"; fi
"$REPO/master/.venv/bin/python" -c "import sounddevice, numpy" 2>/dev/null && pass "sounddevice + numpy importable in master venv" || note "sounddevice/numpy not in master venv (only matters on the master with audio on)"

hdr "Master web UI"
HP=$(python3 -c "import json;print(json.load(open('$CFG')).get('http_port',8080))" 2>/dev/null || echo 8080)
if curl -fsS -m 2 "http://127.0.0.1:$HP/api/state" >/dev/null 2>&1; then pass "master answering on http://$(hostname -I | awk '{print $1}'):$HP/"; else note "no master on this Pi (expected on renderer-only Pis)"; fi

printf "\n%s\n" "done — FAILs block the show, WARNs are worth a look, notes are informational."
