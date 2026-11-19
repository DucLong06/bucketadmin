#!/bin/bash
# UI smoke test of the real app against a real RGW. Needs RGW_ACCESS_KEY / RGW_SECRET_KEY
# (lab at http://127.0.0.1:7480), xdotool, xclip, python3 with Pillow, cargo, and a Secret Service.
# It creates throw-away data on the cluster (users ba-m3-ui-*, two buckets) and removes it again.
#   npx tauri build --debug --no-bundle
#   xvfb-run -a -s "-screen 0 1280x900x24" scripts/ui-smoke/ui-smoke.sh "$PWD/src-tauri/target/debug/bucketadmin"
# $1 = app binary (debug build: only those honour BUCKETADMIN_DEV_SCRIPT). Screenshots: /tmp/ba-smoke/*.png.
# FLOW=admin (default) runs the admin screens, FLOW=browse the S3 browse page (needs ffmpeg for the video viewer).
HERE="$(dirname "$(readlink -f "$0")")"
export TPL="$HERE/driver.tpl.js"
FLOW="${FLOW:-admin}"
export FLOW_JS="$HERE/flow-$FLOW.js"
mkdir -p /tmp/ba-smoke
# Run a private copy: the fixture below is a `cargo test`, and that rebuilds target/debug/bucketadmin
# WITHOUT the embedded frontend (a dev-server build that only shows "Could not connect to localhost").
BIN=/tmp/ba-smoke/bucketadmin-under-test
cp "${1:?usage: ui-smoke.sh <debug app binary built by tauri build --debug>}" "$BIN"
# The UI cannot create buckets, so the data it should show comes from two ignored tests.
case "$FLOW" in
  admin)
    FIXTURE_TEST=rgw_lab FIXTURE=ui_smoke_fixture STEP=10000 ENTER_AT=06-secret-once
    # Debug builds write exports (the onboarding report) here instead of ~/Downloads.
    mkdir -p /tmp/ba-smoke/dl
    rm -f /tmp/ba-smoke/dl/onboard-*.csv
    export BUCKETADMIN_DEV_SAVE_DIR=/tmp/ba-smoke/dl
    NAMES="01-users-no-cluster 02-clusters 03-users-page-1 04-users-all 04b-bulk-dry-run 04c-bulk-done 05-create-user 06-secret-once - 07-users-filter 08-drawer-info 09-suspend-confirm 10-keys 11-rotate-secret 12-add-key-validation 13-subuser-secret 14-subusers 15-caps-error 16-quota 17-usage 18-audit 19-audit-filter 20-buckets 21-bucket-drawer 22-bucket-quota-policy 23-bucket-delete-confirm 24-buckets-after-delete 25-user-buckets 26-purge-confirm 27-buckets-after-purge 28-clusters-removed"
    ;;
  browse)
    FIXTURE_TEST=s3_lab FIXTURE=ui_smoke_browse_fixture STEP=10000 ENTER_AT="05-csv 17b-copy-url"
    NAMES="01-browse-session 02-bucket-root 03-text-find 04-json 05-csv - 06-parquet 07-image 08-audio 09-video 10-pdf 11-hex 12-presign 12b-headers 12c-tags 13a-task-cancelled 13-upload-done 14-versions 15-acl 16-bucket-acl 17-search 17b-copy-url - 17c-create-bucket 17d-new-folder 17e-delete-confirm 18-readonly-denied 19-audit 20-done"
    # Files the flow uploads, and where its downloads go. Native file dialogs cannot be driven
    # under Xvfb, so debug builds take their answers from these two variables instead.
    rm -rf /tmp/ba-smoke/files /tmp/ba-smoke/dl
    mkdir -p /tmp/ba-smoke/files /tmp/ba-smoke/dl
    head -c 20971520 /dev/urandom > /tmp/ba-smoke/files/upload-20m.bin
    echo "dropped onto the window" > /tmp/ba-smoke/files/dropped.txt
    ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=2:size=320x240:rate=15 -pix_fmt yuv420p -movflags +faststart /tmp/ba-smoke/files/clip.mp4 \
      && export BA_SMOKE_MP4=/tmp/ba-smoke/files/clip.mp4
    export BUCKETADMIN_DEV_PICK_UPLOAD=/tmp/ba-smoke/files/upload-20m.bin BUCKETADMIN_DEV_SAVE_DIR=/tmp/ba-smoke/dl
    ;;
  *) echo "unknown FLOW=$FLOW (admin or browse)"; exit 2 ;;
esac
export NAMES
fixture() { (cd "$HERE/../../src-tauri" && cargo test --quiet --test "$FIXTURE_TEST" "${FIXTURE}_$1" -- --ignored --exact 2>&1 | grep -E "test result|panicked|error" | head -3); }
echo "== fixture: create"; fixture create
mkdir -p /tmp/ba-smoke
# Profiles and audit.db go to a throw-away XDG_DATA_HOME; the keychain entry is removed by the last step.
export XDG_DATA_HOME=/tmp/ba-smoke/data
rm -rf /tmp/ba-smoke/data
rm -f /tmp/ba-smoke/*.png
# One slot per screenshot; long enough for the slowest step even when the lab is slow.
export STEP="${STEP:-8000}" UID_T=ba-m1-ui
export START=$(( $(date +%s%3N) + 15000 ))
shot() {
  python3 -c "from PIL import ImageGrab; ImageGrab.grab().crop((0, 0, 1200, 800)).save('/tmp/ba-smoke/$1.png')"
  echo "screenshot: /tmp/ba-smoke/$1.png"
}
# Lab creds reach the driver through this 0600 file only; it is deleted at the end.
( umask 077; python3 - > /tmp/ba-smoke/driver.js <<'PY'
import json, os
cfg = dict(START=int(os.environ["START"]), STEP=int(os.environ["STEP"]), NAMES=os.environ["NAMES"].split(), UID=os.environ["UID_T"],
           ENDPOINT="http://127.0.0.1:7480", AK=os.environ["RGW_ACCESS_KEY"], SK=os.environ["RGW_SECRET_KEY"],
           FILES="/tmp/ba-smoke/files", MP4=bool(os.environ.get("BA_SMOKE_MP4")))
flow = open(os.environ["FLOW_JS"]).read()
print(open(os.environ["TPL"]).read().replace("    // __FLOW__", flow).replace("__CFG__", json.dumps(cfg)))
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
  if [[ " $ENTER_AT " == *" $name "* ]]; then
    # A real key press on the Copy button the flow focused: the clipboard API ignores synthetic clicks.
    xdotool key Return; sleep 0.5
    clip=$(timeout 3 xclip -o -selection clipboard 2>&1)
    if [ "$FLOW" = admin ]; then
      echo "clipboard after a real Enter on 'Copy access key': ${#clip} chars; looks like an access key: $(printf '%s' "$clip" | grep -cE '^[A-Z0-9]{20}$')"
    else
      # A presigned URL is a credential: only its path is printed, never the signature.
      echo "clipboard after a real Enter at $name: ${clip%%\?*}$([[ "$clip" == *X-Amz-Signature=* ]] && echo "?… (presigned, X-Amz-Expires=$(printf '%s' "$clip" | grep -o 'X-Amz-Expires=[0-9]*' | cut -d= -f2))")"
    fi
    shot "${name%%-*}b-copied"
  fi
done
sleep 1.5; shot 99-final
kill $APP; rm -f /tmp/ba-smoke/driver.js
echo "== fixture: remove"; fixture remove
if [ "$FLOW" = admin ]; then
  echo "== onboarding report written by the app (keys masked here; file mode $(stat -c %a /tmp/ba-smoke/dl/onboard-report-*.csv 2>/dev/null | head -1))"
  sed -E 's/,[A-Z0-9]{20},[A-Za-z0-9/+=]{40}\r?$/,<access key>,<secret key>/' /tmp/ba-smoke/dl/onboard-report-*.csv 2>/dev/null
fi
if [ "$FLOW" = browse ]; then
  echo "== files downloaded through the UI (bytes, name)"
  ls -l /tmp/ba-smoke/dl | awk 'NR > 1 { print $5, $9 }'
  cmp /tmp/ba-smoke/files/upload-20m.bin /tmp/ba-smoke/dl/upload-20m.bin \
    && echo "20 MiB file: uploaded (multipart) and downloaded again through the UI, byte-identical"
fi
echo "== profiles.json after the run"; cat /tmp/ba-smoke/data/bucketadmin/profiles.json; echo
# A flow that fails before its last step leaves its cluster profile behind; the profile file is
# throw-away, but its secret sits in the real keychain: remove exactly those entries.
for id in $(grep -o '"id": "[0-9a-f]*"' /tmp/ba-smoke/data/bucketadmin/profiles.json | cut -d'"' -f4); do
  for item in $(gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets \
      --method org.freedesktop.Secret.Service.SearchItems "{'service':'bucketadmin','username':'$id'}" \
      | grep -o "/org/freedesktop/secrets/collection/[A-Za-z0-9_/]*"); do
    gdbus call --session --dest org.freedesktop.secrets --object-path "$item" --method org.freedesktop.Secret.Item.Delete > /dev/null \
      && echo "removed the keychain entry of leftover profile $id"
  done
done
echo "== audit.db written by the app (oldest first)"
python3 - <<'PY'
import os, sqlite3
db = "/tmp/ba-smoke/data/bucketadmin/audit.db"
for action, target, detail, ok, msg in sqlite3.connect(db).execute("select action, target, detail, ok, message from audit order by id"):
    print(f"{action:15} {target:34} {'ok ' if ok else 'ERR'} {detail}{' | ' + msg if msg else ''}")
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
