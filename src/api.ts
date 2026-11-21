// Shapes returned by the Tauri commands (src-tauri/src/lib.rs).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { withNeededCaps } from "./caps";
import { t } from "./i18n";

/** Calls a backend command. An Admin API refusal comes back naming the caps the command needs. */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (e) {
    throw withNeededCaps(command, String(e));
  }
}

export type Profile = {
  id: string;
  label: string;
  endpoint: string;
  access_key: string;
  /** Access key of the personal key saved for "browse with my own key" (its secret stays in the keychain). */
  browse_access_key?: string | null;
  /** A plain user: no admin caps, so the admin screens are hidden and the Admin API is not called. */
  plain_user?: boolean;
  /** This cluster's own proxy choice; absent = follow the app-wide setting. */
  proxy?: Proxy | null;
  /** The paths this connection's key works in, "bucket" or "bucket/prefix/" each; a session lands at the first. Absent = none. */
  start_paths?: string[];
  /** S3 signing region; empty or absent = us-east-1. */
  region?: string;
  /** Path-style addressing (bucket in the path); absent = on. */
  path_style?: boolean;
};
/** How requests leave the machine: by the environment's proxy variables, always direct, or through one given proxy. */
export type Proxy = { mode: "auto" } | { mode: "none" } | { mode: "custom"; url: string };
/** What an endpoint's host looks like from this machine (backend `endpoint_kind`). */
export type EndpointKind = "private-address" | "internal-name" | "public" | "unresolved";
/** An endpoint a proxy outside the network usually cannot reach. */
export const isInternal = (kind: EndpointKind | null) => kind === "private-address" || kind === "internal-name";
export type ClusterInfo = { cluster_id: string; version: string | null };
/** `secret_key` is empty except in the response that creates the key. */
export type KeyPair = { user: string; access_key: string; secret_key: string };
export type Subuser = { id: string; permissions: string };
export type Capability = { type: string; perm: string };
export type Quota = { enabled: boolean; max_size: number; max_size_kb: number; max_objects: number };
export type UserInfo = {
  tenant: string;
  user_id: string;
  display_name: string;
  email: string;
  suspended: number;
  max_buckets?: number;
  keys: KeyPair[];
  caps: Capability[];
  subusers: Subuser[];
};
export type UsageStats = {
  category: string;
  bytes_sent: number;
  bytes_received: number;
  ops: number;
  successful_ops: number;
};
export type Usage = {
  entries: { user: string; buckets: { bucket: string; time: string; categories: UsageStats[] }[] }[];
  summary: { user: string; categories: UsageStats[]; total: UsageStats }[];
};
export type AuditEntry = {
  id: number;
  ts: number;
  cluster_id: string;
  action: string;
  target: string;
  detail: string;
  ok: boolean;
  message: string;
};

/** The uid RGW expects in requests: `tenant$uid` for tenanted users. */
export const uidOf = (u: UserInfo) => (u.tenant ? `${u.tenant}$${u.user_id}` : u.user_id);

/** Whose key a browse session signs with; the empty uid is the caller's own saved key. */
export const keyOwner = (uid: string) => (uid ? t("common.userNamed", { uid }) : t("common.you"));

/** Keeps the admin access key recognisable without showing it in full. */
export const maskKey = (key: string) => (key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key);

export type BucketUsage = { size: number; size_actual: number; num_objects: number };
export type Bucket = {
  bucket: string;
  tenant: string;
  id: string;
  owner: string;
  versioning: string;
  placement_rule: string;
  creation_time: string;
  object_lock_enabled: boolean;
  /** Stats per category; object data is under "rgw.main". Empty for an empty bucket. */
  usage: Record<string, BucketUsage>;
  bucket_quota: Quota;
};
export type BucketDetail = { info: Bucket; policy: string | null; policy_error: string | null };

/** The name the admin API addresses a bucket by: `tenant/bucket` for tenanted buckets. */
export const bucketKey = (b: Bucket) => (b.tenant ? `${b.tenant}/${b.bucket}` : b.bucket);
export const bucketSize = (b: Bucket) => b.usage["rgw.main"]?.size ?? 0;
/** Objects in every category (multipart parts included): any of them blocks a delete. */
export const bucketObjects = (b: Bucket) => Object.values(b.usage).reduce((n, u) => n + u.num_objects, 0);

export type BrowseBucket = { name: string; created: string };
/** Answer of `browse_open` and `test_s3`. `buckets_error`: S3's error code when the key may not list buckets. */
export type Opened = { access_key: string; buckets: BrowseBucket[]; buckets_error: string | null };
export type ObjectEntry = {
  key: string;
  size: number;
  last_modified: string;
  storage_class: string;
  etag: string;
  owner: string;
  /** A key whose latest version is a delete marker (shown on request in a versioned bucket); `last_modified` is then when it was deleted. */
  deleted?: boolean;
};
/** A delete marker left by a delete in a versioned bucket: removing it undoes the delete. */
export type Marker = { key: string; version: string };
export type Listing = { prefixes: string[]; objects: ObjectEntry[]; next_token: string | null };
