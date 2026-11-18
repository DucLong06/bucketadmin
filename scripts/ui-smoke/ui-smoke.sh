#!/bin/bash
# UI smoke test of the real app against a real RGW. Needs RGW_ACCESS_KEY / RGW_SECRET_KEY
# (lab at http://127.0.0.1:7480), xdotool, xclip, python3 with Pillow, cargo, and a Secret Service.
# It creates throw-away data on the cluster (users ba-m3-ui-*, two buckets) and removes it again.
#   npx tauri build --debug --no-bundle
#   xvfb-run -a -s "-screen 0 1280x900x24" scripts/ui-smoke/ui-smoke.sh "$PWD/src-tauri/target/debug/bucketadmin"
# $1 = app binary (debug build: only those honour BUCKETADMIN_DEV_SCRIPT). Screenshots: /tmp/ba-smoke/*.png.
HERE="$(dirname "$(readlink -f "$0")")"
export TPL="$HERE/driver.tpl.js"
mkdir -p /tmp/ba-smoke
# Run a private copy: the fixture below is a `cargo test`, and that rebuilds target/debug/bucketadmin
# WITHOUT the embedded frontend (a dev-server build that only shows "Could not connect to localhost").
BIN=/tmp/ba-smoke/bucketadmin-under-test
cp "${1:?usage: ui-smoke.sh <debug app binary built by tauri build --debug>}" "$BIN"
# The UI cannot create buckets, so the data it should show comes from two ignored tests.
fixture() { (cd "$HERE/../../src-tauri" && cargo test --quiet --test rgw_lab "ui_smoke_fixture_$1" -- --ignored --exact 2>&1 | grep -E "test result|panicked|error" | head -3); }
echo "== fixture: create"; fixture create
mkdir -p /tmp/ba-smoke
# Profiles and audit.db go to a throw-away XDG_DATA_HOME; the keychain entry is removed by the last step.
export XDG_DATA_HOME=/tmp/ba-smoke/data
rm -rf /tmp/ba-smoke/data
rm -f /tmp/ba-smoke/*.png
# One slot per screenshot; long enough for the slowest step even when the lab is slow.
export STEP=8000 UID_T=ba-m1-ui
export NAMES="01-users-no-cluster 02-clusters 03-users-page-1 04-users-all 05-create-user 06-secret-once - 07-users-filter 08-drawer-info 09-suspend-confirm 10-keys 11-rotate-secret 12-add-key-validation 13-subuser-secret 14-subusers 15-caps-error 16-quota 17-usage 18-audit 19-audit-filter 20-buckets 21-bucket-drawer 22-bucket-quota-policy 23-bucket-delete-confirm 24-buckets-after-delete 25-user-buckets 26-purge-confirm 27-buckets-after-purge 28-clusters-removed"
export START=$(( $(date +%s%3N) + 15000 ))
shot() {
  python3 -c "from PIL import ImageGrab; ImageGrab.grab().crop((0, 0, 1200, 800)).save('/tmp/ba-smoke/$1.png')"
  echo "screenshot: /tmp/ba-smoke/$1.png"
}
# Lab creds reach the driver through this 0600 file only; it is deleted at the end.
( umask 077; python3 - > /tmp/ba-smoke/driver.js <<'PY'
import json, os
cfg = dict(START=int(os.environ["START"]), STEP=int(os.environ["STEP"]), NAMES=os.environ["NAMES"].split(), UID=os.environ["UID_T"],
           ENDPOINT="http://127.0.0.1:7480", AK=os.environ["RGW_ACCESS_KEY"], SK=os.environ["RGW_SECRET_KEY"])
print(open(os.environ["TPL"]).read().replace("__CFG__", json.dumps(cfg)))
PY
)
BUCKETADMIN_DEV_SCRIPT=/tmp/ba-smoke/driver.js "$BIN" > /tmp/ba-smoke/app.log 2>&1 &
APP=$!
for i in $(seq 1 30); do
  WID=$(xdotool search --onlyvisible --name 'BucketAdmin' 2>/dev/null | head -1)
  [ -n "$WID" ] && break
  sleep 0.5
done
if [ -z "$WID" ]; then
  echo "NO VISIBLE WINDOW"; cat /tmp/ba-smoke/app.log; rm -f /tmp/ba-smoke/driver.js; exit 1
fi
xdotool windowfocus "$WID"
n=0
for name in $NAMES; do
  n=$((n+1))
  sleep "$(python3 -c "import time; print(max(0, ($START + $n*$STEP - 700)/1000 - time.time()))")"
  [ "$name" = "-" ] && continue
  shot "$name"
  if [ "$name" = "06-secret-once" ]; then
    xdotool key Return; sleep 0.5
    clip=$(timeout 3 xclip -o -selection clipboard 2>&1)
    echo "clipboard after a real Enter on 'Copy access key': ${#clip} chars; looks like an access key: $(printf '%s' "$clip" | grep -cE '^[A-Z0-9]{20}$')"
    shot 06b-copied
  fi
done
sleep 1.5; shot 99-final
kill $APP; rm -f /tmp/ba-smoke/driver.js
echo "== fixture: remove"; fixture remove
echo "== profiles.json after the run"; cat /tmp/ba-smoke/data/bucketadmin/profiles.json; echo
echo "== audit.db written by the app (oldest first)"
python3 - <<'PY'
import os, sqlite3
db = "/tmp/ba-smoke/data/bucketadmin/audit.db"
for action, target, detail, ok, msg in sqlite3.connect(db).execute("select action, target, detail, ok, message from audit order by id"):
    print(f"{action:13} {target:10} {'ok ' if ok else 'ERR'} {detail}{' | ' + msg if msg else ''}")
raw = open(db, "rb").read()
print("admin secret key in audit.db:", raw.count(os.environ["RGW_SECRET_KEY"].encode()), "occurrences")
PY
echo "== app stdout/stderr (libEGL noise filtered)"; grep -v 'libEGL\|DRI3' /tmp/ba-smoke/app.log
# The driver ends with a banner in the bottom-left corner: green = every step passed in time,
# orange = all steps passed but some finished after their screenshot was taken, red = a step failed.
python3 - <<'PY'
import sys
from PIL import Image
r, g, b = Image.open("/tmp/ba-smoke/99-final.png").convert("RGB").getpixel((4, 794))
if g > 240 and r < 200:
    verdict, code = "DONE", 0
elif r > 240 and 180 <= g <= 230:
    verdict, code = "DONE, BUT LATE: some screenshots were taken before their step finished (see the banner in 99-final.png)", 2
elif r > 240:
    verdict, code = "ERROR (see the banner in 99-final.png)", 1
else:
    verdict, code = "NO BANNER (driver did not finish)", 1
print("== driver verdict:", verdict)
sys.exit(code)
PY
