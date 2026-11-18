import { expect, test } from "vitest";
import { accessKeyError, secretKeyError } from "./keys";

test("access key: 16-128 alphanumeric characters", () => {
  expect(accessKeyError("M7A45NTMDNLPNRYB985H")).toBeNull();
  expect(accessKeyError("a".repeat(16))).toBeNull();
  for (const bad of ["", "short", "has space in the middle1", "with-dash-0123456789", "a".repeat(129), " M7A45NTMDNLPNRYB985H"]) {
    expect(accessKeyError(bad), bad).not.toBeNull();
  }
});

test("secret key: 32-128 characters from the base64 alphabet", () => {
  expect(secretKeyError("0AbCDEFg1h2i34JklM5nop6QrSTUV+WxyzaBC7D8")).toBeNull();
  expect(secretKeyError("abc/def+ghi=".repeat(3))).toBeNull();
  for (const bad of ["", "tooshort", "x".repeat(31), "x".repeat(129), "has space ".repeat(4), "quote\"".repeat(8)]) {
    expect(secretKeyError(bad), bad).not.toBeNull();
  }
});
