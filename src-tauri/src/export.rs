//! Saves files the user exports (CSV). The webview has no download handling, so the UI hands
//! the content to the backend, which writes it and reports the path.

use crate::clusters::data_dir;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// `~/Downloads` when it exists, otherwise `<app data>/exports`.
// shortcut: a localised downloads folder is not looked up (xdg user-dirs); such desktops get
// the app data folder. Read XDG_DOWNLOAD_DIR from user-dirs.dirs if that turns out to matter.
pub fn export_dir() -> Result<PathBuf, String> {
    let downloads = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Downloads"));
    match downloads {
        Some(dir) if dir.is_dir() => Ok(dir),
        _ => Ok(data_dir()?.join("exports")),
    }
}

/// Writes `content` to `dir/file_name` and returns the path actually used. An existing file is
/// never overwritten: `name.csv` becomes `name-1.csv`, `name-2.csv`, ...
pub fn save(dir: &Path, file_name: &str, content: &str) -> Result<PathBuf, String> {
    // The name comes from the UI: keep it a plain file name so it cannot leave `dir`.
    let plain = !file_name.is_empty()
        && file_name.len() <= 120
        && !file_name.starts_with('.')
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    let stem = file_name.strip_suffix(".csv").filter(|s| !s.is_empty());
    let Some(stem) = stem.filter(|_| plain) else {
        return Err(format!("invalid export file name: {file_name:?}"));
    };
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    for n in 0..1000 {
        let name = match n {
            0 => format!("{stem}.csv"),
            n => format!("{stem}-{n}.csv"),
        };
        let path = dir.join(name);
        // create_new: fails instead of truncating when the file already exists.
        // 0600: an onboarding report holds the new users' secret keys.
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(content.as_bytes())
                    .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
        }
    }
    Err(format!("too many existing exports named {file_name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bucketadmin-export-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn saves_without_overwriting() {
        let dir = temp_dir("save");
        let first = save(&dir, "usage-alice.csv", "a,b\r\n1,2\r\n").unwrap();
        assert_eq!(first, dir.join("usage-alice.csv"));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "a,b\r\n1,2\r\n");
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&first).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "exports are private to the user");

        let second = save(&dir, "usage-alice.csv", "new").unwrap();
        assert_eq!(second, dir.join("usage-alice-1.csv"));
        assert_eq!(
            std::fs::read_to_string(&first).unwrap(),
            "a,b\r\n1,2\r\n",
            "first export is untouched"
        );
        assert_eq!(
            save(&dir, "usage-alice.csv", "x").unwrap(),
            dir.join("usage-alice-2.csv")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_name_cannot_escape_the_directory() {
        let dir = temp_dir("names");
        for bad in [
            "",
            ".csv",
            "../evil.csv",
            "/etc/cron.d/evil.csv",
            "sub/dir.csv",
            ".hidden.csv",
            "usage.txt",
            "usage.csv.sh",
            "with space.csv",
            "nul\0.csv",
        ] {
            assert!(save(&dir, bad, "x").is_err(), "{bad:?} should be rejected");
        }
        assert!(!dir.exists(), "nothing is created for a rejected name");
    }
}
