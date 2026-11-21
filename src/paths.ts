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
