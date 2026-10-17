//! Fetches one person's photo from Google or the Microsoft directory and returns it as a data URL.
//! Deliberately limited to two hosts, no redirects, no SVG.

use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use url::Url;

const CAP: usize = 256 * 1024;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> Result<&'static reqwest::Client, String> {
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(4))
        .user_agent(concat!("zMail/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| c))
}

fn is_graph(host: &str) -> bool {
    host == "graph.microsoft.com"
}

/// Only https, default port, no userinfo, on Graph or a googleusercontent.com host.
pub(crate) fn photo_url_allowed(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    is_graph(host) || host.ends_with(".googleusercontent.com")
}

#[tauri::command]
pub async fn fetch_photo(url: String, bearer: Option<String>) -> Result<Option<String>, String> {
    let Ok(url) = Url::parse(&url) else {
        return Ok(None);
    };
    if !photo_url_allowed(&url) {
        return Ok(None);
    }
    let mut req = client()?.get(url.clone()).header("Accept", "image/*");
    if let (Some(token), Some(host)) = (bearer.as_deref(), url.host_str())
        && is_graph(host)
    {
        req = req.bearer_auth(token);
    }
    let mut resp = req.send().await.map_err(|_| "unavailable".to_string())?;
    let status = resp.status().as_u16();
    match status {
        200 => {}
        404 => return Ok(None),
        401 | 403 => return Err("forbidden".into()),
        s if (300..400).contains(&s) => return Ok(None),
        _ => return Err("unavailable".into()),
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| "unavailable".to_string())? {
        if body.len() + chunk.len() > CAP {
            return Ok(None);
        }
        body.extend_from_slice(&chunk);
    }
    match crate::sender_logo::sniff_image(&body) {
        Some(mime @ ("image/png" | "image/jpeg" | "image/gif" | "image/webp")) => {
            Ok(Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&body)
            )))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> bool {
        photo_url_allowed(&Url::parse(s).unwrap())
    }

    #[test]
    fn person_photo_url_allowed_accepts_graph_and_google() {
        assert!(ok(
            "https://graph.microsoft.com/v1.0/users/a@b.edu/photos/96x96/$value"
        ));
        assert!(ok("https://lh3.googleusercontent.com/x=s100"));
    }

    #[test]
    fn person_photo_url_allowed_rejects_others() {
        assert!(!ok(
            "http://graph.microsoft.com/v1.0/users/a@b.edu/photos/96x96/$value"
        ));
        assert!(!ok("https://graph.microsoft.com.evil.com/v1.0/x"));
        assert!(!ok("https://googleusercontent.com.evil.com/x"));
        assert!(!ok("https://evil.com/?h=googleusercontent.com"));
        assert!(!ok("https://user@graph.microsoft.com/v1.0/x"));
        assert!(!ok("https://graph.microsoft.com:8443/v1.0/x"));
    }
}
