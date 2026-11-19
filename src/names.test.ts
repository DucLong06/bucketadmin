import { expect, test } from "vitest";
import { bucketNameError } from "./names";

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
