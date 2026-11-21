#!/bin/bash
# UI smoke test of the real app against a real RGW: the whole app, end to end, as a user who
# only has an S3 key. Needs RGW_ACCESS_KEY / RGW_SECRET_KEY (lab at http://127.0.0.1:7480),
# xdotool, xclip, ffmpeg, python3 with Pillow, cargo, and a Secret Service.
# The app starts with 20 made-up saved connections (many connections is the normal case to test).
# It creates throw-away data on the cluster (users ba-m4-ui*, their buckets: two for the flow and
# 32 empty ones for the bucket list) and removes it again.
#   npx tauri build --debug --no-bundle
#   xvfb-run -a -s "-screen 0 1280x900x24" scripts/ui-smoke/ui-smoke.sh "$PWD/src-tauri/target/debug/bucketadmin"
# $1 = app binary (debug build: only those honour BUCKETADMIN_DEV_SCRIPT). Screenshots: /tmp/ba-smoke/*.png.
# UI_LANG=vi|en (default vi): the language the app runs in. The same flow passes in both.
HERE="$(dirname "$(readlink -f "$0")")"
export TPL="$HERE/driver.tpl.js" FLOW_JS="$HERE/flow-browse.js"
mkdir -p /tmp/ba-smoke
export UI_LANG="${UI_LANG:-vi}"
case "$UI_LANG" in vi|en) ;; *) echo "UI_LANG must be vi or en, not '$UI_LANG'"; exit 1 ;; esac
# The flow names every text by its key in the app's string table, so the driver gets that
# language's table. Node 23.6+ runs the .ts file as it is (built-in type stripping).
node -e "import('$HERE/../../src/i18n/strings.ts').then((m) => process.stdout.write(JSON.stringify(m[process.env.UI_LANG])))" > /tmp/ba-smoke/strings.json \
  || { echo "cannot read src/i18n/strings.ts with node (23.6 or newer is needed)"; exit 1; }
# Run a private copy: the fixture below is a `cargo test`, and that rebuilds target/debug/bucketadmin
# WITHOUT the embedded frontend (a dev-server build that only shows "Could not connect to localhost").
BIN=/tmp/ba-smoke/bucketadmin-under-test
cp "${1:?usage: ui-smoke.sh <debug app binary built by tauri build --debug>}" "$BIN"
# One slot per `shot(...)` of the flow, in its order; the shell and the driver walk them together.
export NAMES="$(grep -oE 'await shot\("[^"]+"\)' "$FLOW_JS" | sed -E 's/.*"(.*)".*/\1/' | tr '\n' ' ')"
# Slots at which the shell presses a real Enter (the clipboard ignores synthetic clicks).
ENTER_AT="06-csv 28-copy-url"
# Slots at which the shell presses a real Ctrl+D (a synthetic key event does not prove a shortcut).
CTRL_D_AT="38-ctrl-d"
# Debug builds take GitHub's "latest release" answer from here: the flow sees a newer release.
export BUCKETADMIN_DEV_UPDATE='{"tag_name":"v9.9.9","html_url":"https://github.com/DucLong06/bucketadmin/releases/tag/v9.9.9"}'
# Files the flow uploads, and where its downloads go. Native file dialogs cannot be driven
# under Xvfb, so debug builds take their answers from these two variables instead.
rm -rf /tmp/ba-smoke/files /tmp/ba-smoke/dl
mkdir -p /tmp/ba-smoke/files /tmp/ba-smoke/dl
head -c 20971520 /dev/urandom > /tmp/ba-smoke/files/upload-20m.bin
echo "dropped onto the window" > /tmp/ba-smoke/files/dropped.txt
ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=2:size=320x240:rate=15 -pix_fmt yuv420p -movflags +faststart /tmp/ba-smoke/files/clip.mp4 \
  && export BA_SMOKE_MP4=/tmp/ba-smoke/files/clip.mp4
export BUCKETADMIN_DEV_PICK_UPLOAD=/tmp/ba-smoke/files/upload-20m.bin BUCKETADMIN_DEV_SAVE_DIR=/tmp/ba-smoke/dl
# The UI needs data to show; it comes from two ignored tests.
fixture() { (cd "$HERE/../../src-tauri" && cargo test --quiet --test s3_lab "ui_smoke_browse_fixture_$1" -- --ignored --exact 2>&1 | grep -E "test result|panicked|error" | head -3); }
echo "== fixture: create"; fixture create
# Profiles, settings and audit.db go to a throw-away XDG_DATA_HOME; the keychain entries are removed by the last step.
export XDG_DATA_HOME=/tmp/ba-smoke/data
rm -rf /tmp/ba-smoke/data
# The app starts in the language under test (everything else in settings.json has a default).
mkdir -p "$XDG_DATA_HOME/bucketadmin"
echo "{\"lang\": \"$UI_LANG\"}" > "$XDG_DATA_HOME/bucketadmin/settings.json"
# Many connections from the first second: 20 saved profiles with made-up endpoints and key ids (no
# secret exists for them anywhere), two of them under the same label. The flow adds its real ones.
python3 - > "$XDG_DATA_HOME/bucketadmin/profiles.json" <<'PY'
import json
print(json.dumps([{"id": f"seed{n:02}", "label": f"site-{1 if n == 20 else n:02}", "endpoint": f"http://s3-{n:02}.example.invalid:7480",
                   "access_key": f"AKIAEXAMPLE{n:09}"} for n in range(1, 21)], indent=2))
PY
rm -f /tmp/ba-smoke/*.png
# Long enough for the slowest step even when the lab is slow.
export STEP="${STEP:-10000}"
export START=$(( $(date +%s%3N) + 15000 ))
shot() {
  python3 -c "from PIL import ImageGrab; ImageGrab.grab().crop((0, 0, 1200, 800)).save('/tmp/ba-smoke/$1.png')"
  echo "screenshot: /tmp/ba-smoke/$1.png"
}
# Lab creds reach the driver through this 0600 file only; it is deleted at the end.
( umask 077; python3 - > /tmp/ba-smoke/driver.js <<'PY'
import json, os
cfg = dict(START=int(os.environ["START"]), STEP=int(os.environ["STEP"]), NAMES=os.environ["NAMES"].split(),
           ENDPOINT="http://127.0.0.1:7480", AK=os.environ["RGW_ACCESS_KEY"], SK=os.environ["RGW_SECRET_KEY"],
           FILES="/tmp/ba-smoke/files", MP4=bool(os.environ.get("BA_SMOKE_MP4")),
           LANG=os.environ["UI_LANG"], STR=json.load(open("/tmp/ba-smoke/strings.json")))
flow = open(os.environ["FLOW_JS"]).read()
print(open(os.environ["TPL"]).read().replace("    // __FLOW__", flow).replace("__CFG__", json.dumps(cfg)))
PY
)
# TZ=UTC: the app must show Vietnam time (UTC+7) whatever zone the machine is in; the flow checks it.
TZ=UTC BUCKETADMIN_DEV_SCRIPT=/tmp/ba-smoke/driver.js "$BIN" > /tmp/ba-smoke/app.log 2>&1 &
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
# WINDOW=1100x700 runs the same flow in a smaller window; the flow checks that nothing scrolls sideways.
[ -n "${WINDOW:-}" ] && xdotool windowsize "$WID" "${WINDOW%x*}" "${WINDOW#*x}"
n=0
for name in $NAMES; do
  n=$((n+1))
  sleep "$(python3 -c "import time; print(max(0, ($START + $n*$STEP - 700)/1000 - time.time()))")"
  [ "$name" = "-" ] && continue
  shot "$name"
  if [[ " $ENTER_AT " == *" $name "* ]]; then
    # A real key press on the Copy button the flow focused.
    xdotool key Return; sleep 0.5
    clip=$(timeout 3 xclip -o -selection clipboard 2>&1)
    # A presigned URL is a credential: only its path is printed, never the signature.
    echo "clipboard after a real Enter at $name: ${clip%%\?*}$([[ "$clip" == *X-Amz-Signature=* ]] && echo "?… (presigned, X-Amz-Expires=$(printf '%s' "$clip" | grep -o 'X-Amz-Expires=[0-9]*' | cut -d= -f2))")"
    shot "${name}-copied"
  fi
  if [[ " $CTRL_D_AT " == *" $name "* ]]; then
    xdotool key ctrl+d; sleep 0.8
    shot "${name}-pressed"
  fi
done
sleep 1.5; shot 99-final
kill $APP; rm -f /tmp/ba-smoke/driver.js
echo "== fixture: remove"; fixture remove
echo "== files downloaded through the UI (bytes, name)"
ls -l /tmp/ba-smoke/dl | awk 'NR > 1 { print $5, $9 }'
cmp /tmp/ba-smoke/files/upload-20m.bin /tmp/ba-smoke/dl/upload-20m.bin \
  && echo "20 MiB file: uploaded (multipart) and downloaded again through the UI, byte-identical"
echo "== profiles.json and settings.json after the run"; cat /tmp/ba-smoke/data/bucketadmin/profiles.json; echo
python3 - <<'PY'
import json
s = json.load(open("/tmp/ba-smoke/data/bucketadmin/settings.json"))
print("settings.json: lang", s.get("lang"), "| ui_scale", s.get("ui_scale"), "| proxy", s.get("proxy"), "| update tag", (s.get("update") or {}).get("tag"),
      "| recent places left", len(s.get("recent", [])), "| pins left", len(s.get("pins", [])), "| tabs saved", len((s.get("tabs") or {}).get("tabs", [])))
PY
# A flow that fails before its last step leaves its connections behind; the profile file is
# throw-away, but the secrets sit in the real keychain: remove exactly those entries.
for id in $(grep -o '"id": "[0-9a-f]*"' /tmp/ba-smoke/data/bucketadmin/profiles.json | cut -d'"' -f4); do
  for user in "$id" "$id.browse"; do
    for item in $(gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets \
        --method org.freedesktop.Secret.Service.SearchItems "{'service':'bucketadmin','username':'$user'}" \
        | grep -o "/org/freedesktop/secrets/collection/[A-Za-z0-9_/]*"); do
      gdbus call --session --dest org.freedesktop.secrets --object-path "$item" --method org.freedesktop.Secret.Item.Delete > /dev/null \
        && echo "removed the keychain entry of leftover connection $user"
    done
  done
done
# The audit log has no screen any more; it is still written for every change made while browsing.
echo "== audit.db written by the app (oldest first)"
python3 - <<'PY'
import os, sqlite3, sys
db = "/tmp/ba-smoke/data/bucketadmin/audit.db"
seen = []
for action, target, detail, ok, msg in sqlite3.connect(db).execute("select action, target, detail, ok, message from audit order by id"):
    seen.append(action)
    print(f"{action:21} {target:36} {'ok ' if ok else 'ERR'} {detail}{' | ' + msg if msg else ''}")
raw = open(db, "rb").read()
print("admin secret key in audit.db:", raw.count(os.environ["RGW_SECRET_KEY"].encode()), "occurrences")
print("keys typed in by the flow in audit.db:", raw.count(b"bam7uismokesecret") + raw.count(b"BAM7UISMOKEKEY"), "occurrences")
expected = ["object.presign", "object.tags.set", "object.upload", "version.restore", "version.delete", "acl.set", "acl.set_many",
            "object.delete", "object.delete_many", "object.undelete", "bucket.create", "folder.create", "bucket.versioning.set"]
missing = [a for a in expected if a not in seen]
print("audit actions expected from this flow but not recorded:", missing or "none")
open("/tmp/ba-smoke/audit-missing.txt", "w").write(" ".join(missing))
PY
echo "== app stdout/stderr (libEGL noise filtered)"; grep -v 'libEGL\|DRI3' /tmp/ba-smoke/app.log
# The driver ends with a banner in the bottom-left corner: green = every step passed in time,
# orange = all steps passed but some finished after their screenshot was taken, red = a step failed.
python3 - <<'PY'
import os, sys
from PIL import Image
# The banner sits at the bottom of the window: 800 px high unless WINDOW says otherwise.
height = int((os.environ.get("WINDOW") or "x800").split("x")[1])
r, g, b = Image.open("/tmp/ba-smoke/99-final.png").convert("RGB").getpixel((4, height - 6))
missing = open("/tmp/ba-smoke/audit-missing.txt").read().strip()
if g > 240 and r < 200:
    verdict, code = "DONE", 0
elif r > 240 and 180 <= g <= 230:
    verdict, code = "DONE, BUT LATE: some screenshots were taken before their step finished (see the banner in 99-final.png)", 2
elif r > 240:
    verdict, code = "ERROR (see the banner in 99-final.png)", 1
else:
    verdict, code = "NO BANNER (driver did not finish)", 1
if code == 0 and missing:
    verdict, code = f"DONE, BUT the audit log lacks: {missing}", 1
print("== driver verdict:", verdict)
sys.exit(code)
PY
