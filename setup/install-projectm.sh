#!/usr/bin/env bash
# Fractal Rig — build libprojectM 4 (GLES) from source + fetch Milkdrop preset packs, then rebuild
# the renderer with projectM support. Run on EVERY Pi (master included) so the preset lists match.
#
#   sudo bash setup/install-projectm.sh              # original Milkdrop pack (~550 presets, 7 MB)
#   sudo bash setup/install-projectm.sh --cream      # + Cream of the Crop (~10k presets, ~100 MB, slower to scan)
#
# Takes ~10-15 min on a Pi 5 (mostly compiling). Idempotent.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PM_TAG="${PM_TAG:-v4.1.4}"
PREFIX=/usr/local
PRESETS=$PREFIX/share/projectM/presets
TEXTURES=$PREFIX/share/projectM/textures
WANT_CREAM=0; for a in "$@"; do [ "$a" = "--cream" ] && WANT_CREAM=1; done
JOBS=$(nproc); [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 3000 ] && JOBS=2   # 2 GB Pis: don't OOM

echo "== deps"
apt-get update -qq
apt-get install -y -qq git cmake build-essential pkg-config libglm-dev libgles2-mesa-dev libegl1-mesa-dev libsdl2-dev

if pkg-config --exists projectM-4 && [ "$(pkg-config --modversion projectM-4)" = "${PM_TAG#v}" ]; then
  echo "== libprojectM $(pkg-config --modversion projectM-4) already installed"
else
  echo "== building libprojectM $PM_TAG (GLES) with $JOBS jobs — go and make a brew"
  SRC=/usr/local/src/projectm
  if [ ! -d "$SRC/.git" ]; then
    git clone --depth 1 --branch "$PM_TAG" --recursive https://github.com/projectM-visualizer/projectm.git "$SRC"
  fi
  mkdir -p "$SRC/build" && cd "$SRC/build"
  cmake .. -DCMAKE_BUILD_TYPE=Release -DENABLE_GLES=ON -DENABLE_PLAYLIST=OFF -DENABLE_SDL_UI=OFF -DBUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX=$PREFIX >/dev/null
  make -j"$JOBS"
  make install >/dev/null
  ldconfig
  echo "== installed libprojectM $(pkg-config --modversion projectM-4)"
fi

echo "== presets"
mkdir -p "$PRESETS" "$TEXTURES"
fetch_pack() {  # name repo subdir
  local name=$1 repo=$2
  if [ -d "$PRESETS/$name" ] && [ "$(find "$PRESETS/$name" -name '*.milk' | wc -l)" -gt 0 ]; then echo "   $name: present ($(find "$PRESETS/$name" -name '*.milk' | wc -l) presets)"; return; fi
  local tmp; tmp=$(mktemp -d)
  git clone -q --depth 1 "https://github.com/projectM-visualizer/$repo.git" "$tmp/p"
  mkdir -p "$PRESETS/$name"
  find "$tmp/p" -name '*.milk' -exec cp {} "$PRESETS/$name/" \;
  rm -rf "$tmp"
  echo "   $name: $(ls "$PRESETS/$name" | wc -l) presets"
}
fetch_pack original presets-milkdrop-original
[ "$WANT_CREAM" = 1 ] && fetch_pack cream presets-cream-of-the-crop
if [ -z "$(ls -A "$TEXTURES" 2>/dev/null)" ]; then
  tmp=$(mktemp -d); git clone -q --depth 1 https://github.com/projectM-visualizer/presets-milkdrop-texture-pack.git "$tmp/t"
  cp -r "$tmp/t/textures/"* "$TEXTURES/"; rm -rf "$tmp"
fi
echo "   textures: $(ls "$TEXTURES" | wc -l)"
chmod -R a+rX "$PREFIX/share/projectM"

echo "== rebuilding renderer with projectM"
( cd "$REPO/renderer" && make clean >/dev/null && make -s )
"$REPO/renderer/fractal" --version
systemctl is-active --quiet fractal-renderer && systemctl restart fractal-renderer && echo "== fractal-renderer restarted"
systemctl is-active --quiet fractal-master && systemctl restart fractal-master && echo "== fractal-master restarted (preset list re-read)"
echo
echo "done. Total presets: $(find "$PRESETS" -name '*.milk' | wc -l) — this number must be IDENTICAL on every Pi and the master."
