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
if [ "$ROLE" = "master" ]; then
  apt-get install -y -qq libportaudio2 libasound2-dev libjack-dev || true
fi

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
if [ "$ROLE" = "master" ]; then
  sed -e "s|@REPO@|$REPO|g" -e "s|@USER@|$USER_NAME|g" \
      "$REPO/setup/systemd/fractal-master.service" > /etc/systemd/system/fractal-master.service
fi
systemctl daemon-reload

# KMSDRM needs the user in video/render/input groups
usermod -aG video,render,input "$USER_NAME" || true

# Pi 4/5 GPU memory + no screen blanking (Lite images)
if [ -f /boot/firmware/cmdline.txt ] && ! grep -q consoleblank /boot/firmware/cmdline.txt; then
  sed -i 's/$/ consoleblank=0/' /boot/firmware/cmdline.txt
fi

systemctl enable --now fractal-renderer.service
if [ "$ROLE" = "master" ]; then systemctl enable --now fractal-master.service; fi

echo
echo "== done. Useful:"
echo "   journalctl -fu fractal-renderer      # fps / packets / master status"
if [ "$ROLE" = "master" ]; then echo "   journalctl -fu fractal-master        # inputs, web UI url"; fi
if [ "$ROLE" = "master" ]; then echo "   web UI:  http://$(hostname -I | awk '{print $1}'):8080/"; fi
echo "   change renderer args:  sudo systemctl edit fractal-renderer  (or re-run this script)"
echo "   Milkdrop presets (scene 8, optional, ~15 min):  sudo bash setup/install-projectm.sh"
echo "   NDI source for Resolume/OBS (optional):          sudo bash setup/install-ndi.sh <NDI SDK tar.gz>, then add --ndi to the renderer args"
