#!/usr/bin/env bash
# Fractal Rig — touchscreen console: boots straight into the web UI in PERFORM mode (big touch buttons).
#
#   sudo bash setup/install-kiosk.sh http://fractal-master.local:8080/?perf=1
#
# Two ways to use it:
#   A) a dedicated "console Pi" (Pi 4/5 + official 7" touchscreen or Touch Display 2) — recommended.
#      Runs on Pi OS Lite: installs cage (a one-window Wayland kiosk compositor) + Chromium, autostarts on tty1.
#   B) on the MASTER Pi itself with a touchscreen AND an HDMI projector: KMSDRM (Lite) can't share the GPU
#      between the renderer and a compositor, so use Pi OS Desktop: this script then adds an autostart
#      entry for the kiosk on the touchscreen, and you run the renderer as a normal fullscreen window on the
#      HDMI output (remove SDL_VIDEODRIVER=KMSDRM from fractal-renderer.service, add --display 1).
set -euo pipefail
URL="${1:-http://fractal-master.local:8080/?perf=1}"
USER_NAME="${SUDO_USER:-$(whoami)}"
CHROME=$(command -v chromium || command -v chromium-browser || true)
apt-get update -qq
[ -n "$CHROME" ] || { apt-get install -y -qq chromium || apt-get install -y -qq chromium-browser; CHROME=$(command -v chromium || command -v chromium-browser); }
FLAGS="--kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --check-for-update-interval=31536000 --ozone-platform=wayland --enable-features=OverlayScrollbar --touch-events=enabled --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required"
if [ -d /etc/xdg/labwc ] || command -v labwc >/dev/null || command -v wayfire >/dev/null; then
  echo "== desktop detected: adding kiosk autostart for $USER_NAME"
  HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
  mkdir -p "$HOME_DIR/.config/labwc" "$HOME_DIR/.config/wayfire" 2>/dev/null || true
  AS="$HOME_DIR/.config/labwc/autostart"; touch "$AS"; grep -q "fractal-kiosk" "$AS" || echo "$CHROME $FLAGS --app=$URL '$URL' & # fractal-kiosk" >> "$AS"
  chown -R "$USER_NAME" "$HOME_DIR/.config"
  # keep the screen on
  mkdir -p /etc/xdg/autostart; printf '[Desktop Entry]\nType=Application\nName=no-blank\nExec=sh -c "wlr-randr >/dev/null 2>&1; xset s off 2>/dev/null; xset -dpms 2>/dev/null"\n' > /etc/xdg/autostart/fractal-noblank.desktop
  echo "== done. Log out/in (or reboot); the UI opens fullscreen on the touchscreen. Renderer: sudo systemctl edit fractal-renderer → drop the KMSDRM line, add --display 1."
else
  echo "== Pi OS Lite: installing cage kiosk compositor"
  apt-get install -y -qq cage seatd
  usermod -aG video,render,input,seat "$USER_NAME" || true
  cat > /etc/systemd/system/fractal-kiosk.service <<UNIT
[Unit]
Description=Fractal Rig touchscreen console (cage + chromium kiosk)
After=systemd-user-sessions.service network-online.target
Wants=network-online.target
Conflicts=getty@tty1.service

[Service]
User=$USER_NAME
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
Environment=XDG_RUNTIME_DIR=/run/user/%U
Environment=WLR_LIBINPUT_NO_DEVICES=1
ExecStart=/usr/bin/cage -s -- $CHROME $FLAGS '$URL'
Restart=always
RestartSec=3

[Install]
WantedBy=graphical.target
UNIT
  systemctl daemon-reload; systemctl set-default graphical.target; systemctl enable --now fractal-kiosk.service || true
  grep -q consoleblank /boot/firmware/cmdline.txt 2>/dev/null || sed -i 's/$/ consoleblank=0/' /boot/firmware/cmdline.txt
  echo "== done. The console boots into $URL — tap ✕ EXIT in the top-right for the full controls, ▶ PERFORM to come back."
fi
