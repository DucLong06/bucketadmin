import { expect, test } from "vitest";
import { applyLang } from "./i18n";
import { formatBytes, prettyJson, vnTime } from "./format";

test("formatBytes uses binary units; the decimal mark follows the language", () => {
  applyLang("en");
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.00 KiB");
  expect(formatBytes(1536)).toBe("1.50 KiB");
  expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MiB");
  expect(formatBytes(5 * 1024 ** 3)).toBe("5.00 GiB");
  expect(formatBytes(2 * 1024 ** 6)).toBe("2048.0 PiB");
  applyLang("vi");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1536)).toBe("1,50 KiB");
  expect(formatBytes(10 * 1024 * 1024)).toBe("10,0 MiB");
  expect(formatBytes(2 * 1024 ** 6)).toBe("2048,0 PiB");
});

test("prettyJson indents JSON and leaves other text alone", () => {
  expect(prettyJson('{"Version":"2012-10-17","Statement":[]}')).toBe('{\n  "Version": "2012-10-17",\n  "Statement": []\n}');
  expect(prettyJson("not json")).toBe("not json");
});

test("vnTime shows instants in Asia/Ho_Chi_Minh (UTC+7), whatever zone the machine is in, the same in both languages", () => {
  applyLang("en");
  expect(vnTime("2026-11-18T14:45:06.641Z", true)).toBe("2026-11-18 21:45:06");
  applyLang("vi");
  expect(vnTime("2026-11-18T14:45:06.641Z")).toBe("2026-11-18 21:45");
  expect(vnTime("2026-11-18T14:45:06.641Z", true)).toBe("2026-11-18 21:45:06");
  // Past 17:00 UTC it is already the next day in Vietnam.
  expect(vnTime("2026-12-31T17:00:00Z")).toBe("2027-01-01 00:00");
  // RGW's own formats: usage hours and bucket creation times.
  expect(vnTime("2026-11-19 08:00:00.000000Z")).toBe("2026-11-19 15:00");
  expect(vnTime("2026-11-18T03:41:15.676507Z")).toBe("2026-11-18 10:41");
  expect(vnTime("2026-11-18T03:41:15")).toBe("2026-11-18 10:41");
  expect(vnTime("2026-11-18T10:41:15+07:00")).toBe("2026-11-18 10:41");
  // Epoch milliseconds (audit rows, tasks).
  expect(vnTime(Date.UTC(2026, 10, 18, 14, 45, 6))).toBe("2026-11-18 21:45");
  expect(vnTime("")).toBe("");
  expect(vnTime("không rõ")).toBe("không rõ");
});
