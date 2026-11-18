import { expect, test } from "vitest";
import { presignSeconds } from "./presign";

test("expiry is converted to seconds and bounded to 1 s .. 7 days", () => {
  expect(presignSeconds("30", "s")).toBe(30);
  expect(presignSeconds("15", "m")).toBe(900);
  expect(presignSeconds(" 2 ", "h")).toBe(7200);
  expect(presignSeconds("168", "h")).toBe(604800);
  for (const [amount, unit] of [["0", "s"], ["169", "h"], ["-5", "m"], ["1.5", "h"], ["abc", "s"], ["", "m"]] as const) {
    expect(presignSeconds(amount, unit), `${amount}${unit}`).toBeNull();
  }
});
