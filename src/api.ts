// Shapes returned by the Tauri commands (src-tauri/src/lib.rs).
export { invoke } from "@tauri-apps/api/core";

export type Profile = { id: string; label: string; endpoint: string; access_key: string };
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

/** Keeps the admin access key recognisable without showing it in full. */
export const maskKey = (key: string) => (key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key);
