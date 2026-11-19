#!/usr/bin/env python3
"""Renders the icon master (src-tauri/icons/icon.svg) into every size the app ships.

    python3 scripts/gen-icons.py            # write the files
    python3 scripts/gen-icons.py --check    # fail if a committed file is not what the SVG gives

Writes, in src-tauri/icons/: <N>x<N>.png for N in SIZES (the hicolor sizes the .deb installs),
128x128@2x.png and icon.png (what tauri.conf.json lists), icon.ico; and public/favicon.ico
for the webview. Needs google-chrome (the SVG renderer) and Pillow.
"""
import hashlib, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
SVG = ICONS / "icon.svg"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
MASTER = 1024
RESAMPLE = getattr(getattr(Image, "Resampling", Image), "LANCZOS")


def render_master() -> Image.Image:
    """The SVG at 1024 px with a transparent background (the tile's corners stay see-through)."""
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "icon.html"
        shot = Path(tmp) / "icon.png"
        # A page around the SVG pins its size; opened directly, Chrome scales an SVG to the window its own way.
        page.write_text(
            f'<body style="margin:0;background:transparent"><img src="{SVG.as_uri()}" width="{MASTER}" height="{MASTER}" style="display:block">'
        )
        subprocess.run(
            ["google-chrome", "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--default-background-color=00000000",
             f"--user-data-dir={tmp}/profile", f"--window-size={MASTER},{MASTER}", f"--screenshot={shot}", page.as_uri()],
            check=True, capture_output=True, timeout=120,
        )
        image = Image.open(shot).convert("RGBA")
        image.load()
    assert image.size == (MASTER, MASTER), image.size
    # Self-check: the corners are outside the rounded tile, the centre is inside it.
    assert image.getpixel((2, 2))[3] == 0, "corner should be transparent"
    assert image.getpixel((MASTER // 2, MASTER - 40))[3] == 255, "tile should be opaque"
    return image


def outputs(master: Image.Image) -> dict[Path, bytes]:
    """Every file this script owns, as bytes."""
    with tempfile.TemporaryDirectory() as tmp:
        def png(size: int) -> bytes:
            out = Path(tmp) / f"{size}.png"
            master.resize((size, size), RESAMPLE).save(out, optimize=True)
            return out.read_bytes()

        def ico(sizes) -> bytes:
            out = Path(tmp) / "icon.ico"
            master.save(out, format="ICO", sizes=[(s, s) for s in sizes])
            return out.read_bytes()

        files = {ICONS / f"{s}x{s}.png": png(s) for s in SIZES}
        files[ICONS / "128x128@2x.png"] = files[ICONS / "256x256.png"]
        files[ICONS / "icon.png"] = files[ICONS / "512x512.png"]
        files[ICONS / "icon.ico"] = ico((16, 24, 32, 48, 64, 256))
        files[ROOT / "public" / "favicon.ico"] = ico((16, 32, 48))
        return files


def main() -> int:
    files = outputs(render_master())
    if "--check" in sys.argv:
        stale = [p for p, data in files.items() if not p.exists() or p.read_bytes() != data]
        for p in stale:
            print("differs from what icon.svg renders to:", p.relative_to(ROOT))
        return 1 if stale else 0
    for p, data in files.items():
        p.write_bytes(data)
        print(f"{p.relative_to(ROOT)}  {len(data)} bytes  sha256 {hashlib.sha256(data).hexdigest()[:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
