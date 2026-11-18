//! AWS Signature V4, S3 flavour: the payload hash is always sent as
//! `x-amz-content-sha256` and signed. RGW Admin Ops rejects requests without
//! that header (403 SignatureDoesNotMatch).

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub const REGION: &str = "us-east-1";
pub const SERVICE: &str = "s3";
const SIGNED_HEADERS: &str = "host;x-amz-content-sha256;x-amz-date";

/// Admin credentials. Deliberately not `Debug` so the secret cannot be logged.
#[derive(Clone)]
pub struct Credentials {
    pub access_key: String,
    pub secret_key: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// RFC 3986 percent-encoding: everything except unreserved characters.
pub fn uri_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Encoded, sorted `k=v&k=v` string. Used both for signing and as the URL
/// query, so what is signed is byte-for-byte what is sent.
pub fn canonical_query(params: &[(&str, &str)]) -> String {
    let mut pairs: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (uri_encode(k), uri_encode(v)))
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// `YYYYMMDDTHHMMSSZ` for a unix timestamp (civil-from-days, proleptic Gregorian).
pub fn amz_date(unix_secs: u64) -> String {
    let (days, rem) = ((unix_secs / 86400) as i64, unix_secs % 86400);
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Returns the headers to add to the request: `x-amz-date`,
/// `x-amz-content-sha256` and `authorization`. `query` must already be
/// canonical (see [`canonical_query`]); `amz_date` comes from [`amz_date`].
pub fn sign(
    method: &str,
    host: &str,
    path: &str,
    query: &str,
    body: &[u8],
    creds: &Credentials,
    amz_date: &str,
) -> Vec<(String, String)> {
    let payload_hash = sha256_hex(body);
    let day = &amz_date[..8];
    let scope = format!("{day}/{REGION}/{SERVICE}/aws4_request");
    let canonical_request = format!(
        "{method}\n{path}\n{query}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n\n{SIGNED_HEADERS}\n{payload_hash}"
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let mut key = hmac(format!("AWS4{}", creds.secret_key).as_bytes(), day);
    for part in [REGION, SERVICE, "aws4_request"] {
        key = hmac(&key, part);
    }
    let signature = hex(&hmac(&key, &string_to_sign));
    vec![
        ("x-amz-date".into(), amz_date.into()),
        ("x-amz-content-sha256".into(), payload_hash),
        (
            "authorization".into(),
            format!(
                "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={SIGNED_HEADERS}, Signature={signature}",
                creds.access_key
            ),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    // Published examples from the AWS S3 docs ("Signature Calculations for the
    // Authorization Header: Transferring Payload in a Single Chunk").
    fn aws_example(query: &str) -> String {
        let creds = Credentials {
            access_key: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
        };
        let headers = sign(
            "GET",
            "examplebucket.s3.amazonaws.com",
            "/",
            query,
            b"",
            &creds,
            "20130524T000000Z",
        );
        headers
            .into_iter()
            .find(|(k, _)| k == "authorization")
            .unwrap()
            .1
    }

    #[test]
    fn matches_aws_vector_valueless_param() {
        // Same shape as RGW's `?caps` / `?quota` sub-resources.
        let auth = aws_example(&canonical_query(&[("lifecycle", "")]));
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
        );
    }

    #[test]
    fn matches_aws_vector_sorted_params() {
        let auth = aws_example(&canonical_query(&[("prefix", "J"), ("max-keys", "2")]));
        assert!(
            auth.ends_with(
                "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
            ),
            "{auth}"
        );
    }

    #[test]
    fn payload_hash_header_is_sha256_of_body() {
        let creds = Credentials {
            access_key: "a".into(),
            secret_key: "s".into(),
        };
        let headers = sign("PUT", "h", "/", "", b"hello", &creds, "20130524T000000Z");
        assert!(headers.contains(&(
            "x-amz-content-sha256".to_string(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".to_string()
        )));
    }

    #[test]
    fn query_is_encoded_and_sorted() {
        assert_eq!(
            canonical_query(&[("user-caps", "users=*;usage=read, write"), ("caps", "")]),
            "caps=&user-caps=users%3D%2A%3Busage%3Dread%2C%20write"
        );
    }

    #[test]
    fn amz_date_formats_utc() {
        assert_eq!(amz_date(0), "19700101T000000Z");
        assert_eq!(amz_date(1_369_353_600), "20130524T000000Z");
        assert_eq!(amz_date(1_709_251_199), "20240229T235959Z"); // leap day
        assert_eq!(amz_date(1_794_980_751), "20261118T054551Z");
    }
}
