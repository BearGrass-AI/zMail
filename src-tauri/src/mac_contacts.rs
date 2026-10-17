//! Photos from the Mac Contacts app. Opt-in: nothing here touches the Contacts framework
//! until the user turns the setting on (the request command is what shows the macOS prompt).

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAX_PHOTO_BYTES: usize = 512 * 1024;

/// Maps a raw `CNAuthorizationStatus` value to the name the front end uses.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn status_name(raw: isize) -> &'static str {
    match raw {
        0 => "notDetermined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        4 => "limited",
        _ => "denied",
    }
}

/// Image type from magic bytes. Contacts thumbnails are usually JPEG or PNG; HEIC and TIFF are
/// accepted too.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sniff_contact_image(bytes: &[u8]) -> Option<&'static str> {
    if let Some(m) = crate::sender_logo::sniff_image(bytes) {
        return match m {
            "image/png" | "image/jpeg" | "image/gif" | "image/webp" => Some(m),
            _ => None,
        };
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if matches!(brand, b"heic" | b"heix" | b"hevc" | b"mif1" | b"msf1") {
            return Some("image/heic");
        }
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some("image/tiff");
    }
    None
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use base64::Engine;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2_contacts::{
        CNContact, CNContactStore, CNContactThumbnailImageDataKey, CNEntityType, CNKeyDescriptor,
    };
    use objc2_foundation::{NSArray, NSBundle, NSCopying, NSError, NSString, ns_string};
    use std::sync::{Mutex, mpsc};
    use std::time::Duration;

    /// macOS kills an app that touches Contacts without a usage description in Info.plist.
    fn usage_described() -> bool {
        NSBundle::mainBundle()
            .objectForInfoDictionaryKey(ns_string!("NSContactsUsageDescription"))
            .is_some()
    }

    fn raw_status() -> isize {
        // SAFETY: a class method with no preconditions; callers checked the usage description.
        unsafe { CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts) }.0
    }

    pub fn status() -> String {
        if !usage_described() {
            return "unavailable".into();
        }
        status_name(raw_status()).into()
    }

    pub async fn request() -> Result<bool, String> {
        if !usage_described() {
            return Err("unavailable".into());
        }
        let name = status_name(raw_status());
        if name != "notDetermined" {
            return Ok(name == "authorized" || name == "limited");
        }
        tauri::async_runtime::spawn_blocking(|| {
            let (tx, rx) = mpsc::channel::<bool>();
            let tx = Mutex::new(Some(tx));
            let block = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
                if let Some(tx) = tx.lock().ok().and_then(|mut g| g.take()) {
                    let _ = tx.send(granted.as_bool());
                }
            });
            // SAFETY: `request` checked the usage description first (macOS kills the app
            // without one).
            let store = unsafe { CNContactStore::new() };
            // SAFETY: the block matches the completion handler's signature and outlives the call.
            unsafe {
                store.requestAccessForEntityType_completionHandler(CNEntityType::Contacts, &block)
            };
            Ok(rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn photo(address: String) -> Result<Option<String>, String> {
        if !usage_described() {
            return Err("unavailable".into());
        }
        let name = status_name(raw_status());
        if name != "authorized" && name != "limited" {
            return Ok(None);
        }
        tauri::async_runtime::spawn_blocking(move || Ok(lookup(&address)))
            .await
            .map_err(|e| e.to_string())?
    }

    /// `photo` only calls this with Contacts access granted and the usage description present.
    fn lookup(address: &str) -> Option<String> {
        // SAFETY: access and the usage description were checked by `photo`.
        let store = unsafe { CNContactStore::new() };
        // SAFETY: a class method taking any string.
        let pred = unsafe {
            CNContact::predicateForContactsMatchingEmailAddress(&NSString::from_str(address))
        };
        // SAFETY: reading an immutable framework constant.
        let key: Retained<NSString> = unsafe { CNContactThumbnailImageDataKey }.copy();
        let key: Retained<ProtocolObject<dyn CNKeyDescriptor>> = ProtocolObject::from_retained(key);
        let keys = NSArray::from_retained_slice(&[key]);
        let contacts =
            // SAFETY: a live predicate and an array of key descriptors, as the method expects.
            unsafe { store.unifiedContactsMatchingPredicate_keysToFetch_error(&pred, &keys) }
                .ok()?;
        for c in contacts.iter() {
            // SAFETY: the thumbnail key was fetched above, so reading it can't raise.
            let Some(data) = (unsafe { c.thumbnailImageData() }) else {
                continue;
            };
            let bytes = data.to_vec();
            if bytes.is_empty() || bytes.len() > MAX_PHOTO_BYTES {
                continue;
            }
            let Some(mime) = sniff_contact_image(&bytes) else {
                continue;
            };
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            return Some(format!("data:{mime};base64,{b64}"));
        }
        None
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn status() -> String {
        "unavailable".into()
    }
    pub async fn request() -> Result<bool, String> {
        Err("unavailable".into())
    }
    pub async fn photo(_address: String) -> Result<Option<String>, String> {
        Ok(None)
    }
}

/// "authorized" | "limited" | "denied" | "restricted" | "notDetermined" | "unavailable"
#[tauri::command]
pub fn mac_contacts_status() -> String {
    imp::status()
}

/// Asks macOS for access (shows the system prompt once). Returns whether access was granted.
#[tauri::command]
pub async fn mac_contacts_request() -> Result<bool, String> {
    imp::request().await
}

/// The thumbnail photo of the first contact with this email address, as a data: URL.
#[tauri::command]
pub async fn mac_contact_photo(address: String) -> Result<Option<String>, String> {
    imp::photo(address).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_contacts_status_names() {
        assert_eq!(status_name(0), "notDetermined");
        assert_eq!(status_name(1), "restricted");
        assert_eq!(status_name(2), "denied");
        assert_eq!(status_name(3), "authorized");
        assert_eq!(status_name(4), "limited");
        assert_eq!(status_name(9), "denied");
        assert_eq!(status_name(-1), "denied");
    }

    #[test]
    fn mac_contacts_sniff_image() {
        assert_eq!(
            sniff_contact_image(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_contact_image(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(
            sniff_contact_image(b"\0\0\0\x18ftypheic\0\0\0\0"),
            Some("image/heic")
        );
        assert_eq!(sniff_contact_image(b"II*\0\x08\0\0\0"), Some("image/tiff"));
        assert_eq!(sniff_contact_image(&[0, 0, 1, 0, 1, 0]), None);
        assert_eq!(sniff_contact_image(b"<html>"), None);
    }
}
