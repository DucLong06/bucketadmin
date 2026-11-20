//! What a key can reach, asked without ever listing above what the user typed: a probe of one
//! typed path, and the prefixes a bucket policy grants the key (when the key may read the policy).

use super::{s3_error, S3};
use serde::Serialize;
use serde_json::Value;

/// Folders one probe suggests at most.
pub const PROBE_KEYS: i32 = 25;

/// Answer of a probe. `children`: names of the folders right below the typed prefix (for a
/// prefix that stops mid-name, the folders that continue it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Probe {
    Ok {
        bucket: String,
        prefix: String,
        children: Vec<String>,
    },
    /// S3 refused the listing. Not a dead end: a deeper folder may still be granted.
    Denied,
    Error {
        message: String,
    },
}

/// Bucket and prefix of a path as it is being typed (`bucket`, `bucket/pre`, `s3://bucket/a/`).
/// The prefix is kept exactly as typed: it is what gets listed.
pub fn split_typed(path: &str) -> Option<(&str, &str)> {
    let path = path.trim();
    let scheme = path.get(..5).filter(|s| s.eq_ignore_ascii_case("s3://"));
    let path = path[scheme.map_or(0, str::len)..].trim_start_matches('/');
    let (bucket, prefix) = path.split_once('/').unwrap_or((path, ""));
    (!bucket.is_empty() && !bucket.chars().any(char::is_whitespace)).then_some((bucket, prefix))
}

/// The prefixes an S3 bucket policy lets `uid` (or everyone) list: one per `s3:prefix` condition
/// value of an Allow statement that grants `s3:ListBucket`; a statement without a condition
/// yields "" (the whole bucket). Text that is no policy yields nothing.
pub fn policy_prefixes(policy: &str, uid: Option<&str>) -> Vec<String> {
    // A value that may be one item or a list of them.
    fn items(value: &Value) -> Vec<&Value> {
        match value {
            Value::Array(list) => list.iter().collect(),
            Value::Null => Vec::new(),
            one => vec![one],
        }
    }
    let strings = |value: &Value| -> Vec<String> {
        let texts = items(value).into_iter().filter_map(Value::as_str);
        texts.map(str::to_string).collect()
    };
    let is_me = |principal: &str| {
        // `arn:aws:iam::<tenant>:user/<uid>`; RGW names a tenanted user `tenant$uid`.
        let uid = uid.map(|u| u.rsplit('$').next().unwrap_or(u));
        principal == "*"
            || uid.is_some_and(|u| principal.rsplit_once(":user/").map(|p| p.1) == Some(u))
    };
    let Ok(doc) = serde_json::from_str::<Value>(policy) else {
        return Vec::new();
    };
    let mut found: Vec<String> = Vec::new();
    for statement in items(&doc["Statement"]) {
        let principal = &statement["Principal"];
        let who = match principal {
            Value::Object(by_kind) => by_kind.get("AWS").map(&strings).unwrap_or_default(),
            other => strings(other),
        };
        // shortcut: only `*`, `s3:*`, `s3:List*` and the action itself count as granting a
        // listing; other wildcard spellings are skipped. Upgrade to a glob match if one shows up.
        let lists = strings(&statement["Action"]).iter().any(|action| {
            matches!(
                action.to_ascii_lowercase().as_str(),
                "*" | "s3:*" | "s3:list*" | "s3:listbucket"
            )
        });
        if statement["Effect"] != "Allow" || !lists || !who.iter().any(|p| is_me(p)) {
            continue;
        }
        let mut granted = Vec::new();
        let mut other_condition = false;
        for (operator, keys) in statement["Condition"].as_object().into_iter().flatten() {
            let like = operator.eq_ignore_ascii_case("StringLike");
            let prefixes = keys.as_object().into_iter().flatten();
            let prefixes: Vec<&Value> = prefixes
                .filter(|(key, _)| key.eq_ignore_ascii_case("s3:prefix"))
                .map(|(_, value)| value)
                .collect();
            if !(like || operator.eq_ignore_ascii_case("StringEquals")) || prefixes.is_empty() {
                // A condition this code cannot judge: no claim is made for the statement.
                other_condition = true;
                continue;
            }
            for value in prefixes.into_iter().flat_map(&strings) {
                // `logs/*` grants what is under `logs/`.
                let cut = value.find(['*', '?']).filter(|_| like);
                granted.push(value[..cut.unwrap_or(value.len())].to_string());
            }
        }
        if statement.get("Condition").is_none() {
            granted.push(String::new());
        } else if other_condition {
            continue;
        }
        for prefix in granted {
            if !found.contains(&prefix) {
                found.push(prefix);
            }
        }
    }
    found
}

impl S3 {
    /// Lists at most [`PROBE_KEYS`] entries right at the typed prefix, never above it.
    pub async fn probe(&self, bucket: &str, prefix: &str) -> Probe {
        let request = self.client.list_objects_v2().bucket(bucket).prefix(prefix);
        let sent = request.delimiter("/").max_keys(PROBE_KEYS).send().await;
        match sent.map_err(s3_error) {
            Ok(out) => {
                // Names are shown without the part of the path that is typed already.
                let typed = prefix.rfind('/').map_or(0, |at| at + 1);
                let folders = out.common_prefixes().iter().filter_map(|p| p.prefix());
                Probe::Ok {
                    bucket: bucket.to_string(),
                    prefix: prefix.to_string(),
                    children: folders
                        .map(|p| p[typed.min(p.len())..].trim_end_matches('/').to_string())
                        .filter(|name| !name.is_empty())
                        .collect(),
                }
            }
            Err(message) if message.starts_with("S3 AccessDenied") => Probe::Denied,
            Err(message) => Probe::Error { message },
        }
    }

    /// The prefixes the bucket's policy grants this key, read with the key itself: that only
    /// works when the policy lets the key read it. The caller treats an error as "nothing known".
    pub async fn accessible_prefixes(&self, bucket: &str) -> Result<Vec<String>, String> {
        let policy = self.client.get_bucket_policy().bucket(bucket).send().await;
        let policy = policy.map_err(s3_error)?;
        // Statements naming this user need its uid; without it only the ones for everyone count.
        let uid = self.whoami().await.ok();
        Ok(policy_prefixes(
            policy.policy().unwrap_or_default(),
            uid.as_deref(),
        ))
    }
}

/// Probes a path as typed in the path picker.
pub async fn probe_path(s3: &S3, path: &str) -> Probe {
    match split_typed(path) {
        Some((bucket, prefix)) => s3.probe(bucket, prefix).await,
        None => Probe::Error {
            message: "a path starts with a bucket name".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typed_path_splits_into_bucket_and_the_prefix_as_typed() {
        assert_eq!(split_typed("logs"), Some(("logs", "")));
        assert_eq!(split_typed(" s3://logs/2026/1"), Some(("logs", "2026/1")));
        assert_eq!(split_typed("S3://logs/a/"), Some(("logs", "a/")));
        assert_eq!(split_typed("/logs/"), Some(("logs", "")));
        assert_eq!(split_typed(""), None);
        assert_eq!(split_typed("s3://"), None);
        assert_eq!(split_typed("my bucket/a"), None);
    }

    fn statement(principal: &str, action: &str, condition: &str) -> String {
        let condition = match condition {
            "" => String::new(),
            c => format!(r#","Condition":{c}"#),
        };
        format!(
            r#"{{"Effect":"Allow","Principal":{principal},"Action":{action},"Resource":["arn:aws:s3:::b"]{condition}}}"#
        )
    }

    fn policy(statements: &[String]) -> String {
        format!(
            r#"{{"Version":"2012-10-17","Statement":[{}]}}"#,
            statements.join(",")
        )
    }

    const ALICE: &str = r#"{"AWS":["arn:aws:iam:::user/alice"]}"#;

    #[test]
    fn prefixes_come_from_allow_statements_that_grant_listing_to_this_user() {
        let like = r#"{"StringLike":{"s3:prefix":["scoped/*","logs/2026/*"]}}"#;
        let doc = policy(&[
            statement(ALICE, r#"["s3:ListBucket"]"#, like),
            // Not a listing, another user, and a Deny: none of them adds anything.
            statement(ALICE, r#"["s3:GetObject"]"#, ""),
            statement(r#"{"AWS":"arn:aws:iam:::user/bob"}"#, r#""s3:*""#, ""),
            statement(ALICE, r#""s3:ListBucket""#, "").replace("Allow", "Deny"),
        ]);
        assert_eq!(
            policy_prefixes(&doc, Some("alice")),
            ["scoped/", "logs/2026/"]
        );
        assert!(policy_prefixes(&doc, Some("carol")).is_empty());
        assert!(policy_prefixes(&doc, None).is_empty());
        // A tenanted uid as RGW names it, against a tenanted ARN.
        let tenanted = doc.replace("arn:aws:iam:::user/alice", "arn:aws:iam::acme:user/alice");
        assert_eq!(policy_prefixes(&tenanted, Some("acme$alice")).len(), 2);
    }

    #[test]
    fn no_condition_is_the_whole_bucket_and_everyone_includes_this_user() {
        let whole = policy(&[statement(r#""*""#, r#""s3:*""#, "")]);
        assert_eq!(policy_prefixes(&whole, None), [""]);
        let star = policy(&[statement(r#"{"AWS":"*"}"#, r#"["s3:List*"]"#, "")]);
        assert_eq!(policy_prefixes(&star, Some("alice")), [""]);
        // StringEquals names the prefix itself; a single string is as good as a list.
        let equals = r#"{"StringEquals":{"s3:prefix":"team/"}}"#;
        let one = policy(&[statement(ALICE, r#""s3:ListBucket""#, equals)]);
        assert_eq!(policy_prefixes(&one, Some("alice")), ["team/"]);
        // A single statement that is not in a list.
        let bare = format!(
            r#"{{"Statement":{}}}"#,
            statement(ALICE, r#""s3:ListBucket""#, equals)
        );
        assert_eq!(policy_prefixes(&bare, Some("alice")), ["team/"]);
    }

    #[test]
    fn what_cannot_be_judged_yields_nothing() {
        let by_address = r#"{"IpAddress":{"aws:SourceIp":"10.0.0.0/8"}}"#;
        let doc = policy(&[statement(ALICE, r#""s3:ListBucket""#, by_address)]);
        assert!(policy_prefixes(&doc, Some("alice")).is_empty());
        for junk in ["", "not json", "{}", r#"{"Statement":"x"}"#, "[1,2]"] {
            assert!(policy_prefixes(junk, Some("alice")).is_empty(), "{junk}");
        }
    }
}
