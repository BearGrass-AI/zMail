//! Company logos for sender avatars.
//!
//! A logo is only returned for domains that publish an enforcing DMARC policy (so a forger can't
//! borrow it). Order: BIMI logo, then the company's own website icon. Everything is fetched
//! straight from the company's domain over https, with the Mac's own DNS configuration, and with
//! every connection pinned to addresses that were checked to be public.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use base64::Engine;
use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;
use url::Url;

// ---- pure helpers ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Dmarc {
    pub p: String,
    pub sp: Option<String>,
    pub pct: Option<u8>,
}

fn tags(txt: &str) -> Vec<(String, String)> {
    txt.split(';')
        .filter_map(|part| {
            let (k, v) = part.split_once('=')?;
            Some((k.trim().to_ascii_lowercase(), v.trim().to_string()))
        })
        .collect()
}

pub fn parse_dmarc(txt: &str) -> Option<Dmarc> {
    let t = tags(txt);
    let (k, v) = t.first()?;
    if k != "v" || !v.eq_ignore_ascii_case("DMARC1") {
        return None;
    }
    let get = |name: &str| {
        t.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.to_ascii_lowercase())
    };
    Some(Dmarc {
        p: get("p")?,
        sp: get("sp"),
        pct: get("pct").and_then(|v| v.parse::<u8>().ok()),
    })
}

pub fn enforcing(d: &Dmarc, is_subdomain: bool) -> bool {
    let policy = if is_subdomain {
        d.sp.as_deref().unwrap_or(&d.p)
    } else {
        &d.p
    };
    (policy == "quarantine" || policy == "reject") && matches!(d.pct, None | Some(100))
}

fn normalize_domain(domain: &str) -> String {
    domain.trim().trim_end_matches('.').to_ascii_lowercase()
}

pub fn domain_candidates(domain: &str) -> Vec<String> {
    let d = normalize_domain(domain);
    if d.is_empty() || d.parse::<IpAddr>().is_ok() || d.starts_with('[') {
        return vec![];
    }
    let labels: Vec<&str> = d.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|l| l.is_empty()) {
        return vec![];
    }
    (0..=labels.len() - 2)
        .map(|i| labels[i..].join("."))
        .collect()
}

pub fn parse_bimi(txt: &str) -> Option<String> {
    let t = tags(txt);
    let (k, v) = t.first()?;
    if k != "v" || !v.eq_ignore_ascii_case("BIMI1") {
        return None;
    }
    let l = t.iter().find(|(k, _)| k == "l").map(|(_, v)| v.clone())?;
    if l.to_ascii_lowercase().starts_with("https://") {
        Some(l)
    } else {
        None
    }
}

/// Value of an attribute inside one `<link ...>` tag body (quoted or bare).
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(name) {
        let start = from + pos;
        from = start + name.len();
        let before_ok = start == 0 || lower.as_bytes()[start - 1].is_ascii_whitespace();
        if !before_ok {
            continue;
        }
        let rest = tag[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        return Some(match rest.chars().next()? {
            q @ ('"' | '\'') => {
                let inner = &rest[1..];
                inner[..inner.find(q)?].to_string()
            }
            _ => rest
                .split(|c: char| c.is_whitespace() || c == '>')
                .next()?
                .to_string(),
        });
    }
    None
}

pub fn icon_links(html: &str, base: &Url) -> Vec<Url> {
    let lower = html.to_ascii_lowercase();
    let mut found: Vec<(u8, Url)> = Vec::new();
    let mut from = 0;
    while let Some(pos) = lower[from..].find("<link") {
        let start = from + pos + 5;
        let Some(end) = lower[start..].find('>') else {
            break;
        };
        let body = &html[start..start + end];
        from = start + end;
        if !body.starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let Some(rel) = attr(body, "rel") else {
            continue;
        };
        let rel = rel.to_ascii_lowercase();
        let words: Vec<&str> = rel.split_whitespace().collect();
        let touch = words.iter().any(|w| w.contains("apple-touch-icon"));
        if !touch && !words.contains(&"icon") {
            continue;
        }
        let Some(href) = attr(body, "href") else {
            continue;
        };
        let Ok(url) = base.join(href.trim()) else {
            continue;
        };
        if url.scheme() != "https" {
            continue;
        }
        let svg = attr(body, "type").is_some_and(|t| t.eq_ignore_ascii_case("image/svg+xml"));
        let rank = if touch {
            0
        } else if svg {
            1
        } else {
            2
        };
        if !found.iter().any(|(_, u)| *u == url) {
            found.push((rank, url));
        }
    }
    found.sort_by_key(|(r, _)| *r);
    found.into_iter().take(4).map(|(_, u)| u).collect()
}

pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}');
    if head.trim_start().starts_with("<!doctype html") || head.contains("<html") {
        return None;
    }
    if head.contains("<svg") {
        let t = head.trim_start();
        if t.starts_with("<svg")
            || t.starts_with("<?xml")
            || t.starts_with("<!--")
            || t.starts_with("<!doctype svg")
        {
            return Some("image/svg+xml");
        }
    }
    None
}

fn v4_public(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || (o[0] == 100 && (o[1] & 0xC0) == 64)
        || o[0] == 0
        || o[0] >= 240
        || (o[0] == 198 && (o[1] & 0xFE) == 18)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0))
}

fn v4_from(hi: u16, lo: u16) -> Ipv4Addr {
    let [a, b] = hi.to_be_bytes();
    let [c, d] = lo.to_be_bytes();
    Ipv4Addr::new(a, b, c, d)
}

fn v6_public(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_public(v4);
    }
    let s = ip.segments();
    // Forms that carry an IPv4 address and can reach it: IPv4-compatible (::a.b.c.d),
    // NAT64 (64:ff9b::/96) and 6to4 (2002::/16). The embedded address decides.
    if s[..6] == [0; 6] || (s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4]) {
        return v4_public(v4_from(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return v4_public(v4_from(s[1], s[2]));
    }
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (s[0] & 0xFFC0) == 0xFE80
        || (s[0] & 0xFE00) == 0xFC00
        || (s[0] == 0x2001 && s[1] == 0x0db8))
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v4_public(v),
        IpAddr::V6(v) => v6_public(v),
    }
}

// ---- network ---------------------------------------------------------------------

const DAY: u64 = 86_400;
const MAX_IMAGE: usize = 128 * 1024;
const MAX_HTML: usize = 256 * 1024;

/// A lookup failed because of the network or DNS (not because the answer was "no").
pub(crate) struct NetErr;

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub(crate) fn resolver() -> Result<TokioResolver, NetErr> {
    // The Mac's own DNS configuration, never a hard-coded public resolver.
    TokioResolver::builder_tokio()
        .and_then(hickory_resolver::ResolverBuilder::build)
        .map_err(|_| NetErr)
}

async fn txt(r: &TokioResolver, name: &str) -> Result<Vec<String>, NetErr> {
    match r.txt_lookup(format!("{name}.")).await {
        Ok(l) => Ok(l
            .answers()
            .iter()
            .filter_map(|r| match &r.data {
                RData::TXT(t) => Some(
                    t.txt_data
                        .iter()
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .collect::<String>(),
                ),
                _ => None,
            })
            .collect()),
        Err(e) if e.is_no_records_found() => Ok(vec![]),
        Err(_) => Err(NetErr),
    }
}

/// Every address `host` resolves to, with `port`, when all of them are public.
/// `Ok(None)` means no records, or at least one address that isn't public.
pub(crate) async fn public_addrs(
    r: &TokioResolver,
    host: &str,
    port: u16,
) -> Result<Option<Vec<SocketAddr>>, NetErr> {
    let ips: Vec<IpAddr> = match r.lookup_ip(format!("{host}.")).await {
        Ok(l) => l.iter().collect(),
        Err(e) if e.is_no_records_found() => return Ok(None),
        Err(_) => return Err(NetErr),
    };
    if ips.is_empty() || !ips.iter().all(|ip| is_public_ip(*ip)) {
        return Ok(None);
    }
    Ok(Some(
        ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect(),
    ))
}

/// A client that only ever connects to `host` at `addrs` (already checked), never
/// follows a redirect and ignores any system proxy. Callers add timeouts and a user agent.
pub(crate) fn pinned_client(host: &str, addrs: &[SocketAddr]) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, addrs)
}

fn host_allowed(host: &str, org: &str) -> bool {
    host == org || host.ends_with(&format!(".{org}"))
}

/// Fetch one https URL with pinned, checked addresses and manual same-company redirects.
/// `Ok(None)` means refused / not found / too big; `Err` means a network failure.
async fn fetch(
    r: &TokioResolver,
    start: &str,
    org: &str,
    bimi_host: Option<&str>,
    cap: usize,
) -> Result<Option<Vec<u8>>, NetErr> {
    let Ok(mut url) = Url::parse(start) else {
        return Ok(None);
    };
    for hop in 0..=3 {
        if url.scheme() != "https"
            || url.port().is_some_and(|p| p != 443)
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Ok(None);
        }
        let Some(url::Host::Domain(host)) = url.host() else {
            return Ok(None);
        };
        let host = host.to_ascii_lowercase();
        let allowed = match bimi_host {
            Some(h) => host == h,
            None => host_allowed(&host, org),
        };
        if !allowed {
            return Ok(None);
        }
        let Some(addrs) = public_addrs(r, &host, 443).await? else {
            return Ok(None);
        };
        let client = pinned_client(&host, &addrs)
            .timeout(std::time::Duration::from_secs(6))
            .connect_timeout(std::time::Duration::from_secs(4))
            .user_agent(concat!(
                "zMail/",
                env!("CARGO_PKG_VERSION"),
                " (sender logo lookup)"
            ))
            .build()
            .map_err(|_| NetErr)?;
        let mut resp = client
            .get(url.clone())
            .header("Accept", "image/*,text/html;q=0.8")
            .send()
            .await
            .map_err(|_| NetErr)?;
        let status = resp.status();
        if status.is_redirection() {
            if hop == 3 {
                return Ok(None);
            }
            let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) else {
                return Ok(None);
            };
            let Ok(next) = url.join(loc) else {
                return Ok(None);
            };
            url = next;
            continue;
        }
        if status.as_u16() != 200 {
            return Ok(None);
        }
        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| NetErr)? {
            if body.len() + chunk.len() > cap {
                return Ok(None);
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(Some(body));
    }
    Ok(None)
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

async fn lookup(domain: &str) -> Result<Option<String>, NetErr> {
    let r = resolver()?;
    // Trust: the first domain (self, then parents) with a DMARC record decides.
    let mut org: Option<String> = None;
    for cand in domain_candidates(domain) {
        let records = txt(&r, &format!("_dmarc.{cand}")).await?;
        if let Some(d) = records.iter().find_map(|t| parse_dmarc(t)) {
            if !enforcing(&d, cand != domain) {
                return Ok(None);
            }
            org = Some(cand);
            break;
        }
    }
    let Some(org) = org else { return Ok(None) };

    // BIMI brand logo.
    let mut names = vec![domain.to_string()];
    if org != domain {
        names.push(org.clone());
    }
    for n in names {
        let records = txt(&r, &format!("default._bimi.{n}")).await?;
        if let Some(logo) = records.iter().find_map(|t| parse_bimi(t)) {
            let host = Url::parse(&logo)
                .ok()
                .and_then(|u| u.host_str().map(str::to_ascii_lowercase));
            if let Some(host) = host
                && let Some(bytes) = fetch(&r, &logo, &org, Some(&host), MAX_IMAGE).await?
                && sniff_image(&bytes) == Some("image/svg+xml")
            {
                return Ok(Some(data_url("image/svg+xml", &bytes)));
            }
            break;
        }
    }

    // The company's own website icon.
    let accept = |bytes: &[u8]| sniff_image(bytes).map(|m| data_url(m, bytes));
    if let Some(b) = fetch(
        &r,
        &format!("https://{org}/apple-touch-icon.png"),
        &org,
        None,
        MAX_IMAGE,
    )
    .await?
        && let Some(u) = accept(&b)
    {
        return Ok(Some(u));
    }
    let base_s = format!("https://{org}/");
    if let Some(html) = fetch(&r, &base_s, &org, None, MAX_HTML).await?
        && let Ok(base) = Url::parse(&base_s)
    {
        for link in icon_links(&String::from_utf8_lossy(&html), &base) {
            if let Some(b) = fetch(&r, link.as_str(), &org, None, MAX_IMAGE).await?
                && let Some(u) = accept(&b)
            {
                return Ok(Some(u));
            }
        }
    }
    if let Some(b) = fetch(
        &r,
        &format!("https://{org}/favicon.ico"),
        &org,
        None,
        MAX_IMAGE,
    )
    .await?
        && let Some(u) = accept(&b)
    {
        return Ok(Some(u));
    }
    Ok(None)
}

fn cached(raw: &str) -> Option<Option<String>> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let at = v.get("at")?.as_u64()?;
    let logo = v.get("logo").and_then(|l| l.as_str()).map(str::to_string);
    let ttl = if logo.is_some() { 30 * DAY } else { 7 * DAY };
    if now().saturating_sub(at) < ttl {
        Some(logo)
    } else {
        None
    }
}

#[tauri::command]
pub async fn sender_logo(
    db: tauri::State<'_, crate::db::Db>,
    domain: String,
) -> Result<Option<String>, String> {
    let domain = normalize_domain(&domain);
    if domain_candidates(&domain).is_empty() {
        return Ok(None);
    }
    let key = format!("sender_logo:{domain}");
    let hit = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::db::kv_get_conn(&conn, &key)?
    };
    if let Some(c) = hit.as_deref().and_then(cached) {
        return Ok(c);
    }
    match lookup(&domain).await {
        Ok(logo) => {
            let value = serde_json::json!({ "logo": logo, "at": now() }).to_string();
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let _ = crate::db::kv_set_conn(&conn, &key, &value);
            Ok(logo)
        }
        Err(NetErr) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sender_logo_parse_dmarc() {
        let d = parse_dmarc(" V=DMARC1 ; P=Reject; pct=100; rua=mailto:x@y.z").unwrap();
        assert_eq!(d.p, "reject");
        assert_eq!(d.pct, Some(100));
        assert_eq!(d.sp, None);
        assert!(parse_dmarc("v=spf1 -all").is_none());
        assert!(parse_dmarc("v=DMARC1; rua=mailto:a@b.c").is_none());
        assert_eq!(
            parse_dmarc("v=DMARC1;p=quarantine;sp=none")
                .unwrap()
                .sp
                .as_deref(),
            Some("none")
        );
    }

    #[test]
    fn sender_logo_enforcing() {
        let p = |s: &str| parse_dmarc(s).unwrap();
        assert!(enforcing(&p("v=DMARC1; p=reject"), false));
        assert!(enforcing(&p("v=DMARC1; p=quarantine; pct=100"), false));
        assert!(!enforcing(&p("v=DMARC1; p=none"), false));
        assert!(!enforcing(&p("v=DMARC1; p=reject; pct=50"), false));
        assert!(!enforcing(&p("v=DMARC1; p=reject; sp=none"), true));
        assert!(enforcing(&p("v=DMARC1; p=reject; sp=none"), false));
        assert!(enforcing(&p("v=DMARC1; p=none; sp=reject"), true));
        assert!(enforcing(&p("v=DMARC1; p=reject"), true));
    }

    #[test]
    fn sender_logo_domain_candidates() {
        assert_eq!(
            domain_candidates("a.b.ramp.com"),
            vec!["a.b.ramp.com", "b.ramp.com", "ramp.com"]
        );
        assert_eq!(domain_candidates("ramp.com"), vec!["ramp.com"]);
        assert_eq!(domain_candidates("Ramp.COM."), vec!["ramp.com"]);
        assert!(domain_candidates("localhost").is_empty());
        assert!(domain_candidates("").is_empty());
        assert!(domain_candidates("10.0.0.1").is_empty());
        assert!(domain_candidates("[10.0.0.1]").is_empty());
    }

    #[test]
    fn sender_logo_parse_bimi() {
        assert_eq!(
            parse_bimi("v=BIMI1; l=https://x.com/logo.svg; a=https://x.com/vmc.pem").as_deref(),
            Some("https://x.com/logo.svg")
        );
        assert_eq!(parse_bimi("v=BIMI1; l=;"), None);
        assert_eq!(parse_bimi("v=BIMI1; l=http://x.com/logo.svg"), None);
        assert_eq!(parse_bimi("v=DMARC1; l=https://x.com/a.svg"), None);
    }

    #[test]
    fn sender_logo_icon_links() {
        let base = Url::parse("https://ramp.com/").unwrap();
        let html = r#"<html><head>
            <link rel="icon" href="/favicon-32.png">
            <link rel="icon" type="image/svg+xml" href="//cdn.ramp.com/i.svg">
            <link rel="stylesheet" href="/a.css">
            <LINK REL='apple-touch-icon' HREF='touch.png'>
            <link rel="icon" href="http://insecure.example/x.png">
            </head></html>"#;
        let got: Vec<String> = icon_links(html, &base).iter().map(Url::to_string).collect();
        assert_eq!(
            got,
            vec![
                "https://ramp.com/touch.png",
                "https://cdn.ramp.com/i.svg",
                "https://ramp.com/favicon-32.png"
            ]
        );
        assert!(icon_links("<p>nothing</p>", &base).is_empty());
        let shortcut = icon_links(r#"<link rel="shortcut icon" href="/f.ico">"#, &base);
        assert_eq!(shortcut.len(), 1);
    }

    #[test]
    fn sender_logo_sniff_image() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a"), Some("image/gif"));
        assert_eq!(
            sniff_image(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(sniff_image(&[0, 0, 1, 0, 1, 0]), Some("image/x-icon"));
        assert_eq!(
            sniff_image(b"\xEF\xBB\xBF<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            Some("image/svg+xml")
        );
        assert_eq!(
            sniff_image(b"  <svg viewBox='0 0 1 1'/>"),
            Some("image/svg+xml")
        );
        assert_eq!(
            sniff_image(b"<!doctype html><html><body><svg></svg></body></html>"),
            None
        );
        assert_eq!(sniff_image(b"hello"), None);
        assert_eq!(sniff_image(b""), None);
    }

    #[test]
    fn sender_logo_is_public_ip() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for bad in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "192.0.2.1",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(ip(bad)), "{bad} should not be public");
        }
        for good in [
            "93.184.216.34",
            "8.8.8.8",
            "2606:4700::1111",
            "::ffff:93.184.216.34",
        ] {
            assert!(is_public_ip(ip(good)), "{good} should be public");
        }
    }

    /// IPv6 forms that embed an IPv4 address are judged by that address; 192.0.0.0/24 is never public.
    #[test]
    fn sender_logo_is_public_ip_embedded_v4() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for bad in [
            "192.0.0.1",
            "192.0.0.255",
            // NAT64
            "64:ff9b::7f00:1",
            "64:ff9b::10.0.0.1",
            "64:ff9b::192.168.1.1",
            "64:ff9b::a9fe:a9fe",
            // 6to4: 2002:AABB:CCDD:: embeds AA.BB.CC.DD
            "2002:7f00:1::",
            "2002:a00:1::1",
            "2002:c0a8:101::",
            "2002:a9fe:a9fe::",
            // IPv4-compatible
            "::127.0.0.1",
            "::10.0.0.1",
            "::192.168.0.1",
            "::0.0.0.1",
        ] {
            assert!(!is_public_ip(ip(bad)), "{bad} should not be public");
        }
        for good in [
            "192.0.1.1",
            "64:ff9b::808:808",
            "64:ff9b::93.184.216.34",
            "2002:808:808::1",
            "::8.8.8.8",
        ] {
            assert!(is_public_ip(ip(good)), "{good} should be public");
        }
    }

    #[test]
    fn sender_logo_cache_freshness() {
        let t = now();
        assert_eq!(
            cached(&format!(r#"{{"logo":"data:x","at":{}}}"#, t - 29 * DAY)),
            Some(Some("data:x".into()))
        );
        assert_eq!(
            cached(&format!(r#"{{"logo":"data:x","at":{}}}"#, t - 31 * DAY)),
            None
        );
        assert_eq!(
            cached(&format!(r#"{{"logo":null,"at":{}}}"#, t - 6 * DAY)),
            Some(None)
        );
        assert_eq!(
            cached(&format!(r#"{{"logo":null,"at":{}}}"#, t - 8 * DAY)),
            None
        );
        assert_eq!(cached("garbage"), None);
    }
}
