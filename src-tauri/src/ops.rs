//! Admin operations as the UI calls them. Every mutation is written to the
//! audit log, and secret keys are stripped from every response except the one
//! that creates them (a secret is shown exactly once).

use crate::audit::Audit;
use crate::rgw_admin::{
    Capability, HttpClient, KeyPair, Quota, QuotaType, ReqwestClient, RgwAdmin, RgwError, Usage,
    UserInfo, UserModify,
};
use futures_util::{stream, StreamExt};
use serde::Serialize;

/// `get_user` calls in flight while loading the user list.
const USER_FETCH_CONCURRENCY: usize = 4;

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

fn redact(mut user: UserInfo) -> UserInfo {
    for key in &mut user.keys {
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

    /// All users with their details, secrets stripped. Not audited (read-only).
    pub async fn list_users(&self) -> Result<Vec<UserInfo>, String> {
        let uids = self.admin.list_users().await.map_err(|e| e.to_string())?;
        let admin = &self.admin;
        // Owned uid per future: a closure over `&String` is not general enough for a Send future.
        let fetched: Vec<_> = stream::iter(uids)
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
        Ok(users)
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

    /// Never purges data: RGW refuses while the user still owns buckets.
    pub async fn delete_user(&self, uid: &str) -> Result<(), String> {
        let result = self.admin.delete_user(uid, false).await;
        self.record("user.delete", uid, "", result)
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

    pub async fn get_usage(&self, uid: &str) -> Result<Usage, String> {
        let usage = self.admin.get_usage(Some(uid)).await;
        usage.map_err(|e| e.to_string())
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
        let mut mock = Mock::reply(200, &serde_json::to_string(&uids).unwrap());
        for uid in &uids {
            mock = if uid == "u3" {
                mock.then(404, r#"{"Code":"NoSuchUser"}"#)
            } else {
                mock.then(200, &user_json(uid, &[("AK", "TOPSECRET")]))
            };
        }
        let audit = Audit::in_memory().unwrap();
        let users = ops(&mock, &audit).list_users().await.unwrap();

        let listed: Vec<&str> = users.iter().map(|u| u.user_id.as_str()).collect();
        assert_eq!(
            listed,
            ["u0", "u1", "u2", "u4", "u5", "u6", "u7", "u8", "u9"]
        );
        assert!(users.iter().all(|u| u.keys[0].access_key == "AK"));
        assert!(!serde_json::to_string(&users).unwrap().contains("TOPSECRET"));
        assert_eq!(mock.max_in_flight.load(SeqCst), USER_FETCH_CONCURRENCY);
        assert_eq!(mock.calls().len(), 11);
        assert!(rows(&audit).is_empty(), "reads are not audited");
    }

    #[tokio::test]
    async fn list_users_reports_other_errors() {
        let mock = Mock::reply(200, r#"["u0"]"#).then(403, r#"{"Code":"AccessDenied"}"#);
        let audit = Audit::in_memory().unwrap();
        let err = ops(&mock, &audit).list_users().await.unwrap_err();
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
        assert!(ops.delete_user("ghost").await.is_err());

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
