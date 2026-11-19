//! Admin operations as the UI calls them. Every mutation is written to the
//! audit log, and secret keys are stripped from every response except the one
//! that creates them (a secret is shown exactly once).

use crate::audit::Audit;
use crate::rgw_admin::{
    BucketInfo, Capability, HttpClient, KeyPair, Quota, QuotaType, ReqwestClient, RgwAdmin,
    RgwError, Subuser, Usage, UserIdPage, UserInfo, UserModify,
};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};

/// `get_user` calls in flight while loading the user list.
const USER_FETCH_CONCURRENCY: usize = 4;
/// Upper bound for one page of the user list, whatever the caller asks for.
const MAX_USERS_PAGE: usize = 1000;

pub struct Ops<'a, H = ReqwestClient> {
    pub admin: RgwAdmin<H>,
    pub audit: &'a Audit,
    pub cluster_id: String,
}

#[derive(Debug, Serialize)]
pub struct Quotas {
    pub user: Quota,
    pub bucket: Quota,
}

#[derive(Debug, Serialize)]
pub struct RotatedKey {
    /// The new key, secret included (shown once).
    pub key: KeyPair,
    /// Set when the new key exists but the old one could not be removed.
    pub remove_error: Option<String>,
}

/// One line of an onboarding file.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OnboardRow {
    pub uid: String,
    pub display_name: String,
    #[serde(default)]
    pub email: String,
    /// Admin caps to grant, each as `type=perm`.
    #[serde(default)]
    pub caps: Vec<String>,
    /// User quota (total size) in KiB; `None` leaves the quota off.
    #[serde(default)]
    pub quota_kb: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct OnboardResult {
    pub uid: String,
    /// `would_create` (dry run), `exists` (left untouched), `created`, or `error`.
    pub status: &'static str,
    pub message: String,
    /// The new user's key pair: only for `created`, and for an `error` that happened after the
    /// user was created. This is the one time the secret leaves the backend.
    pub access_key: String,
    pub secret_key: String,
}

impl OnboardResult {
    fn new(
        row: &OnboardRow,
        status: &'static str,
        message: impl Into<String>,
        key: Option<&KeyPair>,
    ) -> Self {
        Self {
            uid: row.uid.clone(),
            status,
            message: message.into(),
            access_key: key.map(|k| k.access_key.clone()).unwrap_or_default(),
            secret_key: key.map(|k| k.secret_key.clone()).unwrap_or_default(),
        }
    }
}

/// Checks one onboarding row before anything is sent.
pub fn validate_onboard_row(row: &OnboardRow) -> Result<(), String> {
    let uid_ok = !row.uid.is_empty()
        && row.uid.len() <= 128
        && !row.uid.chars().any(|c| c.is_whitespace() || c.is_control());
    if !uid_ok {
        return Err(format!("invalid uid {:?}: required, no spaces", row.uid));
    }
    if row.display_name.trim().is_empty() {
        return Err("display name is required".into());
    }
    for cap in &row.caps {
        validate_cap(cap)?;
    }
    if row.quota_kb.is_some_and(|kb| kb <= 0) {
        return Err("quota must be greater than zero".into());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct UsageSupport {
    pub supported: bool,
    /// Backend error that made the probe conclude "not supported".
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TrimmedUsage {
    /// Bucket-hour records that were in the range just before the trim.
    pub records: usize,
}

#[derive(Debug, Serialize)]
pub struct BucketDetail {
    pub info: BucketInfo,
    /// The S3 bucket policy as JSON text; `None` when the bucket has none.
    pub policy: Option<String>,
    /// Why the policy could not be read (typically a missing metadata cap). `info` is still valid.
    pub policy_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UsersPage {
    pub users: Vec<UserInfo>,
    /// Pass back to load the next page; `None` on the last page.
    pub next_marker: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NewSubuser {
    pub subusers: Vec<Subuser>,
    /// The Swift key RGW generated for the new subuser, secret included (shown once).
    pub swift_key: Option<KeyPair>,
}

fn redact(mut user: UserInfo) -> UserInfo {
    for key in user.keys.iter_mut().chain(&mut user.swift_keys) {
        key.secret_key.clear();
    }
    user
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|s| !s.is_empty())
}

/// Checks one `type=perm` capability and returns it without spaces.
/// RGW silently accepts unknown perms, so the perm is checked here.
pub fn validate_cap(cap: &str) -> Result<String, String> {
    let compact: String = cap.chars().filter(|c| !c.is_whitespace()).collect();
    let (cap_type, perm) = compact
        .split_once('=')
        .ok_or("cap must look like type=perm, e.g. usage=read")?;
    let type_ok = !cap_type.is_empty()
        && cap_type
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !type_ok {
        return Err(format!("invalid cap type {cap_type:?}"));
    }
    if !matches!(perm, "read" | "write" | "*" | "read,write" | "write,read") {
        return Err(format!(
            "invalid cap perm {perm:?}: use read, write, \"read,write\" or *"
        ));
    }
    Ok(compact)
}

/// Accepts exactly `YYYY-MM-DD` with a plausible month and day.
pub fn validate_date(date: &str) -> Result<(), String> {
    let b = date.as_bytes();
    let shape_ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    let in_range = |from: usize, min: u32, max: u32| {
        date.get(from..from + 2)
            .and_then(|s| s.parse::<u32>().ok())
            .is_some_and(|n| (min..=max).contains(&n))
    };
    if shape_ok && in_range(5, 1, 12) && in_range(8, 1, 31) {
        Ok(())
    } else {
        Err(format!("invalid date {date:?}: expected YYYY-MM-DD"))
    }
}

/// `access` is RGW's parameter value; anything else is answered with a bare 400 InvalidArgument.
pub fn validate_subuser(name: &str, access: &str) -> Result<(), String> {
    let name_ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !name_ok {
        return Err("subuser name may only contain letters, digits, - and _".into());
    }
    if !matches!(access, "read" | "write" | "readwrite" | "full") {
        return Err(format!(
            "invalid subuser access {access:?}: use read, write, readwrite or full"
        ));
    }
    Ok(())
}

/// Format check for an S3 key pair typed in by hand. RGW itself accepts almost anything,
/// including values that no S3 client could ever sign with.
pub fn validate_key_pair(access_key: &str, secret_key: &str) -> Result<(), String> {
    let access_ok = (16..=128).contains(&access_key.len())
        && access_key.chars().all(|c| c.is_ascii_alphanumeric());
    if !access_ok {
        return Err("access key must be 16-128 letters and digits".into());
    }
    let secret_ok = (32..=128).contains(&secret_key.len())
        && secret_key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/+=".contains(c));
    if !secret_ok {
        return Err("secret key must be 32-128 characters: letters, digits and / + =".into());
    }
    Ok(())
}

impl<H: HttpClient> Ops<'_, H> {
    /// Writes the audit row for a finished mutation and converts the error for the UI.
    fn record<T>(
        &self,
        action: &str,
        target: &str,
        detail: &str,
        result: Result<T, RgwError>,
    ) -> Result<T, String> {
        let result = result.map_err(|e| e.to_string());
        let error = result.as_ref().err().map(String::as_str);
        if let Err(e) = self
            .audit
            .record(&self.cluster_id, action, target, detail, error)
        {
            // The RGW call already happened; failing here would misreport it.
            eprintln!("{e} (while recording {action} on {target})");
        }
        result
    }

    /// One page of users with their details, secrets stripped. Not audited (read-only).
    /// `marker` is the `next_marker` of the previous page; `None` starts from the beginning.
    pub async fn list_users_page(
        &self,
        marker: Option<&str>,
        limit: usize,
    ) -> Result<UsersPage, String> {
        let limit = limit.clamp(1, MAX_USERS_PAGE);
        let page = self.admin.list_users_page(marker, limit).await;
        let UserIdPage {
            keys,
            truncated,
            marker,
        } = page.map_err(|e| e.to_string())?;
        let admin = &self.admin;
        // Owned uid per future: a closure over `&String` is not general enough for a Send future.
        let fetched: Vec<_> = stream::iter(keys)
            .map(|uid| async move { admin.get_user(&uid).await })
            .buffered(USER_FETCH_CONCURRENCY)
            .collect()
            .await;
        let mut users = Vec::with_capacity(fetched.len());
        for result in fetched {
            match result {
                Ok(user) => users.push(redact(user)),
                Err(RgwError::NoSuchUser) => {} // removed between the two calls
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(UsersPage {
            users,
            next_marker: marker.filter(|_| truncated),
        })
    }

    pub async fn get_user(&self, uid: &str) -> Result<UserInfo, String> {
        let user = self.admin.get_user(uid).await.map_err(|e| e.to_string())?;
        Ok(redact(user))
    }

    /// Returns the new user including its secret key(s): the only time they are shown.
    pub async fn create_user(
        &self,
        uid: &str,
        display_name: &str,
        email: &Option<String>,
        access_key: &Option<String>,
        secret_key: &Option<String>,
    ) -> Result<UserInfo, String> {
        let (uid, display_name) = (uid.trim(), display_name.trim());
        if uid.is_empty() || display_name.is_empty() {
            return Err("uid and display name are required".into());
        }
        let (access_key, secret_key) = (non_empty(access_key), non_empty(secret_key));
        let key = if access_key.or(secret_key).is_some() {
            "manual"
        } else {
            "generated"
        };
        let detail = format!("display_name={display_name} key={key}");
        let result = self
            .admin
            .create_user(uid, display_name, non_empty(email), access_key, secret_key)
            .await;
        self.record("user.create", uid, &detail, result)
    }

    /// An empty `email` clears it.
    pub async fn modify_user(
        &self,
        uid: &str,
        display_name: &str,
        email: &str,
    ) -> Result<UserInfo, String> {
        let (display_name, email) = (display_name.trim(), email.trim());
        if display_name.is_empty() {
            return Err("display name is required".into());
        }
        let changes = UserModify {
            display_name: Some(display_name.into()),
            email: Some(email.into()),
            ..Default::default()
        };
        let detail = format!("display_name={display_name} email={email}");
        let result = self.admin.modify_user(uid, &changes).await;
        self.record("user.modify", uid, &detail, result).map(redact)
    }

    pub async fn set_suspended(&self, uid: &str, suspended: bool) -> Result<UserInfo, String> {
        let changes = UserModify {
            suspended: Some(suspended),
            ..Default::default()
        };
        let action = if suspended {
            "user.suspend"
        } else {
            "user.enable"
        };
        let result = self.admin.modify_user(uid, &changes).await;
        self.record(action, uid, "", result).map(redact)
    }

    /// `purge_data` also deletes every bucket and object the user owns. Without it RGW refuses
    /// (409, reported as BucketAlreadyExists) while the user still owns a bucket.
    pub async fn delete_user(&self, uid: &str, purge_data: bool) -> Result<(), String> {
        let result = self.admin.delete_user(uid, purge_data).await;
        let detail = format!("purge_data={purge_data}");
        self.record("user.delete", uid, &detail, result)
    }

    async fn new_key(&self, uid: &str) -> Result<KeyPair, RgwError> {
        // RGW answers with every key of the user; the new one is the one not there before.
        let before = self.admin.get_user(uid).await?.keys;
        let after = self.admin.create_key(uid, None, None).await?;
        after
            .into_iter()
            .find(|k| !before.iter().any(|b| b.access_key == k.access_key))
            .ok_or_else(|| RgwError::Decode("RGW did not return the new key".into()))
    }

    /// Generates a key and returns it with its secret (shown once).
    pub async fn create_key(&self, uid: &str) -> Result<KeyPair, String> {
        let result = self.new_key(uid).await;
        let detail = match &result {
            Ok(key) => format!("access_key={}", key.access_key),
            Err(_) => String::new(),
        };
        self.record("key.create", uid, &detail, result)
    }

    pub async fn remove_key(&self, uid: &str, access_key: &str) -> Result<(), String> {
        let result = self.admin.remove_key(uid, access_key).await;
        self.record(
            "key.remove",
            uid,
            &format!("access_key={access_key}"),
            result,
        )
    }

    /// Attaches an existing key pair (nothing is generated, so there is no secret to show).
    pub async fn add_key(
        &self,
        uid: &str,
        access_key: &str,
        secret_key: &str,
    ) -> Result<(), String> {
        validate_key_pair(access_key, secret_key)?;
        // RGW treats an access key the user already owns as "replace its secret": refuse instead.
        let user = self.admin.get_user(uid).await.map_err(|e| e.to_string())?;
        if user.keys.iter().any(|k| k.access_key == access_key) {
            return Err(
                "the user already has this access key; rotate it to change the secret".into(),
            );
        }
        let result = self
            .admin
            .create_key(uid, Some(access_key), Some(secret_key))
            .await;
        let detail = format!("access_key={access_key} manual");
        self.record("key.create", uid, &detail, result.map(|_| ()))
    }

    /// New key first, then the old one is removed, so the user is never left without a key.
    pub async fn rotate_key(&self, uid: &str, old_access_key: &str) -> Result<RotatedKey, String> {
        let key = self.create_key(uid).await?;
        let remove_error = self.remove_key(uid, old_access_key).await.err();
        Ok(RotatedKey { key, remove_error })
    }

    /// Creates a Swift subuser and returns its generated Swift key once.
    pub async fn create_subuser(
        &self,
        uid: &str,
        subuser: &str,
        access: &str,
    ) -> Result<NewSubuser, String> {
        validate_subuser(subuser, access)?;
        let created = self.admin.create_subuser(uid, subuser, access).await;
        let detail = format!("subuser={subuser} access={access}");
        let subusers = self.record("subuser.create", uid, &detail, created)?;
        // The create call does not return the secret RGW generated; read it from the user once.
        let id = format!("{uid}:{subuser}");
        let user = self.admin.get_user(uid).await.ok();
        let swift_key = user.and_then(|u| u.swift_keys.into_iter().find(|k| k.user == id));
        Ok(NewSubuser {
            subusers,
            swift_key,
        })
    }

    pub async fn remove_subuser(&self, uid: &str, subuser: &str) -> Result<(), String> {
        let result = self.admin.remove_subuser(uid, subuser).await;
        self.record("subuser.remove", uid, &format!("subuser={subuser}"), result)
    }

    pub async fn add_cap(&self, uid: &str, cap: &str) -> Result<Vec<Capability>, String> {
        let cap = validate_cap(cap)?;
        let result = self.admin.add_caps(uid, &cap).await;
        self.record("caps.add", uid, &cap, result)
    }

    pub async fn remove_cap(&self, uid: &str, cap: &str) -> Result<Vec<Capability>, String> {
        let cap = validate_cap(cap)?;
        let result = self.admin.remove_caps(uid, &cap).await;
        self.record("caps.remove", uid, &cap, result)
    }

    pub async fn get_quotas(&self, uid: &str) -> Result<Quotas, String> {
        let user = self.admin.get_quota(uid, QuotaType::User).await;
        let bucket = self.admin.get_quota(uid, QuotaType::Bucket).await;
        Ok(Quotas {
            user: user.map_err(|e| e.to_string())?,
            bucket: bucket.map_err(|e| e.to_string())?,
        })
    }

    /// Negative `max_size_kb` / `max_objects` mean "unlimited".
    pub async fn set_quota(
        &self,
        uid: &str,
        quota_type: QuotaType,
        enabled: bool,
        max_size_kb: i64,
        max_objects: i64,
    ) -> Result<(), String> {
        let detail = format!(
            "type={} enabled={enabled} max_size_kb={max_size_kb} max_objects={max_objects}",
            quota_type.as_str()
        );
        let result = self
            .admin
            .set_quota(uid, quota_type, enabled, max_size_kb, max_objects)
            .await;
        self.record("quota.set", uid, &detail, result)
    }

    async fn onboard_one(&self, row: &OnboardRow, dry_run: bool) -> OnboardResult {
        if let Err(e) = validate_onboard_row(row) {
            return OnboardResult::new(row, "error", e, None);
        }
        match self.admin.get_user(&row.uid).await {
            Ok(_) => {
                return OnboardResult::new(
                    row,
                    "exists",
                    "user already exists; left unchanged",
                    None,
                )
            }
            Err(RgwError::NoSuchUser) => {}
            Err(e) => return OnboardResult::new(row, "error", e.to_string(), None),
        }
        if dry_run {
            return OnboardResult::new(row, "would_create", "", None);
        }
        let email = Some(row.email.trim().to_string());
        let created = self
            .create_user(&row.uid, &row.display_name, &email, &None, &None)
            .await;
        let user = match created {
            Ok(user) => user,
            Err(e) => return OnboardResult::new(row, "error", e, None),
        };
        // From here on the user exists: its key is returned even if a later step fails.
        let key = user.keys.first();
        for cap in &row.caps {
            if let Err(e) = self.add_cap(&row.uid, cap).await {
                let message = format!("user created, but cap {cap} could not be added: {e}");
                return OnboardResult::new(row, "error", message, key);
            }
        }
        if let Some(kb) = row.quota_kb {
            let set = self
                .set_quota(&row.uid, QuotaType::User, true, kb, -1)
                .await;
            if let Err(e) = set {
                let message = format!("user created, but the quota could not be set: {e}");
                return OnboardResult::new(row, "error", message, key);
            }
        }
        OnboardResult::new(row, "created", "", key)
    }

    /// Creates the users of an onboarding file with their caps and quota, a few at a time,
    /// and answers one result per row, in order. Existing users are never modified. With
    /// `dry_run` nothing is changed. Every change goes through the audited single-user calls.
    pub async fn onboard(&self, rows: &[OnboardRow], dry_run: bool) -> Vec<OnboardResult> {
        // Owned rows per future: a closure over borrowed rows is not general enough for a Send future.
        let jobs: Vec<(OnboardRow, bool)> = rows
            .iter()
            .enumerate()
            .map(|(i, row)| {
                (
                    row.clone(),
                    rows[..i].iter().any(|earlier| earlier.uid == row.uid),
                )
            })
            .collect();
        let this = self;
        stream::iter(jobs)
            .map(|(row, repeated)| async move {
                if repeated {
                    return OnboardResult::new(
                        &row,
                        "error",
                        "this uid appears earlier in the file",
                        None,
                    );
                }
                this.onboard_one(&row, dry_run).await
            })
            .buffered(USER_FETCH_CONCURRENCY)
            .collect()
            .await
    }

    /// Buckets with stats, all of the cluster or one user's. Not audited (read-only).
    pub async fn list_buckets(&self, uid: Option<&str>) -> Result<Vec<BucketInfo>, String> {
        let buckets = self.admin.list_buckets(uid).await;
        buckets.map_err(|e| e.to_string())
    }

    pub async fn get_bucket(&self, bucket: &str) -> Result<BucketDetail, String> {
        let info = self.admin.get_bucket(bucket).await;
        let info = info.map_err(|e| e.to_string())?;
        let (policy, policy_error) = match self.admin.get_bucket_policy(&info).await {
            Ok(policy) => (policy, None),
            Err(e) => (None, Some(e.to_string())),
        };
        Ok(BucketDetail {
            info,
            policy,
            policy_error,
        })
    }

    /// Quota of one bucket. Negative `max_size_kb` / `max_objects` mean "unlimited".
    pub async fn set_bucket_quota(
        &self,
        bucket: &str,
        enabled: bool,
        max_size_kb: i64,
        max_objects: i64,
    ) -> Result<(), String> {
        // RGW wants the owner next to the bucket name; look it up rather than trust the caller.
        let info = self.admin.get_bucket(bucket).await;
        let owner = info.map_err(|e| e.to_string())?.owner;
        let detail = format!(
            "owner={owner} enabled={enabled} max_size_kb={max_size_kb} max_objects={max_objects}"
        );
        let result = self
            .admin
            .set_bucket_quota(&owner, bucket, enabled, max_size_kb, max_objects)
            .await;
        self.record("bucket.quota.set", bucket, &detail, result)
    }

    /// Removes an empty bucket; its policy and quota go with it. RGW itself refuses a bucket
    /// that still holds objects (409 BucketNotEmpty): objects are never purged from here.
    pub async fn delete_bucket(&self, bucket: &str) -> Result<(), String> {
        let result = self.admin.delete_bucket(bucket).await;
        self.record("bucket.delete", bucket, "", result)
    }

    /// Whether this cluster answers usage queries at all. `/admin/info` says nothing about
    /// features, so this probes the usage endpoint with a tiny range. It cannot tell a cluster
    /// whose usage log is switched off: that one answers normally, just with no data.
    pub async fn usage_support(&self) -> Result<UsageSupport, String> {
        let probe = self
            .admin
            .get_usage(None, Some("1970-01-02"), Some("1970-01-03"))
            .await;
        match probe {
            Ok(_) => Ok(UsageSupport {
                supported: true,
                reason: None,
            }),
            Err(e @ RgwError::AccessDenied)
            | Err(
                e @ RgwError::Api {
                    status: 404 | 405 | 501,
                    ..
                },
            ) => Ok(UsageSupport {
                supported: false,
                reason: Some(e.to_string()),
            }),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Usage of one user. `start` / `end` are `YYYY-MM-DD` (UTC), `end` exclusive. Read-only.
    pub async fn get_usage(
        &self,
        uid: &str,
        start: Option<&str>,
        end: Option<&str>,
    ) -> Result<Usage, String> {
        for date in [start, end].into_iter().flatten() {
            validate_date(date)?;
        }
        let usage = self.admin.get_usage(Some(uid), start, end).await;
        usage.map_err(|e| e.to_string())
    }

    /// Deletes one user's usage records in `[start, end)` and reports how many there were.
    pub async fn trim_usage(
        &self,
        uid: &str,
        start: &str,
        end: &str,
    ) -> Result<TrimmedUsage, String> {
        // Strict on purpose: RGW ignores a date it cannot parse and treats a missing uid as
        // "all users", either of which would delete far more than was asked for.
        if uid.trim().is_empty() {
            return Err("uid is required to trim usage".into());
        }
        validate_date(start)?;
        validate_date(end)?;
        if start >= end {
            return Err(format!("usage range is empty: {start} is not before {end}"));
        }
        let before = self
            .admin
            .get_usage(Some(uid), Some(start), Some(end))
            .await;
        let records = before
            .map_err(|e| e.to_string())?
            .entries
            .iter()
            .map(|entry| entry.buckets.len())
            .sum();
        let detail = format!("start={start} end={end} records={records}");
        let result = self.admin.trim_usage(uid, start, end).await;
        self.record("usage.trim", uid, &detail, result)?;
        Ok(TrimmedUsage { records })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rgw_admin::mock::Mock;
    use std::sync::atomic::Ordering::SeqCst;

    fn ops<'a>(mock: &'a Mock, audit: &'a Audit) -> Ops<'a, &'a Mock> {
        Ops {
            admin: mock.client(),
            audit,
            cluster_id: "c1".into(),
        }
    }

    fn user_json(uid: &str, keys: &[(&str, &str)]) -> String {
        let keys: Vec<String> = keys
            .iter()
            .map(|(a, s)| format!(r#"{{"user":"{uid}","access_key":"{a}","secret_key":"{s}"}}"#))
            .collect();
        format!(
            r#"{{"user_id":"{uid}","display_name":"{uid}","keys":[{}]}}"#,
            keys.join(",")
        )
    }

    /// (action, target, detail, ok) of every audit row, oldest first.
    fn rows(audit: &Audit) -> Vec<(String, String, String, bool)> {
        let mut entries = audit.recent(None, None).unwrap();
        entries.reverse();
        entries
            .into_iter()
            .map(|e| (e.action, e.target, e.detail, e.ok))
            .collect()
    }

    #[tokio::test]
    async fn list_users_fetches_four_at_a_time_and_strips_secrets() {
        let uids: Vec<String> = (0..10).map(|i| format!("u{i}")).collect();
        let first_page = format!(
            r#"{{"keys":{},"truncated":true,"marker":"M1"}}"#,
            serde_json::to_string(&uids).unwrap()
        );
        let mut mock = Mock::reply(200, &first_page);
        for uid in &uids {
            mock = if uid == "u3" {
                mock.then(404, r#"{"Code":"NoSuchUser"}"#)
            } else {
                mock.then(200, &user_json(uid, &[("AK", "TOPSECRET")]))
            };
        }
        let audit = Audit::in_memory().unwrap();
        let page = ops(&mock, &audit).list_users_page(None, 10).await.unwrap();
        assert_eq!(page.next_marker.as_deref(), Some("M1"));
        let users = page.users;

        let listed: Vec<&str> = users.iter().map(|u| u.user_id.as_str()).collect();
        assert_eq!(
            listed,
            ["u0", "u1", "u2", "u4", "u5", "u6", "u7", "u8", "u9"]
        );
        assert!(users.iter().all(|u| u.keys[0].access_key == "AK"));
        assert!(!serde_json::to_string(&users).unwrap().contains("TOPSECRET"));
        assert_eq!(mock.max_in_flight.load(SeqCst), USER_FETCH_CONCURRENCY);
        assert_eq!(mock.calls().len(), 11);
        assert_eq!(
            mock.calls()[0],
            "GET /admin/metadata/user?format=json&max-entries=10"
        );
        assert!(rows(&audit).is_empty(), "reads are not audited");

        // The marker is passed back verbatim; a page that is not truncated ends the listing.
        let mock = Mock::reply(200, r#"{"keys":[],"truncated":false,"marker":"ignored"}"#);
        let last = ops(&mock, &audit)
            .list_users_page(Some("M1"), 5000)
            .await
            .unwrap();
        assert!(last.users.is_empty());
        assert_eq!(last.next_marker, None);
        assert_eq!(
            mock.calls(),
            ["GET /admin/metadata/user?format=json&marker=M1&max-entries=1000"]
        );
    }

    #[tokio::test]
    async fn list_users_reports_other_errors() {
        let mock = Mock::reply(200, r#"{"keys":["u0"]}"#).then(403, r#"{"Code":"AccessDenied"}"#);
        let audit = Audit::in_memory().unwrap();
        let err = ops(&mock, &audit)
            .list_users_page(None, 10)
            .await
            .unwrap_err();
        assert!(err.starts_with("AccessDenied"), "{err}");
    }

    #[tokio::test]
    async fn create_user_returns_the_secret_once_and_never_audits_it() {
        let mock = Mock::reply(200, &user_json("alice", &[("AKMANUAL", "TOPSECRET")]))
            .then(200, &user_json("alice", &[("AKMANUAL", "TOPSECRET")]));
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);

        let created = ops
            .create_user(
                " alice ",
                "Alice",
                &Some(String::new()),
                &Some("AKMANUAL".into()),
                &Some("TOPSECRET".into()),
            )
            .await
            .unwrap();
        assert_eq!(created.keys[0].secret_key, "TOPSECRET");
        assert_eq!(
            mock.calls()[0],
            "PUT /admin/user?access-key=AKMANUAL&display-name=Alice&format=json&secret-key=TOPSECRET&uid=alice"
        );
        // Reading the same user later does not expose the secret again.
        assert_eq!(ops.get_user("alice").await.unwrap().keys[0].secret_key, "");

        assert_eq!(
            rows(&audit),
            [(
                "user.create".to_string(),
                "alice".to_string(),
                "display_name=Alice key=manual".to_string(),
                true
            )]
        );
        let dump = format!("{:?}", audit.recent(None, None).unwrap());
        assert!(!dump.contains("TOPSECRET"));

        assert!(ops
            .create_user(" ", "x", &None, &None, &None)
            .await
            .is_err());
        assert_eq!(mock.calls().len(), 2, "invalid input never reaches RGW");
    }

    #[tokio::test]
    async fn failures_are_audited_with_the_error() {
        let mock = Mock::reply(409, r#"{"Code":"UserAlreadyExists"}"#)
            .then(400, r#"{"Code":"InvalidCapability"}"#)
            .then(404, r#"{"Code":"NoSuchUser"}"#);
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);
        assert!(ops
            .create_user("bob", "Bob", &None, &None, &None)
            .await
            .is_err());
        assert!(ops.add_cap("bob", "zones = read").await.is_err());
        assert!(ops.delete_user("ghost", false).await.is_err());

        let entries = audit.recent(None, None).unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().all(|e| !e.ok && e.cluster_id == "c1"));
        assert_eq!(entries[0].action, "user.delete");
        assert!(entries[0].message.starts_with("NoSuchUser"));
        assert_eq!(entries[1].detail, "zones=read");
        assert!(entries[1].message.starts_with("InvalidCapability"));
        assert!(entries[2].message.starts_with("UserAlreadyExists"));
    }

    #[tokio::test]
    async fn modify_suspend_caps_and_quota_are_audited() {
        let user = user_json("alice", &[("AK", "TOPSECRET")]);
        let mock = Mock::reply(200, &user)
            .then(200, &user)
            .then(200, &user)
            .then(200, r#"[{"type":"usage","perm":"*"}]"#)
            .then(200, "[]")
            .then(200, "")
            .then(
                200,
                r#"{"enabled":true,"max_size":1048576,"max_size_kb":1024,"max_objects":-1}"#,
            )
            .then(
                200,
                r#"{"enabled":false,"max_size":-1,"max_size_kb":0,"max_objects":-1}"#,
            );
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);

        let modified = ops.modify_user("alice", " Alice A ", "").await.unwrap();
        assert_eq!(
            modified.keys[0].secret_key, "",
            "modify must not leak secrets"
        );
        ops.set_suspended("alice", true).await.unwrap();
        ops.set_suspended("alice", false).await.unwrap();
        let caps = ops.add_cap("alice", "usage=read, write").await.unwrap();
        assert_eq!(caps[0].perm, "*");
        ops.remove_cap("alice", "usage=*").await.unwrap();
        ops.set_quota("alice", QuotaType::User, true, 1024, -1)
            .await
            .unwrap();
        let quotas = ops.get_quotas("alice").await.unwrap();
        assert!(quotas.user.enabled && !quotas.bucket.enabled);

        assert_eq!(
            mock.calls(),
            [
                "POST /admin/user?display-name=Alice%20A&email=&format=json&uid=alice",
                "POST /admin/user?format=json&suspended=true&uid=alice",
                "POST /admin/user?format=json&suspended=false&uid=alice",
                "PUT /admin/user?caps=&format=json&uid=alice&user-caps=usage%3Dread%2Cwrite",
                "DELETE /admin/user?caps=&format=json&uid=alice&user-caps=usage%3D%2A",
                "PUT /admin/user?enabled=true&format=json&max-objects=-1&max-size-kb=1024&quota=&quota-type=user&uid=alice",
                "GET /admin/user?format=json&quota=&quota-type=user&uid=alice",
                "GET /admin/user?format=json&quota=&quota-type=bucket&uid=alice",
            ]
        );
        let logged: Vec<(String, String)> = rows(&audit)
            .into_iter()
            .map(|(action, _, detail, ok)| {
                assert!(ok);
                (action, detail)
            })
            .collect();
        let expected = [
            ("user.modify", "display_name=Alice A email="),
            ("user.suspend", ""),
            ("user.enable", ""),
            ("caps.add", "usage=read,write"),
            ("caps.remove", "usage=*"),
            (
                "quota.set",
                "type=user enabled=true max_size_kb=1024 max_objects=-1",
            ),
        ];
        assert_eq!(logged.len(), expected.len());
        for ((action, detail), (want_action, want_detail)) in logged.iter().zip(expected) {
            assert_eq!(
                (action.as_str(), detail.as_str()),
                (want_action, want_detail)
            );
        }
    }

    #[tokio::test]
    async fn rotate_creates_the_new_key_before_removing_the_old_one() {
        let both = r#"[{"user":"alice","access_key":"OLD","secret_key":"s-old"},{"user":"alice","access_key":"NEW","secret_key":"s-new"}]"#;
        let mock = Mock::reply(200, &user_json("alice", &[("OLD", "s-old")]))
            .then(200, both)
            .then(200, "");
        let audit = Audit::in_memory().unwrap();
        let rotated = ops(&mock, &audit).rotate_key("alice", "OLD").await.unwrap();
        assert_eq!(rotated.key.access_key, "NEW");
        assert_eq!(rotated.key.secret_key, "s-new");
        assert_eq!(rotated.remove_error, None);
        assert_eq!(
            mock.calls(),
            [
                "GET /admin/user?format=json&uid=alice",
                "PUT /admin/user?format=json&key=&uid=alice",
                "DELETE /admin/user?access-key=OLD&format=json&key=&uid=alice",
            ]
        );
        let logged = rows(&audit);
        assert_eq!(logged[0].0, "key.create");
        assert_eq!(logged[0].2, "access_key=NEW");
        assert_eq!(logged[1].0, "key.remove");
        assert_eq!(logged[1].2, "access_key=OLD");
        assert!(!format!("{logged:?}").contains("s-new"));

        // Old key cannot be removed: the new key (and its secret) is still returned.
        let mock = Mock::reply(200, &user_json("alice", &[("OLD", "s-old")]))
            .then(200, both)
            .then(403, r#"{"Code":"AccessDenied"}"#);
        let audit = Audit::in_memory().unwrap();
        let rotated = ops(&mock, &audit).rotate_key("alice", "OLD").await.unwrap();
        assert_eq!(rotated.key.access_key, "NEW");
        assert!(rotated.remove_error.unwrap().starts_with("AccessDenied"));
        assert_eq!(
            rows(&audit)[1],
            (
                "key.remove".into(),
                "alice".into(),
                "access_key=OLD".into(),
                false
            )
        );
    }

    #[tokio::test]
    async fn add_key_validates_refuses_duplicates_and_audits_without_the_secret() {
        let (access, secret) = (
            "MANUALKEY0123456789A",
            "manualSecret/0123456789+abcdefghijklmnop=",
        );
        let mock = Mock::reply(
            200,
            &user_json("alice", &[("OLDKEY0123456789ABCD", "s-old")]),
        )
        .then(200, "[]")
        .then(200, &user_json("alice", &[(access, "s")]));
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);

        assert!(ops.add_key("alice", "short", secret).await.is_err());
        assert!(ops
            .add_key("alice", access, "has spaces in the secret key 0123456789")
            .await
            .is_err());
        assert!(mock.calls().is_empty(), "malformed keys never reach RGW");

        ops.add_key("alice", access, secret).await.unwrap();
        assert_eq!(
            mock.calls()[1],
            format!("PUT /admin/user?access-key={access}&format=json&key=&secret-key=manualSecret%2F0123456789%2Babcdefghijklmnop%3D&uid=alice")
        );
        // Second attempt: the user now owns that access key, so nothing is sent.
        let err = ops.add_key("alice", access, secret).await.unwrap_err();
        assert!(err.contains("already has this access key"), "{err}");
        assert_eq!(mock.calls().len(), 3);

        let logged = rows(&audit);
        assert_eq!(logged.len(), 1);
        assert_eq!(logged[0].0, "key.create");
        assert_eq!(logged[0].2, format!("access_key={access} manual"));
        assert!(!format!("{logged:?}").contains("manualSecret"));
    }

    #[tokio::test]
    async fn subusers_are_audited_and_swift_secrets_only_shown_on_create() {
        let with_swift = r#"{"user_id":"alice","subusers":[{"id":"alice:sw","permissions":"read"}],
            "keys":[{"user":"alice","access_key":"AK","secret_key":"S3SECRET"}],
            "swift_keys":[{"user":"alice:sw","secret_key":"SWIFTSECRET"}]}"#;
        let mock = Mock::reply(200, r#"[{"id":"alice:sw","permissions":"read"}]"#)
            .then(200, with_swift)
            .then(200, with_swift)
            .then(200, "")
            .then(404, r#"{"Code":"NoSuchSubUser"}"#);
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);

        assert!(ops
            .create_subuser("alice", "bad name", "read")
            .await
            .is_err());
        assert!(ops.create_subuser("alice", "sw", "bogus").await.is_err());
        assert!(mock.calls().is_empty(), "invalid input never reaches RGW");

        let created = ops.create_subuser("alice", "sw", "read").await.unwrap();
        assert_eq!(created.subusers[0].permissions, "read");
        assert_eq!(created.swift_key.unwrap().secret_key, "SWIFTSECRET");
        // A later read of the user exposes neither kind of secret.
        let user = ops.get_user("alice").await.unwrap();
        assert_eq!(user.subusers[0].id, "alice:sw");
        let dump = serde_json::to_string(&user).unwrap();
        assert!(
            !dump.contains("SWIFTSECRET") && !dump.contains("S3SECRET"),
            "{dump}"
        );

        ops.remove_subuser("alice", "sw").await.unwrap();
        assert!(ops
            .remove_subuser("alice", "sw")
            .await
            .unwrap_err()
            .contains("NoSuchSubUser"));
        assert_eq!(
            rows(&audit),
            [
                (
                    "subuser.create".into(),
                    "alice".into(),
                    "subuser=sw access=read".into(),
                    true
                ),
                (
                    "subuser.remove".into(),
                    "alice".into(),
                    "subuser=sw".into(),
                    true
                ),
                (
                    "subuser.remove".into(),
                    "alice".into(),
                    "subuser=sw".into(),
                    false
                ),
            ]
        );
        assert!(!format!("{:?}", audit.recent(None, None).unwrap()).contains("SWIFTSECRET"));
    }

    #[tokio::test]
    async fn delete_user_sends_purge_data_only_when_asked() {
        let mock = Mock::reply(409, r#"{"Code":"BucketAlreadyExists"}"#).then(200, "");
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);
        let refused = ops.delete_user("alice", false).await.unwrap_err();
        assert!(refused.contains("BucketAlreadyExists"), "{refused}");
        ops.delete_user("alice", true).await.unwrap();
        assert_eq!(
            mock.calls(),
            [
                "DELETE /admin/user?format=json&uid=alice",
                "DELETE /admin/user?format=json&purge-data=true&uid=alice",
            ]
        );
        assert_eq!(
            rows(&audit),
            [
                (
                    "user.delete".into(),
                    "alice".into(),
                    "purge_data=false".into(),
                    false
                ),
                (
                    "user.delete".into(),
                    "alice".into(),
                    "purge_data=true".into(),
                    true
                ),
            ]
        );
    }

    #[tokio::test]
    async fn bucket_detail_survives_an_unreadable_policy_and_delete_is_audited() {
        let bucket = r#"{"bucket":"photos","id":"abc.1","owner":"alice","usage":{"rgw.main":{"size":11,"num_objects":1}}}"#;
        let mock = Mock::reply(200, bucket)
            .then(403, r#"{"Code":"AccessDenied"}"#)
            .then(409, r#"{"Code":"BucketNotEmpty"}"#)
            .then(200, "");
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);

        let detail = ops.get_bucket("photos").await.unwrap();
        assert_eq!(detail.info.owner, "alice");
        assert_eq!(detail.policy, None);
        assert!(detail.policy_error.unwrap().starts_with("AccessDenied"));

        assert!(ops
            .delete_bucket("photos")
            .await
            .unwrap_err()
            .contains("BucketNotEmpty"));
        ops.delete_bucket("photos").await.unwrap();
        assert_eq!(
            mock.calls()[2],
            "DELETE /admin/bucket?bucket=photos&format=json"
        );
        assert_eq!(
            rows(&audit),
            [
                (
                    "bucket.delete".into(),
                    "photos".into(),
                    String::new(),
                    false
                ),
                ("bucket.delete".into(), "photos".into(), String::new(), true),
            ]
        );
    }

    #[tokio::test]
    async fn bucket_quota_looks_up_the_owner_and_is_audited() {
        let mock = Mock::reply(200, r#"{"bucket":"photos","owner":"alice"}"#)
            .then(200, "")
            .then(404, r#"{"Code":"NoSuchBucket"}"#);
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);
        ops.set_bucket_quota("photos", true, 2048, -1)
            .await
            .unwrap();
        assert_eq!(
            mock.calls()[1],
            "PUT /admin/bucket?bucket=photos&enabled=true&format=json&max-objects=-1&max-size-kb=2048&quota=&uid=alice"
        );
        // Unknown bucket: nothing is sent and nothing is audited (there was no mutation to attempt).
        assert!(ops
            .set_bucket_quota("ghost", false, -1, -1)
            .await
            .unwrap_err()
            .starts_with("NoSuchBucket"));
        assert_eq!(mock.calls().len(), 3);
        assert_eq!(
            rows(&audit),
            [(
                "bucket.quota.set".into(),
                "photos".into(),
                "owner=alice enabled=true max_size_kb=2048 max_objects=-1".into(),
                true
            )]
        );
    }

    #[tokio::test]
    async fn usage_dates_are_validated_and_trim_is_counted_and_audited() {
        let two_records = r#"{"entries":[{"user":"alice","buckets":[
            {"bucket":"a","time":"2026-11-18T13:00:00.000000Z","categories":[{"category":"put_obj","ops":2,"successful_ops":2}]},
            {"bucket":"a","time":"2026-11-18T14:00:00.000000Z","categories":[{"category":"get_obj","ops":1,"successful_ops":1}]}]}],"summary":[]}"#;
        let mock = Mock::reply(200, two_records)
            .then(200, two_records)
            .then(200, "");
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);

        // Nothing malformed reaches RGW, which would ignore it and widen the range.
        assert!(ops
            .get_usage("alice", Some("18/11/2026"), None)
            .await
            .is_err());
        assert!(ops
            .trim_usage("alice", "2026-11-18", "not-a-date")
            .await
            .is_err());
        assert!(ops
            .trim_usage("alice", "2026-11-19", "2026-11-18")
            .await
            .is_err());
        assert!(ops
            .trim_usage("alice", "2026-11-18", "2026-11-18")
            .await
            .is_err());
        assert!(ops
            .trim_usage(" ", "2026-11-18", "2026-11-19")
            .await
            .is_err());
        assert!(mock.calls().is_empty());

        let usage = ops
            .get_usage("alice", Some("2026-11-18"), Some("2026-11-19"))
            .await
            .unwrap();
        assert_eq!(usage.entries[0].buckets.len(), 2);
        let trimmed = ops
            .trim_usage("alice", "2026-11-18", "2026-11-19")
            .await
            .unwrap();
        assert_eq!(trimmed.records, 2);
        assert_eq!(
            mock.calls()[1..],
            [
                "GET /admin/usage?end=2026-11-19&format=json&start=2026-11-18&uid=alice",
                "DELETE /admin/usage?end=2026-11-19&format=json&start=2026-11-18&uid=alice",
            ]
        );
        assert_eq!(
            rows(&audit),
            [(
                "usage.trim".into(),
                "alice".into(),
                "start=2026-11-18 end=2026-11-19 records=2".into(),
                true
            )]
        );
    }

    #[tokio::test]
    async fn usage_support_probe() {
        let audit = Audit::in_memory().unwrap();
        let mock = Mock::reply(200, r#"{"entries":[],"summary":[]}"#);
        let support = ops(&mock, &audit).usage_support().await.unwrap();
        assert!(support.supported && support.reason.is_none());
        assert_eq!(
            mock.calls(),
            ["GET /admin/usage?end=1970-01-03&format=json&start=1970-01-02"]
        );

        for (status, body) in [
            (403, r#"{"Code":"AccessDenied"}"#),
            (405, r#"{"Code":"MethodNotAllowed"}"#),
            (404, ""),
        ] {
            let mock = Mock::reply(status, body);
            let support = ops(&mock, &audit).usage_support().await.unwrap();
            assert!(!support.supported, "HTTP {status} means: hide usage");
            assert!(support.reason.is_some());
        }
        // A cluster that cannot be reached is an error, not "unsupported".
        let mock = Mock::default();
        assert!(ops(&mock, &audit).usage_support().await.is_err());
        let mock = Mock::reply(500, r#"{"Code":"InternalError"}"#);
        assert!(ops(&mock, &audit).usage_support().await.is_err());
    }

    #[test]
    fn date_format_is_strict() {
        for good in ["2026-11-18", "1970-01-02", "2028-02-29"] {
            assert!(validate_date(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "2026-11-8",
            "2026-13-01",
            "2026-00-10",
            "2026-11-32",
            "18-11-2026",
            "2026/11/18",
            "2026-11-18 00:00:00",
            "not-a-date",
        ] {
            assert!(validate_date(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    fn onboard_row(uid: &str, caps: &[&str], quota_kb: Option<i64>) -> OnboardRow {
        OnboardRow {
            uid: uid.into(),
            display_name: format!("User {uid}"),
            email: String::new(),
            caps: caps.iter().map(|c| c.to_string()).collect(),
            quota_kb,
        }
    }

    #[tokio::test]
    async fn onboard_dry_run_changes_nothing() {
        let mock = Mock::reply(404, r#"{"Code":"NoSuchUser"}"#)
            .then(200, &user_json("bob", &[("AK", "S")]));
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);
        let new = ops
            .onboard(&[onboard_row("alice", &["usage=read"], Some(1024))], true)
            .await;
        let old = ops.onboard(&[onboard_row("bob", &[], None)], true).await;
        assert_eq!((new[0].status, old[0].status), ("would_create", "exists"));
        assert_eq!(
            mock.calls(),
            [
                "GET /admin/user?format=json&uid=alice",
                "GET /admin/user?format=json&uid=bob"
            ],
            "a dry run only looks"
        );
        assert!(rows(&audit).is_empty());
        assert!(
            old[0].secret_key.is_empty(),
            "an existing user's key is never handed out"
        );
    }

    #[tokio::test]
    async fn onboard_creates_user_caps_and_quota_and_returns_the_key_once() {
        let mock = Mock::reply(404, r#"{"Code":"NoSuchUser"}"#)
            .then(200, &user_json("alice", &[("AKNEW", "TOPSECRET")]))
            .then(200, r#"[{"type":"buckets","perm":"read"}]"#)
            .then(
                200,
                r#"[{"type":"buckets","perm":"read"},{"type":"usage","perm":"read"}]"#,
            )
            .then(200, "");
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);
        let row = onboard_row("alice", &["buckets=read", "usage=read"], Some(2048));
        let result = &ops.onboard(&[row], false).await[0];
        assert_eq!(
            (
                result.status,
                result.access_key.as_str(),
                result.secret_key.as_str()
            ),
            ("created", "AKNEW", "TOPSECRET")
        );
        assert_eq!(mock.calls().len(), 5);
        assert!(
            mock.calls()[4].contains("max-size-kb=2048")
                && mock.calls()[4].contains("quota-type=user")
        );
        let actions: Vec<String> = rows(&audit).into_iter().map(|r| r.0).collect();
        assert_eq!(
            actions,
            ["user.create", "caps.add", "caps.add", "quota.set"]
        );
        assert!(!format!("{:?}", audit.recent(None, None).unwrap()).contains("TOPSECRET"));
    }

    #[tokio::test]
    async fn onboard_reports_a_failed_step_and_still_returns_the_key() {
        let mock = Mock::reply(404, r#"{"Code":"NoSuchUser"}"#)
            .then(200, &user_json("alice", &[("AKNEW", "TOPSECRET")]))
            .then(400, r#"{"Code":"InvalidCapability"}"#);
        let audit = Audit::in_memory().unwrap();
        let result = &ops(&mock, &audit)
            .onboard(&[onboard_row("alice", &["zones=read"], Some(1))], false)
            .await[0];
        assert_eq!(result.status, "error");
        assert!(
            result
                .message
                .starts_with("user created, but cap zones=read"),
            "{}",
            result.message
        );
        assert_eq!(
            result.secret_key, "TOPSECRET",
            "the user exists, so its key must not be lost"
        );
        assert_eq!(
            mock.calls().len(),
            3,
            "the quota is not attempted after a failed cap"
        );
    }

    #[tokio::test]
    async fn onboard_refuses_bad_and_repeated_rows_without_calling_rgw() {
        let mock = Mock::reply(404, r#"{"Code":"NoSuchUser"}"#);
        let audit = Audit::in_memory().unwrap();
        let ops = ops(&mock, &audit);
        let rows = [
            onboard_row("alice", &[], None),
            onboard_row("alice", &[], None),
            onboard_row("has space", &[], None),
            onboard_row("carol", &["usage=bogus"], None),
            onboard_row("dave", &[], Some(0)),
        ];
        let results = ops.onboard(&rows, true).await;
        let statuses: Vec<&str> = results.iter().map(|r| r.status).collect();
        assert_eq!(
            statuses,
            ["would_create", "error", "error", "error", "error"]
        );
        assert!(results[1].message.contains("appears earlier"));
        assert_eq!(mock.calls().len(), 1, "only the one valid row reached RGW");
        let mut unnamed = onboard_row("erin", &[], None);
        unnamed.display_name = " ".into();
        assert!(validate_onboard_row(&unnamed).is_err());
    }

    #[test]
    fn cap_syntax_is_checked_before_calling_rgw() {
        assert_eq!(validate_cap("usage=read").unwrap(), "usage=read");
        assert_eq!(
            validate_cap(" users = read, write ").unwrap(),
            "users=read,write"
        );
        assert_eq!(
            validate_cap("user-info-without-keys=*").unwrap(),
            "user-info-without-keys=*"
        );
        for bad in [
            "",
            "usage",
            "=read",
            "usage=",
            "usage=bogus",
            "Usage=read",
            "a=read;b=write",
        ] {
            assert!(validate_cap(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
