//! Bucket and object management as the browsed user: create bucket and folder, delete many,
//! object tags, and the raw headers of a HEAD request.

use super::{s3_error, time, ObjectEntry, S3};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{BucketVersioningStatus, Tag, Tagging, VersioningConfiguration};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Objects one multi-delete may touch; a bigger selection has to be narrowed first.
pub const MAX_DELETE: usize = 5000;
/// Deletes in flight at once.
const DELETE_CONCURRENCY: usize = 16;
/// S3 allows at most this many tags per object.
const MAX_TAGS: usize = 10;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ObjectTag {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct FailedDelete {
    pub key: String,
    pub error: String,
}

/// A delete marker: the version to delete to bring `key` back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub key: String,
    pub version: String,
}

#[derive(Debug, Default, Serialize)]
pub struct DeleteReport {
    /// Objects the selection expands to (selected objects plus everything under selected folders).
    pub objects: usize,
    pub deleted: usize,
    pub failed: Vec<FailedDelete>,
    /// Delete markers the deletes left behind (versioning on): what an undo removes.
    pub markers: Vec<Marker>,
}

/// What a versioned bucket still holds of deleted content, one level below a prefix.
#[derive(Debug, Default, Serialize)]
pub struct Deleted {
    /// Folders with versions in them, including those whose every object is deleted.
    pub prefixes: Vec<String>,
    /// Keys whose latest version is a delete marker; `last_modified` is when they were deleted.
    pub objects: Vec<ObjectEntry>,
    /// The listing was cut short: there may be more deleted keys than shown.
    pub truncated: bool,
}

/// Versions looked at by one "show deleted objects" request.
const DELETED_SCAN: usize = 5000;

/// S3 bucket naming rules: 3-63 characters; lowercase letters, digits, dots and hyphens;
/// starts and ends with a letter or digit; no adjacent dots or dot-hyphen pairs; not an IP address.
pub fn validate_bucket_name(name: &str) -> Result<(), String> {
    let bad = |why: &str| Err(format!("invalid bucket name {name:?}: {why}"));
    if !(3..=63).contains(&name.len()) {
        return bad("must be 3 to 63 characters long");
    }
    let allowed = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-';
    if !name.chars().all(allowed) {
        return bad("only lowercase letters, digits, dots and hyphens are allowed");
    }
    let edge_ok = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !edge_ok(name.chars().next()) || !edge_ok(name.chars().last()) {
        return bad("must start and end with a letter or digit");
    }
    if name.contains("..") || name.contains(".-") || name.contains("-.") {
        return bad("dots must be separated by letters or digits");
    }
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok()) {
        return bad("must not look like an IP address");
    }
    Ok(())
}

/// A folder is one path segment: non-empty, no `/`, and not `.` or `..`.
pub fn validate_folder_name(name: &str) -> Result<(), String> {
    let ok = !name.trim().is_empty()
        && name.len() <= 255
        && !name.contains('/')
        && !name.chars().any(char::is_control)
        && name != "."
        && name != "..";
    if ok {
        Ok(())
    } else {
        Err(format!("invalid folder name {name:?}"))
    }
}

/// At most 10 tags, unique non-empty keys up to 128 characters, values up to 256.
pub fn validate_tags(tags: &[ObjectTag]) -> Result<(), String> {
    if tags.len() > MAX_TAGS {
        return Err(format!("an object can have at most {MAX_TAGS} tags"));
    }
    for (i, tag) in tags.iter().enumerate() {
        if tag.key.trim().is_empty() || tag.key.chars().count() > 128 {
            return Err(format!(
                "invalid tag key {:?}: 1 to 128 characters",
                tag.key
            ));
        }
        if tag.value.chars().count() > 256 {
            return Err(format!(
                "the value of tag {:?} is longer than 256 characters",
                tag.key
            ));
        }
        if tags[..i].iter().any(|earlier| earlier.key == tag.key) {
            return Err(format!("tag key {:?} is used twice", tag.key));
        }
    }
    Ok(())
}

fn too_many(limit: usize) -> String {
    format!("the selection holds more than {limit} objects; work on it in smaller parts")
}

impl S3 {
    /// Creates a bucket owned by the browsed user; versioning stays off unless asked for.
    pub async fn create_bucket(&self, name: &str, versioning: bool) -> Result<(), String> {
        validate_bucket_name(name)?;
        let created = self.client.create_bucket().bucket(name).send().await;
        created.map_err(s3_error)?;
        if versioning {
            let on = VersioningConfiguration::builder().status(BucketVersioningStatus::Enabled);
            let put = self.client.put_bucket_versioning().bucket(name);
            let enabled = put.versioning_configuration(on.build()).send().await;
            enabled.map_err(|e| {
                format!(
                    "the bucket was created, but versioning could not be enabled: {}",
                    s3_error(e)
                )
            })?;
        }
        Ok(())
    }

    /// Creates the folder `name` under `prefix` the way S3 tools agree on: a zero-byte object
    /// whose key ends in `/`. Returns that key. An existing folder is left alone.
    pub async fn create_folder(
        &self,
        bucket: &str,
        prefix: &str,
        name: &str,
    ) -> Result<String, String> {
        validate_folder_name(name)?;
        let key = format!("{prefix}{}/", name.trim());
        if self.head(bucket, &key, None).await.is_ok() {
            return Err(format!("folder {key:?} already exists"));
        }
        let put = self.client.put_object().bucket(bucket).key(&key);
        let put = put
            .content_type("application/x-directory")
            .body(ByteStream::from_static(b""));
        put.send().await.map_err(s3_error)?;
        Ok(key)
    }

    /// Every key under `prefix` (all levels, folder markers included; the empty prefix is the
    /// whole bucket), sorted. Fails rather than truncate when there are more than `limit`.
    pub async fn keys_under(
        &self,
        bucket: &str,
        prefix: &str,
        limit: usize,
    ) -> Result<Vec<String>, String> {
        let mut all = Vec::new();
        let mut token = None;
        loop {
            let page = self.client.list_objects_v2().bucket(bucket).prefix(prefix);
            let out = page.set_continuation_token(token).send().await;
            let out = out.map_err(s3_error)?;
            all.extend(
                out.contents()
                    .iter()
                    .filter_map(|o| o.key().map(str::to_string)),
            );
            if all.len() > limit {
                return Err(too_many(limit));
            }
            token = out
                .next_continuation_token()
                .filter(|_| out.is_truncated() == Some(true))
                .map(str::to_string);
            if token.is_none() {
                return Ok(all);
            }
        }
    }

    /// The object keys a selection stands for: `keys` themselves plus every key under each of
    /// `prefixes`. Fails rather than truncate when the selection is larger than `limit`.
    pub async fn expand(
        &self,
        bucket: &str,
        keys: &[String],
        prefixes: &[String],
        limit: usize,
    ) -> Result<Vec<String>, String> {
        let mut all: Vec<String> = keys.to_vec();
        for prefix in prefixes {
            if prefix.is_empty() {
                return Err("refusing to select a whole bucket for deletion".into());
            }
            all.extend(self.keys_under(bucket, prefix, limit).await?);
        }
        all.sort();
        all.dedup();
        if all.len() > limit {
            return Err(too_many(limit));
        }
        Ok(all)
    }

    /// Deletes the given keys, several at a time, and reports what could not be deleted.
    pub async fn delete_many(&self, bucket: &str, keys: Vec<String>) -> DeleteReport {
        let all = keys.into_iter().map(|key| (key, None)).collect();
        self.delete_each(bucket, all).await
    }

    /// Removes delete markers, which makes the objects under them current again.
    pub async fn undelete(&self, bucket: &str, markers: Vec<Marker>) -> DeleteReport {
        let all = markers.into_iter().map(|m| (m.key, Some(m.version)));
        self.delete_each(bucket, all.collect()).await
    }

    // shortcut: one DeleteObject per key instead of DeleteObjects batches, because a batch of
    // 1000 can outlast the HTTP timeout on a slow cluster; switch if round trips become the cost.
    async fn delete_each(
        &self,
        bucket: &str,
        items: Vec<(String, Option<String>)>,
    ) -> DeleteReport {
        let objects = items.len();
        let deletes = items.into_iter().map(|(key, version)| async move {
            let result = self.delete(bucket, &key, version.as_deref()).await;
            (key, result)
        });
        let results: Vec<_> = stream::iter(deletes)
            .buffer_unordered(DELETE_CONCURRENCY)
            .collect()
            .await;
        let mut report = DeleteReport {
            objects,
            ..Default::default()
        };
        for (key, result) in results {
            match result {
                Ok(marker) => {
                    report.deleted += 1;
                    report
                        .markers
                        .extend(marker.map(|version| Marker { key, version }));
                }
                Err(error) => report.failed.push(FailedDelete { key, error }),
            }
        }
        report.failed.sort_by(|a, b| a.key.cmp(&b.key));
        report
    }

    /// Switches the bucket's versioning on, or suspends it (S3 has no way back to "never on":
    /// suspended keeps the old versions and stops making new ones). Only the owner may.
    pub async fn set_versioning(&self, bucket: &str, on: bool) -> Result<(), String> {
        let status = match on {
            true => BucketVersioningStatus::Enabled,
            false => BucketVersioningStatus::Suspended,
        };
        let config = VersioningConfiguration::builder().status(status).build();
        let put = self.client.put_bucket_versioning().bucket(bucket);
        let sent = put.versioning_configuration(config).send().await;
        sent.map(|_| ()).map_err(s3_error)
    }

    /// Deleted keys directly under `prefix` that can still be restored: those whose latest
    /// version is a delete marker.
    // shortcut: looks at the first DELETED_SCAN versions under the prefix and says so when
    // there are more; page through them if folders with that many versions turn out to matter.
    pub async fn list_deleted(&self, bucket: &str, prefix: &str) -> Result<Deleted, String> {
        let mut found = Deleted::default();
        let (mut key_marker, mut version_marker) = (None::<String>, None::<String>);
        let mut seen = 0;
        loop {
            let page = self.client.list_object_versions().bucket(bucket);
            let page = page.prefix(prefix).delimiter("/");
            let page = page
                .set_key_marker(key_marker)
                .set_version_id_marker(version_marker);
            let out = page.send().await.map_err(s3_error)?;
            let prefixes = out.common_prefixes().iter();
            found
                .prefixes
                .extend(prefixes.filter_map(|p| p.prefix().map(str::to_string)));
            let latest = out.delete_markers().iter();
            for marker in latest.filter(|m| m.is_latest() == Some(true)) {
                found.objects.push(ObjectEntry {
                    key: marker.key().unwrap_or_default().to_string(),
                    last_modified: time(marker.last_modified()),
                    ..Default::default()
                });
            }
            seen += out.versions().len() + out.delete_markers().len();
            if out.is_truncated() != Some(true) {
                break;
            }
            if seen >= DELETED_SCAN {
                found.truncated = true;
                break;
            }
            key_marker = out.next_key_marker().map(str::to_string);
            version_marker = out.next_version_id_marker().map(str::to_string);
        }
        found.prefixes.dedup();
        Ok(found)
    }

    pub async fn get_tags(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
    ) -> Result<Vec<ObjectTag>, String> {
        let get = self.client.get_object_tagging().bucket(bucket).key(key);
        let out = get.set_version_id(version.map(str::to_string)).send().await;
        let out = out.map_err(s3_error)?;
        Ok(out
            .tag_set()
            .iter()
            .map(|t| ObjectTag {
                key: t.key().to_string(),
                value: t.value().to_string(),
            })
            .collect())
    }

    /// Replaces the object's tags with exactly `tags` (an empty list removes them all).
    pub async fn put_tags(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
        tags: &[ObjectTag],
    ) -> Result<(), String> {
        validate_tags(tags)?;
        let version = version.map(str::to_string);
        if tags.is_empty() {
            let delete = self.client.delete_object_tagging().bucket(bucket).key(key);
            let deleted = delete.set_version_id(version).send().await;
            return deleted.map(|_| ()).map_err(s3_error);
        }
        let mut set = Vec::new();
        for tag in tags {
            let built = Tag::builder().key(&tag.key).value(&tag.value).build();
            set.push(built.map_err(|e| e.to_string())?);
        }
        let tagging = Tagging::builder().set_tag_set(Some(set)).build();
        let tagging = tagging.map_err(|e| e.to_string())?;
        let put = self.client.put_object_tagging().bucket(bucket).key(key);
        let put = put.set_version_id(version).tagging(tagging);
        put.send().await.map(|_| ()).map_err(s3_error)
    }

    /// Every response header of a real HEAD request for the object, sorted by name. The request
    /// is presigned by the SDK and sent as is, so nothing is filtered or reinterpreted.
    pub async fn head_headers(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
    ) -> Result<Vec<(String, String)>, String> {
        let config = PresigningConfig::expires_in(Duration::from_secs(60));
        let head = self.client.head_object().bucket(bucket).key(key);
        let head = head.set_version_id(version.map(str::to_string));
        let presigned = head.presigned(config.map_err(|e| e.to_string())?).await;
        let url = presigned.map_err(s3_error)?.uri().to_string();
        let sent = self.http()?.head(url).send().await;
        let response = sent.map_err(|e| format!("cannot reach RGW: {e}"))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(format!("S3 HTTP{status} ({status}): HEAD was refused"));
        }
        let mut headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        headers.sort();
        Ok(headers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_names_follow_the_s3_rules() {
        for good in [
            "abc",
            "my-bucket",
            "logs.2026.archive",
            "a1b",
            "0bucket9",
            &"a".repeat(63),
        ] {
            assert!(validate_bucket_name(good).is_ok(), "{good}");
        }
        for bad in [
            "ab",
            &"a".repeat(64),
            "My-Bucket",
            "under_score",
            "-start",
            "end-",
            ".start",
            "two..dots",
            "dot.-dash",
            "dash-.dot",
            "192.168.1.10",
            "has space",
            "tiếng-việt",
            "",
        ] {
            assert!(
                validate_bucket_name(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
        assert!(
            validate_bucket_name("192.168.1.x").is_ok(),
            "only a full IPv4 shape is refused"
        );
    }

    #[test]
    fn folder_names_are_one_path_segment() {
        for good in ["reports", "năm 2026", "a.b", "_folder"] {
            assert!(validate_folder_name(good).is_ok(), "{good}");
        }
        for bad in ["", "  ", "a/b", ".", "..", "tab\there"] {
            assert!(validate_folder_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn tags_are_validated() {
        let tag = |key: &str, value: &str| ObjectTag {
            key: key.into(),
            value: value.into(),
        };
        assert!(validate_tags(&[]).is_ok());
        assert!(validate_tags(&[tag("env", "lab"), tag("owner", "")]).is_ok());
        assert!(validate_tags(&[tag("", "x")]).is_err());
        assert!(
            validate_tags(&[tag("env", "a"), tag("env", "b")]).is_err(),
            "duplicate key"
        );
        assert!(validate_tags(&[tag(&"k".repeat(129), "x")]).is_err());
        assert!(validate_tags(&[tag("k", &"v".repeat(257))]).is_err());
        let eleven: Vec<ObjectTag> = (0..11).map(|i| tag(&format!("k{i}"), "v")).collect();
        assert!(validate_tags(&eleven).is_err());
    }
}
