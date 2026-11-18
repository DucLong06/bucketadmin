//! Cluster profiles. Metadata lives in `profiles.json`; the secret key lives
//! only in the OS keychain (Secret Service on Linux), never on disk.

use crate::rgw_admin::{parse_endpoint, Credentials};
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

impl ProfileStore<Keychain> {
    /// `$XDG_DATA_HOME/bucketadmin`, i.e. `~/.local/share/bucketadmin` by default.
    pub fn open_default() -> Result<Self, String> {
        let base = match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
            Some(p) if p.is_absolute() => p,
            _ => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?)
                .join(".local/share"),
        };
        Ok(Self::new(base.join("bucketadmin"), Keychain))
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
        self.secrets.delete(id)
    }

    /// Endpoint plus full credentials (secret read from the keychain) for a saved profile.
    pub fn credentials(&self, id: &str) -> Result<(String, Credentials), String> {
        let profile = self
            .list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("no cluster profile with id {id}"))?;
        let creds = Credentials {
            access_key: profile.access_key,
            secret_key: self.secrets.get(id)?,
        };
        Ok((profile.endpoint, creds))
    }
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
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemorySecrets(Mutex<HashMap<String, String>>);

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

    fn temp_dir(name: &str) -> PathBuf {
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
        assert_eq!(reopened.list().unwrap(), [added.clone()]);
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
        };
        assert!(store.update(ghost, Some("SK")).is_err());
        assert!(secrets.0.lock().unwrap().is_empty());
        assert!(!dir.join("profiles.json").exists());
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
