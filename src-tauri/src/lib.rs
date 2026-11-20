pub mod audit;
mod browse;
pub mod clusters;
pub mod export;
pub mod ops;
pub mod rgw_admin;
pub mod s3;
pub mod settings;
pub mod update;

use audit::{Audit, AuditEntry};
/// How a browse session gets its S3 client; public so the lab tests build one the app's way.
pub use browse::connect as browse_connect;
/// What `browse_open` answers for a session; public for the same reason.
pub use browse::{open_session as browse_open_session, Opened};
use clusters::{ClusterProfile, ProfileStore};
use ops::{
    BucketDetail, CallerAccess, NewSubuser, Ops, Quotas, RotatedKey, TrimmedUsage, UsageSupport,
    UsersPage,
};
use ops::{OnboardResult, OnboardRow};
use rgw_admin::{
    BucketInfo, Capability, ClusterInfo, Credentials, KeyPair, QuotaType, ReqwestClient, RgwAdmin,
    Usage, UserInfo,
};
use settings::{EndpointKind, Pin, Place, Proxy, SavedTabs, SettingsStore};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, State};

// Errors cross the IPC boundary as English display strings with a stable beginning (an RGW or
// S3 error code, or a fixed phrase). The UI turns that into a sentence in its language
// (src/errors.ts) and keeps this text as the technical detail.

pub(crate) struct AppState {
    pub(crate) profiles: ProfileStore,
    pub(crate) audit: Audit,
    pub(crate) settings: SettingsStore,
    /// One Admin Ops transport per proxy choice in use, built on first use.
    http: Mutex<HashMap<Proxy, ReqwestClient>>,
    pub(crate) browse: browse::Sessions,
    pub(crate) transfers: browse::Transfers,
    pub(crate) policies: browse::PolicyCache,
}

impl AppState {
    /// Admin operations against a saved cluster; the secret comes from the keychain.
    fn ops(&self, cluster_id: &str) -> Result<Ops<'_>, String> {
        let (endpoint, creds) = self.profiles.credentials(cluster_id)?;
        let http = self.http(&self.proxy_of(cluster_id)?)?;
        let admin = RgwAdmin::new(&endpoint, creds, http).map_err(|e| e.to_string())?;
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
        proxy: &Proxy,
    ) -> Result<ClusterInfo, String> {
        let admin = RgwAdmin::new(endpoint, creds, self.http(proxy)?).map_err(|e| e.to_string())?;
        admin.get_info().await.map_err(|e| e.to_string())
    }

    /// How requests to a cluster leave the machine: its own choice, else the app-wide one.
    pub(crate) fn proxy_of(&self, cluster_id: &str) -> Result<Proxy, String> {
        match self.profiles.proxy(cluster_id)? {
            Some(own) => Ok(own),
            None => Ok(self.settings.get()?.proxy),
        }
    }

    pub(crate) fn http(&self, proxy: &Proxy) -> Result<ReqwestClient, String> {
        let mut clients = self.http.lock().map_err(|e| e.to_string())?;
        if let Some(client) = clients.get(proxy) {
            return Ok(client.clone());
        }
        let client = ReqwestClient::with_proxy(proxy).map_err(|e| e.to_string())?;
        clients.insert(proxy.clone(), client.clone());
        Ok(client)
    }

    /// Browse sessions were built with the proxy choice of their time: drop them.
    fn forget_sessions(&self) {
        self.browse.clear();
        self.policies.clear();
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
    start_path: Option<String>,
) -> Cmd<'_, ClusterProfile> {
    // Checked first: a path that is refused must not leave a connection behind.
    let start_path = clusters::normalize_start_path(&start_path.unwrap_or_default())?;
    let added = state
        .profiles
        .add(&label, &endpoint, &access_key, &secret_key)?;
    if start_path.is_empty() {
        return Ok(added);
    }
    state.profiles.set_start_path(&added.id, &start_path)
}

/// Where the connection lands when it is opened: `bucket` or `bucket/prefix/`; empty for none.
#[tauri::command(async)]
fn profile_set_start_path(
    state: St<'_>,
    id: String,
    start_path: String,
) -> Cmd<'_, ClusterProfile> {
    state.profiles.set_start_path(&id, &start_path)
}

#[tauri::command(async)]
fn remove_profile(state: St<'_>, id: String) -> Cmd<'_, ()> {
    state.profiles.remove(&id)?;
    // Its recent and pinned places lead nowhere now.
    let forgotten = state.settings.change(|s| {
        s.recent.retain(|place| place.cluster_id != id);
        s.pins.retain(|pin| pin.place.cluster_id != id);
    });
    forgotten.map(|_| ())
}

/// The pinned places, in the user's order.
#[tauri::command(async)]
fn pin_list(state: St<'_>) -> Cmd<'_, Vec<Pin>> {
    Ok(state.settings.get()?.pins)
}

/// Pins a place (a no-op when it is pinned already) and returns the list.
#[tauri::command(async)]
fn pin_add(state: St<'_>, place: Place, label: String) -> Cmd<'_, Vec<Pin>> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    let now = now.map(|d| d.as_secs() as i64).unwrap_or(0);
    let mut pinned = Ok(());
    let saved = state
        .settings
        .change(|s| pinned = s.pin(place, &label, now))?;
    pinned?;
    Ok(saved.pins)
}

#[tauri::command(async)]
fn pin_remove(state: St<'_>, place: Place) -> Cmd<'_, Vec<Pin>> {
    Ok(state.settings.change(|s| s.unpin(&place))?.pins)
}

#[tauri::command(async)]
fn pin_rename(state: St<'_>, place: Place, label: String) -> Cmd<'_, Vec<Pin>> {
    Ok(state
        .settings
        .change(|s| s.rename_pin(&place, &label))?
        .pins)
}

/// Manual order: the pin of `place` goes to position `to`.
#[tauri::command(async)]
fn pin_move(state: St<'_>, place: Place, to: usize) -> Cmd<'_, Vec<Pin>> {
    Ok(state.settings.change(|s| s.move_pin(&place, to))?.pins)
}

/// The places browsed last, newest first.
#[tauri::command(async)]
fn recent_list(state: St<'_>) -> Cmd<'_, Vec<Place>> {
    Ok(state.settings.get()?.recent)
}

/// Remembers a place that was just opened and returns the updated list.
#[tauri::command(async)]
fn recent_add(state: St<'_>, place: Place) -> Cmd<'_, Vec<Place>> {
    if place.cluster_id.is_empty() || place.bucket.is_empty() {
        return Err("a recent place needs a connection and a bucket".into());
    }
    Ok(state.settings.change(|s| s.remember(place))?.recent)
}

/// The browse tabs that were open when the app was last used; `None` on a first start.
#[tauri::command(async)]
fn tabs_get(state: St<'_>) -> Cmd<'_, Option<SavedTabs>> {
    Ok(state.settings.get()?.tabs)
}

/// Saves the open browse tabs for the next start.
#[tauri::command(async)]
fn tabs_set(state: St<'_>, tabs: SavedTabs) -> Cmd<'_, ()> {
    state.settings.change(|s| s.keep_tabs(tabs)).map(|_| ())
}

/// Ticks or clears "I am a normal user" on a saved profile.
#[allow(dead_code)] // admin UI removed M7b
#[tauri::command(async)]
fn profile_set_plain(state: St<'_>, id: String, plain: bool) -> Cmd<'_, ClusterProfile> {
    state.profiles.set_plain_user(&id, plain)
}

/// The cluster's own proxy choice; `None` puts it back on the app-wide setting.
#[tauri::command(async)]
fn profile_set_proxy(state: St<'_>, id: String, proxy: Option<Proxy>) -> Cmd<'_, ClusterProfile> {
    let saved = state.profiles.set_proxy(&id, proxy)?;
    state.forget_sessions();
    Ok(saved)
}

/// The app-wide proxy choice.
#[tauri::command(async)]
fn network_get(state: St<'_>) -> Cmd<'_, Proxy> {
    Ok(state.settings.get()?.proxy)
}

#[tauri::command(async)]
fn network_set(state: St<'_>, proxy: Proxy) -> Cmd<'_, Proxy> {
    let proxy = proxy.validated()?;
    let saved = state.settings.change(|s| s.proxy = proxy)?;
    state.forget_sessions();
    Ok(saved.proxy)
}

/// Size of the interface in percent (one of `settings::UI_SCALES`).
#[tauri::command(async)]
fn get_ui_scale(state: St<'_>) -> Cmd<'_, u16> {
    Ok(state.settings.get()?.scale())
}

/// Shows the window at the size, snapped to the nearest step, and saves it; returns the step.
#[tauri::command(async)]
fn set_ui_scale(window: tauri::WebviewWindow, state: St<'_>, percent: u16) -> Cmd<'_, u16> {
    let step = settings::nearest_scale(percent)?;
    apply_ui_scale(&window, step)?;
    Ok(state.settings.change(|s| s.ui_scale = step)?.ui_scale)
}

/// Language of the UI chosen by the user: "en", "vi", or "" while it follows the system's.
#[tauri::command(async)]
fn get_lang(state: St<'_>) -> Cmd<'_, String> {
    Ok(state.settings.get()?.lang())
}

#[tauri::command(async)]
fn set_lang(state: St<'_>, lang: String) -> Cmd<'_, String> {
    let lang = settings::valid_lang(&lang)?;
    Ok(state.settings.change(|s| s.lang = lang)?.lang)
}

/// The one zoom mechanism: the webview's own zoom level, the same thing a browser's Ctrl+= changes.
/// Page, dialogs, menus and tooltips scale together, and the viewport shrinks in CSS pixels.
fn apply_ui_scale(window: &tauri::WebviewWindow, percent: u16) -> Result<(), String> {
    window
        .set_zoom(f64::from(percent) / 100.0)
        .map_err(|e| e.to_string())
}

/// The release to tell the user about, if the latest one is newer than this build. Never an error.
#[tauri::command]
async fn update_check(state: St<'_>) -> Cmd<'_, Option<update::Update>> {
    Ok(update::check(&state.settings).await)
}

/// Opens the release page found by the last check in the desktop's browser.
#[tauri::command(async)]
fn update_open(state: St<'_>) -> Cmd<'_, ()> {
    let seen = state.settings.get()?.update;
    // The file can be edited by hand: only a release page of this app is ever opened.
    let url = seen
        .map(|seen| seen.url)
        .filter(|url| url.starts_with(update::RELEASES))
        .ok_or("no release page to open")?;
    let opened = std::process::Command::new("xdg-open").arg(&url).status();
    match opened {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("cannot open the browser: xdg-open {status}")),
        Err(e) => Err(format!("cannot open the browser: {e}")),
    }
}

/// What the endpoint's host looks like from here, to suggest "no proxy" for internal ones.
/// Resolves the name, so it runs off the UI thread.
#[tauri::command(async)]
fn endpoint_kind(endpoint: String) -> Cmd<'static, EndpointKind> {
    settings::endpoint_kind(&endpoint)
}

/// Tests a key typed into the connection form by listing its buckets over S3: no Admin API
/// request, so no cap is needed. Answers like `browse_open`: a key that is valid but may not
/// list buckets passes, with `buckets_error` set. `proxy` is the choice made in the form;
/// without one the app-wide setting applies.
#[tauri::command]
async fn test_s3(
    state: St<'_>,
    endpoint: String,
    access_key: String,
    secret_key: String,
    proxy: Option<Proxy>,
) -> Cmd<'_, Opened> {
    rgw_admin::parse_endpoint(&endpoint).map_err(|e| e.to_string())?;
    let proxy = match proxy {
        Some(own) => own.validated()?,
        None => state.settings.get()?.proxy,
    };
    let s3 = s3::S3::with_proxy(&endpoint, access_key.trim(), secret_key.trim(), &proxy)?;
    browse::open_session(&s3).await
}

/// Test credentials typed into the form, before anything is saved. `proxy` is the choice
/// made in the form; without one the app-wide setting applies.
#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn test_connection(
    state: St<'_>,
    endpoint: String,
    access_key: String,
    secret_key: String,
    proxy: Option<Proxy>,
) -> Cmd<'_, ClusterInfo> {
    let creds = Credentials {
        access_key: access_key.trim().to_string(),
        secret_key,
    };
    let proxy = match proxy {
        Some(own) => own.validated()?,
        None => state.settings.get()?.proxy,
    };
    state.cluster_info(&endpoint, creds, &proxy).await
}

/// Test a saved profile; the secret never leaves the Rust side.
#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn test_profile(state: St<'_>, id: String) -> Cmd<'_, ClusterInfo> {
    let (endpoint, creds) = state.profiles.credentials(&id)?;
    let proxy = state.proxy_of(&id)?;
    state.cluster_info(&endpoint, creds, &proxy).await
}

/// Who the saved key belongs to (asked over S3, which needs no cap) and what it may read on
/// the Admin API. Decides which admin screens the UI offers.
#[tauri::command]
async fn caller_access(state: St<'_>, cluster_id: String) -> Cmd<'_, CallerAccess> {
    // "Me" is whoever the browse key belongs to; the profile's key then asks about that uid.
    let (endpoint, creds) = state.profiles.browse_credentials(&cluster_id)?;
    let proxy = state.proxy_of(&cluster_id)?;
    let own = s3::S3::with_proxy(&endpoint, &creds.access_key, &creds.secret_key, &proxy)?;
    let uid = own.whoami().await?;
    state.ops(&cluster_id)?.caller_access(&uid).await
}

// ---- users ----------------------------------------------------------------

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn user_set_suspended(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    suspended: bool,
) -> Cmd<'_, UserInfo> {
    state.ops(&cluster_id)?.set_suspended(&uid, suspended).await
}

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn key_create(state: St<'_>, cluster_id: String, uid: String) -> Cmd<'_, KeyPair> {
    state.ops(&cluster_id)?.create_key(&uid).await
}

#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn key_remove(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    access_key: String,
) -> Cmd<'_, ()> {
    state.ops(&cluster_id)?.remove_key(&uid, &access_key).await
}

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn key_rotate(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    access_key: String,
) -> Cmd<'_, RotatedKey> {
    state.ops(&cluster_id)?.rotate_key(&uid, &access_key).await
}

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn caps_add(
    state: St<'_>,
    cluster_id: String,
    uid: String,
    cap: String,
) -> Cmd<'_, Vec<Capability>> {
    state.ops(&cluster_id)?.add_cap(&uid, &cap).await
}

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
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

#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn usage_support(state: St<'_>, cluster_id: String) -> Cmd<'_, UsageSupport> {
    state.ops(&cluster_id)?.usage_support().await
}

/// Writes an export next to the user's downloads and returns where it went.
#[allow(dead_code)] // admin UI removed M7b
#[tauri::command(async)]
fn export_save(file_name: String, content: String) -> Cmd<'static, String> {
    let path = export::save(&export::export_dir()?, &file_name, &content)?;
    Ok(path.display().to_string())
}

// ---- buckets --------------------------------------------------------------

#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn buckets_list(
    state: St<'_>,
    cluster_id: String,
    uid: Option<String>,
) -> Cmd<'_, Vec<BucketInfo>> {
    state.ops(&cluster_id)?.list_buckets(uid.as_deref()).await
}

#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn bucket_get(state: St<'_>, cluster_id: String, bucket: String) -> Cmd<'_, BucketDetail> {
    state.ops(&cluster_id)?.get_bucket(&bucket).await
}

#[allow(dead_code)] // admin UI removed M7b
#[tauri::command]
async fn bucket_delete(state: St<'_>, cluster_id: String, bucket: String) -> Cmd<'_, ()> {
    state.ops(&cluster_id)?.delete_bucket(&bucket).await
}

#[allow(dead_code)] // admin UI removed M7b
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
#[allow(dead_code)] // admin UI removed M7b
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
#[allow(dead_code)] // admin UI removed M7b
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
                settings: SettingsStore::new(&clusters::data_dir()?),
                http: Mutex::default(),
                browse: browse::Sessions::default(),
                transfers: browse::Transfers::default(),
                policies: browse::PolicyCache::default(),
            });
            // Before the first paint: the window never shows at another size than the saved one.
            if let Some(window) = app.get_webview_window("main") {
                let saved = app.state::<AppState>().settings.get();
                let _ = apply_ui_scale(&window, saved.map(|s| s.scale()).unwrap_or(100));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            add_profile,
            remove_profile,
            recent_list,
            recent_add,
            pin_list,
            pin_add,
            pin_remove,
            pin_rename,
            pin_move,
            tabs_get,
            tabs_set,
            profile_set_proxy,
            profile_set_start_path,
            network_get,
            network_set,
            get_ui_scale,
            set_ui_scale,
            get_lang,
            set_lang,
            endpoint_kind,
            test_s3,
            update_check,
            update_open,
            caller_access,
            user_get,
            quota_get,
            usage_get,
            browse::browse_key_set,
            browse::browse_open,
            browse::path_probe,
            browse::accessible_prefixes,
            browse::browse_list,
            browse::browse_pick_upload,
            browse::browse_pick_save,
            browse::browse_upload,
            browse::browse_download,
            browse::browse_presign,
            browse::browse_delete,
            browse::browse_undelete,
            browse::browse_deleted,
            browse::browse_set_versioning,
            browse::browse_read,
            browse::browse_media_url,
            browse::browse_parquet,
            browse::browse_versioning,
            browse::browse_versions,
            browse::browse_restore,
            browse::browse_acl_get,
            browse::browse_acl_put,
            browse::browse_acl_targets,
            browse::browse_acl_put_many,
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
