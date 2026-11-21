//! Upload, download, delete and presigned URLs.

use super::{range, s3_error, S3};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Size of one upload part / one download range. Also the largest single-request upload.
pub const PART_SIZE: u64 = 8 * 1024 * 1024;
/// S3's limit on the number of parts of one upload.
const MAX_PARTS: u64 = 10_000;
/// SigV4 presigned URLs cannot live longer than a week.
pub const MAX_PRESIGN_SECS: u64 = 7 * 24 * 3600;

/// Set to stop a running transfer at its next part boundary.
pub type Cancel = Arc<AtomicBool>;
/// The error of a transfer that was stopped on request.
pub const CANCELLED: &str = "cancelled";

#[derive(Debug, Serialize)]
pub struct Downloaded {
    pub path: String,
    pub size: u64,
    /// Bytes that were already on disk from an interrupted attempt and were not fetched again.
    pub resumed_from: u64,
}

/// MIME type for a key, by extension. Used as the stored type of uploads and to make a
/// presigned URL answer with a type the webview can display.
pub fn content_type_for(key: &str) -> &'static str {
    let ext = key.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "txt" | "log" | "md" | "ini" | "conf" | "toml" | "sh" | "py" | "rs" => "text/plain",
        "json" | "ndjson" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "parquet" => "application/vnd.apache.parquet",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        _ => "application/octet-stream",
    }
}

/// Whether two URLs share scheme, host and port (default ports made explicit).
pub fn same_origin(a: &str, b: &str) -> bool {
    let origin = |url: &str| {
        let url = reqwest::Url::parse(url).ok()?;
        let host = url.host_str()?.to_ascii_lowercase();
        Some((url.scheme().to_string(), host, url.port_or_known_default()?))
    };
    matches!((origin(a), origin(b)), (Some(x), Some(y)) if x == y)
}

impl S3 {
    /// The endpoint with `bucket.` before its host: where virtual-host style URLs point.
    fn bucket_host(&self, bucket: &str) -> String {
        match reqwest::Url::parse(&self.endpoint) {
            Ok(mut url) => {
                let host = format!("{bucket}.{}", url.host_str().unwrap_or_default());
                match url.set_host(Some(&host)) {
                    Ok(()) => url.to_string(),
                    Err(_) => self.endpoint.clone(),
                }
            }
            Err(_) => self.endpoint.clone(),
        }
    }
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

impl S3 {
    /// [`S3::upload_with`] that cannot be cancelled.
    pub async fn upload<F>(
        &self,
        bucket: &str,
        key: &str,
        path: &Path,
        progress: F,
    ) -> Result<u64, String>
    where
        F: Fn(u64, u64) + Send + Sync,
    {
        let never = Cancel::default();
        self.upload_with(bucket, key, path, progress, &never).await
    }

    /// Uploads a file; anything larger than one part goes up as a multipart upload.
    /// `progress(done, total)` is called after every part. Returns the size.
    /// Setting `cancel` stops it after the part in flight; nothing is left on the cluster.
    pub async fn upload_with<F>(
        &self,
        bucket: &str,
        key: &str,
        path: &Path,
        progress: F,
        cancel: &Cancel,
    ) -> Result<u64, String>
    where
        F: Fn(u64, u64) + Send + Sync,
    {
        let unreadable = |e: std::io::Error| format!("cannot read {}: {e}", path.display());
        let meta = tokio::fs::metadata(path).await.map_err(unreadable)?;
        if !meta.is_file() {
            return Err(format!("{} is not a file", path.display()));
        }
        let total = meta.len();
        let content_type = content_type_for(key);
        if cancel.load(SeqCst) {
            return Err(CANCELLED.into());
        }
        if total <= PART_SIZE {
            let body = ByteStream::from_path(path).await;
            let body = body.map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            let put = self.client.put_object().bucket(bucket).key(key);
            let sent = put.content_type(content_type).body(body).send().await;
            sent.map_err(s3_error)?;
            progress(total, total);
            return Ok(total);
        }

        let create = self
            .client
            .create_multipart_upload()
            .bucket(bucket)
            .key(key);
        let created = create
            .content_type(content_type)
            .send()
            .await
            .map_err(s3_error)?;
        let upload_id = created
            .upload_id()
            .ok_or("RGW did not return an upload id")?
            .to_string();
        // Reports a finished part and says whether to go on.
        let step = |done: u64, all: u64| {
            progress(done, all);
            !cancel.load(SeqCst)
        };
        let result = self
            .upload_parts(bucket, key, &upload_id, path, total, &step)
            .await;
        if result.is_err() {
            // Parts of an unfinished upload take space but show up in no listing: remove them.
            let abort = self.client.abort_multipart_upload().bucket(bucket).key(key);
            let _ = abort.upload_id(&upload_id).send().await;
        }
        result.map(|()| total)
    }

    async fn upload_parts(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        path: &Path,
        total: u64,
        step: &(dyn Fn(u64, u64) -> bool + Send + Sync),
    ) -> Result<(), String> {
        let unreadable = |e: std::io::Error| format!("cannot read {}: {e}", path.display());
        let part_size = PART_SIZE.max(total.div_ceil(MAX_PARTS));
        let mut file = tokio::fs::File::open(path).await.map_err(unreadable)?;
        let mut parts = Vec::new();
        let mut done = 0;
        // shortcut: one part at a time; send a few in parallel if large uploads prove slow.
        while done < total {
            let mut buf = vec![0; part_size.min(total - done) as usize];
            file.read_exact(&mut buf).await.map_err(unreadable)?;
            let number = parts.len() as i32 + 1;
            let len = buf.len() as u64;
            let part = self.client.upload_part().bucket(bucket).key(key);
            let part = part.upload_id(upload_id).part_number(number);
            let sent = part
                .body(ByteStream::from(buf))
                .send()
                .await
                .map_err(s3_error)?;
            let completed = CompletedPart::builder().part_number(number);
            parts.push(
                completed
                    .set_e_tag(sent.e_tag().map(str::to_string))
                    .build(),
            );
            done += len;
            if !step(done, total) {
                return Err(CANCELLED.into());
            }
        }
        let all = CompletedMultipartUpload::builder()
            .set_parts(Some(parts))
            .build();
        let complete = self
            .client
            .complete_multipart_upload()
            .bucket(bucket)
            .key(key);
        let complete = complete.upload_id(upload_id).multipart_upload(all);
        complete.send().await.map_err(s3_error)?;
        Ok(())
    }

    /// [`S3::download_with`] that cannot be cancelled.
    pub async fn download<F>(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
        dest: &Path,
        progress: F,
    ) -> Result<Downloaded, String>
    where
        F: Fn(u64, u64) + Send + Sync,
    {
        let never = Cancel::default();
        self.download_with(bucket, key, version, dest, progress, &never)
            .await
    }

    /// Downloads an object in ranges to `dest`, through `<dest>.part`. If an earlier attempt for
    /// the same object (same ETag) was interrupted, the bytes already on disk are kept and only
    /// the rest is fetched. `progress(done, total)` is called after every range.
    /// Setting `cancel` stops it after the range in flight; the `.part` file stays for a later resume.
    pub async fn download_with<F>(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
        dest: &Path,
        progress: F,
        cancel: &Cancel,
    ) -> Result<Downloaded, String>
    where
        F: Fn(u64, u64) + Send + Sync,
    {
        let head = self.head(bucket, key, version).await?;
        let (part, tag) = (suffixed(dest, ".part"), suffixed(dest, ".part.etag"));
        let unwritable = |e: std::io::Error| format!("cannot write {}: {e}", part.display());

        // Resume only what is provably the same object as when the partial file was started.
        let same_object = tokio::fs::read_to_string(&tag)
            .await
            .is_ok_and(|t| t == head.etag);
        let have = match tokio::fs::metadata(&part).await {
            Ok(meta) if same_object && meta.len() <= head.size => meta.len(),
            _ => 0,
        };
        tokio::fs::write(&tag, &head.etag)
            .await
            .map_err(unwritable)?;
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true);
        if have > 0 {
            options.append(true);
        } else {
            options.write(true).truncate(true);
        }
        let mut file = options.open(&part).await.map_err(unwritable)?;

        let mut done = have;
        progress(done, head.size);
        while done < head.size {
            if cancel.load(SeqCst) {
                // Keep what is on disk: the next attempt resumes from here.
                file.flush().await.map_err(unwritable)?;
                return Err(CANCELLED.into());
            }
            let get = self.client.get_object().bucket(bucket).key(key);
            let get = get.set_version_id(version.map(str::to_string));
            // If-Match: a replaced object must fail the download, not get spliced into it.
            let get = get.range(range(done, PART_SIZE.min(head.size - done)));
            let out = get.if_match(&head.etag).send().await.map_err(s3_error)?;
            let body = out.body.collect().await;
            let bytes = body
                .map_err(|e| format!("cannot reach RGW: {e}"))?
                .into_bytes();
            if bytes.is_empty() {
                return Err("RGW returned an empty range".into());
            }
            file.write_all(&bytes).await.map_err(unwritable)?;
            done += bytes.len() as u64;
            progress(done, head.size);
        }
        file.flush().await.map_err(unwritable)?;
        drop(file);
        tokio::fs::rename(&part, dest)
            .await
            .map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
        let _ = tokio::fs::remove_file(&tag).await;
        Ok(Downloaded {
            path: dest.display().to_string(),
            size: head.size,
            resumed_from: have,
        })
    }

    /// Deletes an object, or exactly one version of it when `version` is given. With
    /// versioning on, deleting an object only puts a delete marker on top of it: the marker's
    /// version id is returned, and deleting that version brings the object back.
    pub async fn delete(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
    ) -> Result<Option<String>, String> {
        let delete = self.client.delete_object().bucket(bucket).key(key);
        let delete = delete.set_version_id(version.map(str::to_string));
        let out = delete.send().await.map_err(s3_error)?;
        // "null" is the marker of a bucket with versioning suspended: it replaced the data.
        let marker = out
            .version_id()
            .filter(|id| version.is_none() && out.delete_marker() == Some(true) && *id != "null");
        Ok(marker.map(str::to_string))
    }

    /// A URL that lets anyone holding it GET the object for `expires_secs`. `inline_type`
    /// makes the answer carry that Content-Type (so a browser shows it instead of saving it).
    pub async fn presign_get(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
        expires_secs: u64,
        inline_type: Option<&str>,
    ) -> Result<String, String> {
        if !(1..=MAX_PRESIGN_SECS).contains(&expires_secs) {
            return Err("presign expiry must be between 1 second and 7 days".into());
        }
        let config = PresigningConfig::expires_in(Duration::from_secs(expires_secs));
        let config = config.map_err(|e| e.to_string())?;
        let get = self.client.get_object().bucket(bucket).key(key);
        let get = get.set_version_id(version.map(str::to_string));
        let get = get.set_response_content_type(inline_type.map(str::to_string));
        let request = get.presigned(config).await.map_err(s3_error)?;
        let url = request.uri().to_string();
        // Cannot differ by construction; checked anyway because whoever gets this URL gets the object.
        // Virtual-host style names the bucket in the host, but the SDK keeps a bucket name that is no host name in the path.
        let at_bucket = !self.path_style && same_origin(&url, &self.bucket_host(bucket));
        if !same_origin(&url, &self.endpoint) && !at_bucket {
            return Err("presigned URL does not point at the cluster endpoint".into());
        }
        Ok(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::s3::Addressing;
    use crate::settings::Proxy;

    #[test]
    fn content_types_by_extension() {
        assert_eq!(content_type_for("a/b/report.PDF"), "application/pdf");
        assert_eq!(
            content_type_for("data.parquet"),
            "application/vnd.apache.parquet"
        );
        assert_eq!(content_type_for("clip.mp4"), "video/mp4");
        assert_eq!(content_type_for("notes"), "application/octet-stream");
        assert_eq!(content_type_for("archive.tar.gz"), "application/gzip");
    }

    #[test]
    fn origins_compare_scheme_host_and_port() {
        let endpoint = "http://rgw.example:7480";
        assert!(same_origin(
            "http://rgw.example:7480/bucket/key?X-Amz-Signature=abc",
            endpoint
        ));
        assert!(same_origin("HTTP://RGW.EXAMPLE:7480/x", endpoint));
        assert!(same_origin(
            "https://s3.example/b/k",
            "https://s3.example:443"
        ));
        assert!(
            !same_origin("https://rgw.example:7480/b/k", endpoint),
            "scheme differs"
        );
        assert!(
            !same_origin("http://rgw.example:7481/b/k", endpoint),
            "port differs"
        );
        assert!(
            !same_origin("http://rgw.example.evil.test:7480/b/k", endpoint),
            "host differs"
        );
        assert!(!same_origin(
            "http://evil.test/?http://rgw.example:7480",
            endpoint
        ));
        assert!(!same_origin("not a url", endpoint));
    }

    #[tokio::test]
    async fn presigned_urls_follow_the_addressing() {
        let endpoint = "http://rgw.example:7480";
        let path = S3::with_proxy(endpoint, "AK", "SK", &Proxy::None).unwrap();
        let url = path.presign_get("b", "k", None, 60, None).await.unwrap();
        assert!(url.starts_with("http://rgw.example:7480/b/k?"), "{url}");
        assert!(url.contains("us-east-1"), "{url}");
        let virtual_host = Addressing {
            region: "eu-west-1".into(),
            path_style: false,
        };
        let host = S3::connect(endpoint, "AK", "SK", &Proxy::None, &virtual_host).unwrap();
        let url = host
            .presign_get("bucket-a", "k", None, 60, None)
            .await
            .unwrap();
        assert!(
            url.starts_with("http://bucket-a.rgw.example:7480/k?"),
            "{url}"
        );
        assert!(url.contains("eu-west-1"), "{url}");
        // A bucket name that is no host name stays in the path.
        let url = host.presign_get("b", "k", None, 60, None).await.unwrap();
        assert!(url.starts_with("http://rgw.example:7480/b/k?"), "{url}");
    }

    #[test]
    fn part_file_names() {
        assert_eq!(
            suffixed(Path::new("/tmp/a.bin"), ".part"),
            PathBuf::from("/tmp/a.bin.part")
        );
    }
}
