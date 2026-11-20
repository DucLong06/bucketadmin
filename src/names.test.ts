import { beforeEach, expect, test } from "vitest";
import { applyLang } from "./i18n";
import { bucketNameError, folderNameError } from "./names";

beforeEach(() => applyLang("vi"));

test("bucket names follow the S3 rules", () => {
  for (const good of ["abc", "my-bucket", "logs.2026.archive", "a1b", "0bucket9", "a".repeat(63)]) {
    expect(bucketNameError(good), good).toBeNull();
  }
  expect(bucketNameError("ab")).toMatch(/3 đến 63/);
  expect(bucketNameError("a".repeat(64))).toMatch(/3 đến 63/);
  expect(bucketNameError("My-Bucket")).toMatch(/chữ thường/);
  expect(bucketNameError("under_score")).toMatch(/chữ thường/);
  expect(bucketNameError("-start")).toMatch(/bắt đầu/);
  expect(bucketNameError("end-")).toMatch(/bắt đầu/);
  expect(bucketNameError("two..dots")).toMatch(/Dấu chấm/);
  expect(bucketNameError("dot.-dash")).toMatch(/Dấu chấm/);
  expect(bucketNameError("192.168.1.10")).toMatch(/địa chỉ IP/);
  applyLang("en");
  expect(bucketNameError("ab")).toBe("A bucket name is 3 to 63 characters long.");
  expect(bucketNameError("My-Bucket")).toMatch(/lowercase/);
});

test("folder names are one path segment", () => {
  for (const good of ["reports", "năm 2026", "a.b", "_folder"]) expect(folderNameError(good), good).toBeNull();
  expect(folderNameError("  ")).toMatch(/Nhập tên/);
  expect(folderNameError("a/b")).toMatch(/dấu \//);
  expect(folderNameError("..")).toMatch(/không dùng được/);
  expect(folderNameError("x".repeat(256))).toMatch(/quá dài/);
  applyLang("en");
  expect(folderNameError("a/b")).toBe("A folder name cannot contain a /.");
});
