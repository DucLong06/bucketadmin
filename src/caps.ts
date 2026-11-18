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
