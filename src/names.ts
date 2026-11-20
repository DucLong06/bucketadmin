// Name rules checked while typing. The backend (src-tauri/src/s3/manage.rs) enforces the same ones.
import { t } from "./i18n";

/** Why `name` is not a valid S3 bucket name, or null when it is. */
export function bucketNameError(name: string): string | null {
  if (name.length < 3 || name.length > 63) return t("names.bucket.length");
  if (!/^[a-z0-9.-]+$/.test(name)) return t("names.bucket.chars");
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return t("names.bucket.ends");
  if (/\.\.|\.-|-\./.test(name)) return t("names.bucket.dots");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return t("names.bucket.ip");
  return null;
}

/** Why `name` cannot be a folder name (one path segment), or null when it can. */
export function folderNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t("names.folder.empty");
  if (trimmed.includes("/")) return t("names.folder.slash");
  if (trimmed === "." || trimmed === "..") return t("names.folder.dots");
  if (trimmed.length > 255) return t("names.folder.long");
  return null;
}
