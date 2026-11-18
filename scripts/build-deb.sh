#!/usr/bin/env bash
# Builds bucketadmin_<version>_amd64.deb in the repo root.
#   scripts/build-deb.sh 0.1.0~preview1
# Needs: node_modules (npm ci), Rust, the Tauri system libraries, dpkg-deb, objdump (binutils).
# Verify the result with scripts/render-gate.sh before shipping it.
set -euo pipefail

VERSION="${1:?usage: scripts/build-deb.sh <deb-version>   e.g. 0.1.0~preview1}"
if ! [[ "$VERSION" =~ ^[0-9][A-Za-z0-9.+~]*$ ]]; then
  echo "invalid Debian version: $VERSION" >&2
  exit 2
fi
ARCH=amd64
if [ "$(dpkg --print-architecture)" != "$ARCH" ]; then
  echo "this script only packages $ARCH; host is $(dpkg --print-architecture)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT"

# 1. Release binary with the frontend embedded. `tauri build` runs `npm run build` itself
#    (beforeBuildCommand) and enables tauri/custom-protocol.
if ! npx tauri build --no-bundle; then
  # Known failure mode: the CLI dies on the inotify watch limit. Same build by hand; the
  # custom-protocol feature is what keeps the binary off build.devUrl (blank window otherwise).
  echo "tauri build failed; falling back to npm run build + cargo build --features custom-protocol" >&2
  npm run build
  (cd src-tauri && cargo build --release --features custom-protocol)
fi
BIN="$ROOT/src-tauri/target/release/bucketadmin"
[ -x "$BIN" ] || { echo "release binary not found: $BIN" >&2; exit 1; }
# The binary needs a glibc at least as new as the build host's (2.39 when built on Ubuntu 24.04).
# Declaring it makes dpkg refuse older systems instead of installing an app that cannot start.
GLIBC="$(objdump -T "$BIN" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 | cut -d_ -f2)"
[ -n "$GLIBC" ] || { echo "cannot read the glibc requirement of $BIN (is binutils installed?)" >&2; exit 1; }

# 2. Package tree.
NAME="bucketadmin_${VERSION}_${ARCH}"
STAGE="$ROOT/src-tauri/target/deb/$NAME"
rm -rf "${STAGE:?}"
install -Dm755 "$BIN" "$STAGE/usr/bin/bucketadmin"
install -Dm644 packaging/bucketadmin.desktop "$STAGE/usr/share/applications/bucketadmin.desktop"
install -Dm644 src-tauri/icons/128x128.png "$STAGE/usr/share/icons/hicolor/128x128/apps/bucketadmin.png"
install -Dm644 LICENSE "$STAGE/usr/share/doc/bucketadmin/copyright"
install -d -m755 "$STAGE/DEBIAN"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: bucketadmin
Version: $VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Depends: libc6 (>= $GLIBC), libwebkit2gtk-4.1-0, libgtk-3-0
Installed-Size: $(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)
Maintainer: BucketAdmin maintainers <bucketadmin@localhost>
Description: Ceph RGW admin desktop (users, keys, caps, quotas, audit)
 Desktop application for administering Ceph RADOS Gateway through the
 Admin Ops API: users, S3 keys, capabilities, quotas, usage and a local
 audit log. Admin secrets are kept in the system keychain.
EOF

# 3. Build. A fixed timestamp makes two builds of the same commit byte-identical.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
find "$STAGE" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --build --root-owner-group "$STAGE" "$ROOT/$NAME.deb"
echo "built $ROOT/$NAME.deb"
