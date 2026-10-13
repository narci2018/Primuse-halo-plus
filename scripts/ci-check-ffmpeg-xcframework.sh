#!/usr/bin/env bash
# Fail fast if the vendored FFmpeg xcframeworks lost their symlinks.
#
# Why this exists (see docs/cross-platform-plan.md §11): the macOS slices under
# primuse/Frameworks/FFmpeg/*.xcframework/macos-arm64_x86_64/ are *versioned*
# frameworks, so everything except Versions/A is a symlink. The tree was imported
# on Windows, where a plain `git add -A` turns Headers / Modules / Resources /
# Versions/Current / <binary> into 1-27 byte text files holding the link target.
# iOS never notices — its slices are flat — but PrimuseMac dies ~28 minutes into
# the build with "'libavcodec/avcodec.h' file not found". This check answers the
# same question in under a second, and says which link is wrong.
#
# Run from anywhere in the repo: it resolves paths relative to its own location.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FFMPEG_DIR="$ROOT/primuse/Frameworks/FFmpeg"
cd "$FFMPEG_DIR"

status=0
for fw in libavcodec libavformat libavutil libswresample; do
  root="$fw.xcframework/macos-arm64_x86_64/$fw.framework"
  if [ ! -d "$root" ]; then
    echo "::error::$root does not exist — the macOS slice is missing"
    status=1
    continue
  fi
  for link in Headers Modules Resources Versions/Current "$fw"; do
    if [ ! -L "$root/$link" ]; then
      echo "::error::$root/$link is not a symlink — the xcframework was committed from a filesystem without symlink support"
      status=1
    fi
  done
  # The umbrella header is not <framework>.h: avcodec/avformat/avutil drop the
  # "lib" prefix. This list must match Versions/A/Modules/module.modulemap.
  case "$fw" in
    libavcodec) umbrella="avcodec.h" ;;
    libavformat) umbrella="avformat.h" ;;
    libavutil) umbrella="avutil.h" ;;
    libswresample) umbrella="swresample.h" ;;
  esac
  if [ ! -f "$root/Headers/$umbrella" ]; then
    echo "::error::$root/Headers/$umbrella does not resolve through the Headers symlink"
    status=1
  fi
  # The framework binary reachable through Versions/Current must be a real file,
  # not the flattened text placeholder.
  if [ ! -f "$root/Versions/Current/$fw" ]; then
    echo "::error::$root/$fw is not a real Mach-O"
    status=1
  fi
done

# `git ls-files` from inside the FFmpeg dir; the repo carries exactly 20 symlink
# entries (4 frameworks x Headers/Modules/Resources/Versions/Current/<binary>).
echo "symlink-mode entries git will materialise here: $(git ls-files -s . | awk '$1=="120000"' | wc -l) (expect 20)"
echo "xcframework preflight: $([ "$status" = 0 ] && echo OK || echo FAILED)"
exit "$status"
