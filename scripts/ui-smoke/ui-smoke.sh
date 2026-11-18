#!/bin/bash
# UI smoke test of the real app against a real RGW. Needs RGW_ACCESS_KEY / RGW_SECRET_KEY
# (lab at http://127.0.0.1:7480), xdotool, xclip, python3 with Pillow, and a Secret Service.
#   cd src-tauri && cargo tauri build --debug --no-bundle && cd ..
#   xvfb-run -a -s "-screen 0 1280x900x24" scripts/ui-smoke/ui-smoke.sh "$PWD/src-tauri/target/debug/bucketadmin"
# $1 = app binary (debug build: only those honour BUCKETADMIN_DEV_SCRIPT). Screenshots: /tmp/ba-m1/*.png.
export TPL="$(dirname "$(readlink -f "$0")")/driver.tpl.js"
mkdir -p /tmp/ba-m1
# Profiles and audit.db go to a throw-away XDG_DATA_HOME; the keychain entry is removed by the last step.
export XDG_DATA_HOME=/tmp/ba-m1/data
rm -rf /tmp/ba-m1/data
rm -f /tmp/ba-m1/*.png
export STEP=5000 UID_T=ba-m1-ui
export NAMES="01-users-no-cluster 02-clusters 03-users 04-create-user 05-secret-once - 06-users-filter 07-drawer-info 08-suspend-confirm 09-keys 10-rotate-secret 11-caps 12-quota 13-usage-empty 14-audit 15-audit-filter 16-delete-confirm 17-users-after-delete 18-clusters-removed"
export START=$(( $(date +%s%3N) + 15000 ))
shot() {
  python3 -c "from PIL import ImageGrab; ImageGrab.grab().crop((0, 0, 1200, 800)).save('/tmp/ba-m1/$1.png')"
  echo "screenshot: /tmp/ba-m1/$1.png"
}
# Lab creds reach the driver through this 0600 file only; it is deleted at the end.
( umask 077; python3 - > /tmp/ba-m1/driver.js <<'PY'
import json, os
cfg = dict(START=int(os.environ["START"]), STEP=int(os.environ["STEP"]), NAMES=os.environ["NAMES"].split(), UID=os.environ["UID_T"],
           ENDPOINT="http://127.0.0.1:7480", AK=os.environ["RGW_ACCESS_KEY"], SK=os.environ["RGW_SECRET_KEY"])
print(open(os.environ["TPL"]).read().replace("__CFG__", json.dumps(cfg)))
PY
)
BUCKETADMIN_DEV_SCRIPT=/tmp/ba-m1/driver.js "$1" > /tmp/ba-m1/app.log 2>&1 &
APP=$!
for i in $(seq 1 30); do
  WID=$(xdotool search --onlyvisible --name 'BucketAdmin' 2>/dev/null | head -1)
  [ -n "$WID" ] && break
  sleep 0.5
done
if [ -z "$WID" ]; then
  echo "NO VISIBLE WINDOW"; cat /tmp/ba-m1/app.log; rm -f /tmp/ba-m1/driver.js; exit 1
fi
xdotool windowfocus "$WID"
n=0
for name in $NAMES; do
  n=$((n+1))
  sleep "$(python3 -c "import time; print(max(0, ($START + $n*$STEP - 700)/1000 - time.time()))")"
  [ "$name" = "-" ] && continue
  shot "$name"
  if [ "$name" = "05-secret-once" ]; then
    xdotool key Return; sleep 0.5
    clip=$(timeout 3 xclip -o -selection clipboard 2>&1)
    echo "clipboard after a real Enter on 'Copy access key': ${#clip} chars; looks like an access key: $(printf '%s' "$clip" | grep -cE '^[A-Z0-9]{20}$')"
    shot 05b-copied
  fi
done
sleep 1.5; shot 99-final
kill $APP; rm -f /tmp/ba-m1/driver.js
echo "== profiles.json after the run"; cat /tmp/ba-m1/data/bucketadmin/profiles.json; echo
echo "== audit.db written by the app (oldest first)"
python3 - <<'PY'
import os, sqlite3
db = "/tmp/ba-m1/data/bucketadmin/audit.db"
for action, target, detail, ok, msg in sqlite3.connect(db).execute("select action, target, detail, ok, message from audit order by id"):
    print(f"{action:13} {target:10} {'ok ' if ok else 'ERR'} {detail}{' | ' + msg if msg else ''}")
raw = open(db, "rb").read()
print("admin secret key in audit.db:", raw.count(os.environ["RGW_SECRET_KEY"].encode()), "occurrences")
PY
echo "== app stdout/stderr (libEGL noise filtered)"; grep -v 'libEGL\|DRI3' /tmp/ba-m1/app.log
