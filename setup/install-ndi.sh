#!/usr/bin/env bash
# Fractal Rig — install the NDI® SDK for Linux so the renderer can publish its picture as an NDI source
# (Resolume Arena/Avenue, OBS, vMix all take NDI) and so the MASTER can take an NDI source (Resolume's
# composition) in as the LIVE stream for every projector (setup/ndi-recv). The SDK is a licence-click download, so this script
# takes the tarball YOU downloaded and puts the headers + lib where the Makefile finds them.
#
#   1. Download "NDI SDK for Linux" from https://ndi.video/for-developers/ndi-sdk/  (free, needs an email)
#   2. sudo bash setup/install-ndi.sh ~/Downloads/Install_NDI_SDK_v6_Linux.tar.gz
#   3. sudo systemctl edit fractal-renderer   →  add  --ndi  to ExecStart (or re-run install.sh with --ndi)
#   No argument = download the SDK straight from NDI's public download URL (by running that you accept
#   NDI's SDK licence, the same one you click through on the website):
#      sudo bash setup/install-ndi.sh
set -euo pipefail
TAR="${1:-}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d)
if [ -z "$TAR" ]; then
  # pick up a tarball someone already copied to the home dir first, else fetch
  TAR=$(ls -t /home/*/Install_NDI_SDK*Linux*.tar.gz ~/Install_NDI_SDK*Linux*.tar.gz 2>/dev/null | head -1 || true)
  if [ -z "$TAR" ]; then
    for url in https://downloads.ndi.tv/SDK/NDI_SDK_Linux/Install_NDI_SDK_v6_Linux.tar.gz \
               https://downloads.ndi.tv/SDK/NDI_SDK_Linux/Install_NDI_SDK_v5_Linux.tar.gz; do
      echo "== downloading $(basename "$url") (≈ 90 MB — you accept NDI's SDK licence by continuing)"
      if curl -fL --progress-bar -o "$TMP/ndi.tar.gz" "$url"; then TAR="$TMP/ndi.tar.gz"; break; fi
    done
  fi
fi
[ -n "$TAR" ] && [ -f "$TAR" ] || { echo "usage: $0 [Install_NDI_SDK_vX_Linux.tar.gz]  (download from https://ndi.video/for-developers/ndi-sdk/)"; exit 1; }
tar xzf "$TAR" -C "$TMP"
SH=$(find "$TMP" -maxdepth 1 -name "Install_NDI_SDK*.sh" | head -1)
[ -n "$SH" ] || { echo "no installer script in tarball"; exit 1; }
( cd "$TMP" && yes | PAGER=cat bash "$SH" >/dev/null )       # accepts the licence you already agreed to on download
SDK=$(find "$TMP" -maxdepth 1 -type d -name "NDI SDK for Linux*" | head -1)
[ -d "$SDK" ] || { echo "SDK dir not found after extract"; exit 1; }
ARCH=$(uname -m); case "$ARCH" in aarch64) LIBDIR="$SDK/lib/aarch64-rpi4-linux-gnueabi";; x86_64) LIBDIR="$SDK/lib/x86_64-linux-gnu";; armv7l) LIBDIR="$SDK/lib/arm-rpi4-linux-gnueabihf";; *) LIBDIR="";; esac
[ -d "$LIBDIR" ] || LIBDIR=$(find "$SDK/lib" -maxdepth 1 -type d | grep -i "$ARCH" | head -1)
[ -d "$LIBDIR" ] || { echo "no lib dir for $ARCH in $SDK/lib:"; ls "$SDK/lib"; exit 1; }
cp "$SDK"/include/*.h /usr/local/include/
cp -P "$LIBDIR"/libndi.so* /usr/local/lib/
ldconfig
echo "== NDI headers + libndi installed to /usr/local (from $(basename "$LIBDIR"))"
( cd "$REPO/renderer" && make clean >/dev/null && make -s ) && "$REPO/renderer/fractal" --version
# receiver for the master's LIVE source (Resolume → NDI → rig): master/media.py runs setup/ndi-recv
( cd "$REPO/setup" && gcc -O2 -Wall -o ndi-recv ndi-recv.c -lndi -Wl,-rpath,/usr/local/lib && echo "== built setup/ndi-recv (NDI in → LIVE stream)" )
systemctl is-active --quiet fractal-master && systemctl restart fractal-master || true
echo "== add --ndi to the renderer's ExecStart to publish:  sudo systemctl edit fractal-renderer"
echo "== NDI *in* (Resolume → projectors): Media tab → LIVE source → kind NDI"
rm -rf "$TMP"
