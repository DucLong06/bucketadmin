import { getLang } from "./i18n";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** 1536 -> "1.50 KiB" ("1,50 KiB" in Vietnamese: the decimal mark follows the language). Binary units, because RGW quotas are set in KiB. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = unit === 0 ? String(value) : value.toFixed(value < 10 ? 2 : 1);
  return `${getLang() === "vi" ? number.replace(".", ",") : number} ${UNITS[unit]}`;
}

/** Re-indents JSON text for display; text that is not JSON is returned unchanged. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Every time the app shows is in this zone; labels carry this suffix. */
export const TZ = "UTC+7";
const VN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * An instant as "2026-11-18 21:45" in Asia/Ho_Chi_Minh. Takes epoch milliseconds, or a UTC
 * timestamp the way S3 ("2026-11-18T14:45:06.641Z") and RGW ("2026-11-18 14:00:00.000000Z")
 * write them. Text that is not a time is returned unchanged.
 */
export function vnTime(when: string | number, seconds = false): string {
  let iso = when;
  if (typeof iso === "string") {
    // RGW: a space instead of "T" and microseconds; a time without a zone is UTC.
    iso = iso.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
    if (!/(Z|[+-]\d\d:?\d\d)$/.test(iso)) iso += "Z";
  }
  const date = new Date(iso);
  if (when === "" || Number.isNaN(date.getTime())) return String(when);
  const part = Object.fromEntries(VN.formatToParts(date).map((p) => [p.type, p.value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}${seconds ? `:${part.second}` : ""}`;
}
