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

/// A fresh normal user (no admin caps) and an S3 session signed with that user's key.
async fn user(admin: &RgwAdmin, uid: &str) -> (KeyPair, S3) {
    let _ = admin.delete_user(uid, true).await; // leftover from an aborted run
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

    admin
        .delete_user("ba-m4-reader", true)
        .await
        .expect("cleanup reader");
    admin
        .delete_user("ba-m4-owner", true)
        .await
        .expect("cleanup owner");
}
