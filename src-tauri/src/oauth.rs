//! Desktop OAuth 2.0 (authorization code + PKCE, loopback redirect) for Google
//! and Microsoft. Refresh tokens and client config live in the Keychain;
//! access tokens are cached in memory and refreshed on demand.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngExt, distr::Alphanumeric};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv6Addr, SocketAddr, TcpListener};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::secrets;

#[derive(Clone, Copy, serde::Deserialize, serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Microsoft,
}

impl Provider {
    fn auth_url(self, tenant: &str) -> String {
        match self {
            Provider::Google => "https://accounts.google.com/o/oauth2/v2/auth".into(),
            Provider::Microsoft => {
                format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize")
            }
        }
    }
    fn token_url(self, tenant: &str) -> String {
        match self {
            Provider::Google => "https://oauth2.googleapis.com/token".into(),
            Provider::Microsoft => {
                format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token")
            }
        }
    }
}

/// Everything needed to refresh tokens later; stored (as JSON) in the Keychain.
#[derive(Clone, serde::Deserialize, serde::Serialize, Debug)]
pub struct ClientConfig {
    pub provider: Provider,
    pub client_id: String,
    /// Google "Desktop app" clients have a (non-confidential) secret; Microsoft public clients don't.
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
    /// Microsoft tenant: "common", "organizations", or a tenant id. Ignored for Google.
    #[serde(default = "default_tenant")]
    pub tenant: String,
}

fn default_tenant() -> String {
    "common".into()
}

#[derive(Clone, serde::Serialize, Debug)]
pub struct AccessToken {
    pub access_token: String,
    /// Unix seconds.
    pub expires_at: u64,
}

#[derive(serde::Deserialize, Debug)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

#[derive(Default)]
pub struct TokenCache {
    tokens: Mutex<HashMap<String, AccessToken>>,
    /// One refresh per account at a time: callers that arrive while it runs wait for it and
    /// reuse its token instead of each asking the provider for another.
    refreshing: Mutex<HashMap<String, Arc<tauri::async_runtime::Mutex<()>>>>,
    /// Bumped when an account signs out or gets a new sign-in, so a refresh that was already
    /// under way can tell its rotated token belongs to a sign-in that's gone.
    generations: Mutex<HashMap<String, u64>>,
}

impl TokenCache {
    /// The cached access token for `account`, if it hasn't expired.
    fn fresh(&self, account: &str) -> Option<AccessToken> {
        let tokens = self.tokens.lock().ok()?;
        tokens
            .get(account)
            .filter(|t| t.expires_at > now())
            .cloned()
    }

    fn refresh_gate(&self, account: &str) -> Arc<tauri::async_runtime::Mutex<()>> {
        match self.refreshing.lock() {
            Ok(mut gates) => gates.entry(account.to_string()).or_default().clone(),
            // A poisoned map can't hand out a shared gate; refreshing without one is still correct.
            Err(_) => Arc::default(),
        }
    }

    fn generation(&self, account: &str) -> u64 {
        self.generations
            .lock()
            .map_or(0, |g| g.get(account).copied().unwrap_or(0))
    }

    /// Drop `account`'s cached token and outdate any refresh of its old sign-in.
    fn forget(&self, account: &str) {
        if let Ok(mut c) = self.tokens.lock() {
            c.remove(account);
        }
        if let Ok(mut g) = self.generations.lock() {
            *g.entry(account.to_string()).or_default() += 1;
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn random(n: usize) -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(n)
        .map(char::from)
        .collect()
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn config_key(account: &str) -> String {
    format!("oauth.{account}.config")
}
fn refresh_key(account: &str) -> String {
    format!("oauth.{account}.refresh")
}

/// `login_hint` (an address) points the provider's account picker at the mailbox being reconnected.
pub fn build_auth_url(
    cfg: &ClientConfig,
    redirect: &str,
    challenge: &str,
    state: &str,
    login_hint: Option<&str>,
) -> String {
    let mut url = url::Url::parse(&cfg.provider.auth_url(&cfg.tenant)).expect("static url");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", &cfg.client_id)
            .append_pair("redirect_uri", redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", &cfg.scopes.join(" "))
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state);
        if let Some(hint) = login_hint {
            q.append_pair("login_hint", hint);
        }
        match cfg.provider {
            // offline + consent so Google always returns a refresh token.
            Provider::Google => {
                q.append_pair("access_type", "offline")
                    .append_pair("prompt", "consent");
            }
            Provider::Microsoft => {
                q.append_pair("response_mode", "query")
                    .append_pair("prompt", "select_account");
            }
        }
    }
    url.to_string()
}

/// Parse `GET /?code=...&state=... HTTP/1.1` from the loopback request line.
pub fn parse_callback(request_line: &str) -> Result<(String, String), String> {
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or("malformed callback request")?;
    let url = url::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|e| e.to_string())?;
    let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
    if let Some(err) = q.get("error") {
        let desc = q.get("error_description").cloned().unwrap_or_default();
        return Err(format!("sign-in was declined: {err} {desc}")
            .trim()
            .to_string());
    }
    let code = q
        .get("code")
        .cloned()
        .ok_or("no authorization code in callback")?;
    let state = q.get("state").cloned().ok_or("no state in callback")?;
    Ok((code, state))
}

/// How long a browser sign-in may take before zMail gives up (the user can start again).
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(120);

/// How long one loopback connection may take to send its request line.
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(2);

/// Bumped by `oauth_cancel_sign_in`; a waiting sign-in stops when it changes.
static SIGN_IN_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Loopback listeners on one port: 127.0.0.1, plus ::1 when available, because browsers
/// may resolve "localhost" (Microsoft's redirect) to either.
fn loopback_listeners() -> Result<(Vec<TcpListener>, u16), String> {
    let v4 = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = v4.local_addr().map_err(|e| e.to_string())?.port();
    let mut out = vec![v4];
    if let Ok(v6) = TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, port))) {
        out.push(v6);
    }
    Ok((out, port))
}

/// Wait for the browser to hit the loopback redirect; reply with a small page.
fn wait_for_callback(
    listeners: Vec<TcpListener>,
    timeout: Duration,
    generation: u64,
) -> Result<(String, String), String> {
    // Poll so an abandoned or cancelled sign-in ends instead of blocking forever.
    for l in &listeners {
        l.set_nonblocking(true).map_err(|e| e.to_string())?;
    }
    let deadline = Instant::now() + timeout;
    loop {
        if SIGN_IN_GENERATION.load(Ordering::SeqCst) != generation {
            return Err("sign-in cancelled".into());
        }
        if Instant::now() > deadline {
            return Err(format!(
                "timed out waiting for sign-in ({} minutes); try again",
                timeout.as_secs() / 60
            ));
        }
        let mut accepted = None;
        for l in &listeners {
            match l.accept() {
                Ok((stream, _)) => {
                    accepted = Some(stream);
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        let Some(mut stream) = accepted else {
            std::thread::sleep(Duration::from_millis(150));
            continue;
        };
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(CALLBACK_READ_TIMEOUT))
            .map_err(|e| e.to_string())?;
        let mut line = String::new();
        // Browsers open spare connections they may never send on; drop one that stays quiet
        // and keep waiting for the real redirect.
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            continue;
        }
        // Browsers also request /favicon.ico; ignore anything without a query.
        if !line.contains('?') {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        }
        let result = parse_callback(&line);
        let body = match &result {
            Ok(_) => {
                "<h2 style='font-family:-apple-system'>You're signed in to zMail.</h2><p style='font-family:-apple-system'>You can close this tab.</p>"
            }
            Err(_) => {
                "<h2 style='font-family:-apple-system'>Sign-in didn't complete.</h2><p style='font-family:-apple-system'>Return to zMail and try again.</p>"
            }
        };
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        return result;
    }
}

/// Stop a sign-in that is waiting for the browser.
#[tauri::command]
pub fn oauth_cancel_sign_in() {
    SIGN_IN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

async fn token_request(
    cfg: &ClientConfig,
    form: Vec<(&str, String)>,
) -> Result<TokenResponse, String> {
    let mut form = form;
    form.push(("client_id", cfg.client_id.clone()));
    if let Some(secret) = &cfg.client_secret {
        form.push(("client_secret", secret.clone()));
    }
    let res = crate::http::default_client()?
        .post(cfg.provider.token_url(&cfg.tenant))
        .timeout(Duration::from_secs(30))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "token endpoint returned {status}: {}",
            text.chars().take(400).collect::<String>()
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("unexpected token response: {e}"))
}

fn remember(cache: &TokenCache, account: &str, t: &TokenResponse) -> AccessToken {
    let token = AccessToken {
        access_token: t.access_token.clone(),
        // Refresh a minute early.
        expires_at: now() + t.expires_in.unwrap_or(3600).saturating_sub(60),
    };
    if let Ok(mut c) = cache.tokens.lock() {
        c.insert(account.to_string(), token.clone());
    }
    token
}

/// Interactive sign-in. Opens the system browser and stores the refresh token
/// under `account` (an id chosen by the app).
#[tauri::command]
pub async fn oauth_sign_in(
    app: AppHandle,
    cache: State<'_, TokenCache>,
    account: String,
    config: ClientConfig,
    login_hint: Option<String>,
) -> Result<AccessToken, String> {
    // A new sign-in replaces any still waiting.
    let generation = SIGN_IN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (listeners, port) = loopback_listeners()?;
    // Google wants 127.0.0.1; Microsoft's public-client loopback rule expects localhost.
    let redirect = match config.provider {
        Provider::Google => format!("http://127.0.0.1:{port}"),
        Provider::Microsoft => format!("http://localhost:{port}"),
    };
    let verifier = random(64);
    let state = random(24);
    let auth_url = build_auth_url(
        &config,
        &redirect,
        &pkce_challenge(&verifier),
        &state,
        login_hint.as_deref(),
    );

    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| e.to_string())?;

    let (code, got_state) = tauri::async_runtime::spawn_blocking(move || {
        wait_for_callback(listeners, SIGN_IN_TIMEOUT, generation)
    })
    .await
    .map_err(|e| e.to_string())??;
    if got_state != state {
        return Err("sign-in state mismatch; please try again".into());
    }

    let tokens = token_request(
        &config,
        vec![
            ("grant_type", "authorization_code".into()),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect),
        ],
    )
    .await?;

    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or("the provider did not return a refresh token")?;
    cache.forget(&account);
    secrets::set(&refresh_key(&account), &refresh)?;
    secrets::set(
        &config_key(&account),
        &serde_json::to_string(&config).map_err(|e| e.to_string())?,
    )?;
    Ok(remember(&cache, &account, &tokens))
}

/// A valid access token for `account`, refreshing if needed.
#[tauri::command]
pub async fn oauth_access_token(
    cache: State<'_, TokenCache>,
    account: String,
) -> Result<AccessToken, String> {
    if let Some(t) = cache.fresh(&account) {
        return Ok(t);
    }
    let gate = cache.refresh_gate(&account);
    let _turn = gate.lock().await;
    // Another call may have refreshed while this one waited.
    if let Some(t) = cache.fresh(&account) {
        return Ok(t);
    }
    let generation = cache.generation(&account);
    let config: ClientConfig = serde_json::from_str(
        &secrets::get(&config_key(&account))?.ok_or("account is not signed in")?,
    )
    .map_err(|e| e.to_string())?;
    let refresh = secrets::get(&refresh_key(&account))?.ok_or("account is not signed in")?;
    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh),
    ];
    if config.provider == Provider::Microsoft {
        form.push(("scope", config.scopes.join(" ")));
    }
    let tokens = token_request(&config, form).await?;
    // Signed out (or signed in afresh) while the request was out: don't bring the old sign-in back.
    if cache.generation(&account) != generation {
        return Err("account is not signed in".into());
    }
    // Microsoft rotates refresh tokens; keep the newest.
    if let Some(r) = &tokens.refresh_token {
        secrets::set(&refresh_key(&account), r)?;
    }
    Ok(remember(&cache, &account, &tokens))
}

#[tauri::command]
pub async fn oauth_sign_out(cache: State<'_, TokenCache>, account: String) -> Result<(), String> {
    sign_out(&cache, &Keychain, &account).await
}

/// Waits for a refresh under way to finish first, so it can't write its rotated token back afterwards.
async fn sign_out(
    cache: &TokenCache,
    store: &(impl CredentialStore + Sync),
    account: &str,
) -> Result<(), String> {
    let gate = cache.refresh_gate(account);
    let _turn = gate.lock().await;
    cache.forget(account);
    store.delete(&refresh_key(account))?;
    store.delete(&config_key(account))
}

/// Where sign-ins are kept: the Keychain, or a map in tests.
trait CredentialStore {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

struct Keychain;

impl CredentialStore for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        secrets::get(name)
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        secrets::set(name, value)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        secrets::delete(name)
    }
}

/// Give `to` the sign-in stored under `from` (replacing its own) and sign `from` out.
fn move_credentials(store: &impl CredentialStore, from: &str, to: &str) -> Result<(), String> {
    let refresh = store
        .get(&refresh_key(from))?
        .ok_or("account is not signed in")?;
    let config = store
        .get(&config_key(from))?
        .ok_or("account is not signed in")?;
    store.set(&refresh_key(to), &refresh)?;
    store.set(&config_key(to), &config)?;
    store.delete(&refresh_key(from))?;
    store.delete(&config_key(from))
}

/// Reconnect: after the app has checked who signed in under the temporary id `from`,
/// make that sign-in the account `to`'s.
#[tauri::command]
pub async fn oauth_move_account(
    cache: State<'_, TokenCache>,
    from: String,
    to: String,
) -> Result<(), String> {
    // Wait out a refresh of `to`'s old sign-in so its rotated token can't land over the new one.
    let gate = cache.refresh_gate(&to);
    let _turn = gate.lock().await;
    move_credentials(&Keychain, &from, &to)?;
    let token = cache.tokens.lock().ok().and_then(|mut c| c.remove(&from));
    cache.forget(&from);
    cache.forget(&to);
    if let (Some(t), Ok(mut c)) = (token, cache.tokens.lock()) {
        c.insert(to, t);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;
    use std::sync::PoisonError;

    // These tests share SIGN_IN_GENERATION; run them one at a time.
    static SIGN_IN_TESTS: Mutex<()> = Mutex::new(());

    #[test]
    fn random_is_alphanumeric_of_the_given_length() {
        let a = random(64);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(a, random(64));
    }

    fn callback_via(addr: SocketAddr) -> Result<(String, String), String> {
        let _turn = SIGN_IN_TESTS.lock().unwrap_or_else(PoisonError::into_inner);
        let (listeners, port) = loopback_listeners().unwrap();
        let generation = SIGN_IN_GENERATION.load(Ordering::SeqCst);
        let target = SocketAddr::new(addr.ip(), port);
        let client = std::thread::spawn(move || {
            let mut s = TcpStream::connect(target).unwrap();
            s.write_all(b"GET /?code=abc&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
        });
        let r = wait_for_callback(listeners, Duration::from_secs(5), generation);
        client.join().unwrap();
        r
    }

    #[test]
    fn oauth_callback_reaches_ipv4_loopback() {
        assert_eq!(
            callback_via("127.0.0.1:0".parse().unwrap()).unwrap(),
            ("abc".into(), "xyz".into())
        );
    }

    #[test]
    fn oauth_callback_reaches_ipv6_loopback_when_available() {
        if TcpListener::bind("[::1]:0").is_err() {
            return; // no IPv6 loopback on this machine
        }
        assert_eq!(
            callback_via("[::1]:0".parse().unwrap()).unwrap(),
            ("abc".into(), "xyz".into())
        );
    }

    #[test]
    fn oauth_cancel_stops_a_waiting_sign_in() {
        let _turn = SIGN_IN_TESTS.lock().unwrap_or_else(PoisonError::into_inner);
        let (listeners, _) = loopback_listeners().unwrap();
        let generation = SIGN_IN_GENERATION.load(Ordering::SeqCst);
        let waiter = std::thread::spawn(move || {
            wait_for_callback(listeners, Duration::from_secs(10), generation)
        });
        std::thread::sleep(Duration::from_millis(300));
        oauth_cancel_sign_in();
        assert_eq!(waiter.join().unwrap().unwrap_err(), "sign-in cancelled");
    }

    #[test]
    fn oauth_callback_survives_a_quiet_spare_connection() {
        let _turn = SIGN_IN_TESTS.lock().unwrap_or_else(PoisonError::into_inner);
        let (listeners, port) = loopback_listeners().unwrap();
        let generation = SIGN_IN_GENERATION.load(Ordering::SeqCst);
        let client = std::thread::spawn(move || {
            // A browser's spare connection: opened, never written to, held open.
            let spare = TcpStream::connect(("127.0.0.1", port)).unwrap();
            std::thread::sleep(Duration::from_millis(100));
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET /?code=abc&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            std::thread::sleep(CALLBACK_READ_TIMEOUT + Duration::from_secs(1));
            drop(spare);
        });
        let r = wait_for_callback(listeners, Duration::from_secs(10), generation);
        client.join().unwrap();
        assert_eq!(r, Ok(("abc".into(), "xyz".into())));
    }

    #[test]
    fn token_cache_shares_one_refresh_gate_per_account() {
        let cache = TokenCache::default();
        assert!(Arc::ptr_eq(
            &cache.refresh_gate("a"),
            &cache.refresh_gate("a")
        ));
        assert!(!Arc::ptr_eq(
            &cache.refresh_gate("a"),
            &cache.refresh_gate("b")
        ));
    }

    #[test]
    fn token_cache_fresh_skips_expired_tokens() {
        let cache = TokenCache::default();
        let token = |expires_at| AccessToken {
            access_token: "t".into(),
            expires_at,
        };
        cache
            .tokens
            .lock()
            .unwrap()
            .insert("old".into(), token(now() - 1));
        cache
            .tokens
            .lock()
            .unwrap()
            .insert("new".into(), token(now() + 600));
        assert!(cache.fresh("old").is_none());
        assert!(cache.fresh("new").is_some());
        assert!(cache.fresh("missing").is_none());
    }

    fn cfg(provider: Provider) -> ClientConfig {
        ClientConfig {
            provider,
            client_id: "cid".into(),
            client_secret: None,
            scopes: vec!["openid".into(), "email".into()],
            tenant: "common".into(),
        }
    }

    #[test]
    fn pkce_matches_rfc7636_example() {
        // RFC 7636, Appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn auth_url_has_pkce_and_provider_params() {
        let g = build_auth_url(
            &cfg(Provider::Google),
            "http://127.0.0.1:5000",
            "chal",
            "st",
            None,
        );
        assert!(g.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(g.contains("code_challenge=chal") && g.contains("code_challenge_method=S256"));
        assert!(g.contains("access_type=offline") && g.contains("scope=openid+email"));
        assert!(!g.contains("login_hint"));
        let m = build_auth_url(
            &cfg(Provider::Microsoft),
            "http://localhost:5000",
            "chal",
            "st",
            Some("someone@example.edu"),
        );
        assert!(m.starts_with("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"));
        assert!(m.contains("response_mode=query"));
        assert!(m.contains("login_hint=someone%40example.edu"));
    }

    #[derive(Default)]
    struct MapStore(Mutex<HashMap<String, String>>);

    impl CredentialStore for MapStore {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }

    #[test]
    fn sign_out_waits_for_a_refresh_under_way_and_outdates_it() {
        tauri::async_runtime::block_on(async {
            let cache = Arc::new(TokenCache::default());
            let store = Arc::new(MapStore::default());
            store.set(&refresh_key("a"), "old").unwrap();
            store.set(&config_key("a"), "cfg").unwrap();
            // A refresh holds the gate while its request is out.
            let gate = cache.refresh_gate("a");
            let refreshing = gate.lock().await;
            let generation = cache.generation("a");
            let out = tauri::async_runtime::spawn({
                let (cache, store) = (cache.clone(), store.clone());
                async move { sign_out(&cache, &*store, "a").await }
            });
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100)))
                .await
                .unwrap();
            assert_eq!(
                store.get(&refresh_key("a")).unwrap().as_deref(),
                Some("old")
            );
            // The refresh writes its rotated token, then lets go.
            store.set(&refresh_key("a"), "rotated").unwrap();
            drop(refreshing);
            out.await.unwrap().unwrap();
            assert!(store.0.lock().unwrap().is_empty());
            // A refresh that read the old generation now knows not to write.
            assert_ne!(cache.generation("a"), generation);
        });
    }

    #[test]
    fn move_credentials_replaces_the_account_and_signs_out_the_temporary_id() {
        let store = MapStore::default();
        for (name, value) in [
            ("oauth.gmail-old.refresh", "stale"),
            ("oauth.gmail-old.config", "old-cfg"),
            ("oauth.tmp.refresh", "fresh"),
            ("oauth.tmp.config", "new-cfg"),
        ] {
            store.set(name, value).unwrap();
        }
        move_credentials(&store, "tmp", "gmail-old").unwrap();
        let mut got: Vec<_> = store.0.lock().unwrap().clone().into_iter().collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("oauth.gmail-old.config".to_string(), "new-cfg".to_string()),
                ("oauth.gmail-old.refresh".to_string(), "fresh".to_string()),
            ]
        );
        // Nothing to move: the account keeps what it had.
        assert!(move_credentials(&store, "tmp", "gmail-old").is_err());
        assert_eq!(
            store.get("oauth.gmail-old.refresh").unwrap().as_deref(),
            Some("fresh")
        );
    }

    #[test]
    fn parses_callback_success_and_error() {
        assert_eq!(
            parse_callback("GET /?code=abc&state=xyz HTTP/1.1").unwrap(),
            ("abc".to_string(), "xyz".to_string())
        );
        let err = parse_callback("GET /?error=access_denied&error_description=nope HTTP/1.1")
            .unwrap_err();
        assert!(err.contains("access_denied"));
    }
}
