//! Client for the Ceph RGW Admin Ops API (`<base>/admin/<resource>?format=json`).
//! Reference: ceph/ceph `doc/radosgw/adminops.rst`.

#[cfg(test)]
pub(crate) mod mock;
pub mod sigv4;
mod types;

pub use sigv4::Credentials;
pub use types::*;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RgwError {
    #[error("AccessDenied (403): the admin user lacks the caps for this operation")]
    AccessDenied,
    #[error("SignatureDoesNotMatch (403): the secret key is wrong")]
    SignatureDoesNotMatch,
    #[error("InvalidAccessKeyId (403): the access key is unknown to this cluster")]
    InvalidAccessKeyId,
    #[error("NoSuchUser (404): user does not exist")]
    NoSuchUser,
    #[error("NoSuchBucket (404): bucket does not exist")]
    NoSuchBucket,
    #[error("NoSuchKey (404): no such access key")]
    NoSuchKey,
    #[error("NoSuchCap (404): user does not have that capability")]
    NoSuchCap,
    #[error("UserAlreadyExists (409): user already exists")]
    UserAlreadyExists,
    #[error("KeyExists (409): access key belongs to another user")]
    KeyExists,
    #[error("EmailExists (409): email address already in use")]
    EmailExists,
    #[error("InvalidCapability (400): invalid admin capability")]
    InvalidCapability,
    #[error("RGW returned HTTP {status} {code} {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
    },
    #[error("cannot reach RGW: {0}")]
    Transport(String),
    #[error("unexpected response from RGW: {0}")]
    Decode(String),
    #[error("invalid endpoint: {0}")]
    InvalidEndpoint(String),
}

pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Transport seam: the real client is [`ReqwestClient`], tests inject a mock.
pub trait HttpClient: Send + Sync {
    fn send(&self, req: HttpRequest) -> impl Future<Output = Result<HttpResponse, String>> + Send;
}

#[derive(Clone)]
pub struct ReqwestClient(reqwest::Client);

impl ReqwestClient {
    pub fn new() -> Result<Self, RgwError> {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map(Self)
            .map_err(|e| RgwError::Transport(error_chain(&e)))
    }
}

/// reqwest's top-level message hides the cause ("connection refused", TLS...).
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        msg.push_str(&format!(": {s}"));
        source = s.source();
    }
    msg
}

impl HttpClient for ReqwestClient {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, String> {
        let method =
            reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut builder = self.0.request(method, &req.url).body(req.body);
        for (k, v) in &req.headers {
            builder = builder.header(k, v);
        }
        let resp = builder.send().await.map_err(|e| error_chain(&e))?;
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into()))
            .collect();
        let body = resp.bytes().await.map_err(|e| error_chain(&e))?.to_vec();
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

/// Checks that `endpoint` is an http(s) URL with a host and returns it parsed.
pub fn parse_endpoint(endpoint: &str) -> Result<reqwest::Url, RgwError> {
    let url = reqwest::Url::parse(endpoint.trim())
        .map_err(|e| RgwError::InvalidEndpoint(format!("{endpoint}: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(RgwError::InvalidEndpoint(format!(
            "{endpoint}: expected http://host:port or https://host:port"
        )));
    }
    Ok(url)
}

pub struct RgwAdmin<H = ReqwestClient> {
    http: H,
    origin: String,
    host: String,
    base_path: String,
    creds: Credentials,
}

impl<H: HttpClient> RgwAdmin<H> {
    pub fn new(endpoint: &str, creds: Credentials, http: H) -> Result<Self, RgwError> {
        let url = parse_endpoint(endpoint)?;
        // Host header value: port only when it is not the scheme default.
        let host = match (url.host_str(), url.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            (None, _) => unreachable!("parse_endpoint guarantees a host"),
        };
        Ok(Self {
            http,
            origin: format!("{}://{host}", url.scheme()),
            host,
            base_path: url.path().trim_end_matches('/').to_string(),
            creds,
        })
    }

    async fn send(
        &self,
        method: &'static str,
        resource: &str,
        params: &[(&str, &str)],
    ) -> Result<HttpResponse, RgwError> {
        let mut all = vec![("format", "json")];
        all.extend_from_slice(params);
        let query = sigv4::canonical_query(&all);
        let path = format!("{}/admin/{resource}", self.base_path);
        let body = Vec::new(); // every Admin Ops call we make carries its arguments in the query
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| RgwError::Transport(format!("system clock before 1970: {e}")))?;
        let headers = sigv4::sign(
            method,
            &self.host,
            &path,
            &query,
            &body,
            &self.creds,
            &sigv4::amz_date(now.as_secs()),
        );
        let req = HttpRequest {
            method,
            url: format!("{}{path}?{query}", self.origin),
            headers,
            body,
        };
        let resp = self.http.send(req).await.map_err(RgwError::Transport)?;
        if (200..300).contains(&resp.status) {
            Ok(resp)
        } else {
            Err(error_from_response(&resp))
        }
    }

    async fn json<T: DeserializeOwned>(
        &self,
        method: &'static str,
        resource: &str,
        params: &[(&str, &str)],
    ) -> Result<T, RgwError> {
        let resp = self.send(method, resource, params).await?;
        serde_json::from_slice(&resp.body).map_err(|e| RgwError::Decode(e.to_string()))
    }

    /// `GET /admin/info` (caps: info=read).
    pub async fn get_info(&self) -> Result<ClusterInfo, RgwError> {
        let resp = self.send("GET", "info", &[]).await?;
        let v: serde_json::Value =
            serde_json::from_slice(&resp.body).map_err(|e| RgwError::Decode(e.to_string()))?;
        let cluster_id = v
            .pointer("/info/storage_backends/0/cluster_id")
            .and_then(|c| c.as_str())
            .ok_or_else(|| RgwError::Decode("no cluster_id in /admin/info response".into()))?
            .to_string();
        let version = resp
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("server"))
            .map(|(_, v)| v.clone());
        Ok(ClusterInfo {
            cluster_id,
            version,
        })
    }

    /// `GET /admin/metadata/user` (caps: metadata=read) — all user ids.
    pub async fn list_users(&self) -> Result<Vec<String>, RgwError> {
        self.json("GET", "metadata/user", &[]).await
    }

    /// One page of user ids. RGW has no offset: pass the previous page's `marker` to continue.
    pub async fn list_users_page(
        &self,
        marker: Option<&str>,
        max_entries: usize,
    ) -> Result<UserIdPage, RgwError> {
        let max = max_entries.to_string();
        let mut params = vec![("max-entries", max.as_str())];
        if let Some(marker) = marker {
            params.push(("marker", marker));
        }
        self.json("GET", "metadata/user", &params).await
    }

    pub async fn get_user(&self, uid: &str) -> Result<UserInfo, RgwError> {
        self.json("GET", "user", &[("uid", uid)]).await
    }

    /// `access_key` / `secret_key`: `None` lets RGW generate that half of the key pair.
    pub async fn create_user(
        &self,
        uid: &str,
        display_name: &str,
        email: Option<&str>,
        access_key: Option<&str>,
        secret_key: Option<&str>,
    ) -> Result<UserInfo, RgwError> {
        let mut params = vec![("uid", uid), ("display-name", display_name)];
        let optional = [
            ("email", email),
            ("access-key", access_key),
            ("secret-key", secret_key),
        ];
        params.extend(optional.iter().filter_map(|(k, v)| v.map(|v| (*k, v))));
        self.json("PUT", "user", &params).await
    }

    /// `PUT /admin/user?key`: adds an S3 key and returns all S3 keys of the user.
    /// `None` lets RGW generate that half of the key pair.
    pub async fn create_key(
        &self,
        uid: &str,
        access_key: Option<&str>,
        secret_key: Option<&str>,
    ) -> Result<Vec<KeyPair>, RgwError> {
        let mut params = vec![("key", ""), ("uid", uid)];
        let optional = [("access-key", access_key), ("secret-key", secret_key)];
        params.extend(optional.iter().filter_map(|(k, v)| v.map(|v| (*k, v))));
        self.json("PUT", "user", &params).await
    }

    /// `DELETE /admin/user?key`. Squid answers 403 InvalidAccessKeyId for an unknown key.
    pub async fn remove_key(&self, uid: &str, access_key: &str) -> Result<(), RgwError> {
        let params = [("key", ""), ("uid", uid), ("access-key", access_key)];
        self.send("DELETE", "user", &params).await.map(|_| ())
    }

    /// `PUT /admin/user?subuser=<name>`: creates a Swift subuser (RGW generates its secret)
    /// and returns every subuser of the user. `access`: read | write | readwrite | full.
    pub async fn create_subuser(
        &self,
        uid: &str,
        subuser: &str,
        access: &str,
    ) -> Result<Vec<Subuser>, RgwError> {
        let params = [("uid", uid), ("subuser", subuser), ("access", access)];
        self.json("PUT", "user", &params).await
    }

    /// `DELETE /admin/user?subuser=<name>`; its Swift key is removed with it.
    /// Squid answers 404 NoSuchSubUser for an unknown subuser.
    pub async fn remove_subuser(&self, uid: &str, subuser: &str) -> Result<(), RgwError> {
        let params = [("uid", uid), ("subuser", subuser), ("purge-keys", "true")];
        self.send("DELETE", "user", &params).await.map(|_| ())
    }

    pub async fn modify_user(&self, uid: &str, changes: &UserModify) -> Result<UserInfo, RgwError> {
        let max_buckets = changes.max_buckets.map(|n| n.to_string());
        let mut params = vec![("uid", uid)];
        if let Some(v) = &changes.display_name {
            params.push(("display-name", v));
        }
        if let Some(v) = &changes.email {
            params.push(("email", v));
        }
        if let Some(v) = &max_buckets {
            params.push(("max-buckets", v));
        }
        if let Some(v) = changes.suspended {
            params.push(("suspended", if v { "true" } else { "false" }));
        }
        self.json("POST", "user", &params).await
    }

    /// `purge_data` also deletes the user's buckets and objects.
    pub async fn delete_user(&self, uid: &str, purge_data: bool) -> Result<(), RgwError> {
        let mut params = vec![("uid", uid)];
        if purge_data {
            params.push(("purge-data", "true"));
        }
        self.send("DELETE", "user", &params).await.map(|_| ())
    }

    /// `caps` syntax: `users=*;usage=read`. Returns the user's caps afterwards.
    pub async fn add_caps(&self, uid: &str, caps: &str) -> Result<Vec<Capability>, RgwError> {
        // The bare `caps` sub-resource is mandatory: without it RGW treats the
        // PUT as create-user and answers 409 UserAlreadyExists.
        self.json(
            "PUT",
            "user",
            &[("caps", ""), ("uid", uid), ("user-caps", caps)],
        )
        .await
    }

    pub async fn remove_caps(&self, uid: &str, caps: &str) -> Result<Vec<Capability>, RgwError> {
        self.json(
            "DELETE",
            "user",
            &[("caps", ""), ("uid", uid), ("user-caps", caps)],
        )
        .await
    }

    pub async fn get_quota(&self, uid: &str, quota_type: QuotaType) -> Result<Quota, RgwError> {
        self.json(
            "GET",
            "user",
            &[
                ("quota", ""),
                ("uid", uid),
                ("quota-type", quota_type.as_str()),
            ],
        )
        .await
    }

    /// Negative `max_size_kb` / `max_objects` mean "unlimited".
    pub async fn set_quota(
        &self,
        uid: &str,
        quota_type: QuotaType,
        enabled: bool,
        max_size_kb: i64,
        max_objects: i64,
    ) -> Result<(), RgwError> {
        let (size, objects) = (max_size_kb.to_string(), max_objects.to_string());
        let params = [
            ("quota", ""),
            ("uid", uid),
            ("quota-type", quota_type.as_str()),
            ("enabled", if enabled { "true" } else { "false" }),
            ("max-size-kb", &size),
            ("max-objects", &objects),
        ];
        self.send("PUT", "user", &params).await.map(|_| ())
    }

    /// `GET /admin/usage` (caps: usage=read); `uid = None` covers all users.
    pub async fn get_usage(&self, uid: Option<&str>) -> Result<Usage, RgwError> {
        let params: Vec<(&str, &str)> = uid.map(|u| ("uid", u)).into_iter().collect();
        self.json("GET", "usage", &params).await
    }
}

fn error_from_response(resp: &HttpResponse) -> RgwError {
    #[derive(Deserialize, Default)]
    #[serde(default, rename_all = "PascalCase")]
    struct ErrorBody {
        code: String,
        message: String,
    }
    let parsed = serde_json::from_slice::<ErrorBody>(&resp.body);
    let is_json = parsed.is_ok();
    let body = parsed.unwrap_or_default();
    match body.code.as_str() {
        "AccessDenied" => RgwError::AccessDenied,
        "SignatureDoesNotMatch" => RgwError::SignatureDoesNotMatch,
        "InvalidAccessKeyId" => RgwError::InvalidAccessKeyId,
        "NoSuchUser" => RgwError::NoSuchUser,
        "NoSuchBucket" => RgwError::NoSuchBucket,
        "NoSuchKey" => RgwError::NoSuchKey,
        "NoSuchCap" => RgwError::NoSuchCap,
        // adminops.rst says UserExists, squid answers UserAlreadyExists.
        "UserAlreadyExists" | "UserExists" => RgwError::UserAlreadyExists,
        "KeyExists" => RgwError::KeyExists,
        "EmailExists" => RgwError::EmailExists,
        "InvalidCapability" => RgwError::InvalidCapability,
        _ => RgwError::Api {
            status: resp.status,
            code: body.code,
            message: if is_json {
                body.message
            } else {
                // Not an RGW error document (proxy page, wrong port...): show a snippet.
                String::from_utf8_lossy(&resp.body)
                    .chars()
                    .take(200)
                    .collect()
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::mock::Mock;
    use super::*;

    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[tokio::test]
    async fn get_info_signs_s3_style_and_parses() {
        let mock = Mock::reply(
            200,
            r#"{"info":{"storage_backends":[{"name":"rados","cluster_id":"114dc4f2"}]}}"#,
        );
        let info = mock.client().get_info().await.unwrap();
        assert_eq!(info.cluster_id, "114dc4f2");
        assert_eq!(info.version.as_deref(), Some("Ceph Object Gateway (squid)"));

        let reqs = mock.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "GET");
        assert_eq!(reqs[0].url, "http://rgw.test:7480/admin/info?format=json");
        let header = |name: &str| {
            let found = reqs[0].headers.iter().find(|(k, _)| k == name);
            found.unwrap_or_else(|| panic!("missing {name}")).1.clone()
        };
        assert_eq!(header("x-amz-content-sha256"), EMPTY_SHA256);
        assert_eq!(header("x-amz-date").len(), 16);
        let auth = header("authorization");
        assert!(
            auth.starts_with("AWS4-HMAC-SHA256 Credential=AK/"),
            "{auth}"
        );
        assert!(auth.contains("/us-east-1/s3/aws4_request"), "{auth}");
        assert!(auth.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
    }

    #[tokio::test]
    async fn list_users_parses_uid_array() {
        let mock = Mock::reply(200, r#"["dashboard","bucketadmin"]"#);
        let users = mock.client().list_users().await.unwrap();
        assert_eq!(users, ["dashboard", "bucketadmin"]);
        assert_eq!(
            mock.sent(),
            (
                "GET",
                "http://rgw.test:7480/admin/metadata/user?format=json".into()
            )
        );
    }

    #[tokio::test]
    async fn get_user_parses_lab_shape() {
        // Trimmed copy of a real squid 19.2.7 response (keys replaced).
        let mock = Mock::reply(
            200,
            r#"{"tenant":"","user_id":"bucketadmin","display_name":"BucketAdmin App","email":"",
                "suspended":0,"max_buckets":1000,"subusers":[],
                "keys":[{"user":"bucketadmin","access_key":"AKEXAMPLE","secret_key":"SKEXAMPLE","active":true}],
                "caps":[{"type":"buckets","perm":"*"},{"type":"info","perm":"read"}],
                "user_quota":{"enabled":false,"check_on_raw":false,"max_size":-1,"max_size_kb":0,"max_objects":-1},
                "type":"rgw","mfa_ids":[]}"#,
        );
        let user = mock.client().get_user("bucketadmin").await.unwrap();
        assert_eq!(user.user_id, "bucketadmin");
        assert_eq!(user.max_buckets, 1000);
        assert_eq!(user.keys[0].access_key, "AKEXAMPLE");
        assert_eq!(user.caps[1].cap_type, "info");
        assert_eq!(user.user_quota.unwrap().max_size, -1);
        assert_eq!(user.bucket_quota, None);
        assert!(!format!("{:?}", user.keys).contains("SKEXAMPLE"));
        assert_eq!(
            mock.sent().1,
            "http://rgw.test:7480/admin/user?format=json&uid=bucketadmin"
        );
    }

    #[tokio::test]
    async fn create_modify_delete_use_documented_verbs() {
        let mock = Mock::reply(200, r#"{"user_id":"u1"}"#);
        mock.client()
            .create_user("u1", "User One", Some("u1@example.com"), None, None)
            .await
            .unwrap();
        assert_eq!(
            mock.sent(),
            (
                "PUT",
                "http://rgw.test:7480/admin/user?display-name=User%20One&email=u1%40example.com&format=json&uid=u1".into()
            )
        );

        let mock = Mock::reply(200, r#"{"user_id":"u1","suspended":1}"#);
        let changes = UserModify {
            suspended: Some(true),
            max_buckets: Some(5),
            ..Default::default()
        };
        let user = mock.client().modify_user("u1", &changes).await.unwrap();
        assert_eq!(user.suspended, 1);
        assert_eq!(
            mock.sent(),
            (
                "POST",
                "http://rgw.test:7480/admin/user?format=json&max-buckets=5&suspended=true&uid=u1"
                    .into()
            )
        );

        let mock = Mock::reply(200, "");
        mock.client().delete_user("u1", true).await.unwrap();
        assert_eq!(
            mock.sent(),
            (
                "DELETE",
                "http://rgw.test:7480/admin/user?format=json&purge-data=true&uid=u1".into()
            )
        );
    }

    #[tokio::test]
    async fn caps_calls_carry_the_caps_subresource() {
        let mock = Mock::reply(200, r#"[{"type":"usage","perm":"read"}]"#);
        let caps = mock.client().add_caps("u1", "usage=read").await.unwrap();
        assert_eq!(caps[0].perm, "read");
        assert_eq!(
            mock.sent(),
            (
                "PUT",
                "http://rgw.test:7480/admin/user?caps=&format=json&uid=u1&user-caps=usage%3Dread"
                    .into()
            )
        );

        let mock = Mock::reply(200, "[]");
        let caps = mock.client().remove_caps("u1", "usage=read").await.unwrap();
        assert!(caps.is_empty());
        let (method, url) = mock.sent();
        assert_eq!(method, "DELETE");
        assert!(url.contains("?caps=&"), "{url}");
    }

    #[tokio::test]
    async fn quota_get_and_set() {
        let mock = Mock::reply(
            200,
            r#"{"enabled":true,"check_on_raw":false,"max_size":1048576,"max_size_kb":1024,"max_objects":-1}"#,
        );
        let quota = mock
            .client()
            .get_quota("u1", QuotaType::User)
            .await
            .unwrap();
        assert!(quota.enabled);
        assert_eq!(quota.max_size_kb, 1024);
        assert_eq!(
            mock.sent().1,
            "http://rgw.test:7480/admin/user?format=json&quota=&quota-type=user&uid=u1"
        );

        let mock = Mock::reply(200, "");
        mock.client()
            .set_quota("u1", QuotaType::Bucket, true, 1024, -1)
            .await
            .unwrap();
        assert_eq!(
            mock.sent(),
            (
                "PUT",
                "http://rgw.test:7480/admin/user?enabled=true&format=json&max-objects=-1&max-size-kb=1024&quota=&quota-type=bucket&uid=u1".into()
            )
        );
    }

    #[tokio::test]
    async fn usage_parses_entries_and_summary() {
        let mock = Mock::reply(
            200,
            r#"{"entries":[{"user":"u1","buckets":[{"bucket":"b","time":"2026-11-18T05:00:00.000000Z","epoch":1795064400,"owner":"u1",
                 "categories":[{"category":"put_obj","bytes_sent":0,"bytes_received":10,"ops":2,"successful_ops":1}]}]}],
                "summary":[{"user":"u1","categories":[],"total":{"bytes_sent":0,"bytes_received":10,"ops":2,"successful_ops":1}}]}"#,
        );
        let usage = mock.client().get_usage(Some("u1")).await.unwrap();
        assert_eq!(
            usage.entries[0].buckets[0].categories[0].category,
            "put_obj"
        );
        assert_eq!(usage.summary[0].total.bytes_received, 10);
        assert_eq!(
            mock.sent().1,
            "http://rgw.test:7480/admin/usage?format=json&uid=u1"
        );
    }

    #[tokio::test]
    async fn rgw_error_codes_are_mapped() {
        let cases = [
            (403, "AccessDenied", RgwError::AccessDenied),
            (
                403,
                "SignatureDoesNotMatch",
                RgwError::SignatureDoesNotMatch,
            ),
            (403, "InvalidAccessKeyId", RgwError::InvalidAccessKeyId),
            (404, "NoSuchUser", RgwError::NoSuchUser),
            (404, "NoSuchBucket", RgwError::NoSuchBucket),
            (404, "NoSuchKey", RgwError::NoSuchKey),
            (404, "NoSuchCap", RgwError::NoSuchCap),
            (409, "UserAlreadyExists", RgwError::UserAlreadyExists),
            (409, "UserExists", RgwError::UserAlreadyExists),
            (409, "KeyExists", RgwError::KeyExists),
            (409, "EmailExists", RgwError::EmailExists),
            (400, "InvalidCapability", RgwError::InvalidCapability),
        ];
        for (status, code, expected) in cases {
            let body =
                format!(r#"{{"Code":"{code}","Message":"","RequestId":"tx1","HostId":"h"}}"#);
            let mock = Mock::reply(status, &body);
            assert_eq!(mock.client().get_user("x").await.unwrap_err(), expected);
        }
    }

    #[tokio::test]
    async fn unknown_and_non_json_errors_keep_status_and_text() {
        let mock = Mock::reply(500, r#"{"Code":"InternalError","Message":"boom"}"#);
        assert_eq!(
            mock.client().get_info().await.unwrap_err(),
            RgwError::Api {
                status: 500,
                code: "InternalError".into(),
                message: "boom".into()
            }
        );

        let mock = Mock::reply(502, "<html>Bad Gateway</html>");
        let err = mock.client().get_info().await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "RGW returned HTTP 502  <html>Bad Gateway</html>"
        );
    }

    #[tokio::test]
    async fn transport_and_decode_failures_are_distinct() {
        let mock = Mock::default(); // no queued response -> transport error
        assert_eq!(
            mock.client().get_info().await.unwrap_err(),
            RgwError::Transport("connection refused".into())
        );

        let mock = Mock::reply(200, "<html>not rgw</html>");
        assert!(matches!(
            mock.client().list_users().await.unwrap_err(),
            RgwError::Decode(_)
        ));
    }

    #[test]
    fn endpoint_must_be_http_url_and_may_have_a_prefix() {
        let creds = || Credentials {
            access_key: "AK".into(),
            secret_key: "SK".into(),
        };
        let mock = Mock::default();
        for bad in ["", "rgw.test:7480", "ftp://rgw.test", "http://"] {
            assert!(
                matches!(
                    RgwAdmin::new(bad, creds(), &mock),
                    Err(RgwError::InvalidEndpoint(_))
                ),
                "{bad:?} should be rejected"
            );
        }
        let admin = RgwAdmin::new("https://s3.corp.test/rgw/", creds(), &mock).unwrap();
        assert_eq!(admin.host, "s3.corp.test");
        assert_eq!(admin.origin, "https://s3.corp.test");
        assert_eq!(admin.base_path, "/rgw");
    }

    #[tokio::test]
    async fn manual_key_on_create_and_key_calls() {
        let mock = Mock::reply(200, r#"{"user_id":"u1"}"#);
        mock.client()
            .create_user("u1", "U", None, Some("AKMANUAL"), Some("sk/+="))
            .await
            .unwrap();
        assert_eq!(
            mock.calls(),
            ["PUT /admin/user?access-key=AKMANUAL&display-name=U&format=json&secret-key=sk%2F%2B%3D&uid=u1"]
        );

        let mock = Mock::reply(
            200,
            r#"[{"user":"u1","access_key":"OLD","secret_key":"s1","active":true},{"user":"u1","access_key":"NEW","secret_key":"s2","active":true}]"#,
        );
        let keys = mock.client().create_key("u1", None, None).await.unwrap();
        assert_eq!(keys[1].access_key, "NEW");
        assert_eq!(mock.calls(), ["PUT /admin/user?format=json&key=&uid=u1"]);

        let mock = Mock::reply(200, "");
        mock.client().remove_key("u1", "OLD").await.unwrap();
        assert_eq!(
            mock.calls(),
            ["DELETE /admin/user?access-key=OLD&format=json&key=&uid=u1"]
        );

        let mock = Mock::reply(403, r#"{"Code":"InvalidAccessKeyId"}"#);
        assert_eq!(
            mock.client().remove_key("u1", "NOPE").await.unwrap_err(),
            RgwError::InvalidAccessKeyId
        );
    }

    #[tokio::test]
    async fn subuser_calls() {
        let mock = Mock::reply(200, r#"[{"id":"u1:swift","permissions":"full-control"}]"#);
        let subusers = mock
            .client()
            .create_subuser("u1", "swift", "full")
            .await
            .unwrap();
        assert_eq!(subusers[0].id, "u1:swift");
        assert_eq!(subusers[0].permissions, "full-control");
        assert_eq!(
            mock.calls(),
            ["PUT /admin/user?access=full&format=json&subuser=swift&uid=u1"]
        );

        let mock = Mock::reply(200, "");
        mock.client().remove_subuser("u1", "swift").await.unwrap();
        assert_eq!(
            mock.calls(),
            ["DELETE /admin/user?format=json&purge-keys=true&subuser=swift&uid=u1"]
        );

        let mock = Mock::reply(404, r#"{"Code":"NoSuchSubUser"}"#);
        let err = mock
            .client()
            .remove_subuser("u1", "nope")
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "RGW returned HTTP 404 NoSuchSubUser ");
    }
}
