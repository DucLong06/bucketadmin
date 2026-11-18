//! The Browse page's commands. Every S3 call here is signed with the key of the user being
//! browsed as. The admin credentials are used for exactly one thing: looking up that key.

use crate::rgw_admin::RgwAdmin;
use crate::s3::{BucketEntry, Listing, LIST_PAGE, S3};
use crate::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

type Cmd<T> = Result<T, String>;
type St<'a> = State<'a, AppState>;

/// One S3 client per (cluster, uid), so the user's key is looked up once, not per request.
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<(String, String), S3>>);

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
        let (endpoint, admin_creds) = self.profiles.credentials(cluster_id)?;
        let admin = RgwAdmin::new(&endpoint, admin_creds, self.http.clone());
        let user = admin.map_err(|e| e.to_string())?.get_user(uid).await;
        let user = user.map_err(|e| e.to_string())?;
        // shortcut: always the user's first S3 key; let the admin pick one if users with
        // several keys of different reach turn out to matter.
        let key = user
            .keys
            .first()
            .ok_or_else(|| format!("user {uid} has no S3 key to browse with"))?;
        let s3 = S3::new(&endpoint, &key.access_key, &key.secret_key);
        let mut sessions = self.browse.0.lock().map_err(|e| e.to_string())?;
        sessions.insert(cache_key, s3.clone());
        Ok(s3)
    }
}

#[derive(Serialize)]
pub struct Opened {
    /// Which of the user's keys the session signs with (the secret stays in the backend).
    access_key: String,
    buckets: Vec<BucketEntry>,
}

/// Starts (or restarts) browsing as `uid` and lists the buckets that user owns.
#[tauri::command]
pub async fn browse_open(state: St<'_>, cluster_id: String, uid: String) -> Cmd<Opened> {
    let s3 = state.s3(&cluster_id, &uid, true).await?;
    Ok(Opened {
        access_key: s3.access_key().to_string(),
        buckets: s3.list_buckets().await?,
    })
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
