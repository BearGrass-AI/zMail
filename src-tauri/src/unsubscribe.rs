//! RFC 8058 one-click unsubscribe. The URL comes from a sender's header, so it's
//! fetched the way sender logos are: https on port 443 only, every address the host
//! resolves to must be public, the connection is pinned to those addresses, and a
//! redirect is never followed (its 3xx status comes back instead).

use std::net::SocketAddr;
use std::time::Duration;

use url::Url;

use crate::sender_logo::{NetErr, pinned_client, public_addrs, resolver};

/// Enough of the reply to finish the exchange politely; the rest is dropped.
const MAX_REPLY: usize = 64 * 1024;

/// The URL and its host when it is https on the default port, without credentials,
/// and names a host rather than an IP literal.
fn check_url(raw: &str) -> Result<(Url, String), String> {
    let url =
        Url::parse(raw).map_err(|_| "That unsubscribe link isn't a valid URL.".to_string())?;
    if url.scheme() != "https" {
        return Err("Only secure (https) unsubscribe links are used.".into());
    }
    // Url::port() is None for https's default port, so an explicit :443 passes too.
    if url.port().is_some_and(|p| p != 443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("That unsubscribe link uses an unusual port or carries a password, so zMail won't use it.".into());
    }
    let Some(url::Host::Domain(host)) = url.host() else {
        return Err("That unsubscribe link points to an IP address, so zMail won't use it.".into());
    };
    let host = host.to_string();
    Ok((url, host))
}

fn client(host: &str, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    pinned_client(host, addrs)
        .timeout(Duration::from_secs(10))
        .user_agent(concat!(
            "zMail/",
            env!("CARGO_PKG_VERSION"),
            " (one-click unsubscribe)"
        ))
        .build()
        .map_err(|e| e.to_string())
}

async fn post(client: &reqwest::Client, url: Url) -> Result<u16, String> {
    let mut res = client
        .post(url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
        .map_err(|e| format!("The unsubscribe request failed: {e}"))?;
    let status = res.status().as_u16();
    let mut read = 0;
    while read < MAX_REPLY {
        match res.chunk().await {
            Ok(Some(c)) => read += c.len(),
            _ => break,
        }
    }
    Ok(status)
}

/// POST `List-Unsubscribe=One-Click` to a sender's unsubscribe URL and return the
/// HTTP status. Refuses anything but https to a host whose addresses are all public.
#[tauri::command]
pub async fn unsubscribe_post(url: String) -> Result<u16, String> {
    let (url, host) = check_url(&url)?;
    let r = resolver().map_err(|_| "Couldn't read the Mac's DNS settings.".to_string())?;
    // Pinning uses the host exactly as the URL spells it (reqwest matches on that);
    // the lookup drops a trailing dot so "a.com." resolves like "a.com".
    let addrs =
        match public_addrs(&r, host.trim_end_matches('.'), 443).await {
            Ok(Some(a)) => a,
            Ok(None) => return Err(
                "That unsubscribe link doesn't point to a public address, so zMail won't use it."
                    .into(),
            ),
            Err(NetErr) => return Err(format!("Couldn't look up {host}.")),
        };
    post(&client(&host, &addrs)?, url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn unsubscribe_check_url() {
        let (url, host) = check_url("https://News.Example.com/u?x=1").unwrap();
        assert_eq!(host, "news.example.com");
        assert_eq!(url.as_str(), "https://news.example.com/u?x=1");
        assert!(check_url("https://a.com:443/u").is_ok());
        for bad in [
            "http://a.com/u",
            "ftp://a.com/u",
            "javascript:alert(1)",
            "not a url",
            "https://user@a.com/u",
            "https://user:pw@a.com/u",
            "https://a.com:8443/u",
            "https://a.com:80/u",
            "https://127.0.0.1/u",
            "https://[::1]/u",
            "https://0x7f000001/u",
        ] {
            assert!(check_url(bad).is_err(), "{bad} should be refused");
        }
    }

    /// Refused before any lookup or connection.
    #[test]
    fn unsubscribe_post_refuses_bad_urls() {
        for bad in [
            "http://a.com/u",
            "https://a.com:8080/u",
            "https://u:p@a.com/u",
            "https://10.0.0.1/u",
        ] {
            assert!(
                tauri::async_runtime::block_on(unsubscribe_post(bad.into())).is_err(),
                "{bad}"
            );
        }
    }

    /// One loopback exchange through a client pinned to 127.0.0.1. Returns the
    /// status and the raw request, and checks that nothing connected a second time.
    fn exchange(response: &'static [u8]) -> (u16, String) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let n = sock.read(&mut buf).unwrap();
            let _ = sock.write_all(response);
            drop(sock);
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            (
                String::from_utf8_lossy(&buf[..n]).to_lowercase(),
                listener.accept().is_err(),
            )
        });
        // The name never resolves; the pin is the only way to reach the server.
        let host = "unsub.zmail-test.invalid";
        let addrs = [SocketAddr::from(([127, 0, 0, 1], port))];
        let url = Url::parse(&format!("http://{host}:{port}/u?x=1")).unwrap();
        let status =
            tauri::async_runtime::block_on(async { post(&client(host, &addrs)?, url).await })
                .unwrap();
        let (request, no_second) = server.join().unwrap();
        assert!(no_second, "a second request arrived");
        (status, request)
    }

    #[test]
    fn unsubscribe_posts_one_click_body() {
        let (status, request) =
            exchange(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        assert_eq!(status, 200);
        assert!(request.starts_with("post /u?x=1 "), "{request}");
        assert!(request.contains("content-type: application/x-www-form-urlencoded"));
        assert!(request.ends_with("list-unsubscribe=one-click"), "{request}");
    }

    #[test]
    fn unsubscribe_returns_redirect_without_following() {
        let (status, _) = exchange(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(status, 302);
    }

    #[test]
    fn unsubscribe_stops_reading_a_huge_reply() {
        static BIG: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
        let big = BIG.get_or_init(|| {
            let mut v =
                b"HTTP/1.1 200 OK\r\nContent-Length: 4000000\r\nConnection: close\r\n\r\n".to_vec();
            v.resize(v.len() + 4_000_000, b'x');
            v
        });
        let (status, _) = exchange(big);
        assert_eq!(status, 200);
    }
}
