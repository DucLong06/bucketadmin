//! Append-only audit log of admin operations (SQLite, `audit.db`).
//! Callers pass uids, cap strings, access key ids, quota numbers — never secret keys.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The Audit page shows this many newest rows.
const RECENT_LIMIT: i64 = 100;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuditEntry {
    pub id: i64,
    /// Unix seconds (UTC).
    pub ts: i64,
    pub cluster_id: String,
    pub action: String,
    pub target: String,
    pub detail: String,
    pub ok: bool,
    /// Error text when `ok` is false, empty otherwise.
    pub message: String,
}

pub struct Audit(Mutex<Connection>);

fn db_err(e: rusqlite::Error) -> String {
    format!("audit log: {e}")
}

impl Audit {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        Self::init(Connection::open(path).map_err(db_err)?)
    }

    /// For tests: nothing touches the disk.
    pub fn in_memory() -> Result<Self, String> {
        Self::init(Connection::open_in_memory().map_err(db_err)?)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                cluster_id TEXT NOT NULL,
                action TEXT NOT NULL,
                target TEXT NOT NULL,
                detail TEXT NOT NULL,
                ok INTEGER NOT NULL,
                message TEXT NOT NULL
            )",
        )
        .map_err(db_err)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// `error = None` records a success.
    pub fn record(
        &self,
        cluster_id: &str,
        action: &str,
        target: &str,
        detail: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs() as i64;
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO audit (ts, cluster_id, action, target, detail, ok, message)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                ts,
                cluster_id,
                action,
                target,
                detail,
                error.is_none(),
                error.unwrap_or("")
            ],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Newest first, at most 100 rows; `None` filters match everything.
    pub fn recent(
        &self,
        action: Option<&str>,
        cluster_id: Option<&str>,
    ) -> Result<Vec<AuditEntry>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, ts, cluster_id, action, target, detail, ok, message FROM audit
                 WHERE (?1 IS NULL OR action = ?1) AND (?2 IS NULL OR cluster_id = ?2)
                 ORDER BY id DESC LIMIT ?3",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![action, cluster_id, RECENT_LIMIT], |row| {
                Ok(AuditEntry {
                    id: row.get(0)?,
                    ts: row.get(1)?,
                    cluster_id: row.get(2)?,
                    action: row.get(3)?,
                    target: row.get(4)?,
                    detail: row.get(5)?,
                    ok: row.get(6)?,
                    message: row.get(7)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_filters_newest_first() {
        let audit = Audit::in_memory().unwrap();
        audit
            .record("c1", "user.create", "alice", "", None)
            .unwrap();
        audit
            .record(
                "c1",
                "caps.add",
                "alice",
                "usage=read",
                Some("InvalidCapability"),
            )
            .unwrap();
        audit.record("c2", "user.create", "bob", "", None).unwrap();

        let all = audit.recent(None, None).unwrap();
        assert_eq!(
            all.iter().map(|e| e.target.as_str()).collect::<Vec<_>>(),
            ["bob", "alice", "alice"]
        );
        assert!(all[0].ok && all[0].message.is_empty());
        assert!(!all[1].ok);
        assert_eq!(all[1].message, "InvalidCapability");
        assert_eq!(all[1].detail, "usage=read");
        assert!(all[0].ts > 1_700_000_000);

        assert_eq!(audit.recent(Some("user.create"), None).unwrap().len(), 2);
        assert_eq!(audit.recent(None, Some("c1")).unwrap().len(), 2);
        let both = audit.recent(Some("user.create"), Some("c1")).unwrap();
        assert_eq!(both.len(), 1);
        assert_eq!(both[0].target, "alice");
        assert!(audit.recent(Some("quota.set"), None).unwrap().is_empty());
    }

    #[test]
    fn returns_only_the_latest_100() {
        let audit = Audit::in_memory().unwrap();
        for i in 0..105 {
            audit
                .record("c1", "user.modify", &format!("u{i}"), "", None)
                .unwrap();
        }
        let recent = audit.recent(None, None).unwrap();
        assert_eq!(recent.len(), 100);
        assert_eq!(recent[0].target, "u104");
        assert_eq!(recent[99].target, "u5");
    }

    #[test]
    fn survives_reopen() {
        let dir = std::env::temp_dir().join(format!("bucketadmin-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested/audit.db");
        Audit::open(&path)
            .unwrap()
            .record("c1", "user.delete", "alice", "", None)
            .unwrap();
        let reopened = Audit::open(&path).unwrap();
        assert_eq!(
            reopened.recent(None, None).unwrap()[0].action,
            "user.delete"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
