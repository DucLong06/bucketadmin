//! Bounded recursive search for keys under a prefix.

use super::{object_entry, s3_error, ObjectEntry, LIST_PAGE, S3};
use serde::Serialize;
use std::time::{Duration, Instant};

/// Hard caps, whatever the caller asks for.
pub const MAX_RESULTS: usize = 1000;
pub const MAX_SECONDS: u64 = 60;

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub matches: Vec<ObjectEntry>,
    /// Keys looked at before the search ended.
    pub scanned: u64,
    /// Why it ended: `done` (every key under the prefix was looked at), `results` or `time`.
    pub stopped: &'static str,
}

/// A search pattern, lower-cased. What it is compared with follows `find`:
/// - no wildcard: any part of the path below the searched folder contains it;
/// - wildcards but no `/`: the file name matches it;
/// - wildcards and a `/`: the path below the searched folder matches it.
struct Pattern {
    glob: Vec<char>,
    name_only: bool,
}

impl Pattern {
    fn new(pattern: &str) -> Self {
        let lower = pattern.to_lowercase();
        if lower.contains(['*', '?']) {
            Self {
                name_only: !lower.contains('/'),
                glob: lower.chars().collect(),
            }
        } else {
            Self {
                glob: format!("*{lower}*").chars().collect(),
                name_only: false,
            }
        }
    }

    /// `path` is the key without the searched prefix.
    fn matches(&self, path: &str) -> bool {
        let subject = match self.name_only {
            true => path.rsplit('/').next().unwrap_or(path),
            false => path,
        };
        glob(&self.glob, &subject.to_lowercase())
    }
}

/// Glob match: `*` is any run of characters (also across `/`), `?` exactly one.
fn glob(pattern: &[char], text: &str) -> bool {
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    // Where to resume after a mismatch: the last `*` and the text position it was tried at.
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, t));
            p += 1;
        } else if let Some((star_p, star_t)) = star {
            // Let the `*` swallow one more character and try again.
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

/// Whether `pattern` finds the object at `path` (its key below the searched folder).
pub fn pattern_matches(pattern: &str, path: &str) -> bool {
    Pattern::new(pattern).matches(path)
}

impl S3 {
    /// Looks at every key under `prefix` (all levels) until it has `max_results` matches,
    /// `max_secs` have passed, or the keys run out. The time limit is checked between pages
    /// of 1000 keys.
    pub async fn search(
        &self,
        bucket: &str,
        prefix: &str,
        pattern: &str,
        max_results: usize,
        max_secs: u64,
    ) -> Result<SearchResult, String> {
        if pattern.trim().is_empty() {
            return Err("a search pattern is required".into());
        }
        let pattern = Pattern::new(pattern.trim());
        let max_results = max_results.clamp(1, MAX_RESULTS);
        let deadline = Instant::now() + Duration::from_secs(max_secs.min(MAX_SECONDS));
        let mut found = SearchResult {
            matches: Vec::new(),
            scanned: 0,
            stopped: "done",
        };
        let mut token = None;
        loop {
            let page = self.client.list_objects_v2().bucket(bucket).prefix(prefix);
            let page = page.max_keys(LIST_PAGE).fetch_owner(true);
            let out = page.set_continuation_token(token).send().await;
            let out = out.map_err(s3_error)?;
            for object in out.contents() {
                found.scanned += 1;
                let key = object.key().unwrap_or_default();
                if pattern.matches(key.strip_prefix(prefix).unwrap_or(key)) {
                    found.matches.push(object_entry(object));
                    if found.matches.len() >= max_results {
                        found.stopped = "results";
                        return Ok(found);
                    }
                }
            }
            token = out
                .next_continuation_token()
                .filter(|_| out.is_truncated() == Some(true))
                .map(str::to_string);
            if token.is_none() {
                return Ok(found);
            }
            if Instant::now() >= deadline {
                found.stopped = "time";
                return Ok(found);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_words_match_anywhere_in_the_path() {
        assert!(pattern_matches("report", "docs/2026/Annual-REPORT.pdf"));
        assert!(
            pattern_matches("2026", "docs/2026/summary.pdf"),
            "folder names count"
        );
        assert!(!pattern_matches("report", "docs/2026/summary.pdf"));
        assert!(pattern_matches("báo", "Báo cáo quý 4.docx"));
    }

    #[test]
    fn wildcards_without_a_slash_match_the_file_name() {
        assert!(pattern_matches(
            "*.parquet",
            "data/year=2026/part-0001.parquet"
        ));
        assert!(!pattern_matches("*.parquet", "data/part-0001.parquet.crc"));
        assert!(pattern_matches(
            "part-01*",
            "data/year=2026/part-010.parquet"
        ));
        assert!(
            !pattern_matches("part-01*", "part-01-folder/other.txt"),
            "the folder is not the file name"
        );
        assert!(pattern_matches("part-000?.csv", "x/part-0007.csv"));
        assert!(!pattern_matches("part-000?.csv", "x/part-00071.csv"));
        assert!(!pattern_matches("part-000?.csv", "x/part-000.csv"));
    }

    #[test]
    fn wildcards_with_a_slash_match_the_path() {
        assert!(pattern_matches(
            "logs/*/error*.log",
            "logs/2026/11/error-17.log"
        ));
        assert!(!pattern_matches(
            "logs/*/error*.log",
            "archive/logs/2026/error-17.log"
        ));
        assert!(pattern_matches(
            "*/logs/*",
            "archive/logs/2026/error-17.log"
        ));
    }

    #[test]
    fn glob_backtracking_and_edges() {
        let chars = |s: &str| s.chars().collect::<Vec<_>>();
        assert!(glob(&chars("*ab*abc"), "xxababxabc"));
        assert!(!glob(&chars("*ab*abc"), "xxababxab"));
        assert!(glob(&chars("a**"), "a"));
        assert!(glob(&chars("*"), ""));
        assert!(!glob(&chars("?"), ""));
        assert!(!glob(&chars("abc"), "abcd"));
    }
}
