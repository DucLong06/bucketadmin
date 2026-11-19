import { expect, test } from "vitest";
import {
  PREVIEW_CAP,
  cellText,
  displayText,
  hexLines,
  loadableBytes,
  matchingLines,
  parseDelimited,
  previewKind,
  previewPlan,
  shortType,
} from "./parse";

test("viewer is chosen by extension, hex for the unknown", () => {
  expect(previewKind("a/b/config.YAML")).toBe("text");
  expect(previewKind("data.json")).toBe("json");
  expect(previewKind("x.csv")).toBe("csv");
  expect(previewKind("x.tsv")).toBe("tsv");
  expect(previewKind("part-0001.parquet")).toBe("parquet");
  expect(previewKind("logo.svg")).toBe("image");
  expect(previewKind("clip.MP4")).toBe("video");
  expect(previewKind("song.mp3")).toBe("audio");
  expect(previewKind("doc.pdf")).toBe("pdf");
  expect(previewKind("archive.tar.gz")).toBe("hex");
  expect(previewKind("folder.d/README")).toBe("hex"); // the dot belongs to the folder, not the file
});

test("JSON is only re-indented when complete and valid", () => {
  expect(displayText("json", '{"a":[1,2]}', true)).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
  expect(displayText("json", '{"a":[1,', false)).toBe('{"a":[1,');
  expect(displayText("json", "not json", true)).toBe("not json");
  expect(displayText("text", '{"a":1}', true)).toBe('{"a":1}');
});

test("find ignores case and reports line indexes", () => {
  const lines = ["Alpha", "beta ERROR", "gamma", "error again"];
  expect(matchingLines(lines, "error")).toEqual([1, 3]);
  expect(matchingLines(lines, "")).toEqual([]);
  expect(matchingLines(lines, "zzz")).toEqual([]);
});

test("CSV: quotes, embedded delimiters and line breaks, CRLF", () => {
  const text = 'id,name,note\r\n1,"Nguyen, An","said ""hi"""\r\n2,Binh,"two\nlines"\r\n';
  expect(parseDelimited(text, ",", true)).toEqual([
    ["id", "name", "note"],
    ["1", "Nguyen, An", 'said "hi"'],
    ["2", "Binh", "two\nlines"],
  ]);
  expect(parseDelimited("a\tb\n1\t2", "\t", true)).toEqual([["a", "b"], ["1", "2"]]);
  expect(parseDelimited("a,b\n1,", ",", true)).toEqual([["a", "b"], ["1", ""]]);
  expect(parseDelimited("", ",", true)).toEqual([]);
});

test("CSV: a record cut by the end of a chunk is held back until more is loaded", () => {
  expect(parseDelimited("a,b\n1,2\n3,", ",", false)).toEqual([["a", "b"], ["1", "2"]]);
  expect(parseDelimited('a,b\n1,"open quote\nstill', ",", false)).toEqual([["a", "b"]]);
  expect(parseDelimited("a,b\n1,2\n3,", ",", true)).toEqual([["a", "b"], ["1", "2"], ["3", ""]]);
});

test("hex dump lines", () => {
  const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0xff, 0x7f, 0x20, 0x41]);
  expect(hexLines(bytes)).toEqual(["00000000  48 65 6c 6c 6f 00 ff 7f  20 41                    |Hello... A|"]);
  const two = hexLines(new Uint8Array(17), 0x1000);
  expect(two).toHaveLength(2);
  expect(two[1].startsWith("00001010  00 ")).toBe(true);
  expect(hexLines(new Uint8Array())).toEqual([]);
});

test("Parquet cells and type labels", () => {
  expect(cellText(null)).toBe("null");
  expect(cellText(12.5)).toBe("12.5");
  expect(cellText("x")).toBe("x");
  expect(cellText(false)).toBe("false");
  expect(cellText({ shard: 1, tags: ["a"] })).toBe('{"shard":1,"tags":["a"]}');
  expect(shortType("Int64")).toBe("Int64");
  expect(shortType("List(Utf8)")).toBe("List(Utf8)");
  expect(shortType('Struct("shard": non-null Int32, "region": non-null Utf8)')).toBe("Struct");
});

test("big objects are never loaded whole", () => {
  const big = PREVIEW_CAP + 1;
  expect(previewPlan("text", PREVIEW_CAP)).toBe("full");
  for (const kind of ["text", "json", "csv", "tsv"] as const) expect(previewPlan(kind, big), kind).toBe("prefix");
  for (const kind of ["image", "pdf"] as const) expect(previewPlan(kind, big), kind).toBe("ask");
  // These fetch only what they show, whatever the size.
  for (const kind of ["parquet", "hex", "audio", "video"] as const) expect(previewPlan(kind, 500 * big), kind).toBe("full");
});

test("chunked viewers stop at the cap", () => {
  expect(loadableBytes(0, 1000)).toBe(1000);
  expect(loadableBytes(1000, 1000)).toBe(0);
  expect(loadableBytes(0, 10 * PREVIEW_CAP)).toBe(PREVIEW_CAP);
  expect(loadableBytes(PREVIEW_CAP - 5, 10 * PREVIEW_CAP)).toBe(5);
  expect(loadableBytes(PREVIEW_CAP, 10 * PREVIEW_CAP)).toBe(0);
});
