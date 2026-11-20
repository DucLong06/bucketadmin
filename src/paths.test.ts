import { expect, test } from "vitest";
import { joinPath, splitPath, startPath } from "./paths";

test("a typed path splits into bucket and prefix", () => {
  expect(splitPath("bucket")).toEqual({ bucket: "bucket", prefix: "" });
  expect(splitPath("bucket/")).toEqual({ bucket: "bucket", prefix: "" });
  expect(splitPath("bucket/a/b")).toEqual({ bucket: "bucket", prefix: "a/b/" });
  expect(splitPath("bucket/a/b/")).toEqual({ bucket: "bucket", prefix: "a/b/" });
  expect(splitPath("  bucket/team/project/  ")).toEqual({ bucket: "bucket", prefix: "team/project/" });
});

test("the s3:// form and a leading slash mean the same place", () => {
  const place = { bucket: "bucket", prefix: "a/" };
  expect(splitPath("s3://bucket/a/")).toEqual(place);
  expect(splitPath("S3://bucket/a")).toEqual(place);
  expect(splitPath("/bucket/a")).toEqual(place);
  expect(splitPath("//bucket/a/")).toEqual(place);
});

test("a path that ends in a file name lands in the file's folder", () => {
  expect(splitPath("bucket/a/file.txt")).toEqual({ bucket: "bucket", prefix: "a/" });
  expect(splitPath("s3://bucket/a/b/data.parquet")).toEqual({ bucket: "bucket", prefix: "a/b/" });
  expect(splitPath("bucket/readme.md")).toEqual({ bucket: "bucket", prefix: "" });
  // A trailing slash says "folder", whatever the name looks like; a bucket name may have dots.
  expect(splitPath("bucket/a/v1.2/")).toEqual({ bucket: "bucket", prefix: "a/v1.2/" });
  expect(splitPath("my.bucket")).toEqual({ bucket: "my.bucket", prefix: "" });
  expect(splitPath("bucket/my folder/x")).toEqual({ bucket: "bucket", prefix: "my folder/x/" });
});

test("what cannot be a path is refused with the key of its message", () => {
  for (const empty of ["", "   ", "/", "s3://"]) expect(splitPath(empty), empty).toEqual({ error: "paths.empty" });
  expect(splitPath("my bucket/a/")).toEqual({ error: "paths.bucketSpace" });
  expect(splitPath("bucket/../other/")).toEqual({ error: "paths.dots" });
  expect(splitPath("bucket/a/..")).toEqual({ error: "paths.dots" });
  expect(splitPath("..")).toEqual({ error: "paths.dots" });
});

test("a start path is sent in its stored form and reads back as the same place", () => {
  expect(startPath("")).toEqual({ path: "" });
  expect(startPath("  ")).toEqual({ path: "" });
  expect(startPath("team-bucket")).toEqual({ path: "team-bucket" });
  expect(startPath(" s3://team-bucket/project-a ")).toEqual({ path: "team-bucket/project-a/" });
  expect(startPath("team bucket/x")).toEqual({ error: "paths.bucketSpace" });
  for (const stored of ["team-bucket", "team-bucket/project-a/", "team-bucket/a/v1.2/"]) {
    const split = splitPath(stored);
    expect(split.error).toBeUndefined();
    if (!split.error) expect(joinPath(split.bucket, split.prefix)).toBe(stored);
  }
});
