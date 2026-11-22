import { expect, test } from "vitest";
import { addStartPaths, isPathList, joinPath, splitPath, splitPathList, startPath } from "./paths";

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

// ---- M14.1: a pasted list of paths

test("a pasted list splits on newlines, commas, semicolons, tabs and the space between paths; each place once, in order", () => {
  expect(splitPathList("a/x/\nb/y/, c;d\te")).toEqual(["a/x/", "b/y/", "c", "d", "e"]);
  // Blank lines, stray separators and padding are nothing.
  expect(splitPathList("\n\n  a/x/ \r\n\r\n,, ;\n b \n")).toEqual(["a/x/", "b"]);
  // The s3:// form, a leading slash and a file name all land on the stored form, so repeats go.
  expect(splitPathList("s3://logs/2026 /logs/2026/\nlogs/2026/app.log, S3://logs/2026/")).toEqual(["logs/2026/"]);
  // A space splits between `bucket/...` items and before s3://, not inside a folder name.
  expect(splitPathList("a/x/ b/y/ s3://c/z")).toEqual(["a/x/", "b/y/", "c/z/"]);
  expect(splitPathList("bucket/my folder/x")).toEqual(["bucket/my folder/x/"]);
  // A bad item in the middle is kept as typed, in its place; the good ones around it are not lost.
  expect(splitPathList("a/x/\nmy bucket/\nb/..\nc")).toEqual(["a/x/", "my bucket/", "b/..", "c"]);
  expect(splitPathList("  \n ")).toEqual([]);
  expect(isPathList("a/x/\nb")).toBe(true);
  expect(isPathList("a/x/ b/y/")).toBe(true);
  expect(isPathList("bucket/my folder/x")).toBe(false);
  expect(isPathList("a/x/")).toBe(false);
});

test("every valid item of a list becomes a start path; the others are named, the valid ones never lost", () => {
  expect(addStartPaths(["logs"], "a/x/\nmy bucket/\nlogs, s3://b/y")).toEqual({ paths: ["logs", "a/x/", "b/y/"], added: 2, bad: ["my bucket/"] });
  expect(addStartPaths([], "a b/, ..")).toEqual({ paths: [], added: 0, bad: ["a b/", ".."] });
});
