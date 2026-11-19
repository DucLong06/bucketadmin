pub mod audit;
mod browse;
pub mod clusters;
pub mod export;
pub mod ops;
pub mod rgw_admin;
pub mod s3;

use audit::{Audit, AuditEntry};
use clusters::{ClusterProfile, ProfileStore};
use ops::{
    BucketDetail, NewSubuser, Ops, Quotas, RotatedKey, TrimmedUsage, UsageSupport, UsersPage,
};
use ops::{OnboardResult, OnboardRow};
use rgw_admin::{
    BucketInfo, Capability, ClusterInfo, Credentials, KeyPair, QuotaType, ReqwestClient, RgwAdmin,
    Usage, UserInfo,
};
use tauri::{Manager, State};

// Errors cross the IPC boundary as display strings; the UI shows them verbatim.

pub(crate) struct AppState {
    pub(crate) profiles: ProfileStore,
    pub(crate) audit: Audit,
    pub(crate) http: ReqwestClient,
    pub(crate) browse: browse::Sessions,
    pub(crate) transfers: browse::Transfers,
}

impl AppState {
    /// Admin operations against a saved cluster; the secret comes from the keychain.
    fn ops(&self, cluster_id: &str) -> Result<Ops<'_>, String> {
        let (endpoint, creds) = self.profiles.credentials(cluster_id)?;
        let admin =
            RgwAdmin::new(&endpoint, creds, self.http.clone()).map_err(|e| e.to_string())?;
        Ok(Ops {
            admin,
            audit: &self.audit,
            cluster_id: cluster_id.to_string(),
        })
    }

    async fn cluster_info(
        &self,
        endpoint: &str,
        creds: Credentials,
    ) -> Result<ClusterInfo, String> {
        let admin = RgwAdmin::new(endpoint, creds, self.http.clone()).map_err(|e| e.to_string())?;
        admin.get_info().await.map_err(|e| e.to_string())
    }
}

type Cmd<'a, T> = Result<T, String>;
type St<'a> = State<'a, AppState>;

// ---- clusters -------------------------------------------------------------
// `(async)` keeps the blocking file/keychain/SQLite calls off the UI thread.

#[tauri::command(async)]
fn list_profiles(state: St<'_>) -> Cmd<'_, Vec<ClusterProfile>> {
    state.profiles.list()
}

#[tauri::command(async)]
fn add_profile(
    state: St<'_>,
    label: String,
    endpoint: String,
    access_key: String,
    secret_key: String,
) -> Cmd<'_, ClusterProfile> {
    state
        .profiles
        .add(&label, &endpoint, &access_key, &secret_key)
}

#[tauri::command(async)]
fn remove_profile(state: St<'_>, id: String) -> Cmd<'_, ()> {
    state.profiles.remove(&id)
}

/// Test credentials typed into the form, before anything is saved.
#[tauri::command]
async fn test_connection(
    state: St<'_>,
    endpoint: String,
    access_key: String,
    secret_key: String,
) -> Cmd<'_, ClusterInfo> {
    let creds = Credentials {
        access_key: access_key.trim().to_string(),
        secret_key,
    };
    state.cluster_info(&endpoint, creds).await
}

/// Test a saved profile; the secret never leaves the Rust side.
#[tauri::command]
async fn test_profile(state: St<'_>, id: String) -> Cmd<'_, ClusterInfo> {
    let (endpoint, creds) = state.profiles.credentials(&id)?;
    state.cluster_info(&endpoint, creds).await
}

// ---- users ----------------------------------------------------------------

#[tauri::command]
async fn users_list(
    state: St<'_>,
    cluster_id: String,
    marker: Option<String>,
    limit: usize,
) -> Cmd<'_, UsersPage> {
    let ops = state.ops(&cluster_id)?;
    ops.list_users_page(marker.as_deref(), limit).await
}

#[tauri::command]
async fn user_get(state: St<'_>, cluster_id: String, uid: String) -> Cmd<'_, UserInfo> {
    state.ops(&cluster_id)?.get_user(&uid).await
}

#[tauri::command]
async fn user_create(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    display_name: String,
    email: Option<String>,
    access_key: Option<String>,
    secret_key: Option<String>,
) -> Cmd<'_, UserInfo> {
    let ops = state.ops(&cluster_id)?;
    ops.create_user(&uid, &display_name, &email, &access_key, &secret_key)
        .await
}

#[tauri::command]
async fn user_modify(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    display_name: String,
    email: String,
) -> Cmd<'_, UserInfo> {
    let ops = state.ops(&cluster_id)?;
    ops.modify_user(&uid, &display_name, &email).await
}

#[tauri::command]
async fn user_set_suspended(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    suspended: bool,
) -> Cmd<'_, UserInfo> {
    state.ops(&cluster_id)?.set_suspended(&uid, suspended).await
}

#[tauri::command]
async fn user_delete(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    purge_data: bool,
) -> Cmd<'_, ()> {
    state.ops(&cluster_id)?.delete_user(&uid, purge_data).await
}

// ---- keys -----------------------------------------------------------------

#[tauri::command]
async fn key_create(state: St<'_>, cluster_id: String, uid: String) -> Cmd<'_, KeyPair> {
    state.ops(&cluster_id)?.create_key(&uid).await
}

#[tauri::command]
async fn key_remove(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    access_key: String,
) -> Cmd<'_, ()> {
    state.ops(&cluster_id)?.remove_key(&uid, &access_key).await
}

#[tauri::command]
async fn key_add(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    access_key: String,
    secret_key: String,
) -> Cmd<'_, ()> {
    let ops = state.ops(&cluster_id)?;
    ops.add_key(&uid, &access_key, &secret_key).await
}

#[tauri::command]
async fn key_rotate(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    access_key: String,
) -> Cmd<'_, RotatedKey> {
    state.ops(&cluster_id)?.rotate_key(&uid, &access_key).await
}

#[tauri::command]
async fn subuser_create(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    subuser: String,
    access: String,
) -> Cmd<'_, NewSubuser> {
    let ops = state.ops(&cluster_id)?;
    ops.create_subuser(&uid, &subuser, &access).await
}

#[tauri::command]
async fn subuser_remove(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    subuser: String,
) -> Cmd<'_, ()> {
    state.ops(&cluster_id)?.remove_subuser(&uid, &subuser).await
}

// ---- caps, quota, usage -----------------------------------------------------

#[tauri::command]
async fn caps_add(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    cap: String,
) -> Cmd<'_, Vec<Capability>> {
    state.ops(&cluster_id)?.add_cap(&uid, &cap).await
}

#[tauri::command]
async fn caps_remove(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    cap: String,
) -> Cmd<'_, Vec<Capability>> {
    state.ops(&cluster_id)?.remove_cap(&uid, &cap).await
}

#[tauri::command]
async fn quota_get(state: St<'_>, cluster_id: String, uid: String) -> Cmd<'_, Quotas> {
    state.ops(&cluster_id)?.get_quotas(&uid).await
}

#[tauri::command]
async fn quota_set(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    quota_type: QuotaType,
    enabled: bool,
    max_size_kb: i64,
    max_objects: i64,
) -> Cmd<'_, ()> {
    let ops = state.ops(&cluster_id)?;
    ops.set_quota(&uid, quota_type, enabled, max_size_kb, max_objects)
        .await
}

#[tauri::command]
async fn usage_get(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    start: Option<String>,
    end: Option<String>,
) -> Cmd<'_, Usage> {
    let ops = state.ops(&cluster_id)?;
    ops.get_usage(&uid, start.as_deref(), end.as_deref()).await
}

#[tauri::command]
async fn usage_trim(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    start: String,
    end: String,
) -> Cmd<'_, TrimmedUsage> {
    state.ops(&cluster_id)?.trim_usage(&uid, &start, &end).await
}

#[tauri::command]
async fn usage_support(state: St<'_>, cluster_id: String) -> Cmd<'_, UsageSupport> {
    state.ops(&cluster_id)?.usage_support().await
}

/// Writes an export next to the user's downloads and returns where it went.
#[tauri::command(async)]
fn export_save(file_name: String, content: String) -> Cmd<'static, String> {
    let path = export::save(&export::export_dir()?, &file_name, &content)?;
    Ok(path.display().to_string())
}

// ---- buckets --------------------------------------------------------------

#[tauri::command]
async fn buckets_list(
    state: St<'_>,
    cluster_id: String,
    uid: Option<String>,
) -> Cmd<'_, Vec<BucketInfo>> {
    state.ops(&cluster_id)?.list_buckets(uid.as_deref()).await
}

#[tauri::command]
async fn bucket_get(state: St<'_>, cluster_id: String, bucket: String) -> Cmd<'_, BucketDetail> {
    state.ops(&cluster_id)?.get_bucket(&bucket).await
}

#[tauri::command]
async fn bucket_delete(state: St<'_>, cluster_id: String, bucket: String) -> Cmd<'_, ()> {
    state.ops(&cluster_id)?.delete_bucket(&bucket).await
}

#[tauri::command]
async fn bucket_quota_set(
    state: St<'_>,
    cluster_id: String,
    bucket: String,
    enabled: bool,
    max_size_kb: i64,
    max_objects: i64,
) -> Cmd<'_, ()> {
    let ops = state.ops(&cluster_id)?;
    ops.set_bucket_quota(&bucket, enabled, max_size_kb, max_objects)
        .await
}

/// Creates the users of an onboarding file (or, with `dry_run`, says what would happen).
#[tauri::command]
async fn bulk_onboard(
    state: St<'_>,
    cluster_id: String,
    rows: Vec<OnboardRow>,
    dry_run: bool,
) -> Cmd<'_, Vec<OnboardResult>> {
    Ok(state.ops(&cluster_id)?.onboard(&rows, dry_run).await)
}

// ---- audit ----------------------------------------------------------------

/// Latest 100 rows; empty / missing filters match everything.
#[tauri::command(async)]
fn audit_recent(
    state: St<'_>,
    action: Option<String>,
    cluster_id: Option<String>,
) -> Cmd<'_, Vec<AuditEntry>> {
    let filter = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    let (action, cluster_id) = (filter(&action), filter(&cluster_id));
    state.audit.recent(action.as_deref(), cluster_id.as_deref())
}

pub fn run() {
    let builder = tauri::Builder::default();
    // Debug builds only: run the JS file named by BUCKETADMIN_DEV_SCRIPT in the page.
    // The Xvfb UI smoke test drives the real app with it; release builds have no such hook.
    #[cfg(debug_assertions)]
    let builder = builder.on_page_load(|webview, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            let script = std::env::var_os("BUCKETADMIN_DEV_SCRIPT")
                .and_then(|path| std::fs::read_to_string(path).ok());
            if let Some(js) = script {
                let _ = webview.eval(js);
            }
        }
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState {
                profiles: ProfileStore::open_default()?,
                audit: Audit::open(&clusters::data_dir()?.join("audit.db"))?,
                http: ReqwestClient::new().map_err(|e| e.to_string())?,
                browse: browse::Sessions::default(),
                transfers: browse::Transfers::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            add_profile,
            remove_profile,
            test_connection,
            test_profile,
            users_list,
            user_get,
            user_create,
            user_modify,
            user_set_suspended,
            user_delete,
            key_create,
            key_remove,
            key_add,
            key_rotate,
            subuser_create,
            subuser_remove,
            caps_add,
            caps_remove,
            quota_get,
            quota_set,
            usage_get,
            usage_trim,
            usage_support,
            export_save,
            buckets_list,
            bucket_get,
            bucket_delete,
            bucket_quota_set,
            audit_recent,
            bulk_onboard,
            browse::browse_open,
            browse::browse_list,
            browse::browse_pick_upload,
            browse::browse_pick_save,
            browse::browse_upload,
            browse::browse_download,
            browse::browse_presign,
            browse::browse_delete,
            browse::browse_read,
            browse::browse_media_url,
            browse::browse_parquet,
            browse::browse_versioning,
            browse::browse_versions,
            browse::browse_restore,
            browse::browse_acl_get,
            browse::browse_acl_put,
            browse::browse_search,
            browse::browse_cancel,
            browse::browse_create_bucket,
            browse::browse_create_folder,
            browse::browse_delete_many,
            browse::browse_inspect,
            browse::browse_tags_get,
            browse::browse_tags_put
        ])
        .run(tauri::generate_context!())
        .expect("error while running BucketAdmin");
}
