// Pure helpers of the preview viewers (no React, so they are unit-tested directly).

export type PreviewKind = "text" | "json" | "csv" | "tsv" | "parquet" | "image" | "audio" | "video" | "pdf" | "hex";

const BY_EXTENSION: Record<string, PreviewKind> = {
  json: "json",
  csv: "csv",
  tsv: "tsv",
  parquet: "parquet",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  svg: "image",
  gif: "image",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  mp4: "video",
  m4v: "video",
  webm: "video",
  pdf: "pdf",
};
const TEXT = "txt log md yaml yml xml ini conf toml sh py rs js ts html css sql ndjson env properties".split(" ");

/** Which viewer fits a key, by its extension; anything unknown is shown as hex. */
export function previewKind(key: string): PreviewKind {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return BY_EXTENSION[ext] ?? (TEXT.includes(ext) ? "text" : "hex");
}

/** Text as shown by the text viewer: JSON is re-indented once the whole file is loaded and parses. */
export function displayText(kind: PreviewKind, text: string, complete: boolean): string {
  if (kind !== "json" || !complete) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Indexes of the lines containing `query`, ignoring case. An empty query matches nothing. */
export function matchingLines(lines: string[], query: string): number[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (line.toLowerCase().includes(needle)) hits.push(i);
  });
  return hits;
}

/**
 * Rows of CSV/TSV text. Quoted fields may contain the delimiter, line breaks and "" for a quote.
 * While more of the file is still to come (`complete` false) the last, possibly cut, record is left out.
 */
export function parseDelimited(text: string, delimiter: string, complete: boolean): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (complete && (field !== "" || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Classic hex dump lines: offset, 16 bytes in hex, the same bytes as ASCII. */
export function hexLines(bytes: Uint8Array, base = 0): string[] {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const slice = bytes.subarray(at, at + 16);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0"));
    const left = hex.slice(0, 8).join(" ").padEnd(23);
    const right = hex.slice(8).join(" ").padEnd(23);
    const ascii = Array.from(slice, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${(base + at).toString(16).padStart(8, "0")}  ${left}  ${right}  |${ascii}|`);
  }
  return lines;
}

/** A Parquet cell as text: nested values as JSON, null spelled out. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** "Struct(\"a\": Int32)" -> "Struct", "List(Utf8)" -> "List(Utf8)" (short types are kept whole). */
export const shortType = (type: string) => (type.length > 24 ? type.slice(0, type.indexOf("(")) || type.slice(0, 24) : type);

/** A viewer never holds more than this much of an object. */
export const PREVIEW_CAP = 20 * 1024 * 1024;

/**
 * How an object of `size` bytes is previewed without loading it whole:
 * - "full": small enough, or a viewer that only ever fetches what it shows (Parquet pages, hex chunks, streamed media);
 * - "prefix": text and tables show the beginning and offer more, up to PREVIEW_CAP;
 * - "ask": images and PDFs are fetched whole by the webview, so big ones need a click first.
 */
export function previewPlan(kind: PreviewKind, size: number): "full" | "prefix" | "ask" {
  if (size <= PREVIEW_CAP) return "full";
  if (kind === "image" || kind === "pdf") return "ask";
  if (kind === "text" || kind === "json" || kind === "csv" || kind === "tsv") return "prefix";
  return "full";
}

/** Bytes a chunked viewer may still fetch. */
export const loadableBytes = (loaded: number, size: number) => Math.max(0, Math.min(size, PREVIEW_CAP) - loaded);
