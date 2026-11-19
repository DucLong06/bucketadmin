// Cap types RGW accepts. adminops.rst has no list, so this was probed against the lab
// (Ceph squid 19.2.7): these 17 are accepted; "zones", "dedup", "sync", "topics", "admin" are rejected.
// Other Ceph releases may differ, which is what the custom `type=perm` field is for.
export const CAP_TYPES = [
  "users",
  "buckets",
  "usage",
  "info",
  "metadata",
  "zone",
  "ratelimit",
  "roles",
  "user-policy",
  "accounts",
  "user-info-without-keys",
  "oidc-provider",
  "bilog",
  "mdlog",
  "datalog",
  "amz-cache",
  "user",
];

// "read,write" is stored by RGW as "*".
export const CAP_PERMS = ["read", "write", "*"];

// ---- what the connected key may do (M6.2 / M6.3) ----

/** Answer of the `caller_access` command: who the cluster key belongs to and which kinds of
 *  Admin API reads RGW let through. `caps` is empty when the key may not read its own record. */
export type Access = {
  uid: string;
  caps: { type: string; perm: string }[];
  info: boolean;
  users: boolean;
  metadata: boolean;
  buckets: boolean;
  usage: boolean;
};

/** admin: every screen works. partial: an admin screen works, something is missing.
 *  self: only the caller's own info / usage. browse: no admin cap at all. */
export type Level = "admin" | "partial" | "self" | "browse";

export const LEVEL_LABEL: Record<Level, string> = {
  admin: "Admin đầy đủ",
  partial: "Thiếu caps",
  self: "Xem của mình",
  browse: "Chỉ browse",
};

/** Caps a tab needs before it can show anything. */
export const TAB_CAPS: Record<string, string[]> = {
  users: ["users=read", "metadata=read"],
  buckets: ["buckets=read"],
};

/** Everything the app can use. */
const FULL_CAPS = ["users=read", "users=write", "buckets=read", "buckets=write", "metadata=read", "usage=read", "usage=write", "info=read"];

const READ_FLAGS: Record<string, "info" | "users" | "metadata" | "buckets" | "usage"> = {
  info: "info",
  users: "users",
  metadata: "metadata",
  buckets: "buckets",
  usage: "usage",
};

/** Whether the key has `type=read` (as RGW actually answered) or `type=write` (as listed on the user). */
export function hasCap(access: Access, cap: string): boolean {
  const [type, perm] = cap.split("=");
  if (perm === "read") return READ_FLAGS[type] ? access[READ_FLAGS[type]] : false;
  // RGW stores read+write as "*".
  return access.caps.some((c) => c.type === type && (c.perm === "*" || c.perm.includes("write")));
}

export const missingCaps = (access: Access, needed: string[]) => needed.filter((cap) => !hasCap(access, cap));

/** Caps the key lacks for the whole app. */
export const missingForFull = (access: Access) => missingCaps(access, FULL_CAPS);

export function accessLevel(access: Access): Level {
  if (!access.users && !access.metadata && !access.buckets && !access.usage) return "browse";
  if (!access.metadata && !access.buckets) return "self";
  return missingForFull(access).length === 0 ? "admin" : "partial";
}

/** The command a cluster administrator runs to grant `caps` to `uid`. */
export const capsCommand = (uid: string, caps: string[]) =>
  `radosgw-admin caps add --uid=${uid || "<uid>"} --caps="${caps.join(";")}"`;
