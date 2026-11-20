// Turns backend error strings into a sentence in the UI's language. The backend keeps its English
// text (src-tauri/src/rgw_admin/mod.rs `RgwError`, and fixed phrases elsewhere); its stable
// beginning is the code looked up here, and the original always stays available as `detail`.
import { t, type Key } from "./i18n";

export type Explained = {
  /** What to show, in the current language. Never the backend's own text. */
  message: string;
  /** RGW error code or HTTP status when one could be read from the text. */
  code: string | null;
  /** The untouched backend text. */
  detail: string;
  /** Admin caps the refused command needs (only for an Admin API AccessDenied). */
  caps?: string[];
};

// Codes of the Admin API with a sentence of their own (`error.rgw.<code>` in the string table).
// RGW also answers BucketAlreadyExists when asked to remove a user that still owns buckets.
const RGW_CODES = ["AccessDenied", "SignatureDoesNotMatch", "InvalidAccessKeyId", "InvalidAccessKey", "InvalidSecretKey", "InvalidKeyType", "NoSuchUser", "NoSuchSubUser", "NoSuchKey", "NoSuchBucket", "NoSuchCap", "UserAlreadyExists", "BucketAlreadyExists", "BucketNotEmpty", "KeyExists", "EmailExists", "InvalidCapability", "InvalidArgument", "QuotaExceeded", "InvalidBucketName", "MethodNotAllowed", "InternalError"];

// Errors of S3 calls made while browsing ("S3 <Code> (<status>): ..."): the key in question
// is the browsed user's (or the caller's own saved key), so the advice differs from the admin API's.
const S3_CODES = ["AccessDenied", "NoSuchBucket", "BucketAlreadyExists", "BucketAlreadyOwnedByYou", "InvalidBucketName", "TooManyBuckets", "BucketNotEmpty", "InvalidTag", "NoSuchKey", "NotFound", "NoSuchVersion", "NoSuchUpload", "PreconditionFailed", "InvalidRange", "EntityTooSmall", "MalformedACLError", "InvalidBucketState", "SignatureDoesNotMatch", "InvalidAccessKeyId"];

const known = (group: "rgw" | "s3", code: string) => ((group === "rgw" ? RGW_CODES : S3_CODES).includes(code) ? t(`error.${group}.${code}` as Key) : null);

// Fixed phrases of the app's own backend, by how they begin; the first match wins.
const PHRASES: [RegExp, Key, string][] = [
  [/^invalid proxy URL/, "error.proxyUrl", "proxy"],
  [/^keychain:/, "error.keychain", "keychain"],
  [/^cannot read this file as Parquet/, "error.parquet", "parquet"],
  [/^cannot read /, "error.fileRead", "file"],
  [/^cannot (write|create) /, "error.fileWrite", "file"],
  [/^no cluster profile/, "error.noProfile", "profile"],
  [/^cannot open the browser/, "error.browser", "browser"],
  [/^invalid bucket name/, "error.rgw.InvalidBucketName", "InvalidBucketName"],
  [/^invalid folder name/, "error.folderName", "folder"],
  [/^folder .* already exists/, "error.folderExists", "folder"],
  [/^the selection holds more than/, "error.selection", "selection"],
  [/^(an object can have at most|tag key .* is used twice)/, "error.tags", "InvalidTag"],
  [/^invalid (ACL permission|\S+ grantee)/, "error.s3.MalformedACLError", "MalformedACLError"],
  [/^presign(ed URL| expiry)/, "error.presign", "presign"],
  [/^user .* has no S3 key/, "error.noS3Key", "key"],
  [/ (is|are) required( to restore)?$/, "error.required", "required"],
  [/^(unexpected response from RGW|RGW did not|RGW returned an)/, "error.unexpected", "response"],
];

// A status a proxy in between answers with far more often than RGW itself does.
const proxyHint = (status: string) => (["407", "502", "504"].includes(status) ? ` ${t("error.proxyHint")}` : "");

export function explain(raw: string): Explained {
  const detail = raw;
  // "AccessDenied (403): ... [needs users=write]" (the tag is added by `invoke` in api.ts)
  const needs = / \[needs ([^\]]+)\]$/.exec(raw);
  if (needs) {
    const caps = needs[1].split(";");
    return { message: t("error.caps", { caps: caps.join(", ") }), code: "AccessDenied", detail, caps };
  }
  const s3 = /^S3 ([A-Za-z0-9]+) \((\d{3})\)/.exec(raw);
  if (s3) {
    const [, code, status] = s3;
    const sentence = known("s3", code) ?? (status === "403" ? t("error.s3.AccessDenied") : status === "404" ? t("error.s3.NotFound") : null);
    return { message: sentence ?? t("error.s3Http", { status, code }) + proxyHint(status), code, detail };
  }
  // "NoSuchUser (404): user does not exist"
  const named = /^([A-Za-z]+) \((\d{3})\)/.exec(raw);
  // "RGW returned HTTP 400 InvalidArgument some message" (the code can be empty)
  const http = /^RGW returned HTTP (\d{3}) ?([A-Za-z]*)/.exec(raw);
  const code = named?.[1] ?? (http?.[2] || null);
  const status = named?.[2] ?? http?.[1] ?? null;

  const sentence = code && known("rgw", code);
  if (sentence) return { message: sentence, code, detail };
  if (status === "404") return { message: t("error.notFound"), code: code ?? "404", detail };
  if (raw.startsWith("cannot reach RGW")) {
    const timedOut = /timed out|timeout/i.test(raw);
    return { message: t(timedOut ? "error.timeout" : "error.network"), code: timedOut ? "timeout" : "network", detail };
  }
  if (status) return { message: (code ? t("error.rgwHttpCode", { status, code }) : t("error.rgwHttp", { status })) + proxyHint(status), code: code ?? status, detail };
  const phrase = PHRASES.find(([begins]) => begins.test(raw));
  if (phrase) return { message: t(phrase[1]), code: phrase[2], detail };
  // Anything else: a plain sentence, with the backend's words one click away as the detail.
  return { message: t("error.unknown"), code: null, detail };
}
