#!/usr/bin/env python3
"""Fails when a tracked or new text file contains a CJK character.

Project rule: UI strings are Vietnamese/English only. Run from the repo root:
    python3 scripts/check-no-cjk.py
"""
import subprocess
import sys

# Code-point ranges (numeric on purpose, so this file passes its own check).
RANGES = [
    (0x2E80, 0x303F),  # CJK radicals, Kangxi, CJK symbols and punctuation
    (0x3040, 0x30FF),  # Hiragana, Katakana
    (0x3100, 0x312F),  # Bopomofo
    (0x3400, 0x4DBF),  # CJK extension A
    (0x4E00, 0x9FFF),  # CJK unified ideographs
    (0xAC00, 0xD7AF),  # Hangul syllables
    (0xF900, 0xFAFF),  # CJK compatibility ideographs
    (0xFF00, 0xFFEF),  # half/full-width forms
    (0x20000, 0x3FFFF),  # CJK extensions B and later
]
SKIP_SUFFIXES = (".png", ".ico", ".icns", ".lock")
SKIP_FILES = {"package-lock.json"}


def is_cjk(ch: str) -> bool:
    return any(lo <= ord(ch) <= hi for lo, hi in RANGES)


def main() -> int:
    listed = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    scanned, bad = 0, []
    for path in listed:
        if path.endswith(SKIP_SUFFIXES) or path in SKIP_FILES:
            continue
        try:
            text = open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        scanned += 1
        for number, line in enumerate(text.split("\n"), 1):
            if any(is_cjk(ch) for ch in line):
                bad.append(f"{path}:{number}: {line.strip()[:80]}")
    print(f"CJK check: {scanned} text files scanned, {len(bad)} lines with CJK characters")
    print("\n".join(bad), end="\n" if bad else "")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
