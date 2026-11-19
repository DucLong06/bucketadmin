import { expect, test } from "vitest";
import { bucketNameError, folderNameError } from "./names";

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
});

test("folder names are one path segment", () => {
  for (const good of ["reports", "năm 2026", "a.b", "_folder"]) expect(folderNameError(good), good).toBeNull();
  expect(folderNameError("  ")).toMatch(/Nhập tên/);
  expect(folderNameError("a/b")).toMatch(/dấu \//);
  expect(folderNameError("..")).toMatch(/không dùng được/);
  expect(folderNameError("x".repeat(256))).toMatch(/quá dài/);
});
