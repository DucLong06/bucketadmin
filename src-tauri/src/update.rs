//! The daily look for a newer release on GitHub. Trouble on the way (no network, a proxy
//! that refuses, an answer that is not a release) is silent: the check never shows an error
//! and never holds the app up.

use crate::settings::{Proxy, SettingsStore, UpdateSeen};
use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LATEST: &str = "https://api.github.com/repos/DucLong06/bucketadmin/releases/latest";
/// Every release page starts with this; nothing else is ever opened in the browser.
pub const RELEASES: &str = "https://github.com/DucLong06/bucketadmin/releases/";
const DAY_SECS: u64 = 86_400;
/// The version this binary was packaged as (scripts/build-deb.sh passes it in); the crate
/// version in a plain build.
pub const CURRENT: &str = match option_env!("BUCKETADMIN_VERSION") {
    Some(packaged) => packaged,
    None => env!("CARGO_PKG_VERSION"),
};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Update {
    /// Tag of the latest release, e.g. `v0.2.0`.
    pub tag: String,
    pub url: String,
    /// The version that is running.
    pub current: &'static str,
}

/// `v0.2.0-preview1` (the git tag) and `0.2.0~preview1` (the deb version made from it) name
/// the same release.
pub fn same_version(tag: &str, current: &str) -> bool {
    let plain = |v: &str| v.trim().trim_start_matches('v').replace('~', "-");
    plain(tag) == plain(current)
}

/// `v0.2.0-preview1` or `0.2.0~preview1` as numbers plus the pre-release part ("" for a
/// release); `None` for text that is no version.
fn version(text: &str) -> Option<([u64; 3], String)> {
    let plain = text.trim().trim_start_matches('v').replace('~', "-");
    let plain = plain.split('+').next().unwrap_or_default();
    let (numbers, pre) = plain.split_once('-').unwrap_or((plain, ""));
    let mut parts = numbers.split('.').map(|n| n.parse::<u64>().ok());
    let triple = [
        parts.next()??,
        parts.next().unwrap_or(Some(0))?,
        parts.next().unwrap_or(Some(0))?,
    ];
    match parts.next() {
        None => Some((triple, pre.to_string())),
        Some(_) => None,
    }
}

/// `preview2` sorts as ("preview", 2), so `preview10` comes after `preview9`.
fn pre_release(pre: &str) -> (&str, u64) {
    let name = pre.trim_end_matches(|c: char| c.is_ascii_digit());
    (name, pre[name.len()..].parse().unwrap_or(0))
}

/// Whether the release tagged `tag` is newer than the build `current` (semver order: a
/// pre-release comes before its release). Text that is no version is never "newer".
pub fn is_newer(tag: &str, current: &str) -> bool {
    use std::cmp::Ordering;
    let (Some((theirs, their_pre)), Some((mine, my_pre))) = (version(tag), version(current)) else {
        return false;
    };
    match theirs.cmp(&mine) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => match (their_pre.is_empty(), my_pre.is_empty()) {
            (true, false) => true,
            (false, false) => pre_release(&their_pre) > pre_release(&my_pre),
            _ => false,
        },
    }
}

/// Tag and page of the latest release in GitHub's answer; `None` when it names none.
pub fn parse_latest(body: &str) -> Option<(String, String)> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let tag = json.get("tag_name")?.as_str()?.trim();
    // The tag is shown in the UI and put into a URL: version characters only.
    let version_like = |c: char| c.is_ascii_alphanumeric() || ".-_+".contains(c);
    if tag.is_empty() || tag.len() > 64 || !tag.chars().all(version_like) {
        return None;
    }
    let page = json.get("html_url").and_then(|url| url.as_str());
    let url = match page.filter(|url| url.starts_with(RELEASES)) {
        Some(url) => url.to_string(),
        None => format!("{RELEASES}tag/{tag}"),
    };
    Some((tag.to_string(), url))
}

/// Whether GitHub should be asked again: never asked, or the last answer is a day old.
pub fn is_due(seen: Option<&UpdateSeen>, now: u64) -> bool {
    seen.is_none_or(|seen| now.saturating_sub(seen.checked_at) >= DAY_SECS)
}

/// What to tell the user after an answer: a release newer than this build. A build ahead of
/// the latest release (a preview, a local build) is not told to go back.
pub fn pending(seen: &UpdateSeen, current: &'static str) -> Option<Update> {
    is_newer(&seen.tag, current).then(|| Update {
        tag: seen.tag.clone(),
        url: seen.url.clone(),
        current,
    })
}

/// GitHub's answer. `None`: it could not be asked (try again at the next start). An answer
/// that is not a success comes back empty: that is an answer, and it holds for the day.
async fn fetch(proxy: &Proxy) -> Option<String> {
    let client = proxy.reqwest().ok()?;
    let client = client.timeout(Duration::from_secs(10));
    // GitHub refuses requests without a User-Agent.
    let client = client.user_agent("bucketadmin-update-check").build().ok()?;
    let request = client
        .get(LATEST)
        .header("accept", "application/vnd.github+json");
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return Some(String::new());
    }
    response.text().await.ok()
}

/// The release to tell the user about, if any. Asks GitHub at most once a day, through the
/// app-wide proxy setting; in between, the saved answer is used.
pub async fn check(settings: &SettingsStore) -> Option<Update> {
    let saved = settings.get().ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    if !is_due(saved.update.as_ref(), now) {
        return pending(&saved.update?, CURRENT);
    }
    // Debug builds only: the UI smoke test supplies GitHub's answer and needs no network.
    let canned = cfg!(debug_assertions)
        .then(|| std::env::var("BUCKETADMIN_DEV_UPDATE").ok())
        .flatten();
    let body = match canned {
        Some(body) => body,
        None => fetch(&saved.proxy).await?,
    };
    let (tag, url) = parse_latest(&body).unwrap_or_default();
    let seen = UpdateSeen {
        checked_at: now,
        tag,
        url,
    };
    // Not saved (read-only disk?) only means GitHub is asked again at the next start.
    let _ = settings.change(|s| s.update = Some(seen.clone()));
    pending(&seen, CURRENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clusters::tests::temp_dir;

    fn seen(checked_at: u64, tag: &str) -> UpdateSeen {
        UpdateSeen {
            checked_at,
            tag: tag.into(),
            url: format!("{RELEASES}tag/{tag}"),
        }
    }

    #[test]
    fn tag_and_package_version_of_one_release_are_the_same() {
        assert!(same_version("v0.1.0", "0.1.0"));
        assert!(same_version("v0.1.0-preview2", "0.1.0~preview2"));
        assert!(same_version(" v0.2.0\n", "0.2.0"));
        assert!(!same_version("v0.2.0", "0.1.0"));
        assert!(!same_version("v0.1.0", "0.1.0~preview2"));
        assert!(!same_version("v0.1.0-preview3", "0.1.0~preview2"));
    }

    #[test]
    fn only_a_newer_release_is_reported_never_an_older_one() {
        // The case from the field: this build is ahead of the latest tag.
        assert_eq!(pending(&seen(1, "v0.1.1"), "0.1.2"), None);
        let told = pending(&seen(1, "v0.1.2"), "0.1.1").expect("a newer release");
        assert_eq!((told.tag.as_str(), told.current), ("v0.1.2", "0.1.1"));
        assert_eq!(pending(&seen(1, "v0.1.2"), "0.1.2"), None);

        for (tag, current) in [
            ("v0.1.2", "0.1.1"),
            ("v0.2.0", "0.1.9"),
            ("v1.0.0", "0.9.9"),
            ("v0.1.10", "0.1.9"), // numbers, not text
            ("v0.2", "0.1.5"),
            ("v0.1.2", "0.1.2~preview1"), // the release of my preview
            ("v0.1.2-preview2", "0.1.2~preview1"),
            ("v0.1.2-preview10", "0.1.2~preview9"),
            ("v0.1.3-preview1", "0.1.2"),
        ] {
            assert!(is_newer(tag, current), "{tag} is newer than {current}");
            assert!(!is_newer(current, tag), "{current} is not newer than {tag}");
        }
        for (tag, current) in [
            ("v0.1.2", "0.1.2"),
            ("v0.1.2+build7", "0.1.2"),
            ("v0.1.2-preview1", "0.1.2~preview1"),
            ("v0.1.2-preview1", "0.1.2"), // a preview of what I already run
            ("", "0.1.2"),
            ("nightly", "0.1.2"),
            ("v1.2.3.4", "0.1.2"),
        ] {
            assert!(!is_newer(tag, current), "{tag} vs {current}");
        }
        // A package version of an old milestone build still compares.
        assert!(is_newer("v0.1.2", "0.0.0~m7afinal"));
    }

    #[test]
    fn only_a_plain_tag_and_a_release_page_of_this_repo_are_taken_from_the_answer() {
        let page = format!("{RELEASES}tag/v0.2.0");
        let body = format!(r#"{{"tag_name":"v0.2.0","html_url":"{page}","draft":false}}"#);
        assert_eq!(parse_latest(&body), Some(("v0.2.0".into(), page.clone())));
        // A page somewhere else is replaced by the page the tag has in this repo.
        let elsewhere = r#"{"tag_name":"v0.2.0","html_url":"https://example.com/get-it"}"#;
        assert_eq!(
            parse_latest(elsewhere),
            Some(("v0.2.0".into(), page.clone()))
        );
        assert_eq!(parse_latest(r#"{"tag_name":"v0.2.0"}"#).unwrap().1, page);
        for none in [
            "",
            "not json",
            "{}",
            r#"{"message":"Not Found"}"#,
            r#"{"tag_name":""}"#,
            r#"{"tag_name":"v1 <b>now</b>"}"#,
            r#"{"tag_name":"../../x"}"#,
            r#"{"tag_name":7}"#,
        ] {
            assert_eq!(parse_latest(none), None, "{none:?}");
        }
    }

    #[test]
    fn github_is_asked_once_a_day_and_a_different_tag_is_reported() {
        assert!(is_due(None, 1_000_000));
        let last = seen(1_000_000, "v0.2.0");
        assert!(!is_due(Some(&last), 1_000_000 + DAY_SECS - 1));
        assert!(is_due(Some(&last), 1_000_000 + DAY_SECS));
        assert!(
            !is_due(Some(&last), 999_000),
            "a clock set back does not ask early"
        );

        let told = pending(&last, "0.1.0").expect("a newer tag");
        assert_eq!((told.tag.as_str(), told.current), ("v0.2.0", "0.1.0"));
        assert!(told.url.starts_with(RELEASES));
        assert_eq!(pending(&last, "0.2.0"), None, "this build is that release");
        assert_eq!(pending(&seen(1, ""), "0.1.0"), None, "no release was read");
    }

    #[tokio::test]
    async fn a_fresh_saved_answer_is_used_without_asking_again() {
        let dir = temp_dir("update");
        let store = SettingsStore::new(&dir);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        // Asked a minute ago: `check` must answer from the file. If it went to the network
        // instead, the tag below (which no release has) could not come back.
        let last = seen(now.as_secs() - 60, "v99.0.0-saved");
        store.change(|s| s.update = Some(last.clone())).unwrap();
        let told = check(&store).await.expect("the saved answer");
        assert_eq!(told.tag, "v99.0.0-saved");
        assert_eq!(told.current, CURRENT);
        assert_eq!(store.get().unwrap().update, Some(last), "nothing rewritten");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Asks the real GitHub API once, through the proxy variables of the environment.
    ///   cargo test --lib update::tests::real_github -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "needs the network: asks api.github.com for the latest release"]
    async fn real_github_answer() {
        let body = fetch(&Proxy::Auto).await;
        println!(
            "GitHub answered: {}",
            match &body {
                None => "nothing (could not be reached)".to_string(),
                Some(body) if body.is_empty() => "not a success (no release to read)".to_string(),
                Some(body) => format!("{} bytes", body.len()),
            }
        );
        let latest = body.as_deref().and_then(parse_latest);
        println!("latest release -> {latest:?}; this build is {CURRENT}");
        if let Some((tag, url)) = latest {
            assert!(url.starts_with(RELEASES));
            println!(
                "same version as this build: {}",
                same_version(&tag, CURRENT)
            );
        }
    }
}
