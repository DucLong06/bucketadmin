//! S3 access for browsing, always with the key of the user being browsed as.
//! The cluster's admin secret is never used here: what this module can see or change is
//! exactly what that user's key is allowed to.

pub mod parquet;
pub mod transfer;

use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use aws_sdk_s3::primitives::{DateTime, DateTimeFormat};
use aws_sdk_s3::Client;
use serde::Serialize;
use std::time::Duration;

/// Keys per listing request; also the page size of the object table.
pub const LIST_PAGE: i32 = 1000;

#[derive(Clone)]
pub struct S3 {
    client: Client,
    access_key: String,
    /// Footer of the Parquet object previewed last, so paging through it does not fetch it again.
    parquet_footer: parquet::FooterCache,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BucketEntry {
    pub name: String,
    pub created: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ObjectEntry {
    pub key: String,
    pub size: u64,
    pub last_modified: String,
    pub storage_class: String,
    pub etag: String,
    /// Owner display name or id; empty when the listing does not carry it.
    pub owner: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Listing {
    /// "Folders": common prefixes one level below the listed prefix, each ending in `/`.
    pub prefixes: Vec<String>,
    pub objects: Vec<ObjectEntry>,
    /// Pass back to get the next page; `None` on the last page.
    pub next_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ObjectHead {
    pub size: u64,
    pub content_type: String,
    pub etag: String,
    pub last_modified: String,
    pub version_id: Option<String>,
}

fn time(t: Option<&DateTime>) -> String {
    t.and_then(|t| t.fmt(DateTimeFormat::DateTime).ok())
        .unwrap_or_default()
}

/// Error text for the UI: `S3 <Code> (<status>): <message>`, the same shape as the admin
/// client's errors but marked as coming from the user's own S3 access.
pub(crate) fn s3_error<E>(err: SdkError<E>) -> String
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
{
    let status = err.raw_response().map(|r| r.status().as_u16());
    match (err.code(), status) {
        (Some(code), Some(status)) => {
            format!("S3 {code} ({status}): {}", err.message().unwrap_or(""))
        }
        // HEAD answers carry no error document, only the status.
        (None, Some(status)) => format!("S3 HTTP{status} ({status}): no error document"),
        _ => format!("cannot reach RGW: {}", DisplayErrorContext(&err)),
    }
}

/// `bytes=a-b` for `len` bytes starting at `start`.
pub(crate) fn range(start: u64, len: u64) -> String {
    format!("bytes={start}-{}", start + len.max(1) - 1)
}

impl S3 {
    /// A client for one user's key against a path-style endpoint (RGW has no bucket subdomains
    /// unless DNS is set up for them).
    pub fn new(endpoint: &str, access_key: &str, secret_key: &str) -> Self {
        let credentials = Credentials::new(access_key, secret_key, None, None, "bucketadmin");
        let timeouts = aws_sdk_s3::config::timeout::TimeoutConfig::builder()
            .connect_timeout(Duration::from_secs(10))
            .build();
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .endpoint_url(endpoint.trim_end_matches('/'))
            .credentials_provider(credentials)
            .force_path_style(true)
            .timeout_config(timeouts)
            // Newer SDKs add CRC checksums to every request by default; older Ceph releases
            // reject the trailer form, so only send them where S3 requires one.
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .build();
        Self {
            client: Client::from_conf(config),
            access_key: access_key.to_string(),
            parquet_footer: Default::default(),
        }
    }

    /// The access key this session signs with (never the secret).
    pub fn access_key(&self) -> &str {
        &self.access_key
    }

    /// The SDK client, for calls this module does not wrap (test setup).
    pub fn client(&self) -> &Client {
        &self.client
    }

    /// Buckets owned by the user. Buckets shared with the user by policy or ACL are not
    /// listed by S3; they can still be opened by name.
    pub async fn list_buckets(&self) -> Result<Vec<BucketEntry>, String> {
        let out = self.client.list_buckets().send().await.map_err(s3_error)?;
        Ok(out
            .buckets()
            .iter()
            .map(|b| BucketEntry {
                name: b.name().unwrap_or_default().to_string(),
                created: time(b.creation_date()),
            })
            .collect())
    }

    /// One page of a bucket seen as folders: keys directly under `prefix`, plus the common
    /// prefixes one `/` further down.
    pub async fn list(
        &self,
        bucket: &str,
        prefix: &str,
        token: Option<&str>,
        limit: i32,
    ) -> Result<Listing, String> {
        let out = self
            .client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .delimiter("/")
            .max_keys(limit.clamp(1, LIST_PAGE))
            .fetch_owner(true)
            .set_continuation_token(token.map(str::to_string))
            .send()
            .await
            .map_err(s3_error)?;
        Ok(Listing {
            prefixes: out
                .common_prefixes()
                .iter()
                .filter_map(|p| p.prefix().map(str::to_string))
                .collect(),
            objects: out.contents().iter().map(object_entry).collect(),
            next_token: out
                .next_continuation_token()
                .filter(|_| out.is_truncated() == Some(true))
                .map(str::to_string),
        })
    }

    pub async fn head(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
    ) -> Result<ObjectHead, String> {
        let out = self
            .client
            .head_object()
            .bucket(bucket)
            .key(key)
            .set_version_id(version.map(str::to_string))
            .send()
            .await
            .map_err(s3_error)?;
        Ok(ObjectHead {
            size: out.content_length().unwrap_or(0).max(0) as u64,
            content_type: out.content_type().unwrap_or_default().to_string(),
            etag: out.e_tag().unwrap_or_default().to_string(),
            last_modified: time(out.last_modified()),
            version_id: out.version_id().map(str::to_string),
        })
    }

    /// `len` bytes of an object starting at `start` (fewer at the end of the object).
    pub async fn read_range(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
        start: u64,
        len: u64,
    ) -> Result<Vec<u8>, String> {
        let out = self
            .client
            .get_object()
            .bucket(bucket)
            .key(key)
            .set_version_id(version.map(str::to_string))
            .range(range(start, len))
            .send()
            .await
            .map_err(s3_error)?;
        let body = out.body.collect().await;
        let body = body.map_err(|e| format!("cannot reach RGW: {e}"))?;
        Ok(body.into_bytes().to_vec())
    }
}

pub(crate) fn object_entry(o: &aws_sdk_s3::types::Object) -> ObjectEntry {
    let owner = o.owner();
    ObjectEntry {
        key: o.key().unwrap_or_default().to_string(),
        size: o.size().unwrap_or(0).max(0) as u64,
        last_modified: time(o.last_modified()),
        storage_class: o
            .storage_class()
            .map(|c| c.as_str().to_string())
            .unwrap_or_default(),
        etag: o.e_tag().unwrap_or_default().trim_matches('"').to_string(),
        owner: owner
            .and_then(|w| w.display_name().or(w.id()))
            .unwrap_or_default()
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_header() {
        assert_eq!(range(0, 4096), "bytes=0-4095");
        assert_eq!(range(4096, 1), "bytes=4096-4096");
        assert_eq!(
            range(10, 0),
            "bytes=10-10",
            "a zero length still asks for one byte"
        );
    }
}
