//! App-wide settings (`settings.json` next to the profiles): how requests leave the machine.
//! The proxy choice applies to every client the app has: the Admin Ops client, the S3 client
//! of a browse session, the HEAD behind the Headers tab and the update check.

use crate::rgw_admin::parse_endpoint;
use aws_sdk_s3::config::SharedHttpClient;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Chosen app-wide, with an optional override per cluster profile.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Proxy {
    /// Whatever HTTP_PROXY / HTTPS_PROXY / NO_PROXY in the environment say.
    #[default]
    Auto,
    /// Always connect directly, even when the environment names a proxy.
    None,
    /// Always through this proxy, whatever the environment says.
    Custom { url: String },
}

impl Proxy {
    /// Trims a custom URL and rejects one no client could use.
    pub fn validated(self) -> Result<Self, String> {
        let Proxy::Custom { url } = self else {
            return Ok(self);
        };
        let url = url.trim().to_string();
        match parse_endpoint(&url) {
            Ok(_) => Ok(Proxy::Custom { url }),
            Err(_) => Err(format!(
                "invalid proxy URL {url:?}: expected http://host:port"
            )),
        }
    }

    /// A reqwest client builder that routes the way this setting says.
    pub fn reqwest(&self) -> Result<reqwest::ClientBuilder, String> {
        let builder = reqwest::Client::builder();
        Ok(match self {
            Proxy::Auto => builder,
            Proxy::None => builder.no_proxy(),
            // An explicit proxy also switches reqwest's own look at the environment off.
            Proxy::Custom { url } => {
                let all = reqwest::Proxy::all(url);
                builder.proxy(all.map_err(|e| format!("invalid proxy URL {url:?}: {e}"))?)
            }
        })
    }

    /// The same for the S3 SDK. `None` for [`Proxy::Auto`]: the SDK's default client already
    /// reads the environment, so that case stays exactly what it was.
    pub fn s3_http_client(&self) -> Result<Option<SharedHttpClient>, String> {
        use aws_smithy_http_client::proxy::ProxyConfig;
        use aws_smithy_http_client::{tls, Builder, ConnectorBuilder};
        let config = match self {
            Proxy::Auto => return Ok(None),
            Proxy::None => ProxyConfig::disabled(),
            Proxy::Custom { url } => ProxyConfig::all(url.as_str())
                .map_err(|e| format!("invalid proxy URL {url:?}: {e}"))?,
        };
        // Built the way the SDK builds its default client, with the proxy choice put in.
        let client = Builder::new().build_with_connector_fn(move |settings, components| {
            let crypto = tls::rustls_provider::CryptoMode::AwsLc;
            let mut connector =
                ConnectorBuilder::default().tls_provider(tls::Provider::Rustls(crypto));
            connector.set_connector_settings(settings.cloned());
            if let Some(components) = components {
                connector.set_sleep_impl(components.sleep_impl());
            }
            connector.set_proxy_config(Some(config.clone()));
            connector.build()
        });
        Ok(Some(client))
    }
}

/// Answer of the last update check that reached GitHub, kept so the check runs once a day.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdateSeen {
    /// Seconds since 1970.
    pub checked_at: u64,
    /// Tag of the latest release; empty when there was none to read.
    pub tag: String,
    pub url: String,
}

/// A place that was browsed: a prefix of a bucket, on a connection, with whose key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub cluster_id: String,
    /// Empty: the connection's own key.
    #[serde(default)]
    pub uid: String,
    pub bucket: String,
    #[serde(default)]
    pub prefix: String,
}

/// Recent places kept.
pub const MAX_RECENT: usize = 20;

/// Sizes the whole interface can be shown at, in percent.
pub const UI_SCALES: [u16; 6] = [80, 90, 100, 110, 125, 150];

fn default_scale() -> u16 {
    100
}

/// The allowed step nearest to `percent`; a value outside the range of steps is refused.
pub fn nearest_scale(percent: u16) -> Result<u16, String> {
    let (min, max) = (UI_SCALES[0], UI_SCALES[UI_SCALES.len() - 1]);
    if !(min..=max).contains(&percent) {
        return Err(format!(
            "invalid UI scale {percent}: expected {min} to {max} percent"
        ));
    }
    let nearest = UI_SCALES.iter().min_by_key(|step| step.abs_diff(percent));
    Ok(*nearest.unwrap_or(&100))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub proxy: Proxy,
    /// Size of the interface in percent, one of [`UI_SCALES`].
    #[serde(default = "default_scale")]
    pub ui_scale: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateSeen>,
    /// Places opened last, newest first, at most [`MAX_RECENT`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent: Vec<Place>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            proxy: Proxy::default(),
            ui_scale: default_scale(),
            update: None,
            recent: Vec::new(),
        }
    }
}

impl Settings {
    /// The saved scale as a step the UI can show; a hand-edited value that is no step gives 100.
    pub fn scale(&self) -> u16 {
        nearest_scale(self.ui_scale).unwrap_or(default_scale())
    }

    /// Puts `place` at the front of the recent places; a place already listed moves up.
    pub fn remember(&mut self, place: Place) {
        self.recent.retain(|known| *known != place);
        self.recent.insert(0, place);
        self.recent.truncate(MAX_RECENT);
    }
}

pub struct SettingsStore {
    path: PathBuf,
    // Serialises read-modify-write of the file across concurrent commands.
    lock: Mutex<()>,
}

impl SettingsStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("settings.json"),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<Settings, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("{} is corrupt: {e}", self.path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(format!("cannot read {}: {e}", self.path.display())),
        }
    }

    /// The saved settings; the defaults while nothing was saved yet.
    pub fn get(&self) -> Result<Settings, String> {
        let _guard = self.lock.lock().map_err(|e| e.to_string())?;
        self.read()
    }

    /// Read-modify-write under the lock; returns the settings as saved.
    pub fn change(&self, edit: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let _guard = self.lock.lock().map_err(|e| e.to_string())?;
        let mut settings = self.read()?;
        edit(&mut settings);
        let err = |e: std::io::Error| format!("cannot write {}: {e}", self.path.display());
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        // Write-then-rename so a crash never leaves a half-written file.
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, json).map_err(err)?;
        std::fs::rename(&tmp, &self.path).map_err(err)?;
        Ok(settings)
    }
}

/// What an endpoint looks like from this machine; the first two are reasons to suggest
/// "no proxy" for it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndpointKind {
    /// An address a proxy outside the network cannot reach: RFC 1918, loopback, link-local,
    /// or IPv6 unique-local.
    PrivateAddress,
    /// A name only an internal DNS knows: a single label, or an internal-only suffix.
    InternalName,
    Public,
    /// The name could not be resolved from here; a proxy may still know it.
    Unresolved,
}

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Names that never resolve on the public internet.
pub fn is_internal_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    const SUFFIXES: [&str; 6] = [
        ".local",
        ".lan",
        ".internal",
        ".intranet",
        ".corp",
        ".home.arpa",
    ];
    !host.contains('.') || SUFFIXES.iter().any(|s| host.ends_with(s))
}

/// Classifies the endpoint's host. Resolves the name (blocking), so call it off the UI thread.
pub fn endpoint_kind(endpoint: &str) -> Result<EndpointKind, String> {
    let url = parse_endpoint(endpoint).map_err(|e| e.to_string())?;
    let host = url.host_str().unwrap_or_default();
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = literal.parse::<IpAddr>() {
        return Ok(match is_private(ip) {
            true => EndpointKind::PrivateAddress,
            false => EndpointKind::Public,
        });
    }
    if is_internal_name(host) {
        return Ok(EndpointKind::InternalName);
    }
    let port = url.port_or_known_default().unwrap_or(80);
    Ok(match (host, port).to_socket_addrs() {
        Ok(mut addrs) => match addrs.any(|a| is_private(a.ip())) {
            true => EndpointKind::PrivateAddress,
            false => EndpointKind::Public,
        },
        Err(_) => EndpointKind::Unresolved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clusters::tests::temp_dir;
    use crate::rgw_admin::{HttpClient, HttpRequest, ReqwestClient};
    use crate::s3::S3;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn proxy_choice_is_stored_as_a_mode_and_validated() {
        let json = |p: &Proxy| serde_json::to_string(p).unwrap();
        assert_eq!(json(&Proxy::Auto), r#"{"mode":"auto"}"#);
        assert_eq!(json(&Proxy::None), r#"{"mode":"none"}"#);
        let custom = Proxy::Custom {
            url: " http://proxy.example:3128/ ".into(),
        };
        let custom = custom.validated().unwrap();
        assert_eq!(
            json(&custom),
            r#"{"mode":"custom","url":"http://proxy.example:3128/"}"#
        );
        assert_eq!(
            serde_json::from_str::<Proxy>(&json(&custom)).unwrap(),
            custom
        );
        for bad in [
            "",
            "proxy.example:3128",
            "socks5://proxy.example:1080",
            "http://",
        ] {
            let refused = Proxy::Custom { url: bad.into() }.validated();
            assert!(refused.is_err(), "{bad:?} should be rejected");
        }
        assert_eq!(Proxy::None.validated().unwrap(), Proxy::None);
    }

    #[test]
    fn settings_default_until_saved_and_survive_a_reload() {
        let dir = temp_dir("settings");
        let store = SettingsStore::new(&dir);
        assert_eq!(store.get().unwrap(), Settings::default());
        assert_eq!(store.get().unwrap().proxy, Proxy::Auto);
        store.change(|s| s.proxy = Proxy::None).unwrap();
        let seen = UpdateSeen {
            checked_at: 1,
            tag: "v0.2.0".into(),
            url: "u".into(),
        };
        store.change(|s| s.update = Some(seen.clone())).unwrap();
        let reloaded = SettingsStore::new(&dir).get().unwrap();
        assert_eq!((reloaded.proxy, reloaded.update), (Proxy::None, Some(seen)));
        // ---- recent places: newest first, no duplicates, at most MAX_RECENT
        let place = |n: usize| Place {
            cluster_id: "c1".into(),
            uid: String::new(),
            bucket: "logs".into(),
            prefix: format!("day-{n}/"),
        };
        for n in 0..MAX_RECENT + 5 {
            store.change(|s| s.remember(place(n))).unwrap();
        }
        store.change(|s| s.remember(place(10))).unwrap();
        let recent = SettingsStore::new(&dir).get().unwrap().recent;
        assert_eq!(recent.len(), MAX_RECENT);
        assert_eq!(recent[0], place(10), "opened again: moved to the front");
        assert_eq!(recent[1], place(MAX_RECENT + 4));
        assert_eq!(recent.iter().filter(|p| **p == place(10)).count(), 1);
        assert!(!recent.contains(&place(0)), "the oldest fell off");
        let json = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(json.contains(r#""clusterId": "c1""#), "{json}");
        // A file from before a field existed still loads.
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        assert_eq!(store.get().unwrap(), Settings::default());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ui_scale_defaults_to_100_snaps_to_a_step_and_survives_a_reload() {
        let dir = temp_dir("ui-scale");
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::new(&dir);
        // A settings.json written before the field existed.
        std::fs::write(dir.join("settings.json"), r#"{"proxy":{"mode":"none"}}"#).unwrap();
        let old = store.get().unwrap();
        assert_eq!(
            (old.ui_scale, old.scale(), old.proxy),
            (100, 100, Proxy::None)
        );
        // Round trip.
        store.change(|s| s.ui_scale = 125).unwrap();
        assert_eq!(SettingsStore::new(&dir).get().unwrap().scale(), 125);
        let json = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(json.contains(r#""ui_scale": 125"#), "{json}");
        // Clamping: a value between two steps goes to the nearer one, anything outside is refused.
        for (asked, step) in [
            (80, 80),
            (84, 80),
            (86, 90),
            (104, 100),
            (117, 110),
            (118, 125),
            (140, 150),
            (150, 150),
        ] {
            assert_eq!(nearest_scale(asked), Ok(step), "{asked}");
        }
        for refused in [0, 79, 151, 400] {
            assert!(nearest_scale(refused).is_err(), "{refused}");
        }
        // A hand-edited file: a value between steps is shown as a step, nonsense as 100.
        std::fs::write(dir.join("settings.json"), r#"{"ui_scale":120}"#).unwrap();
        assert_eq!(store.get().unwrap().scale(), 125);
        std::fs::write(dir.join("settings.json"), r#"{"ui_scale":9}"#).unwrap();
        assert_eq!(store.get().unwrap().scale(), 100);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn private_addresses_and_internal_names() {
        for private in [
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.10.10",
            "::1",
            "fd12:3456::1",
            "fe80::1",
        ] {
            assert!(is_private(private.parse().unwrap()), "{private}");
        }
        for public in ["8.8.8.8", "172.32.0.1", "11.0.0.1", "2001:4860:4860::8888"] {
            assert!(!is_private(public.parse().unwrap()), "{public}");
        }
        for internal in [
            "rgw",
            "ceph-rgw01",
            "rgw.lan",
            "s3.corp",
            "rgw.dc1.internal",
            "RGW.LOCAL.",
        ] {
            assert!(is_internal_name(internal), "{internal}");
        }
        for public in ["rgw.example.com", "s3.amazonaws.com", "local.example.org"] {
            assert!(!is_internal_name(public), "{public}");
        }
        // No DNS needed for these.
        let kind = |e: &str| endpoint_kind(e).unwrap();
        assert_eq!(
            kind("http://10.20.30.40:7480"),
            EndpointKind::PrivateAddress
        );
        assert_eq!(kind("http://127.0.0.1:7480"), EndpointKind::PrivateAddress);
        assert_eq!(kind("https://[fd00::10]:443"), EndpointKind::PrivateAddress);
        assert_eq!(kind("https://8.8.8.8"), EndpointKind::Public);
        assert_eq!(kind("http://rgw:7480"), EndpointKind::InternalName);
        assert_eq!(kind("https://s3.dc1.internal"), EndpointKind::InternalName);
        assert!(endpoint_kind("not a url").is_err());
    }

    /// A local HTTP server that answers every request with `status` and counts them.
    fn server(status: &'static str) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let answer =
                    format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                let _ = stream.write_all(answer.as_bytes());
            }
        });
        (address, hits)
    }

    fn get(url: &str) -> HttpRequest {
        HttpRequest {
            method: "GET",
            url: url.to_string(),
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    /// Both clients, both explicit modes: "custom" sends the request to the proxy, "none"
    /// sends it straight to the target. (The "auto" mode reads the process environment and is
    /// covered by tests/proxy_lab.rs, which owns its process.)
    #[tokio::test]
    async fn custom_goes_through_the_proxy_and_none_goes_direct() {
        let (target, target_hits) = server("200 OK");
        let (proxy, proxy_hits) = server("502 Bad Gateway");
        let hits = || {
            (
                target_hits.load(Ordering::SeqCst),
                proxy_hits.load(Ordering::SeqCst),
            )
        };
        let via = Proxy::Custom { url: proxy.clone() };

        // ---- the Admin Ops transport
        let through = ReqwestClient::with_proxy(&via).unwrap();
        let answer = through.send(get(&format!("{target}/admin/info"))).await;
        assert_eq!(answer.unwrap().status, 502, "the proxy answered");
        assert_eq!(hits(), (0, 1));
        let direct = ReqwestClient::with_proxy(&Proxy::None).unwrap();
        let answer = direct.send(get(&format!("{target}/admin/info"))).await;
        assert_eq!(answer.unwrap().status, 200, "the target answered");
        assert_eq!(hits(), (1, 1));

        // ---- the S3 client (the answers are not S3 answers; only who was asked matters)
        let through = S3::with_proxy(&target, "AK", "SK", &via).unwrap();
        let _ = through.list_buckets().await;
        let (target_now, proxy_now) = hits();
        assert_eq!(target_now, 1, "the S3 request did not reach the target");
        assert!(proxy_now > 1, "the S3 request went to the proxy");
        let direct = S3::with_proxy(&target, "AK", "SK", &Proxy::None).unwrap();
        let _ = direct.list_buckets().await;
        assert!(hits().0 > 1, "the S3 request went straight to the target");
        assert_eq!(hits().1, proxy_now, "and not to the proxy");

        // ---- the HEAD behind the Headers tab follows the same choice
        let _ = through.head_headers("bucket", "key", None).await;
        assert!(hits().1 > proxy_now);
    }
}
