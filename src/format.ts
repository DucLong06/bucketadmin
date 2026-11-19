const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** 1536 -> "1.5 KiB". Binary units, because RGW quotas are set in KiB. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${UNITS[unit]}`;
}

/** Re-indents JSON text for display; text that is not JSON is returned unchanged. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** "2026-11-18T14:45:06.641Z" -> "2026-11-18 14:45" (still UTC). */
export const shortTime = (iso: string) => iso.slice(0, 16).replace("T", " ");
