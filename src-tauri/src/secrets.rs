//! API keys and OAuth tokens live in the macOS Keychain, never in the webview's
//! localStorage. Each secret is a generic password under the service
//! "com.zach.zmail" with the given name as the account.

const SERVICE: &str = "com.zach.zmail";

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

pub fn get(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(name: &str, value: &str) -> Result<(), String> {
    entry(name)?.set_password(value).map_err(|e| e.to_string())
}

pub fn delete(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The only names the webview may touch: provider API keys (`apikey.<slot>`,
/// `apikey.provider.<id>`) and OAuth app client secrets. OAuth tokens and anything
/// else stay Rust-only, so a script that slipped into the webview can't read them.
fn webview_may_use(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix("apikey.") {
        return !rest.is_empty()
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    }
    matches!(name, "oauthapp.google.secret" | "oauthapp.microsoft.secret")
}

fn check(name: &str) -> Result<(), String> {
    if webview_may_use(name) {
        Ok(())
    } else {
        Err("not allowed".into())
    }
}

#[tauri::command(async)]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    check(&name)?;
    get(&name)
}

#[tauri::command(async)]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    check(&name)?;
    if value.is_empty() {
        delete(&name)
    } else {
        set(&name, &value)
    }
}

#[tauri::command(async)]
pub fn secret_delete(name: String) -> Result<(), String> {
    check(&name)?;
    delete(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_webview_names() {
        for ok in [
            "apikey.provider.abc-123",
            "apikey.anthropic",
            "apikey.provider.a_b.c",
            "oauthapp.google.secret",
            "oauthapp.microsoft.secret",
        ] {
            assert!(webview_may_use(ok), "{ok} should be allowed");
        }
        for bad in [
            "oauth.me@x.com.refresh",
            "oauth.google.refresh",
            "apikey.",
            "apikey",
            "apikey.a/b",
            "apikey.a b",
            "apikey.\u{e9}",
            "xapikey.a",
            "oauthapp.google",
            "oauthapp.other.secret",
            "oauthapp.google.secret.x",
            "",
        ] {
            assert!(!webview_may_use(bad), "{bad} should be refused");
        }
    }

    /// Refused names fail before reaching the Keychain.
    #[test]
    fn secrets_commands_refuse_other_names() {
        let name = || "oauth.a@b.c.refresh".to_string();
        assert_eq!(secret_get(name()), Err("not allowed".into()));
        assert_eq!(secret_set(name(), "x".into()), Err("not allowed".into()));
        assert_eq!(secret_set(name(), "".into()), Err("not allowed".into()));
        assert_eq!(secret_delete(name()), Err("not allowed".into()));
    }

    /// Round-trips a throwaway secret through the real Keychain.
    /// Run with: cargo test -- --ignored
    #[test]
    #[ignore = "writes to the real Keychain"]
    fn keychain_round_trip() {
        let name = "test.zmail.roundtrip";
        super::set(name, "s3cret").unwrap();
        assert_eq!(super::get(name).unwrap().as_deref(), Some("s3cret"));
        super::delete(name).unwrap();
        assert_eq!(super::get(name).unwrap(), None);
    }
}
