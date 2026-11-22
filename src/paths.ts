// A place typed as text: "bucket", "bucket/folder/", "s3://bucket/folder/file.txt".
// The backend stores a connection's start path under the same rules (src-tauri/src/clusters.rs).
import type { Key } from "./i18n";

export type SplitPath = { bucket: string; prefix: string; error?: undefined } | { error: Key };

/** Bucket and prefix of a typed path. The prefix is "" or ends in "/"; a path that ends in a
 *  file name lands in the folder the file is in. */
export function splitPath(text: string): SplitPath {
  const path = text.trim().replace(/^s3:\/\//i, "").replace(/^\/+/, "");
  const [bucket, ...rest] = path.split("/");
  if (!bucket) return { error: "paths.empty" };
  if (/\s/.test(bucket)) return { error: "paths.bucketSpace" };
  const parts = rest.filter(Boolean);
  if (parts.includes("..") || bucket === "..") return { error: "paths.dots" };
  // shortcut: a last segment with an extension and no trailing slash is taken for a file name;
  // a folder named like one ("v1.2") needs its trailing slash. Upgrade to a HEAD if that bites.
  if (!path.endsWith("/") && /\.[A-Za-z0-9]{1,8}$/.test(parts[parts.length - 1] ?? "")) parts.pop();
  return { bucket, prefix: parts.length > 0 ? `${parts.join("/")}/` : "" };
}

/** The stored form of a place: "bucket" or "bucket/prefix/". */
export const joinPath = (bucket: string, prefix: string) => (prefix ? `${bucket}/${prefix}` : bucket);

/** A start path as the connection form sends it: "" for none, the stored form, or why it cannot be one. */
export function startPath(text: string): { path: string; error?: undefined } | { error: Key } {
  if (!text.trim()) return { path: "" };
  const split = splitPath(text);
  return split.error ? { error: split.error } : { path: joinPath(split.bucket, split.prefix) };
}

/** The start paths after `typed` is added to them: in its stored form, and not a second time. Nothing typed
 *  adds nothing; a text that cannot be a path says why and adds nothing. */
export function addStartPath(paths: string[], typed: string): { paths: string[]; error?: undefined } | { error: Key } {
  const next = startPath(typed);
  if (next.error) return next;
  return { paths: !next.path || paths.includes(next.path) ? paths : [...paths, next.path] };
}

// shortcut: a space splits only next to a "/" or before "s3://", so "bucket/my folder/x" stays one path but
// "bucket/a/file.txt bucket/b/" does not split; one path per line always works. Upgrade if lists of file paths are pasted.
const LIST_SEPARATOR = /[\n\r\t,;]+|(?<=\/)\s+|\s+(?=\/|s3:\/\/)/i;

/** The items of a pasted list of paths, in order and each place once: newlines, commas, semicolons and
 *  tabs separate them, and so does a space between `bucket/...` items. An item that is a place comes in its
 *  stored form; one that cannot be a place is kept as typed, for the caller to name. */
export function splitPathList(text: string): string[] {
  const items = text.split(LIST_SEPARATOR).map((item) => item.trim()).filter(Boolean);
  const stored = items.map((item) => {
    const at = startPath(item);
    return at.error ? item : at.path;
  });
  return [...new Set(stored)];
}

/** Whether a text is a list of paths rather than one path (Enter and paste take each of them then). */
export const isPathList = (text: string) => /[\n\r\t,;]/.test(text) || splitPathList(text).length > 1;

/** The start paths after every item of a pasted list is added to them; `bad`: the items that cannot be one. */
export function addStartPaths(paths: string[], text: string): { paths: string[]; added: number; bad: string[] } {
  let next = paths;
  const bad: string[] = [];
  for (const item of splitPathList(text)) {
    const added = addStartPath(next, item);
    if (added.error) bad.push(item);
    else next = added.paths;
  }
  return { paths: next, added: next.length - paths.length, bad };
}
