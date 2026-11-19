//! M7a.3 against the lab RGW (a private address): with a proxy named in the environment and
//! nothing excluded from it, "no proxy" still reaches the cluster directly, for the Admin Ops
//! client, the S3 client and the presigned HEAD alike.
//!
//! This file holds ONE test on purpose: it rewrites the proxy variables of its own process,
//! which must not happen next to other tests.
//!
//!   RGW_ACCESS_KEY=... RGW_SECRET_KEY=... cargo test --test proxy_lab -- --nocapture

use bucketadmin_lib::rgw_admin::{Credentials, ReqwestClient, RgwAdmin};
use bucketadmin_lib::s3::S3;
use bucketadmin_lib::settings::{endpoint_kind, EndpointKind, Proxy};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Stands where the company proxy would be: answers 502 to everything and counts the calls.
fn fake_proxy() -> (String, Arc<AtomicUsize>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            counter.fetch_add(1, Ordering::SeqCst);
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            );
        }
    });
    (address, hits)
}

#[tokio::test]
async fn m7_private_endpoint_is_reached_directly_despite_a_proxy_in_the_environment() {
    let (Ok(access_key), Ok(secret_key)) = (
        std::env::var("RGW_ACCESS_KEY"),
        std::env::var("RGW_SECRET_KEY"),
    ) else {
        eprintln!("SKIPPED: RGW_ACCESS_KEY / RGW_SECRET_KEY not set");
        return;
    };
    let endpoint = std::env::var("RGW_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:7480".into());
    let kind = endpoint_kind(&endpoint).unwrap();
    println!("endpoint kind -> {kind:?} (the form suggests \"no proxy\" for it)");
    assert_eq!(kind, EndpointKind::PrivateAddress);

    // The environment of a machine behind a proxy that forgot to exclude the cluster.
    let (proxy, proxy_hits) = fake_proxy();
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::set_var(name, &proxy);
    }
    for name in ["NO_PROXY", "no_proxy"] {
        std::env::remove_var(name);
    }
    let hits = || proxy_hits.load(Ordering::SeqCst);
    let creds = || Credentials {
        access_key: access_key.clone(),
        secret_key: secret_key.clone(),
    };
    let admin = |proxy: &Proxy| {
        let http = ReqwestClient::with_proxy(proxy).unwrap();
        RgwAdmin::new(&endpoint, creds(), http).unwrap()
    };

    // ---- "auto" follows the environment: the request ends at the proxy
    let via_env = admin(&Proxy::Auto).get_info().await;
    println!(
        "auto, Admin Ops get_info -> {:?}; proxy saw {} request(s)",
        via_env
            .as_ref()
            .map(|i| &i.cluster_id)
            .map_err(|e| e.to_string()),
        hits()
    );
    assert!(via_env.is_err() && hits() == 1);
    let s3_via_env = S3::with_proxy(&endpoint, &access_key, &secret_key, &Proxy::Auto).unwrap();
    let listed = s3_via_env.list_buckets().await;
    let after_auto = hits();
    println!(
        "auto, S3 list_buckets -> {:?}; proxy saw {after_auto} request(s) so far",
        listed.as_ref().map(Vec::len)
    );
    assert!(listed.is_err() && after_auto > 1);

    // ---- "no proxy" goes straight to the cluster: everything works, the proxy sees nothing
    let info = admin(&Proxy::None).get_info().await.expect("get_info");
    let direct = S3::with_proxy(&endpoint, &access_key, &secret_key, &Proxy::None).unwrap();
    let uid = direct.whoami().await.expect("whoami");
    let buckets = direct.list_buckets().await.expect("list_buckets");
    println!(
        "no proxy, Admin Ops get_info -> cluster_id of {} characters; S3 whoami -> a uid of {} characters, {} bucket(s)",
        info.cluster_id.len(),
        uid.len(),
        buckets.len()
    );
    let bucket = "ba-m7-proxy";
    direct.create_bucket(bucket, false).await.expect("bucket");
    let put = direct.client().put_object().bucket(bucket).key("a.txt");
    put.body(b"direct".to_vec().into())
        .send()
        .await
        .expect("put");
    let headers = direct
        .head_headers(bucket, "a.txt", None)
        .await
        .expect("HEAD");
    let url = direct
        .presign_get(bucket, "a.txt", None, 60, None)
        .await
        .unwrap();
    println!(
        "no proxy, presigned HEAD -> {} headers; presigned URL starts with the endpoint: {}",
        headers.len(),
        url.starts_with(&endpoint)
    );
    assert!(headers
        .iter()
        .any(|(name, value)| name == "content-length" && value == "6"));
    assert!(url.starts_with(&endpoint));
    direct.delete(bucket, "a.txt", None).await.expect("delete");
    direct
        .client()
        .delete_bucket()
        .bucket(bucket)
        .send()
        .await
        .expect("delete bucket");
    println!(
        "proxy saw {} request(s) while \"no proxy\" was used",
        hits() - after_auto
    );
    assert_eq!(hits(), after_auto, "nothing went to the proxy");

    // ---- "custom" names the proxy itself, whatever the environment says
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::remove_var(name);
    }
    let custom = Proxy::Custom { url: proxy.clone() };
    assert!(admin(&custom).get_info().await.is_err());
    println!(
        "custom (environment cleared) -> proxy saw {} more request(s)",
        hits() - after_auto
    );
    assert_eq!(hits(), after_auto + 1);
}
