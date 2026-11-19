#!/usr/bin/env bash
# Render gate: runs the binary packed in a .deb under Xvfb and fails unless the real UI shows up.
#   scripts/render-gate.sh bucketadmin_0.1.0~preview1_amd64.deb
# Screenshot: /tmp/ba-m2/render.png (look at it; the automatic check below is only a heuristic).
# Needs: xvfb-run, ffmpeg, dpkg-deb; uses dbus-run-session and xwininfo when present.
# Touches no real profile: app data goes to /tmp/ba-m2/data. Logs: /tmp/ba-m2/app.log, session.log.
set -euo pipefail

OUT=/tmp/ba-m2
# How long the UI may take to appear. On a headless machine the first paint comes after about
# 25 s: with no desktop session, xdg-desktop-portal waits that long for a secrets service
# before GTK gets its answer. The first version of this gate looked once after 10 s, which
# passed on a desktop (warm session bus) and found GitHub's runner still black.
WAIT_SECS="${RENDER_GATE_WAIT:-90}"

if [ "${1:-}" != "--inside-xvfb" ]; then
  DEB="$(readlink -f "${1:?usage: scripts/render-gate.sh <file.deb>}")"
  mkdir -p "$OUT"
  rm -rf "$OUT/root" "$OUT/data" "$OUT/render.png"
  dpkg-deb -x "$DEB" "$OUT/root"
  # The screen is larger than the app window (1200x800), so a screenshot shows all of it.
  run=(xvfb-run -a -s "-screen 0 1280x900x24" "$0" --inside-xvfb)
  # A private session bus: the same conditions on a desktop as on a CI runner, and the app
  # under test never talks to the developer's real keyring or portals. The bus and the
  # services it starts are chatty on stderr; that goes to a log shown only on failure.
  if command -v dbus-run-session > /dev/null; then
    exec dbus-run-session -- "${run[@]}" 2> "$OUT/session.log"
  fi
  exec "${run[@]}" 2> "$OUT/session.log"
fi

# No GPU under Xvfb: render in software, so a missing GL driver cannot leave the webview black.
export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
XDG_DATA_HOME="$OUT/data" "$OUT/root/usr/bin/bucketadmin" > "$OUT/app.log" 2>&1 &
APP=$!

diagnose() {
  echo "--- app output"
  cat "$OUT/app.log"
  echo "--- windows on the display"
  (xwininfo -root -tree 2>&1 || echo "xwininfo is not installed") | grep -vE '^\s*$' | head -30
  echo "--- the app and its child processes"
  ps -o pid,stat,etime,args --pid "$APP" --ppid "$APP" 2>&1 | cut -c1-160 || true
  echo "--- session bus and X server messages (last 30 lines)"
  tail -30 "$OUT/session.log" 2>/dev/null || true
}

# Heuristic for the two known bad outcomes. The UI is dark with text on it, so:
#   - a devUrl build shows a white "Could not connect" page  -> average brightness is high
#   - a window that never painted leaves the black Xvfb root -> the frame is one flat colour
# YAVG = average luma, YMIN/YMAX = darkest/brightest pixel (0-255). Revisit if the theme turns light.
verdict=""
look() {
  ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -video_size 1280x900 -i "$DISPLAY" -frames:v 1 "$OUT/render.png"
  local stats
  stats="$(ffmpeg -loglevel info -i "$OUT/render.png" -vf signalstats,metadata=print -f null - 2>&1)"
  stat() { printf '%s\n' "$stats" | sed -n "s/.*lavfi.signalstats.$1=\([0-9]*\).*/\1/p" | head -1; }
  YAVG="$(stat YAVG)" YMIN="$(stat YMIN)" YMAX="$(stat YMAX)"
  if [ -z "$YAVG" ] || [ -z "$YMIN" ] || [ -z "$YMAX" ]; then
    verdict="could not measure the screenshot"
  elif [ $((YMAX - YMIN)) -lt 64 ]; then
    verdict="blank screen, nothing was painted"
  elif [ "$YAVG" -gt 128 ]; then
    verdict="mostly white screen (dev-server build? see build.devUrl)"
  else
    verdict=""
  fi
}

# Look every 3 s until the UI is there. A white page is given the same time: the real UI
# replaces a momentarily unpainted window, while a dev-server build stays white.
waited=0
while :; do
  sleep 3
  waited=$((waited + 3))
  if ! kill -0 "$APP" 2>/dev/null; then
    echo "RENDER GATE FAILED: the app exited after about $waited s"
    diagnose
    exit 1
  fi
  look
  [ -z "$verdict" ] && break
  if [ "$waited" -ge "$WAIT_SECS" ]; then
    echo "screenshot: $OUT/render.png (average luma $YAVG, range $YMIN-$YMAX)"
    echo "RENDER GATE FAILED: $verdict (still so after $waited s)"
    diagnose
    kill "$APP" 2>/dev/null || true
    exit 1
  fi
done
kill "$APP"
echo "screenshot: $OUT/render.png (average luma $YAVG, range $YMIN-$YMAX, UI up after about $waited s)"
echo "RENDER GATE PASSED"
