//! FIFO mock transport shared by the unit tests of this crate.

use super::{Credentials, HttpClient, HttpRequest, HttpResponse, RgwAdmin};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct Mock {
    pub responses: Mutex<VecDeque<HttpResponse>>,
    pub requests: Mutex<Vec<HttpRequest>>,
    in_flight: AtomicUsize,
    pub max_in_flight: AtomicUsize,
}

impl HttpClient for &Mock {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, String> {
        self.requests.lock().unwrap().push(req);
        let resp = self.responses.lock().unwrap().pop_front();
        let now = self.in_flight.fetch_add(1, SeqCst) + 1;
        self.max_in_flight.fetch_max(now, SeqCst);
        // Yield so concurrent callers overlap and tests can observe the concurrency.
        tokio::task::yield_now().await;
        self.in_flight.fetch_sub(1, SeqCst);
        resp.ok_or_else(|| "connection refused".to_string())
    }
}

impl Mock {
    pub fn reply(status: u16, body: &str) -> Self {
        Mock::default().then(status, body)
    }

    /// Queues one more response.
    pub fn then(self, status: u16, body: &str) -> Self {
        self.responses.lock().unwrap().push_back(HttpResponse {
            status,
            headers: vec![("Server".into(), "Ceph Object Gateway (squid)".into())],
            body: body.as_bytes().to_vec(),
        });
        self
    }

    pub fn client(&self) -> RgwAdmin<&Mock> {
        let creds = Credentials {
            access_key: "AK".into(),
            secret_key: "SK".into(),
        };
        RgwAdmin::new("http://rgw.test:7480/", creds, self).unwrap()
    }

    /// "METHOD path?query" of every request sent, in order.
    pub fn calls(&self) -> Vec<String> {
        let reqs = self.requests.lock().unwrap();
        reqs.iter()
            .map(|r| format!("{} {}", r.method, r.url.replace("http://rgw.test:7480", "")))
            .collect()
    }

    /// (method, url) of the only request sent.
    pub fn sent(&self) -> (&'static str, String) {
        let reqs = self.requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        (reqs[0].method, reqs[0].url.clone())
    }
}
