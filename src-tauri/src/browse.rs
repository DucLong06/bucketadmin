//! The Browse page's commands. Every S3 call here is signed with the key of the user being
//! browsed as. The admin credentials are used for exactly one thing: looking up that key.
//! In "my own key" mode (an empty `uid`) they are not used at all: the session signs with
//! the personal key the user typed in, and no Admin API request is made.

use crate::clusters::{ClusterProfile, ProfileStore, SecretStore};
use crate::rgw_admin::{HttpClient, RgwAdmin};
use crate::s3::access::{probe_path, Probe};
use crate::s3::acl::{Acl, AclReport, AppliedAcl, Grant, VersionEntry, Versioning};
use crate::s3::manage::{DeleteReport, Deleted, Marker, ObjectTag, MAX_DELETE};
use crate::s3::parquet::ParquetPage;
use crate::s3::search::SearchResult;
use crate::s3::transfer::{content_type_for, Cancel, Downloaded};
use crate::s3::{BucketEntry, Listing, ObjectHead, LIST_PAGE, S3};
use crate::settings::Proxy;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

type Cmd<T> = Result<T, String>;
type St<'a> = State<'a, AppState>;

/// One S3 client per (cluster, uid), so the user's key is looked up once, not per request.
/// The empty uid is the session of the personal key ("my own key").
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<(String, String), S3>>);

impl Sessions {
    pub(crate) fn clear(&self) {
        if let Ok(mut sessions) = self.0.lock() {
            sessions.clear();
        }
    }
}

/// What `accessible_prefixes` learned from a bucket's policy, per (cluster, bucket): asked once
/// per start of the app. Only answers are kept; a refusal is asked again next time.
#[derive(Default)]
pub struct PolicyCache(Mutex<HashMap<(String, String), Vec<String>>>);

impl PolicyCache {
    pub(crate) fn clear(&self) {
        if let Ok(mut known) = self.0.lock() {
            known.clear();
        }
    }
}

/// Cancel flags of the transfers in flight, by the id the UI gave them.
#[derive(Default)]
pub struct Transfers(Mutex<HashMap<String, Cancel>>);

impl Transfers {
    fn begin(&self, id: &str) -> Cancel {
        let cancel = Cancel::default();
        if let Ok(mut running) = self.0.lock() {
            running.insert(id.to_string(), cancel.clone());
        }
        cancel
    }

    fn end(&self, id: &str) {
        if let Ok(mut running) = self.0.lock() {
            running.remove(id);
        }
    }
}

/// The S3 client a browse session signs with. An empty `uid` means "my own key": the personal
/// key saved for the cluster (or the profile's own key), without any Admin API request. Any other `uid` is looked up
/// with the admin credentials to get that user's key.
pub async fn connect<S: SecretStore, H: HttpClient>(
    profiles: &ProfileStore<S>,
    http: H,
    cluster_id: &str,
    uid: &str,
    proxy: &Proxy,
) -> Result<S3, String> {
    let addressing = profiles.addressing(cluster_id)?;
    if uid.is_empty() {
        let (endpoint, mine) = profiles.browse_credentials(cluster_id)?;
        return S3::connect(
            &endpoint,
            &mine.access_key,
            &mine.secret_key,
            proxy,
            &addressing,
        );
    }
    let (endpoint, admin_creds) = profiles.credentials(cluster_id)?;
    let admin = RgwAdmin::new(&endpoint, admin_creds, http).map_err(|e| e.to_string())?;
    let user = admin.get_user(uid).await.map_err(|e| e.to_string())?;
    // shortcut: always the user's first S3 key; let the admin pick one if users with
    // several keys of different reach turn out to matter.
    let key = user
        .keys
        .first()
        .ok_or_else(|| format!("user {uid} has no S3 key to browse with"))?;
    S3::connect(
        &endpoint,
        &key.access_key,
        &key.secret_key,
        proxy,
        &addressing,
    )
}

/// What a command acts on, and as whom (`uid` empty: with the caller's own saved key).
/// `key` is empty for bucket-level commands.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub cluster_id: String,
    pub uid: String,
    pub bucket: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub version: Option<String>,
}

impl ObjectRef {
    pub(crate) fn version(&self) -> Option<&str> {
        self.version.as_deref().filter(|v| !v.is_empty())
    }

    fn require_key(&self) -> Result<(), String> {
        if self.bucket.is_empty() || self.key.is_empty() {
            return Err("bucket and object key are required".into());
        }
        Ok(())
    }
}

impl AppState {
    /// The S3 session of `uid` on a cluster. `fresh` looks the key up again (after a rotate).
    pub(crate) async fn s3(&self, cluster_id: &str, uid: &str, fresh: bool) -> Result<S3, String> {
        let cache_key = (cluster_id.to_string(), uid.to_string());
        if !fresh {
            let sessions = self.browse.0.lock().map_err(|e| e.to_string())?;
            if let Some(s3) = sessions.get(&cache_key) {
                return Ok(s3.clone());
            }
        }
        let proxy = self.proxy_of(cluster_id)?;
        let http = self.http(&proxy)?;
        let s3 = connect(&self.profiles, http, cluster_id, uid, &proxy).await?;
        let mut sessions = self.browse.0.lock().map_err(|e| e.to_string())?;
        sessions.insert(cache_key, s3.clone());
        Ok(s3)
    }

    pub(crate) async fn session(&self, at: &ObjectRef) -> Result<S3, String> {
        self.s3(&at.cluster_id, &at.uid, false).await
    }

    /// Audit row for a mutation made while browsing. The target is `bucket/key`; the detail
    /// starts with whose key did it, since that is not the cluster admin.
    pub(crate) fn audit_s3<T>(
        &self,
        at: &ObjectRef,
        action: &str,
        detail: &str,
        result: &Result<T, String>,
    ) {
        let target = match at.key.as_str() {
            "" => at.bucket.clone(),
            key => format!("{}/{key}", at.bucket),
        };
        let who = match at.uid.as_str() {
            "" => "own-key", // never the key itself
            uid => uid,
        };
        let mut full = format!("as={who}");
        if let Some(version) = at.version() {
            full.push_str(&format!(" version={version}"));
        }
        if !detail.is_empty() {
            full.push_str(&format!(" {detail}"));
        }
        let error = result.as_ref().err().map(String::as_str);
        let recorded = self
            .audit
            .record(&at.cluster_id, action, &target, &full, error);
        if let Err(e) = recorded {
            // The S3 call already happened; failing here would misreport it.
            eprintln!("{e} (while recording {action} on {target})");
        }
    }
}

/// Drops the cached own-key session, so a replaced or deleted key stops being used at once.
fn forget_own_session(state: &AppState, cluster_id: &str) {
    if let Ok(mut sessions) = state.browse.0.lock() {
        sessions.remove(&(cluster_id.to_string(), String::new()));
    }
    // Another key may be granted other prefixes.
    state.policies.clear();
}

/// Saves the personal S3 key for "browse with my own key": the secret goes to the OS
/// keychain, the access key to the profile. Entering a key again replaces the old one.
#[tauri::command(async)]
pub fn browse_key_set(
    state: St<'_>,
    cluster_id: String,
    access_key: String,
    secret_key: String,
) -> Cmd<ClusterProfile> {
    forget_own_session(&state, &cluster_id);
    state
        .profiles
        .set_browse_key(&cluster_id, &access_key, &secret_key)
}

/// Deletes the personal key from the keychain and the profile.
#[allow(dead_code)] // admin UI removed M7b: keys are managed by adding / removing a connection
#[tauri::command(async)]
pub fn browse_key_clear(state: St<'_>, cluster_id: String) -> Cmd<ClusterProfile> {
    forget_own_session(&state, &cluster_id);
    state.profiles.clear_browse_key(&cluster_id)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Opened {
    /// Which of the user's keys the session signs with (the secret stays in the backend).
    pub access_key: String,
    pub buckets: Vec<BucketEntry>,
    /// The S3 error code when the key may not list buckets (e.g. `AccessDenied`). Normal for a
    /// user who was only granted one folder: such a key still opens a path it is told.
    pub buckets_error: Option<String>,
}

/// What a session shows after its ListBuckets answer. A refusal by S3 is not a failure of the
/// session; a key RGW does not accept, or a cluster that cannot be reached, is.
pub fn opened(
    access_key: &str,
    listed: Result<Vec<BucketEntry>, String>,
) -> Result<Opened, String> {
    let (buckets, buckets_error) = match listed {
        Ok(buckets) => (buckets, None),
        Err(error) => {
            // `S3 <Code> (<status>): ...` (see `s3::s3_error`); anything else is the network.
            let code = error.strip_prefix("S3 ").and_then(|e| e.split(' ').next());
            match code {
                Some("InvalidAccessKeyId" | "SignatureDoesNotMatch") | None => return Err(error),
                Some(code) => (Vec::new(), Some(code.to_string())),
            }
        }
    };
    Ok(Opened {
        access_key: access_key.to_string(),
        buckets,
        buckets_error,
    })
}

/// Lists the buckets of a fresh session the way `browse_open` reports them.
pub async fn open_session(s3: &S3) -> Result<Opened, String> {
    opened(s3.access_key(), s3.list_buckets().await)
}

/// Starts (or restarts) browsing as `uid` (empty: with the caller's own saved key) and lists
/// the buckets that key's user owns. A key that may not list buckets still gets its session.
#[tauri::command]
pub async fn browse_open(state: St<'_>, cluster_id: String, uid: String) -> Cmd<Opened> {
    open_session(&state.s3(&cluster_id, &uid, true).await?).await
}

/// What a path being typed leads to, for the path picker: the folders right below it, or that
/// S3 refuses to list there. One small listing AT the typed prefix, never above it. Trouble of
/// any kind is an answer (`status: "error"`), not a failed command: the picker shows it inline.
#[tauri::command]
pub async fn path_probe(
    state: St<'_>,
    cluster_id: String,
    path: String,
    uid: Option<String>,
) -> Cmd<Probe> {
    let uid = uid.unwrap_or_default();
    Ok(match state.s3(&cluster_id, &uid, false).await {
        Ok(s3) => probe_path(&s3, &path).await,
        Err(message) => Probe::Error { message },
    })
}

/// Best effort: the prefixes of `bucket` its policy grants the connection's own key, read with
/// that key. Any trouble (no policy, not allowed to read it, no network) is an empty list.
#[tauri::command]
pub async fn accessible_prefixes(
    state: St<'_>,
    cluster_id: String,
    bucket: String,
) -> Cmd<Vec<String>> {
    let cache_key = (cluster_id.clone(), bucket.clone());
    let known = state
        .policies
        .0
        .lock()
        .ok()
        .and_then(|k| k.get(&cache_key).cloned());
    if let Some(prefixes) = known {
        return Ok(prefixes);
    }
    let Ok(s3) = state.s3(&cluster_id, "", false).await else {
        return Ok(Vec::new());
    };
    let Ok(prefixes) = s3.accessible_prefixes(&bucket).await else {
        return Ok(Vec::new());
    };
    if let Ok(mut known) = state.policies.0.lock() {
        known.insert(cache_key, prefixes.clone());
    }
    Ok(prefixes)
}

#[tauri::command]
pub async fn browse_list(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    bucket: String,
    prefix: String,
    token: Option<String>,
) -> Cmd<Listing> {
    let s3 = state.s3(&cluster_id, &uid, false).await?;
    s3.list(&bucket, &prefix, token.as_deref(), LIST_PAGE).await
}

// ---- transfers --------------------------------------------------------------

/// Sent to the UI as the `transfer` event after every part of an upload or download.
#[derive(Clone, Serialize)]
struct Progress<'a> {
    id: &'a str,
    done: u64,
    total: u64,
}

fn report(app: &AppHandle, id: &str) -> impl Fn(u64, u64) + Send + Sync {
    let (app, id) = (app.clone(), id.to_string());
    move |done, total| {
        let progress = Progress {
            id: &id,
            done,
            total,
        };
        let _ = app.emit("transfer", progress);
    }
}

/// Debug builds only: the answer a native file dialog would give, taken from the environment,
/// because the UI smoke test cannot operate a native dialog. Release builds never look.
fn dev_answer(variable: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(variable).ok().filter(|v| !v.is_empty())
    } else {
        None
    }
}

/// Native "open" dialog; the chosen paths (none when cancelled). `title` comes from the UI, in its language.
#[tauri::command(async)]
pub fn browse_pick_upload(app: AppHandle, title: String) -> Vec<String> {
    if let Some(path) = dev_answer("BUCKETADMIN_DEV_PICK_UPLOAD") {
        return vec![path];
    }
    let picked = app.dialog().file().set_title(title).blocking_pick_files();
    picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
        .collect()
}

/// Native "save as" dialog; `None` when cancelled. `title` comes from the UI, in its language.
#[tauri::command(async)]
pub fn browse_pick_save(app: AppHandle, name: String, title: String) -> Option<String> {
    if let Some(dir) = dev_answer("BUCKETADMIN_DEV_SAVE_DIR") {
        return Some(format!("{dir}/{name}"));
    }
    let picked = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(name)
        .blocking_save_file();
    let path = picked.and_then(|f| f.into_path().ok())?;
    Some(path.display().to_string())
}

/// Uploads a local file to `at.bucket/at.key` (multipart above one part). Returns the size.
#[tauri::command]
pub async fn browse_upload(
    app: AppHandle,
    state: St<'_>,
    at: ObjectRef,
    path: String,
    transfer_id: String,
) -> Cmd<u64> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    let progress = report(&app, &transfer_id);
    let cancel = state.transfers.begin(&transfer_id);
    let result = s3
        .upload_with(&at.bucket, &at.key, Path::new(&path), progress, &cancel)
        .await;
    state.transfers.end(&transfer_id);
    let detail = match &result {
        Ok(size) => format!("size={size}"),
        Err(_) => String::new(),
    };
    state.audit_s3(&at, "object.upload", &detail, &result);
    result
}

/// Downloads to `dest` (a path the user picked), resuming an interrupted attempt.
#[tauri::command]
pub async fn browse_download(
    app: AppHandle,
    state: St<'_>,
    at: ObjectRef,
    dest: String,
    transfer_id: String,
) -> Cmd<Downloaded> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    let progress = report(&app, &transfer_id);
    let cancel = state.transfers.begin(&transfer_id);
    let dest = Path::new(&dest);
    let result = s3
        .download_with(&at.bucket, &at.key, at.version(), dest, progress, &cancel)
        .await;
    state.transfers.end(&transfer_id);
    result
}

/// A time-limited GET URL signed with the browsed user's key. The URL is a bearer credential,
/// so handing one out is audited (without the URL itself).
#[tauri::command]
pub async fn browse_presign(state: St<'_>, at: ObjectRef, expires_secs: u64) -> Cmd<String> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    let result = s3
        .presign_get(&at.bucket, &at.key, at.version(), expires_secs, None)
        .await;
    let detail = format!("expires_secs={expires_secs}");
    state.audit_s3(&at, "object.presign", &detail, &result);
    result
}

/// Deletes the object, or exactly one version of it when `at.version` is set. Returns the
/// version id of the delete marker when the bucket's versioning turned the delete into one.
#[tauri::command]
pub async fn browse_delete(state: St<'_>, at: ObjectRef) -> Cmd<Option<String>> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    let result = s3.delete(&at.bucket, &at.key, at.version()).await;
    let action = match at.version() {
        Some(_) => "version.delete",
        None => "object.delete",
    };
    let detail = match &result {
        Ok(Some(marker)) => format!("delete_marker={marker}"),
        _ => String::new(),
    };
    state.audit_s3(&at, action, &detail, &result);
    result
}

/// Undo of a delete in a bucket with versioning on: removes the delete markers it left.
#[tauri::command]
pub async fn browse_undelete(
    state: St<'_>,
    at: ObjectRef,
    markers: Vec<Marker>,
) -> Cmd<DeleteReport> {
    let s3 = state.session(&at).await?;
    let report = s3.undelete(&at.bucket, markers).await;
    let detail = format!(
        "objects={} restored={} failed={}",
        report.objects,
        report.deleted,
        report.failed.len()
    );
    let outcome = match report.failed.first() {
        None => Ok(()),
        Some(first) => Err(format!("{}: {}", first.key, first.error)),
    };
    state.audit_s3(&at, "object.undelete", &detail, &outcome);
    Ok(report)
}

/// Deleted but restorable keys one level below the prefix `at.key`.
#[tauri::command]
pub async fn browse_deleted(state: St<'_>, at: ObjectRef) -> Cmd<Deleted> {
    let s3 = state.session(&at).await?;
    s3.list_deleted(&at.bucket, &at.key).await
}

/// Switches the bucket's versioning on or suspends it, and reports the state that reads back.
#[tauri::command]
pub async fn browse_set_versioning(state: St<'_>, at: ObjectRef, enabled: bool) -> Cmd<Versioning> {
    let s3 = state.session(&at).await?;
    let result = s3.set_versioning(&at.bucket, enabled).await;
    let detail = format!("status={}", if enabled { "Enabled" } else { "Suspended" });
    state.audit_s3(&at, "bucket.versioning.set", &detail, &result);
    result?;
    Ok(s3.versioning(&at.bucket).await)
}

// ---- preview ----------------------------------------------------------------

/// Largest piece one `browse_read` returns.
const MAX_READ: u64 = 4 * 1024 * 1024;
/// How long a URL handed to the preview frame stays valid. It is never shown or logged; a
/// video paused for longer than this has to be reopened.
const MEDIA_URL_SECS: u64 = 900;

/// Bytes `[start, start + len)` of the object, raw (the text, CSV and hex viewers).
#[tauri::command]
pub async fn browse_read(
    state: St<'_>,
    at: ObjectRef,
    start: u64,
    len: u64,
) -> Cmd<tauri::ipc::Response> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    let len = len.clamp(1, MAX_READ);
    let bytes = s3
        .read_range(&at.bucket, &at.key, at.version(), start, len)
        .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// A short-lived URL the webview loads an image, audio, video or PDF from directly, so media
/// streams from RGW by range requests. Its Content-Type follows the key's extension.
#[tauri::command]
pub async fn browse_media_url(state: St<'_>, at: ObjectRef) -> Cmd<String> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    let inline_type = Some(content_type_for(&at.key));
    s3.presign_get(
        &at.bucket,
        &at.key,
        at.version(),
        MEDIA_URL_SECS,
        inline_type,
    )
    .await
}

/// Rows `[offset, offset + limit)` of a Parquet object, read by ranged GETs.
#[tauri::command]
pub async fn browse_parquet(
    state: St<'_>,
    at: ObjectRef,
    offset: u64,
    limit: usize,
) -> Cmd<ParquetPage> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    s3.parquet_page(&at.bucket, &at.key, at.version(), offset, limit)
        .await
}

// ---- versions and ACL ---------------------------------------------------------

/// The bucket's versioning state; `supported = false` tells the UI to hide the feature.
#[tauri::command]
pub async fn browse_versioning(state: St<'_>, at: ObjectRef) -> Cmd<Versioning> {
    Ok(state.session(&at).await?.versioning(&at.bucket).await)
}

#[tauri::command]
pub async fn browse_versions(state: St<'_>, at: ObjectRef) -> Cmd<Vec<VersionEntry>> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    s3.list_versions(&at.bucket, &at.key).await
}

/// Makes `at.version` the current content of the key again (as a new version).
#[tauri::command]
pub async fn browse_restore(state: St<'_>, at: ObjectRef) -> Cmd<()> {
    at.require_key()?;
    let version = at.version().ok_or("a version id is required to restore")?;
    let s3 = state.session(&at).await?;
    let result = s3.restore_version(&at.bucket, &at.key, version).await;
    state.audit_s3(&at, "version.restore", "", &result);
    result
}

/// ACL of the object, or of the bucket when `at.key` is empty.
#[tauri::command]
pub async fn browse_acl_get(state: St<'_>, at: ObjectRef) -> Cmd<Acl> {
    state.session(&at).await?.get_acl(&at.bucket, &at.key).await
}

/// Replaces the ACL and reports what reads back afterwards.
#[tauri::command]
pub async fn browse_acl_put(state: St<'_>, at: ObjectRef, grants: Vec<Grant>) -> Cmd<AppliedAcl> {
    let s3 = state.session(&at).await?;
    let result = s3.put_acl(&at.bucket, &at.key, &grants).await;
    let verified = result
        .as_ref()
        .map(|applied| applied.verified)
        .unwrap_or(false);
    let detail = format!("grants={} verified={verified}", grants_text(&grants));
    state.audit_s3(&at, "acl.set", &detail, &result);
    result
}

fn grants_text(grants: &[Grant]) -> String {
    let listed: Vec<String> = grants
        .iter()
        .map(|g| format!("{}:{}={}", g.kind, g.grantee, g.permission))
        .collect();
    listed.join(",")
}

/// The keys a recursive ACL change would touch: everything under the prefix `at.key`
/// (empty: the whole bucket).
#[tauri::command]
pub async fn browse_acl_targets(state: St<'_>, at: ObjectRef) -> Cmd<Vec<String>> {
    let s3 = state.session(&at).await?;
    s3.keys_under(&at.bucket, &at.key, MAX_DELETE).await
}

/// Applies one ACL to each of `keys` in turn (the objects under the prefix `at.key`, as
/// listed by `browse_acl_targets`), reporting progress as `transfer` events.
#[tauri::command]
pub async fn browse_acl_put_many(
    app: AppHandle,
    state: St<'_>,
    at: ObjectRef,
    keys: Vec<String>,
    grants: Vec<Grant>,
    transfer_id: String,
) -> Cmd<AclReport> {
    let s3 = state.session(&at).await?;
    let cancel = state.transfers.begin(&transfer_id);
    let progress = report(&app, &transfer_id);
    let result = s3
        .put_acl_many(&at.bucket, &keys, &grants, progress, &cancel)
        .await;
    state.transfers.end(&transfer_id);
    let detail = match &result {
        Ok(r) => format!(
            "objects={} applied={} unverified={} failed={} cancelled={} grants={}",
            r.objects,
            r.applied,
            r.unverified,
            r.failed.len(),
            r.cancelled,
            grants_text(&grants)
        ),
        Err(_) => format!("objects={} grants={}", keys.len(), grants_text(&grants)),
    };
    // The row is an error when any object failed, with the first failure as its message.
    let outcome = match &result {
        Ok(r) => match r.failed.first() {
            None => Ok(()),
            Some(first) => Err(format!("{}: {}", first.key, first.error)),
        },
        Err(e) => Err(e.clone()),
    };
    state.audit_s3(&at, "acl.set_many", &detail, &outcome);
    result
}

// ---- search -------------------------------------------------------------------

/// Keys under `prefix` (all levels) matching `pattern`, bounded by result count and time.
#[tauri::command]
pub async fn browse_search(
    state: St<'_>,
    at: ObjectRef,
    prefix: String,
    pattern: String,
    max_results: usize,
    max_secs: u64,
) -> Cmd<SearchResult> {
    let s3 = state.session(&at).await?;
    s3.search(&at.bucket, &prefix, &pattern, max_results, max_secs)
        .await
}

/// Asks a running upload or download to stop at its next part. False when it is not running.
#[tauri::command]
pub fn browse_cancel(state: St<'_>, transfer_id: String) -> bool {
    let running = state.transfers.0.lock();
    let flag = running.ok().and_then(|map| map.get(&transfer_id).cloned());
    flag.is_some_and(|cancel| {
        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        true
    })
}

// ---- buckets, folders, multi-delete, properties, tags ----------------------------

/// Creates the bucket `at.bucket`, owned by the browsed user.
#[tauri::command]
pub async fn browse_create_bucket(state: St<'_>, at: ObjectRef, versioning: bool) -> Cmd<()> {
    let s3 = state.session(&at).await?;
    let result = s3.create_bucket(&at.bucket, versioning).await;
    let detail = format!("versioning={versioning}");
    state.audit_s3(&at, "bucket.create", &detail, &result);
    result
}

/// Creates the folder `name` under the prefix `at.key` (empty for the bucket root).
#[tauri::command]
pub async fn browse_create_folder(state: St<'_>, at: ObjectRef, name: String) -> Cmd<String> {
    let s3 = state.session(&at).await?;
    let result = s3.create_folder(&at.bucket, &at.key, &name).await;
    let detail = format!("folder={}", name.trim());
    state.audit_s3(&at, "folder.create", &detail, &result);
    result
}

/// Deletes the selected objects and everything under the selected folders. With `dry_run`
/// nothing is deleted: the report only says how many objects the selection stands for.
#[tauri::command]
pub async fn browse_delete_many(
    state: St<'_>,
    at: ObjectRef,
    keys: Vec<String>,
    prefixes: Vec<String>,
    dry_run: bool,
) -> Cmd<DeleteReport> {
    let s3 = state.session(&at).await?;
    let all = s3.expand(&at.bucket, &keys, &prefixes, MAX_DELETE).await?;
    if dry_run {
        return Ok(DeleteReport {
            objects: all.len(),
            ..Default::default()
        });
    }
    let report = s3.delete_many(&at.bucket, all).await;
    let detail = format!(
        "objects={} deleted={} failed={} delete_markers={} folders={}",
        report.objects,
        report.deleted,
        report.failed.len(),
        report.markers.len(),
        prefixes.join(",")
    );
    let outcome = match report.failed.first() {
        None => Ok(()),
        Some(first) => Err(format!("{}: {}", first.key, first.error)),
    };
    state.audit_s3(&at, "object.delete_many", &detail, &outcome);
    Ok(report)
}

#[derive(Serialize)]
pub struct Inspected {
    head: ObjectHead,
    /// Every header of the HEAD response, as RGW sent them.
    headers: Vec<(String, String)>,
}

/// Properties and raw HEAD headers of the object.
#[tauri::command]
pub async fn browse_inspect(state: St<'_>, at: ObjectRef) -> Cmd<Inspected> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    Ok(Inspected {
        head: s3.head(&at.bucket, &at.key, at.version()).await?,
        headers: s3.head_headers(&at.bucket, &at.key, at.version()).await?,
    })
}

#[tauri::command]
pub async fn browse_tags_get(state: St<'_>, at: ObjectRef) -> Cmd<Vec<ObjectTag>> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    s3.get_tags(&at.bucket, &at.key, at.version()).await
}

/// Replaces the object's tags.
#[tauri::command]
pub async fn browse_tags_put(state: St<'_>, at: ObjectRef, tags: Vec<ObjectTag>) -> Cmd<()> {
    at.require_key()?;
    let s3 = state.session(&at).await?;
    let result = s3.put_tags(&at.bucket, &at.key, at.version(), &tags).await;
    let keys: Vec<&str> = tags.iter().map(|t| t.key.as_str()).collect();
    let detail = format!("tags={}", keys.join(","));
    state.audit_s3(&at, "object.tags.set", &detail, &result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clusters::tests::{temp_dir, MemorySecrets};
    use crate::rgw_admin::mock::Mock;

    /// M6.1: the session of "my own key" is built from the saved key alone. The mock transport
    /// stands where the Admin API would be: it must see nothing.
    #[tokio::test]
    async fn own_key_session_makes_no_admin_request() {
        let dir = temp_dir("ownkey");
        let secrets = MemorySecrets::default();
        let store = ProfileStore::new(dir.clone(), &secrets);
        let admin_endpoint = "http://rgw.test:7480";
        let p = store.add("lab", admin_endpoint, "AK", "SK").unwrap();

        let none = Mock::default();
        let auto = Proxy::Auto;
        // No separate key entered: the profile's own key signs, still without the Admin API.
        let s3 = connect(&store, &none, &p.id, "", &auto).await.unwrap();
        assert_eq!(s3.access_key(), "AK");
        store.set_browse_key(&p.id, "AKMINE", "my-secret").unwrap();
        let s3 = connect(&store, &none, &p.id, "", &auto).await.unwrap();
        assert_eq!(s3.access_key(), "AKMINE");
        assert_eq!(none.calls(), [] as [&str; 0], "own key: no Admin API call");

        // Browsing as another user is the one case that asks the Admin API (for that key).
        let user = r#"{"user_id":"alice","keys":[{"user":"alice","access_key":"AKALICE","secret_key":"s"}]}"#;
        let lookup = Mock::reply(200, user);
        let s3 = connect(&store, &lookup, &p.id, "alice", &auto)
            .await
            .unwrap();
        assert_eq!(s3.access_key(), "AKALICE");
        assert_eq!(lookup.calls(), ["GET /admin/user?format=json&uid=alice"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// M9.1: a key that may not list buckets (one folder granted by a bucket policy) still
    /// gets a session; a key RGW rejects, or no answer at all, still fails.
    #[test]
    fn a_refused_bucket_listing_is_a_state_of_the_session_not_a_failure() {
        let bucket = BucketEntry {
            name: "logs".into(),
            created: String::new(),
        };
        let listed = opened("AK", Ok(vec![bucket.clone()])).unwrap();
        assert_eq!((listed.buckets, listed.buckets_error), (vec![bucket], None));

        let denied = opened("AK", Err("S3 AccessDenied (403): ".into())).unwrap();
        assert_eq!(denied.access_key, "AK");
        assert!(denied.buckets.is_empty());
        assert_eq!(denied.buckets_error.as_deref(), Some("AccessDenied"));
        let other = opened("AK", Err("S3 MethodNotAllowed (405): no".into())).unwrap();
        assert_eq!(other.buckets_error.as_deref(), Some("MethodNotAllowed"));

        for fatal in [
            "S3 InvalidAccessKeyId (403): ",
            "S3 SignatureDoesNotMatch (403): ",
            "cannot reach RGW: dispatch failure: connection refused",
        ] {
            assert_eq!(opened("AK", Err(fatal.into())), Err(fatal.to_string()));
        }
        // The UI reads this field by name.
        let json = serde_json::to_string(&denied).unwrap();
        assert!(json.contains(r#""buckets_error":"AccessDenied""#), "{json}");
    }
}
