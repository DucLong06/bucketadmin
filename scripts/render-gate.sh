#!/usr/bin/env bash
# Render gate: runs the binary packed in a .deb under Xvfb and fails unless the real UI shows up.
#   scripts/render-gate.sh bucketadmin_0.1.0~preview1_amd64.deb
# Screenshot: /tmp/ba-m2/render.png (look at it; the automatic check below is only a heuristic).
# Needs: xvfb-run, ffmpeg, dpkg-deb. Touches no real profile: app data goes to /tmp/ba-m2/data.
set -euo pipefail

OUT=/tmp/ba-m2
if [ "${1:-}" != "--inside-xvfb" ]; then
  DEB="$(readlink -f "${1:?usage: scripts/render-gate.sh <file.deb>}")"
  mkdir -p "$OUT"
  rm -rf "$OUT/root" "$OUT/data" "$OUT/render.png"
  dpkg-deb -x "$DEB" "$OUT/root"
  exec xvfb-run -a -s "-screen 0 1100x700x24" "$0" --inside-xvfb
fi

XDG_DATA_HOME="$OUT/data" "$OUT/root/usr/bin/bucketadmin" > "$OUT/app.log" 2>&1 &
APP=$!
sleep 10
if ! kill -0 "$APP" 2>/dev/null; then
  echo "RENDER GATE FAILED: the app exited within 10 s" >&2
  cat "$OUT/app.log" >&2
  exit 1
fi
ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -video_size 1100x700 -i "$DISPLAY" -frames:v 1 "$OUT/render.png"
kill "$APP"

# Heuristic for the two known bad outcomes. The UI is dark with text on it, so:
#   - a devUrl build shows a white "Could not connect" page  -> average brightness is high
#   - a window that never painted leaves the black Xvfb root -> the frame is one flat colour
# YAVG = average luma, YMIN/YMAX = darkest/brightest pixel (0-255). Revisit if the theme turns light.
STATS="$(ffmpeg -loglevel info -i "$OUT/render.png" -vf signalstats,metadata=print -f null - 2>&1)"
stat() { printf '%s\n' "$STATS" | sed -n "s/.*lavfi.signalstats.$1=\([0-9]*\).*/\1/p" | head -1; }
YAVG="$(stat YAVG)" YMIN="$(stat YMIN)" YMAX="$(stat YMAX)"
echo "screenshot: $OUT/render.png (average luma $YAVG, range $YMIN-$YMAX)"
if [ -z "$YAVG" ] || [ -z "$YMIN" ] || [ -z "$YMAX" ]; then
  echo "RENDER GATE FAILED: could not measure the screenshot" >&2
  exit 1
fi
if [ "$YAVG" -gt 128 ]; then
  echo "RENDER GATE FAILED: mostly white screen (dev-server build? see build.devUrl)" >&2
  exit 1
fi
if [ $((YMAX - YMIN)) -lt 64 ]; then
  echo "RENDER GATE FAILED: blank screen, nothing was painted" >&2
  exit 1
fi
echo "RENDER GATE PASSED"
