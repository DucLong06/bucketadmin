//! Browse-side integration tests against the lab RGW (127.0.0.1:7480), run when
//! RGW_ACCESS_KEY / RGW_SECRET_KEY are set (otherwise each test prints SKIPPED and passes).
//! The admin key is only used to create the test users; every S3 call is made with a
//! normal user's own key, which is the point of these tests.
//!
//!   RGW_ACCESS_KEY=... RGW_SECRET_KEY=... cargo test --test s3_lab -- --nocapture

use bucketadmin_lib::rgw_admin::{Credentials, KeyPair, ReqwestClient, RgwAdmin, UserModify};
use bucketadmin_lib::s3::S3;

fn endpoint() -> String {
    std::env::var("RGW_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:7480".into())
}

fn lab() -> Option<RgwAdmin> {
    let (Ok(access_key), Ok(secret_key)) = (
        std::env::var("RGW_ACCESS_KEY"),
        std::env::var("RGW_SECRET_KEY"),
    ) else {
        eprintln!("SKIPPED: RGW_ACCESS_KEY / RGW_SECRET_KEY not set");
        return None;
    };
    let creds = Credentials {
        access_key,
        secret_key,
    };
    Some(RgwAdmin::new(&endpoint(), creds, ReqwestClient::new().unwrap()).unwrap())
}

/// Deletes a user with its data. The buckets are emptied first, many deletes at a time: one
/// delete takes about a second on the lab, so RGW's own purge (one object after another)
/// would outlast any HTTP timeout for a bucket of a thousand keys.
async fn remove_user(admin: &RgwAdmin, uid: &str) {
    use futures_util::StreamExt;
    let found = admin.get_user(uid).await.ok();
    if let Some(key) = found.and_then(|u| u.keys.into_iter().next()) {
        let s3 = S3::new(&endpoint(), &key.access_key, &key.secret_key);
        for bucket in s3.list_buckets().await.unwrap_or_default() {
            while let Ok(page) = s3.search(&bucket.name, "", "*", 1000, 60).await {
                if page.matches.is_empty() {
                    break;
                }
                let deletes = page
                    .matches
                    .iter()
                    .map(|o| s3.delete(&bucket.name, &o.key, None));
                let done: Vec<_> = futures_util::stream::iter(deletes)
                    .buffer_unordered(48)
                    .collect()
                    .await;
                if done.iter().any(Result::is_err) {
                    break; // e.g. the user was made read-only: leave the rest to the purge below
                }
            }
        }
    }
    for _ in 0..30 {
        let _ = admin.delete_user(uid, true).await;
        if admin.get_user(uid).await.is_err() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    panic!("user {uid} could not be removed");
}

/// A fresh normal user (no admin caps) and an S3 session signed with that user's key.
async fn user(admin: &RgwAdmin, uid: &str) -> (KeyPair, S3) {
    remove_user(admin, uid).await; // leftover from an aborted run
    let created = admin
        .create_user(uid, "M4 browse test", None, None, None)
        .await
        .expect("create test user");
    assert!(created.caps.is_empty(), "the test user has no admin caps");
    let key = created.keys[0].clone();
    let s3 = S3::new(&endpoint(), &key.access_key, &key.secret_key);
    (key, s3)
}

async fn put(s3: &S3, bucket: &str, key: &str, body: &[u8]) -> Result<(), String> {
    let sent = s3
        .client()
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(body.to_vec().into())
        .send()
        .await;
    sent.map(|_| ()).map_err(|e| {
        use aws_sdk_s3::error::ProvideErrorMetadata;
        e.code().unwrap_or("?").to_string()
    })
}

/// A bucket policy letting `uid` do `actions` on `bucket` and everything in it.
fn policy(bucket: &str, uid: &str, actions: &str) -> String {
    format!(
        r#"{{"Version":"2012-10-17","Statement":[{{"Effect":"Allow","Principal":{{"AWS":["arn:aws:iam:::user/{uid}"]}},"Action":[{actions}],"Resource":["arn:aws:s3:::{bucket}","arn:aws:s3:::{bucket}/*"]}}]}}"#
    )
}

/// M4.1: buckets and folder-style listing with a normal user's key, and what a restricted
/// user really can and cannot do.
#[tokio::test]
async fn m4_browse_with_user_credentials() {
    let Some(admin) = lab() else { return };
    let bucket = "ba-m4-browse";
    let (owner_key, owner) = user(&admin, "ba-m4-owner").await;
    let (_, reader) = user(&admin, "ba-m4-reader").await;
    assert_eq!(owner.access_key(), owner_key.access_key);
    assert_ne!(
        owner.access_key(),
        std::env::var("RGW_ACCESS_KEY").unwrap(),
        "browsing never signs with the admin key"
    );

    owner
        .client()
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .expect("create bucket");
    for key in [
        "top.txt",
        "docs/a.txt",
        "docs/b/c.txt",
        "docs/b/d.txt",
        "logs/2026/x.log",
    ] {
        put(&owner, bucket, key, key.as_bytes())
            .await
            .expect("owner can upload");
    }

    // ---- the owner sees its bucket as folders
    let buckets = owner.list_buckets().await.expect("list_buckets");
    println!(
        "owner list_buckets -> {:?}",
        buckets.iter().map(|b| &b.name).collect::<Vec<_>>()
    );
    assert!(buckets
        .iter()
        .any(|b| b.name == bucket && !b.created.is_empty()));
    let root = owner.list(bucket, "", None, 1000).await.expect("list root");
    println!(
        "list '' -> prefixes {:?}, objects {:?}",
        root.prefixes,
        root.objects.iter().map(|o| &o.key).collect::<Vec<_>>()
    );
    assert_eq!(root.prefixes, ["docs/", "logs/"]);
    assert_eq!(root.objects.len(), 1);
    let top = &root.objects[0];
    assert_eq!((top.key.as_str(), top.size), ("top.txt", 7));
    assert!(!top.last_modified.is_empty() && !top.etag.is_empty());
    println!("object fields -> {top:?}");
    let docs = owner
        .list(bucket, "docs/", None, 1000)
        .await
        .expect("list docs/");
    assert_eq!(docs.prefixes, ["docs/b/"]);
    assert_eq!(
        docs.objects
            .iter()
            .map(|o| o.key.as_str())
            .collect::<Vec<_>>(),
        ["docs/a.txt"]
    );
    assert_eq!(root.next_token, None);

    // ---- paging by continuation token
    let first = owner.list(bucket, "docs/b/", None, 1).await.unwrap();
    assert_eq!(first.objects.len(), 1);
    let token = first.next_token.expect("a second page exists");
    let second = owner
        .list(bucket, "docs/b/", Some(&token), 1)
        .await
        .unwrap();
    assert_eq!(second.objects[0].key, "docs/b/d.txt");
    assert_eq!(second.next_token, None);

    // ---- head and ranged read
    let head = owner.head(bucket, "docs/a.txt", None).await.expect("head");
    assert_eq!(head.size, 10);
    assert_eq!(
        owner
            .read_range(bucket, "docs/a.txt", None, 5, 3)
            .await
            .unwrap(),
        b"a.t"
    );
    assert_eq!(
        owner
            .read_range(bucket, "docs/a.txt", None, 5, 4096)
            .await
            .unwrap(),
        b"a.txt"
    );
    let missing = owner.head(bucket, "nope.txt", None).await.unwrap_err();
    println!("head missing -> {missing}");
    assert!(
        missing.starts_with("S3 ") && missing.contains("(404)"),
        "{missing}"
    );

    // ---- another user: nothing is shared yet
    assert!(
        reader.list_buckets().await.unwrap().is_empty(),
        "the reader owns no bucket"
    );
    let denied = reader.list(bucket, "", None, 1000).await.unwrap_err();
    println!("reader list before any grant -> {denied}");
    assert!(denied.starts_with("S3 AccessDenied (403)"), "{denied}");

    // ---- read-only grant by bucket policy: can list and read, cannot write or delete
    let read_only = policy(bucket, "ba-m4-reader", r#""s3:ListBucket","s3:GetObject""#);
    owner
        .client()
        .put_bucket_policy()
        .bucket(bucket)
        .policy(read_only)
        .send()
        .await
        .expect("put policy");
    let seen = reader
        .list(bucket, "docs/", None, 1000)
        .await
        .expect("reader can list after the grant");
    assert_eq!(seen.objects[0].key, "docs/a.txt");
    assert_eq!(
        reader
            .read_range(bucket, "top.txt", None, 0, 100)
            .await
            .unwrap(),
        b"top.txt"
    );
    let upload = put(&reader, bucket, "by-reader.txt", b"x")
        .await
        .unwrap_err();
    println!("reader upload with a read-only grant -> {upload}");
    assert_eq!(upload, "AccessDenied");
    let delete = reader
        .client()
        .delete_object()
        .bucket(bucket)
        .key("top.txt")
        .send()
        .await;
    assert!(
        delete.is_err(),
        "reader cannot delete with a read-only grant"
    );

    // ---- op-mask=read on the user: even a full grant does not let this user write
    let full = policy(bucket, "ba-m4-reader", r#""s3:*""#);
    owner
        .client()
        .put_bucket_policy()
        .bucket(bucket)
        .policy(full)
        .send()
        .await
        .expect("put policy");
    put(&reader, bucket, "by-reader.txt", b"x")
        .await
        .expect("with a full grant the reader can upload");
    let read_only_user = UserModify {
        op_mask: Some("read".into()),
        ..Default::default()
    };
    admin
        .modify_user("ba-m4-reader", &read_only_user)
        .await
        .expect("set op-mask=read");
    let masked = put(&reader, bucket, "by-reader-2.txt", b"x")
        .await
        .unwrap_err();
    println!("reader upload with op-mask=read despite a full grant -> {masked}");
    assert_eq!(masked, "AccessDenied");
    assert_eq!(
        reader
            .read_range(bucket, "top.txt", None, 0, 3)
            .await
            .unwrap(),
        b"top",
        "reading still works"
    );
    assert!(owner
        .list(bucket, "", None, 1000)
        .await
        .unwrap()
        .objects
        .iter()
        .all(|o| o.key != "by-reader-2.txt"));

    remove_user(&admin, "ba-m4-reader").await;
    remove_user(&admin, "ba-m4-owner").await;
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("bucketadmin-m4-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Deterministic, non-repeating-looking bytes (so a misplaced range shows up in a compare).
fn pattern(len: usize) -> Vec<u8> {
    (0..len as u64)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect()
}

/// M4.2: single-request and multipart upload, ranged download with resume, presigned URL, delete.
#[tokio::test]
async fn m4_upload_download_presign() {
    use bucketadmin_lib::s3::transfer::PART_SIZE;
    use std::sync::Mutex;
    let Some(admin) = lab() else { return };
    let bucket = "ba-m4-transfer";
    let (_, owner) = user(&admin, "ba-m4-xfer").await;
    owner
        .client()
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .expect("create bucket");
    let dir = temp_dir("transfer");
    const MIB: u64 = 1024 * 1024;

    // ---- small file: one PutObject
    let small = dir.join("small.txt");
    std::fs::write(&small, b"hello browse").unwrap();
    let calls = Mutex::new(Vec::new());
    let size = owner
        .upload(bucket, "docs/small.txt", &small, |d, t| {
            calls.lock().unwrap().push((d, t))
        })
        .await
        .expect("upload small");
    assert_eq!(
        (size, calls.lock().unwrap().as_slice()),
        (12, &[(12, 12)][..])
    );
    let head = owner.head(bucket, "docs/small.txt", None).await.unwrap();
    assert_eq!((head.size, head.content_type.as_str()), (12, "text/plain"));

    // ---- 20 MiB file: multipart, 3 parts, progress after each
    let big = dir.join("big.bin");
    let data = pattern((20 * MIB) as usize);
    std::fs::write(&big, &data).unwrap();
    let calls = Mutex::new(Vec::new());
    owner
        .upload(bucket, "big.bin", &big, |d, t| {
            calls.lock().unwrap().push((d, t))
        })
        .await
        .expect("multipart upload");
    println!("multipart upload progress -> {:?}", calls.lock().unwrap());
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        [
            (8 * MIB, 20 * MIB),
            (16 * MIB, 20 * MIB),
            (20 * MIB, 20 * MIB)
        ]
    );
    let head = owner.head(bucket, "big.bin", None).await.unwrap();
    println!("multipart object -> size {} etag {}", head.size, head.etag);
    assert_eq!(head.size, 20 * MIB);
    assert!(
        head.etag.trim_matches('"').ends_with("-3"),
        "a multipart ETag ends in -<parts>: {}",
        head.etag
    );

    // ---- download in ranges
    let dest = dir.join("big.copy");
    let calls = Mutex::new(Vec::new());
    let got = owner
        .download(bucket, "big.bin", None, &dest, |d, t| {
            calls.lock().unwrap().push((d, t))
        })
        .await
        .expect("download");
    assert_eq!((got.size, got.resumed_from), (20 * MIB, 0));
    assert_eq!(
        calls.lock().unwrap().len(),
        4,
        "start + one call per 8 MiB range"
    );
    assert!(
        std::fs::read(&dest).unwrap() == data,
        "downloaded bytes equal the uploaded ones"
    );
    assert!(!dir.join("big.copy.part").exists() && !dir.join("big.copy.part.etag").exists());

    // ---- resume: 9 MiB of an interrupted attempt are on disk. They are zeros here on purpose:
    // if they survive in the result, they were kept rather than downloaded again.
    let dest = dir.join("big.resumed");
    std::fs::write(dir.join("big.resumed.part"), vec![0u8; (9 * MIB) as usize]).unwrap();
    std::fs::write(dir.join("big.resumed.part.etag"), &head.etag).unwrap();
    let got = owner
        .download(bucket, "big.bin", None, &dest, |_, _| {})
        .await
        .expect("resumed download");
    println!(
        "resumed download -> resumed_from {} of {}",
        got.resumed_from, got.size
    );
    assert_eq!(got.resumed_from, 9 * MIB);
    let resumed = std::fs::read(&dest).unwrap();
    assert_eq!(resumed.len() as u64, 20 * MIB);
    assert!(
        resumed[..(9 * MIB) as usize].iter().all(|b| *b == 0),
        "the bytes on disk were kept"
    );
    assert!(
        resumed[(9 * MIB) as usize..] == data[(9 * MIB) as usize..],
        "the rest was fetched from the right offset"
    );

    // ---- a partial file of a different object version (other ETag) is not trusted
    let dest = dir.join("big.stale");
    std::fs::write(dir.join("big.stale.part"), vec![0u8; MIB as usize]).unwrap();
    std::fs::write(dir.join("big.stale.part.etag"), "\"some-other-etag\"").unwrap();
    let got = owner
        .download(bucket, "big.bin", None, &dest, |_, _| {})
        .await
        .expect("download");
    assert_eq!(got.resumed_from, 0);
    assert!(std::fs::read(&dest).unwrap() == data);
    assert_eq!(PART_SIZE, 8 * MIB);

    // ---- a user who may only read cannot upload through the same code path
    let (_, reader) = user(&admin, "ba-m4-xfer-ro").await;
    let grant = policy(bucket, "ba-m4-xfer-ro", r#""s3:*""#);
    owner
        .client()
        .put_bucket_policy()
        .bucket(bucket)
        .policy(grant)
        .send()
        .await
        .expect("put policy");
    let read_only = UserModify {
        op_mask: Some("read".into()),
        ..Default::default()
    };
    admin
        .modify_user("ba-m4-xfer-ro", &read_only)
        .await
        .expect("op-mask=read");
    let denied = reader
        .upload(bucket, "by-reader.bin", &big, |_, _| {})
        .await
        .unwrap_err();
    println!("read-only user multipart upload -> {denied}");
    assert!(denied.starts_with("S3 AccessDenied (403)"), "{denied}");
    let copy = dir.join("reader.copy");
    reader
        .download(bucket, "docs/small.txt", None, &copy, |_, _| {})
        .await
        .expect("read-only user can download");
    assert_eq!(std::fs::read(&copy).unwrap(), b"hello browse");
    let denied = reader
        .delete(bucket, "docs/small.txt", None)
        .await
        .unwrap_err();
    assert!(denied.starts_with("S3 AccessDenied (403)"), "{denied}");

    // ---- presigned URL: works without credentials, then expires
    let http = reqwest::Client::new();
    let url = owner
        .presign_get(bucket, "docs/small.txt", None, 300, None)
        .await
        .expect("presign");
    println!("presigned url -> {}...", &url[..url.find('?').unwrap()]);
    let answer = http.get(&url).send().await.unwrap();
    assert_eq!(answer.status(), 200);
    assert_eq!(answer.text().await.unwrap(), "hello browse");
    let plain = format!("{}/{bucket}/docs/small.txt", endpoint());
    assert_eq!(
        http.get(&plain).send().await.unwrap().status(),
        403,
        "without the signature the object is private"
    );
    let typed = owner
        .presign_get(bucket, "docs/small.txt", None, 300, Some("application/pdf"))
        .await
        .unwrap();
    let answer = http.get(&typed).send().await.unwrap();
    assert_eq!(answer.headers()["content-type"], "application/pdf");
    let short = owner
        .presign_get(bucket, "docs/small.txt", None, 1, None)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let expired = http.get(&short).send().await.unwrap().status();
    println!("presigned url 3 s after a 1 s expiry -> {expired}");
    assert_eq!(expired, 403);
    assert!(owner
        .presign_get(bucket, "docs/small.txt", None, 0, None)
        .await
        .is_err());
    assert!(owner
        .presign_get(bucket, "docs/small.txt", None, 8 * 24 * 3600, None)
        .await
        .is_err());

    // ---- delete
    owner
        .delete(bucket, "docs/small.txt", None)
        .await
        .expect("delete");
    assert!(owner.head(bucket, "docs/small.txt", None).await.is_err());
    assert!(owner
        .upload(bucket, "x", &dir.join("missing"), |_, _| {})
        .await
        .unwrap_err()
        .starts_with("cannot read"));

    std::fs::remove_dir_all(&dir).unwrap();
    remove_user(&admin, "ba-m4-xfer-ro").await;
    remove_user(&admin, "ba-m4-xfer").await;
}

/// Writes a Parquet file of about `megabytes` MB with flat, nullable and nested columns and a
/// 1 KiB incompressible payload per row. Returns the number of rows.
fn write_parquet(path: &std::path::Path, megabytes: u64) -> u64 {
    use arrow_array::builder::{ListBuilder, StringBuilder};
    use arrow_array::{
        ArrayRef, BinaryArray, Float64Array, Int32Array, Int64Array, RecordBatch, StringArray,
        StructArray,
    };
    use arrow_schema::{DataType, Field, Fields, Schema};
    use parquet::arrow::ArrowWriter;
    use parquet::basic::Compression;
    use parquet::file::properties::WriterProperties;
    use std::sync::Arc;

    let meta_fields = Fields::from(vec![
        Field::new("shard", DataType::Int32, false),
        Field::new("region", DataType::Utf8, false),
    ]);
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, false),
        Field::new("score", DataType::Float64, true),
        Field::new(
            "tags",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
            true,
        ),
        Field::new("meta", DataType::Struct(meta_fields.clone()), false),
        Field::new("payload", DataType::Binary, false),
    ]));
    let props = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_max_row_group_row_count(Some(20_000))
        // The payload is random: a dictionary would only be built to be thrown away.
        .set_column_dictionary_enabled("payload".into(), false)
        .build();
    let mut writer = ArrowWriter::try_new(
        std::fs::File::create(path).unwrap(),
        schema.clone(),
        Some(props),
    )
    .unwrap();

    // xorshift noise: incompressible, so the file really has the requested size on disk.
    let mut x = 0x9E37_79B9_7F4A_7C15u64;
    let block: Vec<u8> = (0..1024 * 1024 + 1024)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 32) as u8
        })
        .collect();
    let total = megabytes * 1000;
    const BATCH: u64 = 5000;
    let mut first = 0;
    while first < total {
        let ids: Vec<i64> = (first..(first + BATCH).min(total))
            .map(|i| i as i64)
            .collect();
        let mut tags = ListBuilder::new(StringBuilder::new());
        for id in &ids {
            if id % 7 == 0 {
                tags.append(false);
            } else {
                tags.values().append_value(format!("t{}", id % 3));
                tags.values().append_value("lab");
                tags.append(true);
            }
        }
        let meta = StructArray::new(
            meta_fields.clone(),
            vec![
                Arc::new(Int32Array::from_iter_values(
                    ids.iter().map(|i| (i % 16) as i32),
                )) as ArrayRef,
                Arc::new(StringArray::from_iter_values(ids.iter().map(|i| {
                    if i % 2 == 0 {
                        "hn"
                    } else {
                        "hcm"
                    }
                }))),
            ],
            None,
        );
        let columns: Vec<ArrayRef> = vec![
            Arc::new(Int64Array::from(ids.clone())),
            Arc::new(StringArray::from_iter_values(
                ids.iter().map(|i| format!("row-{i}")),
            )),
            Arc::new(Float64Array::from_iter(
                ids.iter().map(|i| (i % 5 != 0).then_some(*i as f64 / 2.0)),
            )),
            Arc::new(tags.finish()),
            Arc::new(meta),
            Arc::new(BinaryArray::from_iter_values(ids.iter().map(|i| {
                let at = (*i as usize * 7919) % (1024 * 1024);
                &block[at..at + 1024]
            }))),
        ];
        writer
            .write(&RecordBatch::try_new(schema.clone(), columns).unwrap())
            .unwrap();
        first += BATCH;
    }
    writer.close().unwrap();
    total
}

/// M4.3: Parquet preview by ranged reads. The file is generated here with arrow-rs; its size
/// comes from BA_PARQUET_MB (default 64 so the regular suite stays quick; the 500 MB run is
/// `BA_PARQUET_MB=500 cargo test --test s3_lab m4_parquet -- --nocapture`).
#[tokio::test]
async fn m4_parquet_ranged_preview() {
    let Some(admin) = lab() else { return };
    let megabytes: u64 = std::env::var("BA_PARQUET_MB")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(64);
    let bucket = "ba-m4-parquet";
    let (_, owner) = user(&admin, "ba-m4-pq").await;
    owner
        .client()
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .expect("create bucket");
    let dir = temp_dir("parquet");
    let file = dir.join("big.parquet");

    let started = std::time::Instant::now();
    let total = write_parquet(&file, megabytes);
    let size = std::fs::metadata(&file).unwrap().len();
    println!(
        "generated {total} rows, {size} bytes ({:.1} MiB) in {:.0?}",
        size as f64 / 1048576.0,
        started.elapsed()
    );
    assert!(
        size > megabytes * 1_000_000,
        "the file is at least the requested size"
    );
    let started = std::time::Instant::now();
    owner
        .upload(bucket, "data/big.parquet", &file, |_, _| {})
        .await
        .expect("upload");
    println!("uploaded in {:.0?}", started.elapsed());
    std::fs::remove_dir_all(&dir).unwrap();

    const MIB: u64 = 1024 * 1024;
    let cost = |label: &str, page: &bucketadmin_lib::s3::parquet::ParquetPage| {
        println!(
            "{label}: {} rows, fetched {} bytes ({:.2} MiB = {:.2}% of the file) in {} range requests",
            page.rows.len(),
            page.fetched_bytes,
            page.fetched_bytes as f64 / MIB as f64,
            page.fetched_bytes as f64 * 100.0 / size as f64,
            page.requests
        );
        // At most the 8 MiB footer request + the pages of one view; never anything near the whole file.
        assert!(
            page.fetched_bytes <= 16 * MIB,
            "{label} fetched {} bytes",
            page.fetched_bytes
        );
        assert!(
            page.fetched_bytes < size / 4,
            "{label} fetched a large share of the file"
        );
    };

    // ---- first page: schema, row count, values, nested cells as JSON
    let page = owner
        .parquet_page(bucket, "data/big.parquet", None, 0, 50)
        .await
        .expect("first page");
    cost("first page", &page);
    let columns: Vec<(&str, &str)> = page
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.data_type.as_str()))
        .collect();
    println!("columns -> {columns:?}");
    println!(
        "row groups -> {}, total rows -> {}",
        page.row_groups, page.total_rows
    );
    assert_eq!(
        columns.iter().map(|c| c.0).collect::<Vec<_>>(),
        ["id", "name", "score", "tags", "meta", "payload"]
    );
    assert_eq!(
        (columns[0].1, columns[1].1, columns[2].1),
        ("Int64", "Utf8", "Float64")
    );
    assert!(
        columns[3].1.starts_with("List") && columns[4].1.starts_with("Struct"),
        "{columns:?}"
    );
    assert_eq!(
        (page.total_rows, page.file_size, page.rows.len()),
        (total, size, 50)
    );
    assert_eq!(page.row_groups as u64, total.div_ceil(20_000));
    println!(
        "row 1 -> {}",
        serde_json::to_string(&page.rows[1])
            .unwrap()
            .chars()
            .take(150)
            .collect::<String>()
    );
    let row = &page.rows[1];
    assert_eq!(row["id"], 1);
    assert_eq!(row["name"], "row-1");
    assert_eq!(row["score"], 0.5);
    assert_eq!(row["tags"], serde_json::json!(["t1", "lab"]));
    assert_eq!(
        row["meta"],
        serde_json::json!({"shard": 1, "region": "hcm"})
    );
    let payload = row["payload"].as_str().unwrap();
    assert!(
        payload[..2000].bytes().all(|b| b.is_ascii_hexdigit()) && payload.ends_with("(+48 ký tự)"),
        "binary cells are shown as hex, cut for display: {}",
        &payload[1990..]
    );
    assert!(
        page.rows[0]["score"].is_null() && page.rows[0]["tags"].is_null(),
        "nulls stay nulls"
    );

    // ---- a page from the middle, crossing a row-group boundary
    let middle = (total / 2 / 20_000) * 20_000 - 30;
    let page = owner
        .parquet_page(bucket, "data/big.parquet", None, middle, 100)
        .await
        .expect("middle page");
    cost("middle page", &page);
    // The footer was fetched for the first page and is reused: this page cost only its data pages.
    assert!(
        page.fetched_bytes <= 4 * MIB,
        "middle page fetched {} bytes",
        page.fetched_bytes
    );
    let ids: Vec<u64> = page
        .rows
        .iter()
        .map(|r| r["id"].as_u64().unwrap())
        .collect();
    assert_eq!(
        ids,
        (middle..middle + 100).collect::<Vec<_>>(),
        "exactly the requested rows, in order"
    );

    // ---- the last, short page and a page past the end
    let page = owner
        .parquet_page(bucket, "data/big.parquet", None, total - 7, 50)
        .await
        .expect("last page");
    cost("last page", &page);
    assert_eq!(page.rows.len(), 7);
    assert_eq!(page.rows[6]["id"], total - 1);
    let past = owner
        .parquet_page(bucket, "data/big.parquet", None, total + 10, 50)
        .await
        .expect("past the end");
    assert!(past.rows.is_empty() && past.total_rows == total);

    // ---- not a Parquet file
    put(
        &owner,
        bucket,
        "notes.txt",
        b"just some text, long enough to not be a parquet footer",
    )
    .await
    .unwrap();
    let wrong = owner
        .parquet_page(bucket, "notes.txt", None, 0, 10)
        .await
        .unwrap_err();
    println!("non-parquet object -> {wrong}");
    assert!(
        wrong.starts_with("cannot read this file as Parquet"),
        "{wrong}"
    );

    remove_user(&admin, "ba-m4-pq").await;
}

/// M4.4: versions (list, read, restore, delete, delete markers) and the ACL editor's calls.
#[tokio::test]
async fn m4_versions_and_acl() {
    use aws_sdk_s3::types::{BucketVersioningStatus, VersioningConfiguration};
    use bucketadmin_lib::s3::acl::Grant;
    let Some(admin) = lab() else { return };
    let bucket = "ba-m4-versions";
    let (_, owner) = user(&admin, "ba-m4-ver").await;
    let (_, other) = user(&admin, "ba-m4-ver-other").await;
    owner
        .client()
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .expect("create bucket");

    // ---- before versioning is switched on
    let state = owner.versioning(bucket).await;
    println!("versioning (new bucket) -> {state:?}");
    assert!(state.supported && state.status.is_empty());
    put(&owner, bucket, "plain.txt", b"only").await.unwrap();
    let plain = owner
        .list_versions(bucket, "plain.txt")
        .await
        .expect("list_versions");
    assert_eq!(plain.len(), 1);
    assert_eq!(
        (plain[0].version_id.as_str(), plain[0].is_latest),
        ("null", true)
    );
    let denied = other.versioning(bucket).await;
    println!(
        "versioning asked by another user -> supported={} reason={:?}",
        denied.supported, denied.reason
    );
    assert!(
        !denied.supported,
        "a user who may not ask gets the feature hidden"
    );

    // ---- versioned key
    let on = VersioningConfiguration::builder()
        .status(BucketVersioningStatus::Enabled)
        .build();
    owner
        .client()
        .put_bucket_versioning()
        .bucket(bucket)
        .versioning_configuration(on)
        .send()
        .await
        .expect("enable versioning");
    assert_eq!(owner.versioning(bucket).await.status, "Enabled");
    for body in ["v1", "version two", "v3!"] {
        put(&owner, bucket, "doc.txt", body.as_bytes())
            .await
            .unwrap();
    }
    put(
        &owner,
        bucket,
        "doc.txt.bak",
        b"other key with the same prefix",
    )
    .await
    .unwrap();
    let versions = owner
        .list_versions(bucket, "doc.txt")
        .await
        .expect("list_versions");
    println!(
        "versions of doc.txt -> {:?}",
        versions
            .iter()
            .map(|v| (v.size, v.is_latest, v.delete_marker))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        versions.iter().map(|v| v.size).collect::<Vec<_>>(),
        [3, 11, 2],
        "newest first, only this key"
    );
    assert!(versions[0].is_latest && !versions[1].is_latest);
    let (v1, v2) = (
        versions[2].version_id.clone(),
        versions[1].version_id.clone(),
    );
    assert_eq!(
        owner
            .read_range(bucket, "doc.txt", Some(&v1), 0, 100)
            .await
            .unwrap(),
        b"v1"
    );

    // ---- download one version
    let dir = temp_dir("versions");
    let got = owner
        .download(bucket, "doc.txt", Some(&v2), &dir.join("v2.txt"), |_, _| {})
        .await
        .expect("download version");
    assert_eq!(
        (got.size, std::fs::read(dir.join("v2.txt")).unwrap()),
        (11, b"version two".to_vec())
    );
    std::fs::remove_dir_all(&dir).unwrap();

    // ---- restore: the old content becomes a new latest version, nothing is lost
    owner
        .restore_version(bucket, "doc.txt", &v1)
        .await
        .expect("restore_version");
    let after = owner.list_versions(bucket, "doc.txt").await.unwrap();
    assert_eq!(after.len(), 4);
    assert_eq!(
        owner
            .read_range(bucket, "doc.txt", None, 0, 100)
            .await
            .unwrap(),
        b"v1"
    );
    println!(
        "after restore -> {} versions, latest reads {:?}",
        after.len(),
        "v1"
    );

    // ---- delete without a version leaves a delete marker; removing the marker undeletes
    owner.delete(bucket, "doc.txt", None).await.expect("delete");
    assert!(
        owner.head(bucket, "doc.txt", None).await.is_err(),
        "the key looks deleted"
    );
    let marked = owner.list_versions(bucket, "doc.txt").await.unwrap();
    assert!(
        marked[0].delete_marker && marked[0].is_latest,
        "{:?}",
        marked[0]
    );
    assert_eq!(marked.len(), 5);
    owner
        .delete(bucket, "doc.txt", Some(&marked[0].version_id))
        .await
        .expect("delete the marker");
    assert_eq!(
        owner
            .read_range(bucket, "doc.txt", None, 0, 100)
            .await
            .unwrap(),
        b"v1",
        "the object is back"
    );

    // ---- delete one specific version
    owner
        .delete(bucket, "doc.txt", Some(&v2))
        .await
        .expect("delete version");
    let left = owner.list_versions(bucket, "doc.txt").await.unwrap();
    println!(
        "after deleting one version -> {:?}",
        left.iter().map(|v| v.size).collect::<Vec<_>>()
    );
    assert!(left.iter().all(|v| v.version_id != v2) && left.len() == 3);
    assert!(owner
        .read_range(bucket, "doc.txt", Some(&v2), 0, 10)
        .await
        .is_err());

    // ---- ACL: read, grant a user, verify by that user's own access, revoke
    let grant = |kind: &str, grantee: &str, permission: &str| Grant {
        kind: kind.into(),
        grantee: grantee.into(),
        display_name: String::new(),
        permission: permission.into(),
    };
    let acl = owner.get_acl(bucket, "plain.txt").await.expect("get_acl");
    println!(
        "object ACL -> owner {} grants {:?}",
        acl.owner_id,
        acl.grants
            .iter()
            .map(|g| (&g.grantee, &g.permission))
            .collect::<Vec<_>>()
    );
    assert_eq!(acl.owner_id, "ba-m4-ver");
    assert_eq!(acl.grants.len(), 1);
    assert_eq!(
        (
            acl.grants[0].kind.as_str(),
            acl.grants[0].grantee.as_str(),
            acl.grants[0].permission.as_str()
        ),
        ("user", "ba-m4-ver", "FULL_CONTROL")
    );
    assert!(
        other
            .read_range(bucket, "plain.txt", None, 0, 10)
            .await
            .is_err(),
        "no access before the grant"
    );

    let wanted = [
        grant("user", "ba-m4-ver", "FULL_CONTROL"),
        grant("user", "ba-m4-ver-other", "READ"),
    ];
    let applied = owner
        .put_acl(bucket, "plain.txt", &wanted)
        .await
        .expect("put_acl");
    println!(
        "put_acl (+READ for another user) -> verified={} grants={}",
        applied.verified,
        applied.acl.grants.len()
    );
    assert!(applied.verified && applied.acl.grants.len() == 2);
    assert_eq!(
        other
            .read_range(bucket, "plain.txt", None, 0, 10)
            .await
            .unwrap(),
        b"only",
        "the grant took effect"
    );
    let not_allowed = other
        .put_acl(bucket, "plain.txt", &wanted)
        .await
        .unwrap_err();
    println!("put_acl by a user with READ only -> {not_allowed}");
    assert!(
        not_allowed.starts_with("S3 AccessDenied (403)"),
        "{not_allowed}"
    );

    // ---- group AllUsers: anonymous read works, then stops when revoked
    let http = reqwest::Client::new();
    let url = format!("{}/{bucket}/plain.txt", endpoint());
    assert_eq!(http.get(&url).send().await.unwrap().status(), 403);
    let public = [
        grant("user", "ba-m4-ver", "FULL_CONTROL"),
        grant("group", "AllUsers", "READ"),
    ];
    let applied = owner
        .put_acl(bucket, "plain.txt", &public)
        .await
        .expect("put_acl public");
    assert!(applied.verified);
    assert!(applied
        .acl
        .grants
        .iter()
        .any(|g| g.kind == "group" && g.grantee == "AllUsers"));
    let anonymous = http.get(&url).send().await.unwrap().status();
    println!("anonymous GET with AllUsers=READ -> {anonymous}");
    assert_eq!(anonymous, 200);
    assert!(other
        .read_range(bucket, "plain.txt", None, 0, 10)
        .await
        .is_ok());
    let private = [grant("user", "ba-m4-ver", "FULL_CONTROL")];
    assert!(
        owner
            .put_acl(bucket, "plain.txt", &private)
            .await
            .unwrap()
            .verified
    );
    assert_eq!(
        http.get(&url).send().await.unwrap().status(),
        403,
        "revoked"
    );

    // ---- bucket ACL: READ lets the other user list
    assert!(other.list(bucket, "", None, 10).await.is_err());
    let bucket_acl = [
        grant("user", "ba-m4-ver", "FULL_CONTROL"),
        grant("user", "ba-m4-ver-other", "READ"),
    ];
    let applied = owner
        .put_acl(bucket, "", &bucket_acl)
        .await
        .expect("put bucket acl");
    assert!(applied.verified);
    assert!(
        other.list(bucket, "", None, 10).await.is_ok(),
        "bucket READ lets the grantee list"
    );
    assert!(
        put(&other, bucket, "nope.txt", b"x").await.is_err(),
        "READ does not let the grantee write"
    );

    // ---- invalid grants never reach RGW
    assert!(owner
        .put_acl(bucket, "plain.txt", &[grant("user", "ba-m4-ver", "ADMIN")])
        .await
        .unwrap_err()
        .contains("invalid ACL permission"));

    remove_user(&admin, "ba-m4-ver-other").await;
    remove_user(&admin, "ba-m4-ver").await;
}

/// M4.5: recursive search with result and time limits.
#[tokio::test]
async fn m4_search_bounded() {
    use futures_util::StreamExt;
    let Some(admin) = lab() else { return };
    let bucket = "ba-m4-search";
    let (_, owner) = user(&admin, "ba-m4-search").await;
    let (_, stranger) = user(&admin, "ba-m4-search-x").await;
    owner
        .client()
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .expect("create bucket");

    // More than one listing page (1000 keys), so paging and the limits are really exercised.
    let mut keys: Vec<String> = (0..1100).map(|i| format!("logs/2026/{i:04}.log")).collect();
    keys.extend((0..30).map(|i| format!("data/year=2026/part-{i:03}.parquet")));
    keys.push("Reports/Annual/Q1.PDF".into());
    let total = keys.len() as u64;
    let uploads = keys.iter().map(|key| put(&owner, bucket, key, b"x"));
    let results: Vec<_> = futures_util::stream::iter(uploads)
        .buffer_unordered(24)
        .collect()
        .await;
    assert!(results.iter().all(Result::is_ok), "fixture upload");

    let all = owner
        .search(bucket, "", "*.parquet", 500, 20)
        .await
        .expect("search");
    println!(
        "*.parquet -> {} matches, scanned {} keys, stopped: {}",
        all.matches.len(),
        all.scanned,
        all.stopped
    );
    assert_eq!(
        (all.matches.len(), all.scanned, all.stopped),
        (30, total, "done")
    );
    assert!(all
        .matches
        .iter()
        .all(|m| m.key.ends_with(".parquet") && m.size == 1));

    let word = owner.search(bucket, "", "q1.pdf", 500, 20).await.unwrap();
    assert_eq!(
        word.matches
            .iter()
            .map(|m| m.key.as_str())
            .collect::<Vec<_>>(),
        ["Reports/Annual/Q1.PDF"],
        "plain words match anywhere in the path, ignoring case"
    );
    let by_path = owner
        .search(bucket, "", "logs/2026/00?0.log", 500, 20)
        .await
        .unwrap();
    let by_name = owner.search(bucket, "", "00?0.log", 500, 20).await.unwrap();
    assert_eq!(
        (by_path.matches.len(), by_name.matches.len()),
        (10, 10),
        "a pattern with / is a path, one without is a file name"
    );
    let folder = owner.search(bucket, "", "annual", 500, 20).await.unwrap();
    assert_eq!(
        folder.matches.len(),
        1,
        "a plain word also finds folder names"
    );

    // Scoped to a prefix: only that subtree is scanned.
    let scoped = owner
        .search(bucket, "data/", "part-01*", 500, 20)
        .await
        .unwrap();
    println!(
        "prefix data/ + part-01* -> {} matches, scanned {}",
        scoped.matches.len(),
        scoped.scanned
    );
    assert_eq!(
        (scoped.matches.len(), scoped.scanned, scoped.stopped),
        (10, 30, "done")
    );

    // Result limit: stops early and says so.
    let capped = owner.search(bucket, "", "*.log", 25, 20).await.unwrap();
    println!(
        "*.log limit 25 -> {} matches, scanned {} of {total}, stopped: {}",
        capped.matches.len(),
        capped.scanned,
        capped.stopped
    );
    assert_eq!((capped.matches.len(), capped.stopped), (25, "results"));
    assert!(capped.scanned < total);

    // Time limit (0 s here: one page of 1000 keys, then stop).
    let timed = owner
        .search(bucket, "", "no-such-name", 500, 0)
        .await
        .unwrap();
    println!(
        "time limit 0 s -> scanned {} of {total}, stopped: {}",
        timed.scanned, timed.stopped
    );
    assert_eq!(
        (timed.matches.len(), timed.scanned, timed.stopped),
        (0, 1000, "time")
    );

    assert!(
        owner.search(bucket, "", "  ", 500, 20).await.is_err(),
        "an empty pattern is refused"
    );
    let denied = stranger
        .search(bucket, "", "*.log", 500, 20)
        .await
        .unwrap_err();
    assert!(denied.starts_with("S3 AccessDenied (403)"), "{denied}");

    remove_user(&admin, "ba-m4-search-x").await;
    remove_user(&admin, "ba-m4-search").await;
}

// ---- data for the browse flow of scripts/ui-smoke/ui-smoke.sh (FLOW=browse) ----

const SMOKE_OWNER: &str = "ba-m4-ui";
const SMOKE_READ_ONLY: &str = "ba-m4-ui-ro";
const SMOKE_BUCKET: &str = "ba-m4-ui-bucket";

/// One second of a 440 Hz tone as a 16-bit mono WAV file.
fn wav() -> Vec<u8> {
    const RATE: u32 = 8000;
    let samples: Vec<u8> = (0..RATE)
        .flat_map(|i| {
            {
                let t = i as f32 / RATE as f32;
                ((t * 440.0 * std::f32::consts::TAU).sin() * 12000.0) as i16
            }
            .to_le_bytes()
        })
        .collect();
    let mut out = Vec::new();
    out.extend(b"RIFF");
    out.extend((36 + samples.len() as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes()); // PCM
    out.extend(1u16.to_le_bytes()); // mono
    out.extend(RATE.to_le_bytes());
    out.extend((RATE * 2).to_le_bytes()); // bytes per second
    out.extend(2u16.to_le_bytes()); // bytes per sample
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend((samples.len() as u32).to_le_bytes());
    out.extend(samples);
    out
}

/// A one-page PDF saying `text`, with a correct cross-reference table.
fn pdf(text: &str) -> Vec<u8> {
    let stream = format!("BT /F1 28 Tf 60 700 Td ({text}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for offset in offsets {
        out.extend(format!("{offset:010} 00000 n \n").bytes());
    }
    out.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .bytes(),
    );
    out
}

/// A user owning a bucket with one object per viewer, a versioned key, and a second user who
/// is granted everything on the bucket but is read-only by op-mask.
#[tokio::test]
#[ignore = "fixture for scripts/ui-smoke/ui-smoke.sh, not a test"]
async fn ui_smoke_browse_fixture_create() {
    use aws_sdk_s3::types::{BucketVersioningStatus, VersioningConfiguration};
    let admin = lab().expect("RGW_ACCESS_KEY / RGW_SECRET_KEY must be set");
    let (_, owner) = user(&admin, SMOKE_OWNER).await;
    user(&admin, SMOKE_READ_ONLY).await;
    let bucket = SMOKE_BUCKET;
    owner
        .client()
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .expect("create bucket");

    let readme: String = (1..=400)
        .map(|i| match i {
            50 | 250 | 399 => format!("dòng {i}: ERROR disk full\n"),
            _ => format!("dòng {i}: ok\n"),
        })
        .collect();
    let mut csv = String::from("id,name,city,note\n");
    for i in 1..=200 {
        csv.push_str(&format!(
            "{i},\"Nguyen, An {i}\",Ha Noi,\"said \"\"hi\"\"\"\n"
        ));
    }
    let json = r#"{"name":"lab","retention_days":30,"tags":["a","b"],"nested":{"enabled":true}}"#;
    let files: [(&str, Vec<u8>); 8] = [
        ("notes/readme.txt", readme.into_bytes()),
        ("notes/config.json", json.as_bytes().to_vec()),
        ("data/people.csv", csv.into_bytes()),
        (
            "media/icon.png",
            include_bytes!("../icons/128x128.png").to_vec(),
        ),
        (
            "media/shape.svg",
            include_bytes!("../icons/icon.svg").to_vec(),
        ),
        ("media/tone.wav", wav()),
        ("media/doc.pdf", pdf("BucketAdmin PDF preview")),
        ("bin/blob.bin", pattern(10240)),
    ];
    for (key, body) in &files {
        put(&owner, bucket, key, body)
            .await
            .expect("fixture object");
    }
    let dir = temp_dir("smoke-fixture");
    let parquet = dir.join("sample.parquet");
    assert_eq!(write_parquet(&parquet, 2), 2000);
    owner
        .upload(bucket, "data/sample.parquet", &parquet, |_, _| {})
        .await
        .expect("parquet");
    std::fs::remove_dir_all(&dir).unwrap();
    // The video comes from the smoke script (ffmpeg); without it the flow skips that viewer.
    if let Ok(mp4) = std::env::var("BA_SMOKE_MP4") {
        let mp4 = std::path::PathBuf::from(mp4);
        owner
            .upload(bucket, "media/clip.mp4", &mp4, |_, _| {})
            .await
            .expect("mp4");
    }

    let on = VersioningConfiguration::builder()
        .status(BucketVersioningStatus::Enabled)
        .build();
    let versioning = owner.client().put_bucket_versioning().bucket(bucket);
    versioning
        .versioning_configuration(on)
        .send()
        .await
        .expect("enable versioning");
    for body in ["first version", "second version, longer", "third"] {
        put(&owner, bucket, "notes/versioned.txt", body.as_bytes())
            .await
            .expect("version");
    }

    let grant = policy(bucket, SMOKE_READ_ONLY, r#""s3:*""#);
    owner
        .client()
        .put_bucket_policy()
        .bucket(bucket)
        .policy(grant)
        .send()
        .await
        .expect("put policy");
    let read_only = UserModify {
        op_mask: Some("read".into()),
        ..Default::default()
    };
    admin
        .modify_user(SMOKE_READ_ONLY, &read_only)
        .await
        .expect("op-mask=read");
}

#[tokio::test]
#[ignore = "fixture for scripts/ui-smoke/ui-smoke.sh, not a test"]
async fn ui_smoke_browse_fixture_remove() {
    let admin = lab().expect("RGW_ACCESS_KEY / RGW_SECRET_KEY must be set");
    remove_user(&admin, SMOKE_READ_ONLY).await;
    remove_user(&admin, SMOKE_OWNER).await;
}

/// M5: create bucket (with and without versioning), create folder, multi-delete with folders,
/// tags and raw HEAD headers, all with a normal user's key.
#[tokio::test]
async fn m5_manage_buckets_folders_delete_tags() {
    use bucketadmin_lib::s3::manage::ObjectTag;
    let Some(admin) = lab() else { return };
    let (_, owner) = user(&admin, "ba-m5-manage").await;
    let (_, other) = user(&admin, "ba-m5-manage-x").await;

    // ---- create bucket
    let invalid = owner
        .create_bucket("Not_A_Valid_Name", false)
        .await
        .unwrap_err();
    println!("create_bucket invalid name -> {invalid}");
    assert!(invalid.starts_with("invalid bucket name"));
    owner
        .create_bucket("ba-m5-plain", false)
        .await
        .expect("create bucket");
    owner
        .create_bucket("ba-m5-versioned", true)
        .await
        .expect("create versioned bucket");
    println!(
        "versioning after create -> plain {:?}, versioned {:?}",
        owner.versioning("ba-m5-plain").await.status,
        owner.versioning("ba-m5-versioned").await.status
    );
    assert_eq!(owner.versioning("ba-m5-plain").await.status, "");
    assert_eq!(owner.versioning("ba-m5-versioned").await.status, "Enabled");
    let names: Vec<String> = owner
        .list_buckets()
        .await
        .unwrap()
        .into_iter()
        .map(|b| b.name)
        .collect();
    assert_eq!(names, ["ba-m5-plain", "ba-m5-versioned"]);
    let taken = other.create_bucket("ba-m5-plain", false).await.unwrap_err();
    println!("create_bucket with a name another user owns -> {taken}");
    assert!(taken.starts_with("S3 BucketAlreadyExists (409)"), "{taken}");

    // ---- create folder
    let bucket = "ba-m5-plain";
    let key = owner
        .create_folder(bucket, "", "reports")
        .await
        .expect("create_folder");
    assert_eq!(key, "reports/");
    assert_eq!(
        owner
            .create_folder(bucket, "reports/", "2026")
            .await
            .unwrap(),
        "reports/2026/"
    );
    assert!(owner
        .create_folder(bucket, "", "reports")
        .await
        .unwrap_err()
        .contains("already exists"));
    assert!(owner.create_folder(bucket, "", "a/b").await.is_err());
    let root = owner.list(bucket, "", None, 1000).await.unwrap();
    println!(
        "after create_folder -> prefixes {:?}, objects {}",
        root.prefixes,
        root.objects.len()
    );
    assert_eq!(
        (root.prefixes.as_slice(), root.objects.len()),
        (&["reports/".to_string()][..], 0)
    );
    let inside = owner.list(bucket, "reports/", None, 1000).await.unwrap();
    assert_eq!(inside.prefixes, ["reports/2026/"]);
    assert_eq!(
        inside
            .objects
            .iter()
            .map(|o| (o.key.as_str(), o.size))
            .collect::<Vec<_>>(),
        [("reports/", 0)],
        "the folder marker itself"
    );
    assert!(
        other.create_folder(bucket, "", "intruder").await.is_err(),
        "another user cannot create folders"
    );

    // ---- multi-delete: two objects and one folder (with everything below it)
    for key in [
        "keep.txt",
        "one.txt",
        "two.txt",
        "reports/a.csv",
        "reports/2026/b.csv",
        "reports/2026/q1/c.csv",
    ] {
        put(&owner, bucket, key, b"x").await.unwrap();
    }
    let selection = (
        vec!["one.txt".to_string(), "two.txt".to_string()],
        vec!["reports/".to_string()],
    );
    let keys = owner
        .expand(bucket, &selection.0, &selection.1, 5000)
        .await
        .expect("expand");
    println!("selection expands to -> {keys:?}");
    assert_eq!(
        keys,
        [
            "one.txt",
            "reports/",
            "reports/2026/",
            "reports/2026/b.csv",
            "reports/2026/q1/c.csv",
            "reports/a.csv",
            "two.txt"
        ]
    );
    assert!(owner
        .expand(bucket, &[], &selection.1, 3)
        .await
        .unwrap_err()
        .contains("more than 3 objects"));
    assert!(
        owner
            .expand(bucket, &[], &[String::new()], 5000)
            .await
            .is_err(),
        "an empty prefix would mean the whole bucket"
    );
    let refused = other.delete_many(bucket, keys.clone()).await;
    assert_eq!(
        (refused.deleted, refused.failed.len()),
        (0, 7),
        "another user deletes nothing"
    );
    assert!(refused.failed[0].error.starts_with("S3 AccessDenied (403)"));
    let report = owner.delete_many(bucket, keys).await;
    println!(
        "delete_many -> {} of {} deleted, {} failed",
        report.deleted,
        report.objects,
        report.failed.len()
    );
    assert_eq!(
        (report.objects, report.deleted, report.failed.len()),
        (7, 7, 0)
    );
    let left = owner.list(bucket, "", None, 1000).await.unwrap();
    assert!(left.prefixes.is_empty());
    assert_eq!(
        left.objects
            .iter()
            .map(|o| o.key.as_str())
            .collect::<Vec<_>>(),
        ["keep.txt"]
    );

    // ---- tags
    let tag = |key: &str, value: &str| ObjectTag {
        key: key.into(),
        value: value.into(),
    };
    assert!(owner
        .get_tags(bucket, "keep.txt", None)
        .await
        .unwrap()
        .is_empty());
    owner
        .put_tags(
            bucket,
            "keep.txt",
            None,
            &[tag("env", "lab"), tag("owner", "đội sys")],
        )
        .await
        .expect("put_tags");
    let tags = owner.get_tags(bucket, "keep.txt", None).await.unwrap();
    println!("tags -> {tags:?}");
    assert_eq!(tags, [tag("env", "lab"), tag("owner", "đội sys")]);
    owner
        .put_tags(bucket, "keep.txt", None, &[tag("env", "prod")])
        .await
        .unwrap();
    assert_eq!(
        owner.get_tags(bucket, "keep.txt", None).await.unwrap(),
        [tag("env", "prod")],
        "tags are replaced, not merged"
    );
    assert!(owner
        .put_tags(bucket, "keep.txt", None, &[tag("", "x")])
        .await
        .is_err());
    assert!(other
        .put_tags(bucket, "keep.txt", None, &[tag("x", "y")])
        .await
        .is_err());
    owner
        .put_tags(bucket, "keep.txt", None, &[])
        .await
        .expect("clear tags");
    assert!(owner
        .get_tags(bucket, "keep.txt", None)
        .await
        .unwrap()
        .is_empty());

    // ---- raw HEAD headers
    let headers = owner
        .head_headers(bucket, "keep.txt", None)
        .await
        .expect("head_headers");
    println!(
        "HEAD headers -> {:?}",
        headers.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>()
    );
    let header = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(header("content-length"), Some("1"));
    assert!(
        header("etag").is_some()
            && header("last-modified").is_some()
            && header("x-amz-request-id").is_some()
    );
    assert!(owner
        .head_headers(bucket, "missing.txt", None)
        .await
        .unwrap_err()
        .contains("(404)"));

    remove_user(&admin, "ba-m5-manage-x").await;
    remove_user(&admin, "ba-m5-manage").await;
}

/// M5: a running transfer stops when cancelled; an upload leaves no parts behind, a download
/// keeps what it has for a later resume.
#[tokio::test]
async fn m5_transfers_can_be_cancelled() {
    use bucketadmin_lib::s3::transfer::Cancel;
    use std::sync::atomic::Ordering::SeqCst;
    let Some(admin) = lab() else { return };
    let bucket = "ba-m5-cancel";
    let (_, owner) = user(&admin, "ba-m5-cancel").await;
    owner
        .create_bucket(bucket, false)
        .await
        .expect("create bucket");
    let dir = temp_dir("cancel");
    let big = dir.join("big.bin");
    std::fs::write(&big, pattern(20 * 1024 * 1024)).unwrap();

    // Cancel as soon as the first part is done.
    let cancel = Cancel::default();
    let flag = cancel.clone();
    let stopped = owner
        .upload_with(
            bucket,
            "big.bin",
            &big,
            move |_, _| flag.store(true, SeqCst),
            &cancel,
        )
        .await
        .unwrap_err();
    println!("upload cancelled after the first part -> {stopped}");
    assert_eq!(stopped, "cancelled");
    assert!(
        owner.head(bucket, "big.bin", None).await.is_err(),
        "no object was created"
    );
    let pending = owner
        .client()
        .list_multipart_uploads()
        .bucket(bucket)
        .send()
        .await
        .unwrap();
    assert!(
        pending.uploads().is_empty(),
        "the multipart upload was aborted"
    );

    owner
        .upload(bucket, "big.bin", &big, |_, _| {})
        .await
        .expect("upload");
    let dest = dir.join("big.copy");
    let cancel = Cancel::default();
    let flag = cancel.clone();
    let stopped = owner
        .download_with(
            bucket,
            "big.bin",
            None,
            &dest,
            move |done, _| flag.store(done > 0, SeqCst),
            &cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(stopped, "cancelled");
    let kept = std::fs::metadata(dir.join("big.copy.part")).unwrap().len();
    println!("download cancelled -> {kept} bytes kept in the .part file");
    assert_eq!(kept, 8 * 1024 * 1024);
    assert!(!dest.exists());
    let resumed = owner
        .download(bucket, "big.bin", None, &dest, |_, _| {})
        .await
        .expect("resume");
    assert_eq!(resumed.resumed_from, kept);
    assert!(std::fs::read(&dest).unwrap() == std::fs::read(&big).unwrap());

    std::fs::remove_dir_all(&dir).unwrap();
    remove_user(&admin, "ba-m5-cancel").await;
}

// ---- M6.1: browsing with a key typed in by hand ("my own key") ----

/// The profile store's secrets in memory (the app keeps them in the OS keychain).
#[derive(Default)]
struct MemorySecrets(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl bucketadmin_lib::clusters::SecretStore for MemorySecrets {
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

/// Stands where the Admin API transport is: counts the requests and refuses them.
#[derive(Default)]
struct NoAdminApi(std::sync::atomic::AtomicUsize);

impl bucketadmin_lib::rgw_admin::HttpClient for &NoAdminApi {
    async fn send(
        &self,
        _req: bucketadmin_lib::rgw_admin::HttpRequest,
    ) -> Result<bucketadmin_lib::rgw_admin::HttpResponse, String> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err("the own-key flow must not call the Admin API".into())
    }
}

/// M6.1: a normal user without any admin cap saves a personal key and gets the whole browse
/// feature set with it. The session is built the way the app builds it (`browse::connect`),
/// with a transport in the Admin API's place that counts requests: it must count none.
#[tokio::test]
async fn m6_browse_with_own_key_never_calls_the_admin_api() {
    use bucketadmin_lib::browse_connect as connect;
    use bucketadmin_lib::clusters::ProfileStore;
    use bucketadmin_lib::rgw_admin::RgwError;
    use bucketadmin_lib::s3::acl::Grant;
    use bucketadmin_lib::s3::manage::ObjectTag;
    use bucketadmin_lib::s3::transfer::PART_SIZE;
    use bucketadmin_lib::s3::LIST_PAGE;
    use std::sync::atomic::Ordering::SeqCst;

    let Some(admin) = lab() else { return };
    let (uid, bucket) = ("ba-m6-plain", "ba-m6-plain-bucket");
    let (key, _) = user(&admin, uid).await; // asserts the user has no admin caps

    // What this user gets from the Admin API: nothing. That is why M6.1 exists.
    let creds = Credentials {
        access_key: key.access_key.clone(),
        secret_key: key.secret_key.clone(),
    };
    let as_user = RgwAdmin::new(&endpoint(), creds, ReqwestClient::new().unwrap()).unwrap();
    let info = as_user.get_info().await.map(|i| i.cluster_id);
    let users = as_user.list_users().await.map(|u| u.len());
    println!(
        "plain user on the Admin API: /admin/info -> {info:?}, /admin/metadata/user -> {users:?}"
    );
    assert_eq!(info, Err(RgwError::AccessDenied));
    assert_eq!(users, Err(RgwError::AccessDenied));

    // The profile as that user would save it, then the personal key (pasted with a newline).
    let dir = temp_dir("ownkey");
    let store = ProfileStore::new(dir.join("data"), MemorySecrets::default());
    let profile = store
        .add("lab", &endpoint(), &key.access_key, &key.secret_key)
        .unwrap();
    let no_admin = NoAdminApi::default();
    let before = connect(&store, &no_admin, &profile.id, "").await;
    assert_eq!(
        before.err().unwrap(),
        "no personal key saved for this cluster"
    );
    let pasted = format!("{}\n", key.secret_key);
    let saved = store
        .set_browse_key(&profile.id, &key.access_key, &pasted)
        .unwrap();
    assert_eq!(
        saved.browse_access_key.as_deref(),
        Some(key.access_key.as_str())
    );
    let on_disk = std::fs::read_to_string(dir.join("data/profiles.json")).unwrap();
    assert!(!on_disk.contains(&key.secret_key), "secret leaked to disk");

    let s3 = connect(&store, &no_admin, &profile.id, "")
        .await
        .expect("own-key session");
    assert_eq!(s3.access_key(), key.access_key);

    // ---- buckets, folders, listing
    assert_eq!(s3.list_buckets().await.unwrap(), []);
    s3.create_bucket(bucket, false)
        .await
        .expect("create bucket");
    let names: Vec<String> = s3
        .list_buckets()
        .await
        .unwrap()
        .into_iter()
        .map(|b| b.name)
        .collect();
    assert_eq!(names, [bucket]);
    let folder = s3.create_folder(bucket, "", "docs").await.expect("folder");
    assert_eq!(folder, "docs/");

    // ---- upload: one request, and multipart
    let small = dir.join("small.txt");
    std::fs::write(&small, b"hello own key").unwrap();
    let big = dir.join("big.bin");
    let big_bytes = pattern(PART_SIZE as usize + 1024 * 1024);
    std::fs::write(&big, &big_bytes).unwrap();
    let up = s3.upload(bucket, "docs/small.txt", &small, |_, _| {}).await;
    assert_eq!(up.expect("upload small"), 13);
    let up = s3.upload(bucket, "docs/big.bin", &big, |_, _| {}).await;
    assert_eq!(up.expect("upload multipart"), big_bytes.len() as u64);
    let listing = s3.list(bucket, "", None, LIST_PAGE).await.unwrap();
    assert_eq!(listing.prefixes, ["docs/"]);
    let listing = s3.list(bucket, "docs/", None, LIST_PAGE).await.unwrap();
    let keys: Vec<&str> = listing.objects.iter().map(|o| o.key.as_str()).collect();
    assert_eq!(keys, ["docs/", "docs/big.bin", "docs/small.txt"]);

    // ---- preview (ranged read), properties, search
    let read = s3.read_range(bucket, "docs/small.txt", None, 6, 100).await;
    assert_eq!(read.unwrap(), b"own key");
    let head = s3.head(bucket, "docs/big.bin", None).await.unwrap();
    assert_eq!(head.size, big_bytes.len() as u64);
    let found = s3.search(bucket, "", "*.bin", 500, 20).await.unwrap();
    assert_eq!((found.matches.len(), found.stopped), (1, "done"));

    // ---- download, byte-identical
    let dest = dir.join("big.copy");
    s3.download(bucket, "docs/big.bin", None, &dest, |_, _| {})
        .await
        .expect("download");
    assert!(std::fs::read(&dest).unwrap() == big_bytes);

    // ---- versions, ACL, tags
    assert!(s3.versioning(bucket).await.supported);
    let versions = s3.list_versions(bucket, "docs/small.txt").await.unwrap();
    assert_eq!(versions.len(), 1);
    let acl = s3.get_acl(bucket, "docs/small.txt").await.unwrap();
    assert_eq!(acl.owner_id, uid);
    let grant = |kind: &str, grantee: &str, permission: &str| Grant {
        kind: kind.into(),
        grantee: grantee.into(),
        display_name: String::new(),
        permission: permission.into(),
    };
    let grants = [
        grant("user", uid, "FULL_CONTROL"),
        grant("group", "AuthenticatedUsers", "READ"),
    ];
    let applied = s3.put_acl(bucket, "docs/small.txt", &grants).await.unwrap();
    assert!(applied.verified && applied.acl.grants.len() == 2);
    let tags = [ObjectTag {
        key: "team".into(),
        value: "csoc".into(),
    }];
    s3.put_tags(bucket, "docs/small.txt", None, &tags)
        .await
        .expect("put tags");
    let read_back = s3.get_tags(bucket, "docs/small.txt", None).await.unwrap();
    assert_eq!(read_back.len(), 1);

    // ---- presigned URL: fetched without any credentials
    let url = s3
        .presign_get(bucket, "docs/small.txt", None, 300, None)
        .await
        .expect("presign");
    let answer = reqwest::Client::new().get(&url).send().await.unwrap();
    assert_eq!(answer.status(), 200);
    assert_eq!(answer.text().await.unwrap(), "hello own key");

    // ---- delete: one object, then the rest of the folder
    s3.delete(bucket, "docs/small.txt", None)
        .await
        .expect("delete");
    let rest = s3
        .expand(bucket, &[], &["docs/".to_string()], 1000)
        .await
        .unwrap();
    let report = s3.delete_many(bucket, rest).await;
    assert_eq!((report.deleted, report.failed.len()), (2, 0));
    let listing = s3.list(bucket, "", None, LIST_PAGE).await.unwrap();
    assert!(listing.prefixes.is_empty() && listing.objects.is_empty());

    // The key is deleted again: no session, and still no Admin API request anywhere above.
    let cleared = store.clear_browse_key(&profile.id).unwrap();
    assert_eq!(cleared.browse_access_key, None);
    assert!(connect(&store, &no_admin, &profile.id, "").await.is_err());
    println!(
        "own-key browse as {uid}: buckets, folders, upload (single + multipart), list, preview, \
         search, download, versions, ACL, tags, presign, delete -> Admin API requests: {}",
        no_admin.0.load(SeqCst)
    );
    assert_eq!(no_admin.0.load(SeqCst), 0, "the Admin API was called");

    std::fs::remove_dir_all(&dir).unwrap();
    remove_user(&admin, uid).await;
}
