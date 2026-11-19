//! Object versions and ACLs, as the browsed user's key is allowed to see and change them.

use super::manage::FailedDelete;
use super::transfer::Cancel;
use super::{s3_error, time, S3};
use crate::rgw_admin::sigv4::uri_encode;
use aws_sdk_s3::types::{AccessControlPolicy, Grantee, Owner, Permission, Type};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;

const GROUP_URI: &str = "http://acs.amazonaws.com/groups/global/";
const GROUPS: [&str; 2] = ["AllUsers", "AuthenticatedUsers"];
const PERMISSIONS: [&str; 5] = ["FULL_CONTROL", "READ", "WRITE", "READ_ACP", "WRITE_ACP"];
/// Versions of one key shown at most.
const MAX_VERSIONS: usize = 1000;

#[derive(Debug, Serialize)]
pub struct Versioning {
    /// False when the cluster or this key cannot answer versioning queries: hide the feature.
    pub supported: bool,
    /// `Enabled`, `Suspended`, or empty when versioning was never switched on.
    pub status: String,
    /// The error behind `supported = false`.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VersionEntry {
    pub version_id: String,
    pub is_latest: bool,
    pub last_modified: String,
    pub size: u64,
    pub etag: String,
    /// A delete marker: the key looks deleted while this is the latest entry.
    pub delete_marker: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Grant {
    /// `user` or `group`.
    pub kind: String,
    /// The user's id (its uid on RGW), or `AllUsers` / `AuthenticatedUsers` for a group.
    pub grantee: String,
    #[serde(default)]
    pub display_name: String,
    /// `FULL_CONTROL`, `READ`, `WRITE`, `READ_ACP` or `WRITE_ACP`.
    pub permission: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Acl {
    pub owner_id: String,
    pub owner_name: String,
    pub grants: Vec<Grant>,
}

#[derive(Debug, Serialize)]
pub struct AppliedAcl {
    /// The ACL as read back after the change.
    pub acl: Acl,
    /// Whether what was read back holds exactly the grants that were sent.
    pub verified: bool,
}

/// Outcome of applying one ACL to many objects.
#[derive(Debug, Default, Serialize)]
pub struct AclReport {
    pub objects: usize,
    /// Objects whose ACL was replaced.
    pub applied: usize,
    /// Of those, how many read back with other grants than were sent.
    pub unverified: usize,
    pub failed: Vec<FailedDelete>,
    /// Stopped on request before the last object.
    pub cancelled: bool,
}

/// Rejects grants RGW would refuse or, worse, quietly reinterpret.
pub fn validate_grants(grants: &[Grant]) -> Result<(), String> {
    for g in grants {
        let grantee_ok = match g.kind.as_str() {
            "user" => !g.grantee.trim().is_empty() && !g.grantee.contains(char::is_whitespace),
            "group" => GROUPS.contains(&g.grantee.as_str()),
            _ => {
                return Err(format!(
                    "invalid grantee kind {:?}: use user or group",
                    g.kind
                ))
            }
        };
        if !grantee_ok {
            return Err(format!("invalid {} grantee {:?}", g.kind, g.grantee));
        }
        if !PERMISSIONS.contains(&g.permission.as_str()) {
            return Err(format!("invalid ACL permission {:?}", g.permission));
        }
    }
    Ok(())
}

/// The grants as comparable, order-free triples.
fn normalized(grants: &[Grant]) -> Vec<(String, String, String)> {
    let mut all: Vec<_> = grants
        .iter()
        .map(|g| (g.kind.clone(), g.grantee.clone(), g.permission.clone()))
        .collect();
    all.sort();
    all.dedup();
    all
}

fn acl_from(owner: Option<&Owner>, grants: &[aws_sdk_s3::types::Grant]) -> Acl {
    let grants = grants
        .iter()
        .filter_map(|g| {
            let grantee = g.grantee()?;
            let permission = g.permission()?.as_str().to_string();
            let (kind, name) = match grantee.r#type() {
                Type::Group => ("group", grantee.uri()?.trim_start_matches(GROUP_URI)),
                _ => ("user", grantee.id()?),
            };
            Some(Grant {
                kind: kind.to_string(),
                grantee: name.to_string(),
                display_name: grantee.display_name().unwrap_or_default().to_string(),
                permission,
            })
        })
        .collect();
    Acl {
        owner_id: owner.and_then(Owner::id).unwrap_or_default().to_string(),
        owner_name: owner
            .and_then(Owner::display_name)
            .unwrap_or_default()
            .to_string(),
        grants,
    }
}

impl S3 {
    /// The bucket's versioning state, or "not supported" when it cannot be asked.
    pub async fn versioning(&self, bucket: &str) -> Versioning {
        let asked = self
            .client
            .get_bucket_versioning()
            .bucket(bucket)
            .send()
            .await;
        match asked {
            Ok(out) => Versioning {
                supported: true,
                status: out
                    .status()
                    .map(|s| s.as_str().to_string())
                    .unwrap_or_default(),
                reason: None,
            },
            Err(e) => Versioning {
                supported: false,
                status: String::new(),
                reason: Some(s3_error(e)),
            },
        }
    }

    /// Every version and delete marker of exactly `key`, newest first.
    pub async fn list_versions(
        &self,
        bucket: &str,
        key: &str,
    ) -> Result<Vec<VersionEntry>, String> {
        let mut entries = Vec::new();
        let (mut key_marker, mut version_marker) = (None::<String>, None::<String>);
        loop {
            let page = self
                .client
                .list_object_versions()
                .bucket(bucket)
                .prefix(key);
            let page = page
                .set_key_marker(key_marker)
                .set_version_id_marker(version_marker);
            let out = page.send().await.map_err(s3_error)?;
            // The prefix also matches longer keys ("a.txt" and "a.txt.bak"): keep the exact key.
            for v in out.versions().iter().filter(|v| v.key() == Some(key)) {
                entries.push(VersionEntry {
                    version_id: v.version_id().unwrap_or("null").to_string(),
                    is_latest: v.is_latest() == Some(true),
                    last_modified: time(v.last_modified()),
                    size: v.size().unwrap_or(0).max(0) as u64,
                    etag: v.e_tag().unwrap_or_default().trim_matches('"').to_string(),
                    delete_marker: false,
                });
            }
            for m in out.delete_markers().iter().filter(|m| m.key() == Some(key)) {
                entries.push(VersionEntry {
                    version_id: m.version_id().unwrap_or("null").to_string(),
                    is_latest: m.is_latest() == Some(true),
                    last_modified: time(m.last_modified()),
                    size: 0,
                    etag: String::new(),
                    delete_marker: true,
                });
            }
            let more = out.is_truncated() == Some(true) && entries.len() < MAX_VERSIONS;
            if !more {
                break;
            }
            key_marker = out.next_key_marker().map(str::to_string);
            version_marker = out.next_version_id_marker().map(str::to_string);
        }
        entries.sort_by(|a, b| {
            let latest_first = b.is_latest.cmp(&a.is_latest);
            latest_first.then(b.last_modified.cmp(&a.last_modified))
        });
        Ok(entries)
    }

    /// Makes an old version current again by copying it onto the key (a new version is
    /// written; nothing is removed).
    pub async fn restore_version(
        &self,
        bucket: &str,
        key: &str,
        version: &str,
    ) -> Result<(), String> {
        let path: Vec<String> = key.split('/').map(uri_encode).collect();
        let source = format!(
            "{bucket}/{}?versionId={}",
            path.join("/"),
            uri_encode(version)
        );
        let copy = self.client.copy_object().bucket(bucket).key(key);
        copy.copy_source(source)
            .send()
            .await
            .map(|_| ())
            .map_err(s3_error)
    }

    /// The ACL of an object, or of the bucket itself when `key` is empty.
    pub async fn get_acl(&self, bucket: &str, key: &str) -> Result<Acl, String> {
        if key.is_empty() {
            let out = self.client.get_bucket_acl().bucket(bucket).send().await;
            let out = out.map_err(s3_error)?;
            Ok(acl_from(out.owner(), out.grants()))
        } else {
            let out = self
                .client
                .get_object_acl()
                .bucket(bucket)
                .key(key)
                .send()
                .await;
            let out = out.map_err(s3_error)?;
            Ok(acl_from(out.owner(), out.grants()))
        }
    }

    /// Replaces the ACL with exactly `grants` (the owner stays the owner), then reads it back.
    pub async fn put_acl(
        &self,
        bucket: &str,
        key: &str,
        grants: &[Grant],
    ) -> Result<AppliedAcl, String> {
        validate_grants(grants)?;
        let current = self.get_acl(bucket, key).await?;
        let owner = Owner::builder().id(&current.owner_id);
        let owner = owner.display_name(&current.owner_name).build();
        let mut policy = AccessControlPolicy::builder().owner(owner);
        for g in grants {
            let grantee = match g.kind.as_str() {
                "group" => Grantee::builder()
                    .r#type(Type::Group)
                    .uri(format!("{GROUP_URI}{}", g.grantee)),
                _ => Grantee::builder()
                    .r#type(Type::CanonicalUser)
                    .id(&g.grantee),
            };
            let grantee = grantee.build().map_err(|e| e.to_string())?;
            let grant = aws_sdk_s3::types::Grant::builder().grantee(grantee);
            policy = policy.grants(
                grant
                    .permission(Permission::from(g.permission.as_str()))
                    .build(),
            );
        }
        let policy = policy.build();
        let sent = if key.is_empty() {
            let put = self.client.put_bucket_acl().bucket(bucket);
            let sent = put.access_control_policy(policy).send().await;
            sent.map(|_| ()).map_err(s3_error)
        } else {
            let put = self.client.put_object_acl().bucket(bucket).key(key);
            let sent = put.access_control_policy(policy).send().await;
            sent.map(|_| ()).map_err(s3_error)
        };
        sent?;
        let acl = self.get_acl(bucket, key).await?;
        let verified = normalized(&acl.grants) == normalized(grants);
        Ok(AppliedAcl { acl, verified })
    }

    /// Replaces the ACL of each of `keys` with `grants`, one object after the other, calling
    /// `progress(done, total)` after each. One failure does not stop the rest.
    pub async fn put_acl_many(
        &self,
        bucket: &str,
        keys: &[String],
        grants: &[Grant],
        progress: impl Fn(u64, u64),
        cancel: &Cancel,
    ) -> Result<AclReport, String> {
        validate_grants(grants)?;
        let mut report = AclReport {
            objects: keys.len(),
            ..Default::default()
        };
        for (done, key) in keys.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                report.cancelled = true;
                break;
            }
            match self.put_acl(bucket, key, grants).await {
                Ok(applied) => {
                    report.applied += 1;
                    report.unverified += usize::from(!applied.verified);
                }
                Err(error) => report.failed.push(FailedDelete {
                    key: key.clone(),
                    error,
                }),
            }
            progress(done as u64 + 1, keys.len() as u64);
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(kind: &str, grantee: &str, permission: &str) -> Grant {
        Grant {
            kind: kind.into(),
            grantee: grantee.into(),
            display_name: String::new(),
            permission: permission.into(),
        }
    }

    #[test]
    fn grants_are_validated() {
        let good = [
            grant("user", "alice", "FULL_CONTROL"),
            grant("group", "AllUsers", "READ"),
            grant("group", "AuthenticatedUsers", "READ_ACP"),
        ];
        assert!(validate_grants(&good).is_ok());
        assert!(
            validate_grants(&[]).is_ok(),
            "an empty ACL is allowed: the owner keeps control"
        );
        for bad in [
            grant("user", "", "READ"),
            grant("user", "two words", "READ"),
            grant("group", "Everyone", "READ"),
            grant("role", "alice", "READ"),
            grant("user", "alice", "read"),
            grant("user", "alice", "ADMIN"),
        ] {
            assert!(
                validate_grants(std::slice::from_ref(&bad)).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn comparison_ignores_order_duplicates_and_display_names() {
        let mut named = grant("user", "alice", "READ");
        named.display_name = "Alice".into();
        let a = [grant("group", "AllUsers", "READ"), named];
        let b = [
            grant("user", "alice", "READ"),
            grant("group", "AllUsers", "READ"),
            grant("user", "alice", "READ"),
        ];
        assert_eq!(normalized(&a), normalized(&b));
        assert_ne!(
            normalized(&a),
            normalized(&[grant("user", "alice", "WRITE")])
        );
    }
}
