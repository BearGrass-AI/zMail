use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

#[derive(serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    /// Seconds from a `Retry-After` header (429/503 throttling), when present.
    pub retry_after: Option<u64>,
}

/// Parse a `Retry-After` value in its delta-seconds form. The HTTP-date form
/// returns None (Microsoft Graph sends seconds), and so does 0, so callers
/// back off on their own instead of retrying instantly.
fn parse_retry_after(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok().filter(|&s| s > 0)
}

/// Only http(s) URLs go out. The webview can name any URL, so `file:`, `data:` and other
/// schemes are refused here rather than left to reqwest. Hosts are not restricted: model
/// endpoints are user-configured (localhost, LAN, custom servers).
fn check_scheme(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid URL {url}: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        other => Err(format!("unsupported URL scheme \"{other}\"")),
    }
}

static DEFAULT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static NO_REDIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub(crate) fn default_client() -> Result<&'static reqwest::Client, String> {
    if let Some(c) = DEFAULT_CLIENT.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(DEFAULT_CLIENT.get_or_init(|| c))
}

fn no_redirect_client() -> Result<&'static reqwest::Client, String> {
    if let Some(c) = NO_REDIRECT_CLIENT.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    Ok(NO_REDIRECT_CLIENT.get_or_init(|| c))
}

/// Make an HTTP request to a model provider (Anthropic, OpenAI, Ollama, Jev,
/// or a custom endpoint) and return the status and raw body. Runs in Rust so
/// the webview avoids CORS and can reach localhost and tailnet hosts.
/// `follow_redirects: Some(false)` returns a 3xx as-is instead of following it
/// (used for requests to untrusted URLs, e.g. one-click unsubscribe).
#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    follow_redirects: Option<bool>,
) -> Result<HttpResponse, String> {
    check_scheme(&url)?;
    let client = if follow_redirects == Some(false) {
        no_redirect_client()?
    } else {
        default_client()?
    };

    let method =
        reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let needs_length = matches!(
        method,
        reqwest::Method::POST | reqwest::Method::PUT | reqwest::Method::PATCH
    );
    let mut req = client.request(method, &url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    match body {
        Some(b) => req = req.body(b),
        // Google answers a bodyless POST (e.g. messages/{id}/trash) with 411
        // Length Required, and an empty body alone doesn't produce the header.
        None if needs_length => req = req.header(reqwest::header::CONTENT_LENGTH, "0").body(""),
        None => {}
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("request to {url} failed: {e}"))?;
    let status = res.status().as_u16();
    let retry_after = res
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_retry_after);
    let bytes = read_capped(res, MAX_BODY).await?;
    // Same decoding reqwest's text() does without its charset feature.
    let body = String::from_utf8_lossy(&bytes).into_owned();
    Ok(HttpResponse {
        status,
        body,
        retry_after,
    })
}

/// No model or mail API answers with more than this; a bigger body is refused
/// rather than buffered into memory.
const MAX_BODY: usize = 50 * 1024 * 1024;

async fn read_capped(mut res: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    if res.content_length().is_some_and(|n| n > cap as u64) {
        return Err("response too large".into());
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > cap {
            return Err("response too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only http(s) leaves the proxy; the command refuses anything else before building a request.
    #[test]
    fn rejects_non_http_schemes() {
        for url in [
            "file:///etc/passwd",
            "data:text/plain,hi",
            "ftp://example.com/x",
            "tauri://localhost",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert!(check_scheme(url).is_err(), "{url} was allowed");
        }
        for url in [
            "http://127.0.0.1:11434/api",
            "https://api.example.com/v1",
            "HTTPS://x.y",
        ] {
            assert!(check_scheme(url).is_ok(), "{url} was refused");
        }
        let err = tauri::async_runtime::block_on(http_request(
            "GET".into(),
            "file:///etc/passwd".into(),
            HashMap::new(),
            None,
            None,
        ))
        .err()
        .unwrap();
        assert!(err.contains("scheme"), "{err}");
    }

    /// A bodyless POST must still carry Content-Length: 0 (Google returns 411 otherwise).
    #[test]
    fn bodyless_post_sends_content_length() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap();
            sock.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
            String::from_utf8_lossy(&buf[..n]).to_lowercase()
        });
        let res = tauri::async_runtime::block_on(http_request(
            "POST".into(),
            format!("http://127.0.0.1:{port}/messages/abc/trash"),
            HashMap::new(),
            None,
            None,
        ))
        .unwrap();
        assert_eq!(res.status, 204);
        assert!(server.join().unwrap().contains("content-length: 0"));
    }

    /// With follow_redirects: Some(false), a 302 comes back as-is and its target is never requested.
    #[test]
    fn no_redirect_returns_3xx() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).unwrap();
            sock.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
            // A followed redirect would connect again; none should arrive.
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            listener.accept().is_err()
        });
        let res = tauri::async_runtime::block_on(http_request(
            "POST".into(),
            format!("http://127.0.0.1:{port}/unsub"),
            HashMap::new(),
            Some("List-Unsubscribe=One-Click".into()),
            Some(false),
        ))
        .unwrap();
        assert_eq!(res.status, 302);
        assert!(server.join().unwrap(), "redirect target was requested");
    }

    /// A 429's Retry-After (delta seconds) comes back as retry_after.
    #[test]
    fn retry_after_is_returned() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).unwrap();
            sock.write_all(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
        });
        let res = tauri::async_runtime::block_on(http_request(
            "GET".into(),
            format!("http://127.0.0.1:{port}/me/messages"),
            HashMap::new(),
            None,
            None,
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!(res.status, 429);
        assert_eq!(res.retry_after, Some(7));
    }

    /// Serve one canned response on loopback and read it back through read_capped.
    fn capped(response: &'static [u8], cap: usize) -> Result<Vec<u8>, String> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).unwrap();
            let _ = sock.write_all(response);
        });
        let out = tauri::async_runtime::block_on(async {
            let res = default_client()?
                .get(format!("http://127.0.0.1:{port}/"))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            read_capped(res, cap).await
        });
        server.join().unwrap();
        out
    }

    #[test]
    fn http_body_cap() {
        assert_eq!(
            capped(
                b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                5
            )
            .unwrap(),
            b"hello"
        );
        // Refused from the declared length, and from the bytes when there's no length.
        assert_eq!(
            capped(
                b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nhello!",
                5
            ),
            Err("response too large".into())
        );
        assert_eq!(
            capped(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n", 5),
            Err("response too large".into())
        );
        assert_eq!(MAX_BODY, 50 * 1024 * 1024);
    }

    #[test]
    fn parses_retry_after_seconds_only() {
        assert_eq!(parse_retry_after("2"), Some(2));
        assert_eq!(parse_retry_after(" 120 "), Some(120));
        // 0 means "use backoff" so a retry isn't instant.
        assert_eq!(parse_retry_after("0"), None);
        // HTTP-date form isn't parsed (no date crate); callers fall back to backoff.
        assert_eq!(parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after(""), None);
        assert_eq!(parse_retry_after("-1"), None);
    }

    /// Live check of the Rust transport against Anthropic's model list with a
    /// bad key: expects a clean 401, not a transport error.
    /// Run with: cargo test -- --ignored
    #[test]
    #[ignore = "calls the real Anthropic API"]
    fn anthropic_models_rejects_bad_key() {
        let mut headers = HashMap::new();
        headers.insert("x-api-key".into(), "sk-ant-invalid".into());
        headers.insert("anthropic-version".into(), "2023-06-01".into());
        let res = tauri::async_runtime::block_on(http_request(
            "GET".into(),
            "https://api.anthropic.com/v1/models?limit=1".into(),
            headers,
            None,
            None,
        ))
        .expect("transport should succeed");
        assert_eq!(res.status, 401, "body: {}", res.body);
    }
}
