//! Cluster profiles. Metadata lives in `profiles.json`; the secret key lives
//! only in the OS keychain (Secret Service on Linux), never on disk.

use crate::rgw_admin::{parse_endpoint, Credentials};
use crate::settings::Proxy;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const KEYCHAIN_SERVICE: &str = "bucketadmin";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClusterProfile {
    pub id: String,
    pub label: String,
    pub endpoint: String,
    pub access_key: String,
    /// Access key of the personal S3 key saved for "browse with my own key"; its secret is
    /// in the keychain under `<id>.browse`. Absent in files written before M6.
    #[serde(default)]
    pub browse_access_key: Option<String>,
    /// "I am a normal user": the key has no admin caps, so the UI hides the admin screens
    /// and never calls the Admin API for this profile.
    #[serde(default)]
    pub plain_user: bool,
    /// This cluster's own proxy choice; absent = follow the app-wide setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<Proxy>,
}

/// Where secret keys go. The app uses [`Keychain`]; tests use an in-memory map.
pub trait SecretStore: Send + Sync {
    fn set(&self, id: &str, secret: &str) -> Result<(), String>;
    fn get(&self, id: &str) -> Result<String, String>;
    /// Deleting a secret that does not exist is not an error.
    fn delete(&self, id: &str) -> Result<(), String>;
}

/// OS keychain entry `service = "bucketadmin"`, `username = <profile id>`.
pub struct Keychain;

impl Keychain {
    fn entry(id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, id).map_err(|e| format!("keychain: {e}"))
    }
}

impl SecretStore for Keychain {
    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        Self::entry(id)?
            .set_password(secret)
            .map_err(|e| format!("keychain: cannot store secret key: {e}"))
    }

    fn get(&self, id: &str) -> Result<String, String> {
        Self::entry(id)?
            .get_password()
            .map_err(|e| format!("keychain: cannot read secret key: {e}"))
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain: cannot delete secret key: {e}")),
        }
    }
}

pub struct ProfileStore<S = Keychain> {
    dir: PathBuf,
    secrets: S,
    // Serialises read-modify-write of profiles.json across concurrent commands.
    lock: Mutex<()>,
}

/// `$XDG_DATA_HOME/bucketadmin`, i.e. `~/.local/share/bucketadmin` by default.
pub fn data_dir() -> Result<PathBuf, String> {
    let base = match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        Some(p) if p.is_absolute() => p,
        _ => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?).join(".local/share"),
    };
    Ok(base.join("bucketadmin"))
}

impl ProfileStore<Keychain> {
    pub fn open_default() -> Result<Self, String> {
        Ok(Self::new(data_dir()?, Keychain))
    }
}

impl<S: SecretStore> ProfileStore<S> {
    pub fn new(dir: PathBuf, secrets: S) -> Self {
        Self {
            dir,
            secrets,
            lock: Mutex::new(()),
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join("profiles.json")
    }

    fn read(&self) -> Result<Vec<ClusterProfile>, String> {
        let path = self.file();
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("{} is corrupt: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("cannot read {}: {e}", path.display())),
        }
    }

    fn write(&self, profiles: &[ClusterProfile]) -> Result<(), String> {
        let path = self.file();
        let err = |e: std::io::Error| format!("cannot write {}: {e}", path.display());
        std::fs::create_dir_all(&self.dir).map_err(err)?;
        // Write-then-rename so a crash never leaves a half-written profiles.json.
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(profiles).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, json).map_err(err)?;
        std::fs::rename(&tmp, &path).map_err(err)
    }

    pub fn list(&self) -> Result<Vec<ClusterProfile>, String> {
        let _guard = self.lock.lock().map_err(|e| e.to_string())?;
        self.read()
    }

    pub fn add(
        &self,
        label: &str,
        endpoint: &str,
        access_key: &str,
        secret_key: &str,
    ) -> Result<ClusterProfile, String> {
        if secret_key.is_empty() {
            return Err("secret key is required".into());
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let profile = validated(ClusterProfile {
            id: format!("{nanos:x}"),
            label: label.into(),
            endpoint: endpoint.into(),
            access_key: access_key.into(),
            browse_access_key: None,
            plain_user: false,
            proxy: None,
        })?;
        let _guard = self.lock.lock().map_err(|e| e.to_string())?;
        let mut profiles = self.read()?;
        self.secrets.set(&profile.id, secret_key)?;
        profiles.push(profile.clone());
        if let Err(e) = self.write(&profiles) {
            let _ = self.secrets.delete(&profile.id); // do not leave an orphan secret
            return Err(e);
        }
        Ok(profile)
    }

    /// Replaces the profile with the same id; `secret_key = None` keeps the stored secret.
    pub fn update(&self, profile: ClusterProfile, secret_key: Option<&str>) -> Result<(), String> {
        let profile = validated(profile)?;
        let _guard = self.lock.lock().map_err(|e| e.to_string())?;
        let mut profiles = self.read()?;
        let slot = profiles
            .iter_mut()
            .find(|p| p.id == profile.id)
            .ok_or_else(|| format!("no cluster profile with id {}", profile.id))?;
        if let Some(secret) = secret_key.filter(|s| !s.is_empty()) {
            self.secrets.set(&profile.id, secret)?;
        }
        *slot = profile;
        self.write(&profiles)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|e| e.to_string())?;
        let mut profiles = self.read()?;
        profiles.retain(|p| p.id != id);
        self.write(&profiles)?;
        self.secrets.delete(&browse_secret_id(id))?;
        self.secrets.delete(id)
    }

    /// Saves (or replaces) the personal S3 key the Browse page signs with in "my own key"
    /// mode. Nothing is checked against the cluster here: no Admin API call is involved.
    pub fn set_browse_key(
        &self,
        id: &str,
        access_key: &str,
        secret_key: &str,
    ) -> Result<ClusterProfile, String> {
        // Pasted keys often carry a trailing newline or space; S3 keys never contain one.
        let (access_key, secret_key) = (access_key.trim(), secret_key.trim());
        if access_key.is_empty() || secret_key.is_empty() {
            return Err("access key and secret key are required".into());
        }
        self.change(id, |profile| {
            self.secrets.set(&browse_secret_id(id), secret_key)?;
            profile.browse_access_key = Some(access_key.to_string());
            Ok(())
        })
    }

    /// Marks the profile as a normal user's (or back). A normal user's cluster key is their
    /// personal key, so it also becomes the browse key unless one was already entered.
    pub fn set_plain_user(&self, id: &str, plain: bool) -> Result<ClusterProfile, String> {
        self.change(id, |profile| {
            if plain && profile.browse_access_key.is_none() {
                let secret = self.secrets.get(id)?;
                self.secrets.set(&browse_secret_id(id), &secret)?;
                profile.browse_access_key = Some(profile.access_key.clone());
            }
            profile.plain_user = plain;
            Ok(())
        })
    }

    /// Sets this cluster's own proxy choice, or (`None`) puts it back on the app-wide setting.
    pub fn set_proxy(&self, id: &str, proxy: Option<Proxy>) -> Result<ClusterProfile, String> {
        let proxy = proxy.map(Proxy::validated).transpose()?;
        self.change(id, |profile| {
            profile.proxy = proxy;
            Ok(())
        })
    }

    /// The cluster's own proxy choice, if it has one.
    pub fn proxy(&self, id: &str) -> Result<Option<Proxy>, String> {
        Ok(self.find(id)?.proxy)
    }

    /// Forgets the personal key: the keychain entry and its access key in the profile.
    pub fn clear_browse_key(&self, id: &str) -> Result<ClusterProfile, String> {
        self.change(id, |profile| {
            self.secrets.delete(&browse_secret_id(id))?;
            profile.browse_access_key = None;
            Ok(())
        })
    }

    /// Endpoint plus the key a browse session signs with: the personal key saved by
    /// [`Self::set_browse_key`], or the profile's own key when no separate one was entered
    /// (the usual case since the app became browse-only: the profile's key IS the user's key).
    pub fn browse_credentials(&self, id: &str) -> Result<(String, Credentials), String> {
        let profile = self.find(id)?;
        let Some(access_key) = profile.browse_access_key else {
            return self.credentials(id);
        };
        let secret_key = self.secrets.get(&browse_secret_id(id))?;
        let creds = Credentials {
            access_key,
            secret_key,
        };
        Ok((profile.endpoint, creds))
    }

    fn find(&self, id: &str) -> Result<ClusterProfile, String> {
        let found = self.list()?.into_iter().find(|p| p.id == id);
        found.ok_or_else(|| format!("no cluster profile with id {id}"))
    }

    /// Read-modify-write of one profile under the lock; returns the profile as saved.
    fn change(
        &self,
        id: &str,
        edit: impl FnOnce(&mut ClusterProfile) -> Result<(), String>,
    ) -> Result<ClusterProfile, String> {
        let _guard = self.lock.lock().map_err(|e| e.to_string())?;
        let mut profiles = self.read()?;
        let slot = profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("no cluster profile with id {id}"))?;
        edit(slot)?;
        let saved = slot.clone();
        self.write(&profiles)?;
        Ok(saved)
    }

    /// Endpoint plus full credentials (secret read from the keychain) for a saved profile.
    pub fn credentials(&self, id: &str) -> Result<(String, Credentials), String> {
        let profile = self.find(id)?;
        let creds = Credentials {
            access_key: profile.access_key,
            secret_key: self.secrets.get(id)?,
        };
        Ok((profile.endpoint, creds))
    }
}

/// Keychain entry of a profile's personal browse key (the admin secret is under the bare id).
fn browse_secret_id(id: &str) -> String {
    format!("{id}.browse")
}

/// Trims the fields and rejects profiles that could never connect.
fn validated(mut p: ClusterProfile) -> Result<ClusterProfile, String> {
    p.label = p.label.trim().to_string();
    p.endpoint = p.endpoint.trim().trim_end_matches('/').to_string();
    p.access_key = p.access_key.trim().to_string();
    if p.label.is_empty() {
        return Err("label is required".into());
    }
    if p.access_key.is_empty() {
        return Err("access key is required".into());
    }
    parse_endpoint(&p.endpoint).map_err(|e| e.to_string())?;
    Ok(p)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    pub(crate) struct MemorySecrets(pub(crate) Mutex<HashMap<String, String>>);

    impl SecretStore for &MemorySecrets {
        fn set(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            let found = self.0.lock().unwrap().get(id).cloned();
            found.ok_or_else(|| "no entry".to_string())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    pub(crate) fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bucketadmin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn profile_round_trip_keeps_secret_out_of_the_file() {
        let dir = temp_dir("roundtrip");
        let secrets = MemorySecrets::default();
        let store = ProfileStore::new(dir.clone(), &secrets);
        assert_eq!(store.list().unwrap(), []);

        let added = store
            .add(" lab ", "http://127.0.0.1:7480/", "AKLAB", "s3cr3t-value")
            .unwrap();
        assert_eq!(added.label, "lab");
        assert_eq!(added.endpoint, "http://127.0.0.1:7480");

        // A second store on the same directory sees the profile: it is persisted.
        let reopened = ProfileStore::new(dir.clone(), &secrets);
        assert_eq!(reopened.list().unwrap(), std::slice::from_ref(&added));
        let (endpoint, creds) = reopened.credentials(&added.id).unwrap();
        assert_eq!(endpoint, "http://127.0.0.1:7480");
        assert_eq!(creds.access_key, "AKLAB");
        assert_eq!(creds.secret_key, "s3cr3t-value");

        let on_disk = std::fs::read_to_string(dir.join("profiles.json")).unwrap();
        assert!(on_disk.contains("AKLAB"));
        assert!(!on_disk.contains("s3cr3t-value"), "secret leaked to disk");

        let renamed = ClusterProfile {
            label: "lab-2".into(),
            ..added.clone()
        };
        store.update(renamed.clone(), None).unwrap();
        assert_eq!(
            store.credentials(&added.id).unwrap().1.secret_key,
            "s3cr3t-value"
        );
        store.update(renamed.clone(), Some("rotated")).unwrap();
        assert_eq!(
            store.credentials(&added.id).unwrap().1.secret_key,
            "rotated"
        );
        assert_eq!(store.list().unwrap(), [renamed]);

        store.remove(&added.id).unwrap();
        assert_eq!(store.list().unwrap(), []);
        assert!(secrets.0.lock().unwrap().is_empty(), "secret not deleted");
        assert!(store.credentials(&added.id).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_profiles_are_rejected_and_store_nothing() {
        let dir = temp_dir("invalid");
        let secrets = MemorySecrets::default();
        let store = ProfileStore::new(dir.clone(), &secrets);
        assert!(store.add("", "http://h:1", "AK", "SK").is_err());
        assert!(store.add("lab", "h:1", "AK", "SK").is_err());
        assert!(store.add("lab", "http://h:1", " ", "SK").is_err());
        assert!(store.add("lab", "http://h:1", "AK", "").is_err());
        let ghost = ClusterProfile {
            id: "missing".into(),
            label: "x".into(),
            endpoint: "http://h:1".into(),
            access_key: "AK".into(),
            browse_access_key: None,
            plain_user: false,
            proxy: None,
        };
        assert!(store.update(ghost, Some("SK")).is_err());
        assert!(secrets.0.lock().unwrap().is_empty());
        assert!(!dir.join("profiles.json").exists());
    }

    #[test]
    fn a_profile_can_override_the_proxy_and_go_back_to_the_shared_setting() {
        let dir = temp_dir("proxy");
        let secrets = MemorySecrets::default();
        let store = ProfileStore::new(dir.clone(), &secrets);
        let p = store.add("lab", "http://h:1", "AK", "SK").unwrap();
        assert_eq!(store.proxy(&p.id).unwrap(), None);
        let file = || std::fs::read_to_string(dir.join("profiles.json")).unwrap();
        assert!(!file().contains("proxy"), "no override, nothing written");

        let saved = store.set_proxy(&p.id, Some(Proxy::None)).unwrap();
        assert_eq!(saved.proxy, Some(Proxy::None));
        assert!(file().contains(r#""mode": "none""#));
        let custom = Proxy::Custom {
            url: " http://proxy.example:3128 ".into(),
        };
        store.set_proxy(&p.id, Some(custom)).unwrap();
        let trimmed = Proxy::Custom {
            url: "http://proxy.example:3128".into(),
        };
        assert_eq!(store.proxy(&p.id).unwrap(), Some(trimmed.clone()));
        let junk = Proxy::Custom { url: "nope".into() };
        assert!(store.set_proxy(&p.id, Some(junk)).is_err());
        assert_eq!(
            store.proxy(&p.id).unwrap(),
            Some(trimmed),
            "a refused URL changes nothing"
        );
        store.set_proxy(&p.id, None).unwrap();
        assert_eq!(store.proxy(&p.id).unwrap(), None);
        assert!(store.set_proxy("missing", None).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn browse_key_is_kept_apart_from_the_admin_key() {
        let dir = temp_dir("browsekey");
        let secrets = MemorySecrets::default();
        let store = ProfileStore::new(dir.clone(), &secrets);
        let p = store
            .add("lab", "http://h:1", "AKADMIN", "admin-secret")
            .unwrap();
        assert_eq!(p.browse_access_key, None);
        assert_eq!(
            store.browse_credentials(&p.id).unwrap().1.access_key,
            "AKADMIN",
            "no separate key yet: the profile's own key browses"
        );
        assert!(store.set_browse_key(&p.id, "AKMINE", " ").is_err());
        assert!(store.set_browse_key("missing", "AKMINE", "s").is_err());

        // Pasted with stray whitespace; saved trimmed.
        let saved = store
            .set_browse_key(&p.id, " AKMINE\n", "my-secret\n")
            .unwrap();
        assert_eq!(saved.browse_access_key.as_deref(), Some("AKMINE"));
        let (endpoint, mine) = store.browse_credentials(&p.id).unwrap();
        assert_eq!(
            (endpoint.as_str(), mine.access_key.as_str()),
            ("http://h:1", "AKMINE")
        );
        assert_eq!(mine.secret_key, "my-secret");
        assert_eq!(
            store.credentials(&p.id).unwrap().1.secret_key,
            "admin-secret"
        );
        let on_disk = std::fs::read_to_string(dir.join("profiles.json")).unwrap();
        assert!(on_disk.contains("AKMINE") && !on_disk.contains("my-secret"));

        // Entered again: replaced. Deleted: gone from the file and the secret store.
        store.set_browse_key(&p.id, "AKMINE2", "second").unwrap();
        assert_eq!(
            store.browse_credentials(&p.id).unwrap().1.secret_key,
            "second"
        );
        assert_eq!(
            store.clear_browse_key(&p.id).unwrap().browse_access_key,
            None
        );
        assert_eq!(
            store.browse_credentials(&p.id).unwrap().1.secret_key,
            "admin-secret",
            "back on the profile's own key"
        );
        assert_eq!(
            secrets.0.lock().unwrap().len(),
            1,
            "only the admin secret is left"
        );

        // Removing the profile takes a saved browse key with it.
        store.set_browse_key(&p.id, "AKMINE", "my-secret").unwrap();
        store.remove(&p.id).unwrap();
        assert!(
            secrets.0.lock().unwrap().is_empty(),
            "browse secret left behind"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn plain_user_profile_browses_with_its_own_key() {
        let dir = temp_dir("plain");
        let secrets = MemorySecrets::default();
        let store = ProfileStore::new(dir.clone(), &secrets);
        let p = store
            .add("mine", "http://h:1", "AKMINE", "my-secret")
            .unwrap();
        assert!(!p.plain_user);
        let marked = store.set_plain_user(&p.id, true).unwrap();
        assert!(marked.plain_user);
        assert_eq!(marked.browse_access_key.as_deref(), Some("AKMINE"));
        let mine = store.browse_credentials(&p.id).unwrap().1;
        assert_eq!(mine.secret_key, "my-secret");

        // Unmarking keeps the browse key; marking again does not overwrite one typed in since.
        assert!(!store.set_plain_user(&p.id, false).unwrap().plain_user);
        store
            .set_browse_key(&p.id, "AKOTHER", "other-secret")
            .unwrap();
        let again = store.set_plain_user(&p.id, true).unwrap();
        assert_eq!(again.browse_access_key.as_deref(), Some("AKOTHER"));
        assert!(store.set_plain_user("missing", true).is_err());
        store.remove(&p.id).unwrap();
        assert!(secrets.0.lock().unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn profiles_written_before_m6_still_load() {
        let dir = temp_dir("oldfile");
        std::fs::create_dir_all(&dir).unwrap();
        let old = r#"[{"id":"1","label":"lab","endpoint":"http://h:1","access_key":"AK"}]"#;
        std::fs::write(dir.join("profiles.json"), old).unwrap();
        let secrets = MemorySecrets::default();
        let listed = ProfileStore::new(dir.clone(), &secrets).list().unwrap();
        assert_eq!(listed[0].browse_access_key, None);
        assert!(!listed[0].plain_user);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Talks to the real Secret Service, so it needs a desktop session with an
    /// unlocked keyring: `cargo test real_keychain -- --ignored`.
    #[test]
    #[ignore = "needs a running, unlocked Secret Service (desktop session)"]
    fn real_keychain_round_trip() {
        let id = format!("selftest-{}", std::process::id());
        Keychain.set(&id, "round-trip-secret").unwrap();
        assert_eq!(Keychain.get(&id).unwrap(), "round-trip-secret");
        Keychain.delete(&id).unwrap();
        assert!(Keychain.get(&id).is_err());
        Keychain.delete(&id).unwrap(); // deleting again is not an error
    }
}
