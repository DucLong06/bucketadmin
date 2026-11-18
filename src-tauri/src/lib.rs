pub mod audit;
pub mod clusters;
pub mod rgw_admin;

use clusters::{ClusterProfile, ProfileStore};
use rgw_admin::{ClusterInfo, Credentials, ReqwestClient, RgwAdmin};
use tauri::{Manager, State};

// Errors cross the IPC boundary as display strings; the UI shows them verbatim.

async fn cluster_info(endpoint: &str, creds: Credentials) -> Result<ClusterInfo, String> {
    let http = ReqwestClient::new().map_err(|e| e.to_string())?;
    let admin = RgwAdmin::new(endpoint, creds, http).map_err(|e| e.to_string())?;
    admin.get_info().await.map_err(|e| e.to_string())
}

// `(async)` keeps the blocking file/keychain calls off the UI thread.
#[tauri::command(async)]
fn list_profiles(store: State<'_, ProfileStore>) -> Result<Vec<ClusterProfile>, String> {
    store.list()
}

#[tauri::command(async)]
fn add_profile(
    store: State<'_, ProfileStore>,
    label: String,
    endpoint: String,
    access_key: String,
    secret_key: String,
) -> Result<ClusterProfile, String> {
    store.add(&label, &endpoint, &access_key, &secret_key)
}

#[tauri::command(async)]
fn remove_profile(store: State<'_, ProfileStore>, id: String) -> Result<(), String> {
    store.remove(&id)
}

/// Test credentials typed into the form, before anything is saved.
#[tauri::command]
async fn test_connection(
    endpoint: String,
    access_key: String,
    secret_key: String,
) -> Result<ClusterInfo, String> {
    let creds = Credentials {
        access_key: access_key.trim().to_string(),
        secret_key,
    };
    cluster_info(&endpoint, creds).await
}

/// Test a saved profile; the secret never leaves the Rust side.
#[tauri::command]
async fn test_profile(store: State<'_, ProfileStore>, id: String) -> Result<ClusterInfo, String> {
    let (endpoint, creds) = store.credentials(&id)?;
    cluster_info(&endpoint, creds).await
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(ProfileStore::open_default()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            add_profile,
            remove_profile,
            test_connection,
            test_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running BucketAdmin");
}
