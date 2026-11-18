//! Response types for the RGW Admin Ops API. Every field defaults, because
//! the set of fields differs between Ceph releases.

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClusterInfo {
    pub cluster_id: String,
    /// `/admin/info` carries no version; this is the release name RGW puts in
    /// its `Server` header, e.g. "Ceph Object Gateway (squid)".
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UserInfo {
    pub tenant: String,
    pub user_id: String,
    pub display_name: String,
    pub email: String,
    /// 0 = active, 1 = suspended (RGW sends an integer).
    pub suspended: i64,
    pub max_buckets: i64,
    pub keys: Vec<KeyPair>,
    pub caps: Vec<Capability>,
    pub bucket_quota: Option<Quota>,
    pub user_quota: Option<Quota>,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct KeyPair {
    pub user: String,
    pub access_key: String,
    pub secret_key: String,
}

// Manual impl so a `{:?}` of a user never prints the secret.
impl fmt::Debug for KeyPair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyPair")
            .field("user", &self.user)
            .field("access_key", &self.access_key)
            .field("secret_key", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Capability {
    #[serde(rename = "type")]
    pub cap_type: String,
    pub perm: String,
}

/// Negative `max_size` / `max_objects` mean "unlimited".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Quota {
    pub enabled: bool,
    pub check_on_raw: bool,
    pub max_size: i64,
    pub max_size_kb: i64,
    pub max_objects: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuotaType {
    User,
    Bucket,
}

impl QuotaType {
    pub fn as_str(self) -> &'static str {
        match self {
            QuotaType::User => "user",
            QuotaType::Bucket => "bucket",
        }
    }
}

/// Fields of `POST /admin/user`; `None` leaves the value unchanged.
#[derive(Debug, Clone, Default)]
pub struct UserModify {
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub max_buckets: Option<i64>,
    pub suspended: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Usage {
    pub entries: Vec<UsageEntry>,
    pub summary: Vec<UsageSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageEntry {
    pub user: String,
    pub buckets: Vec<UsageBucket>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageBucket {
    pub bucket: String,
    pub time: String,
    pub epoch: u64,
    pub owner: String,
    pub categories: Vec<UsageStats>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageSummary {
    pub user: String,
    pub categories: Vec<UsageStats>,
    pub total: UsageStats,
}

/// Used both per category (`category` set) and for the summary total (`category` empty).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageStats {
    pub category: String,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub ops: u64,
    pub successful_ops: u64,
}
