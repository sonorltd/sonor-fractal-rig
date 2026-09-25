#!/usr/bin/env bash
# Fractal Rig — one-shot installer for a Raspberry Pi (OS Lite or Desktop, Bookworm+).
#
#   sudo bash setup/install.sh slave              # renderer only  (projector Pi)
#   sudo bash setup/install.sh master             # renderer + master controller (projector #1 + brain)
#   sudo bash setup/install.sh slave --tile 2 2 1 0   # extra args are passed to the renderer
#
# Idempotent — re-run after `git pull` to rebuild + restart.
set -euo pipefail
ROLE="${1:-slave}"; shift || true
RENDER_ARGS="$*"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${SUDO_USER:-$(whoami)}"

echo "== Fractal Rig installer :: role=$ROLE repo=$REPO user=$USER_NAME"

echo "== apt packages"
apt-get update -qq
apt-get install -y -qq build-essential pkg-config libsdl2-dev libgles2-mesa-dev python3-venv python3-pip git alsa-utils curl
# video scene: libmpv decodes the synced clips on every Pi; ffmpeg converts uploads (master) and feeds the LIVE stream
apt-get install -y -qq libmpv-dev ffmpeg || echo "!! libmpv-dev/ffmpeg not installed — scene 9 (Video) will fall back to plasma"
if [ "$ROLE" = "master" ]; then
  apt-get install -y -qq libportaudio2 libasound2-dev libjack-dev v4l-utils || true
fi

# per-Pi runtime state: synced clips, mapping.txt, the renderer's note of where the master is
install -d -o "$USER_NAME" -g "$USER_NAME" /var/lib/fractal-rig /var/lib/fractal-rig/media

echo "== renderer build"
( cd "$REPO/renderer" && make -s )

if [ "$ROLE" = "master" ]; then
  echo "== master python venv"
  sudo -u "$USER_NAME" python3 -m venv "$REPO/master/.venv"
  sudo -u "$USER_NAME" "$REPO/master/.venv/bin/pip" install -q -r "$REPO/master/requirements.txt" || \
  sudo -u "$USER_NAME" "$REPO/master/.venv/bin/pip" install -q aiohttp python-osc mido python-rtmidi
fi

echo "== systemd units"
sed -e "s|@REPO@|$REPO|g" -e "s|@USER@|$USER_NAME|g" -e "s|@ARGS@|$RENDER_ARGS|g" \
    "$REPO/setup/systemd/fractal-renderer.service" > /etc/systemd/system/fractal-renderer.service
sed -e "s|@REPO@|$REPO|g" -e "s|@USER@|$USER_NAME|g" \
    "$REPO/setup/systemd/fractal-media-sync.service" > /etc/systemd/system/fractal-media-sync.service
if [ "$ROLE" = "master" ]; then
  sed -e "s|@REPO@|$REPO|g" -e "s|@USER@|$USER_NAME|g" \
      "$REPO/setup/systemd/fractal-master.service" > /etc/systemd/system/fractal-master.service
fi
systemctl daemon-reload

# KMSDRM needs the user in video/render/input groups; systemd-journal lets the status page show the renderer log
usermod -aG video,render,input,systemd-journal "$USER_NAME" || true

# Pi 4/5 GPU memory + no screen blanking (Lite images)
if [ -f /boot/firmware/cmdline.txt ] && ! grep -q consoleblank /boot/firmware/cmdline.txt; then
  sed -i 's/$/ consoleblank=0/' /boot/firmware/cmdline.txt
fi

# A slave is a dedicated projector Pi: if this is a Desktop image, the compositor (labwc/wayfire) owns the
# HDMI output and the KMSDRM renderer can never page-flip ("Could not queue pageflip: -13"). Boot to the
# console instead (raspi-config B2 = console + autologin). KEEP_DESKTOP=1 skips this.
if [ "$ROLE" = "slave" ] && [ -z "${KEEP_DESKTOP:-}" ] && command -v raspi-config >/dev/null \
   && [ "$(systemctl get-default 2>/dev/null)" = "graphical.target" ]; then
  echo "== desktop image detected: switching to console boot so the renderer owns the HDMI output (KEEP_DESKTOP=1 to skip)"
  raspi-config nonint do_boot_behaviour B2 || true
  NEED_REBOOT=1
fi

# enable AND restart — `enable --now` leaves an already-running renderer on the old binary/unit
systemctl enable fractal-renderer.service >/dev/null 2>&1; systemctl restart fractal-renderer.service
systemctl enable fractal-media-sync.service >/dev/null 2>&1; systemctl restart fractal-media-sync.service
if [ "$ROLE" = "master" ]; then systemctl enable fractal-master.service >/dev/null 2>&1; systemctl restart fractal-master.service; fi

echo
[ -z "${NEED_REBOOT:-}" ] || echo "!! reboot required: sudo reboot   (desktop → console so the renderer can take the screen)"
echo "== done. Useful:"
echo "   journalctl -fu fractal-renderer      # fps / packets / master status"
echo "   journalctl -fu fractal-media-sync    # clip + mapping sync from the master"
echo "   this Pi's status page:  http://$(hostname -I | awk '{print $1}'):8082/"
if [ "$ROLE" = "master" ]; then echo "   journalctl -fu fractal-master        # inputs, web UI url"; fi
if [ "$ROLE" = "master" ]; then echo "   web UI:  http://$(hostname -I | awk '{print $1}'):8080/"; fi
echo "   change renderer args:  sudo systemctl edit fractal-renderer  (or re-run this script)"
echo "   Milkdrop presets (scene 8, optional, ~15 min):  sudo bash setup/install-projectm.sh"
echo "   NDI source for Resolume/OBS (optional):          sudo bash setup/install-ndi.sh <NDI SDK tar.gz>, then add --ndi to the renderer args"
