import { expect, test } from "vitest";
import { formatBytes, prettyJson, shortTime } from "./format";

test("formatBytes uses binary units", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.00 KiB");
  expect(formatBytes(1536)).toBe("1.50 KiB");
  expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MiB");
  expect(formatBytes(5 * 1024 ** 3)).toBe("5.00 GiB");
  expect(formatBytes(2 * 1024 ** 6)).toBe("2048.0 PiB");
});

test("prettyJson indents JSON and leaves other text alone", () => {
  expect(prettyJson('{"Version":"2012-10-17","Statement":[]}')).toBe('{\n  "Version": "2012-10-17",\n  "Statement": []\n}');
  expect(prettyJson("not json")).toBe("not json");
});

test("shortTime keeps date and minutes", () => {
  expect(shortTime("2026-11-18T14:45:06.641Z")).toBe("2026-11-18 14:45");
  expect(shortTime("")).toBe("");
});
