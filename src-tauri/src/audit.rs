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

/// One row of the audit-log viewer: what was done, where. `target` of the stored entry
/// ("bucket/folder/file") is split into bucket, folder and object name.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuditRow {
    /// Unix seconds (UTC).
    pub ts: i64,
    pub action: String,
    pub cluster_id: String,
    pub bucket: String,
    pub prefix: String,
    pub object: String,
    pub ok: bool,
    /// Error text when `ok` is false, empty otherwise.
    pub message: String,
}

/// "bucket/a/b.txt" -> ("bucket", "a/", "b.txt"); "bucket/a/" -> ("bucket", "a/", ""); "bucket" -> ("bucket", "", "").
pub fn split_target(target: &str) -> (String, String, String) {
    let (bucket, key) = target.split_once('/').unwrap_or((target, ""));
    let cut = key.rfind('/').map_or(0, |at| at + 1);
    (bucket.into(), key[..cut].into(), key[cut..].into())
}

/// The viewer never asks for more rows than this at once.
pub const LIST_MAX: u32 = 1000;

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

    /// The viewer's page of the log, newest first: `limit` rows (at most [`LIST_MAX`]) after skipping
    /// `offset`, not older than `since_unix`. A non-empty `filter` must be part of the action or of
    /// the target, whatever the case, or the entry must be of one of `filter_clusters` (the
    /// connections whose label matches: labels are not in the log). Read-only.
    pub fn list(
        &self,
        limit: u32,
        offset: u32,
        filter: &str,
        filter_clusters: &[String],
        since_unix: i64,
    ) -> Result<Vec<AuditRow>, String> {
        // LIKE with its wildcards escaped: the text is looked for as it is typed.
        let escaped = filter
            .trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let like = format!("%{escaped}%");
        let clusters = format!("\n{}\n", filter_clusters.join("\n"));
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT ts, action, cluster_id, target, ok, message FROM audit
                 WHERE ts >= ?1 AND (?2 = '%%' OR action LIKE ?2 ESCAPE '\\' OR target LIKE ?2 ESCAPE '\\'
                        OR instr(?3, char(10) || cluster_id || char(10)) > 0)
                 ORDER BY id DESC LIMIT ?4 OFFSET ?5",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(
                params![since_unix, like, clusters, limit.min(LIST_MAX), offset],
                |row| {
                    let (bucket, prefix, object) = split_target(&row.get::<_, String>(3)?);
                    Ok(AuditRow {
                        ts: row.get(0)?,
                        action: row.get(1)?,
                        cluster_id: row.get(2)?,
                        bucket,
                        prefix,
                        object,
                        ok: row.get(4)?,
                        message: row.get(5)?,
                    })
                },
            )
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
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
    fn the_viewer_lists_a_log_file_by_page_filter_and_time() {
        assert_eq!(
            split_target("logs/2026/11/a.txt"),
            ("logs".into(), "2026/11/".into(), "a.txt".into())
        );
        assert_eq!(
            split_target("logs/2026/"),
            ("logs".into(), "2026/".into(), "".into())
        );
        assert_eq!(split_target("logs"), ("logs".into(), "".into(), "".into()));
        assert_eq!(
            split_target("logs/a.txt"),
            ("logs".into(), "".into(), "a.txt".into())
        );

        // A real file, as the app keeps it next to profiles.json.
        let dir = std::env::temp_dir().join(format!("ba-audit-list-{}", std::process::id()));
        let audit = Audit::open(&dir.join("audit.db")).unwrap();
        audit
            .record("c1", "object.upload", "logs/2026/a.txt", "size=3", None)
            .unwrap();
        audit
            .record(
                "c2",
                "object.delete",
                "media/100%_done.png",
                "",
                Some("AccessDenied"),
            )
            .unwrap();
        audit
            .record("c1", "bucket.create", "team-data", "", None)
            .unwrap();
        audit
            .record("c1", "acl.set_many", "logs/2026/", "objects=3", None)
            .unwrap();
        // One entry from long ago.
        let old = "UPDATE audit SET ts = 1000 WHERE action = 'object.upload'";
        audit.0.lock().unwrap().execute(old, []).unwrap();

        let all = audit.list(200, 0, "", &[], 0).unwrap();
        let actions = |rows: &[AuditRow]| rows.iter().map(|r| r.action.clone()).collect::<Vec<_>>();
        assert_eq!(
            actions(&all),
            [
                "acl.set_many",
                "bucket.create",
                "object.delete",
                "object.upload"
            ]
        );
        let (folder, denied) = (&all[0], &all[2]);
        assert_eq!(
            (
                folder.bucket.as_str(),
                folder.prefix.as_str(),
                folder.object.as_str(),
                folder.ok
            ),
            ("logs", "2026/", "", true)
        );
        assert_eq!(
            (
                denied.cluster_id.as_str(),
                denied.object.as_str(),
                denied.ok,
                denied.message.as_str()
            ),
            ("c2", "100%_done.png", false, "AccessDenied")
        );
        // Pages.
        assert_eq!(
            actions(&audit.list(2, 0, "", &[], 0).unwrap()),
            ["acl.set_many", "bucket.create"]
        );
        assert_eq!(
            actions(&audit.list(2, 2, "", &[], 0).unwrap()),
            ["object.delete", "object.upload"]
        );
        assert!(audit.list(2, 4, "", &[], 0).unwrap().is_empty());
        // Since: the old entry is left out.
        assert_eq!(audit.list(200, 0, "", &[], 1001).unwrap().len(), 3);
        // Filter: a part of the action or of the path, any case; % and _ are plain characters.
        assert_eq!(
            actions(&audit.list(200, 0, " OBJECT. ", &[], 0).unwrap()),
            ["object.delete", "object.upload"]
        );
        assert_eq!(
            actions(&audit.list(200, 0, "logs/2026", &[], 0).unwrap()),
            ["acl.set_many", "object.upload"]
        );
        assert_eq!(
            actions(&audit.list(200, 0, "100%_", &[], 0).unwrap()),
            ["object.delete"]
        );
        assert!(audit.list(200, 0, "%", &[], 0).unwrap().len() == 1);
        assert!(audit
            .list(200, 0, "nothing-like-it", &[], 0)
            .unwrap()
            .is_empty());
        // ... or the entries of the connections whose label matched.
        assert_eq!(
            actions(&audit.list(200, 0, "prod", &["c2".into()], 0).unwrap()),
            ["object.delete"]
        );
        // Reading changed nothing.
        assert_eq!(audit.list(200, 0, "", &[], 0).unwrap(), all);
        std::fs::remove_dir_all(dir).unwrap();
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
