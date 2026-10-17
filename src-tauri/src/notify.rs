//! Native macOS notifications (UserNotifications) for new mail that needs you. The Tauri
//! notification plugin can't report which banner was clicked on desktop, so this talks to
//! `UNUserNotificationCenter` directly and installs a delegate that opens the clicked email.
//! The front end decides what to notify about; this only shows, removes and reports clicks.

use std::sync::Mutex;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const TITLE_MAX: usize = 120;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SUBTITLE_MAX: usize = 160;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const BODY_MAX: usize = 300;

/// One banner, as the front end plans it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Note {
    /// Notification identifier: the email id, or "summary-<ms>".
    id: String,
    title: String,
    subtitle: Option<String>,
    body: Option<String>,
    /// threadIdentifier: the account id, so macOS groups banners per account.
    thread: Option<String>,
    sound: bool,
    email_id: Option<String>,
    account_id: Option<String>,
}

/// Maps a raw `UNAuthorizationStatus` to the name the front end uses. Ephemeral (4) and any
/// later value count as authorized.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn status_name(raw: isize) -> &'static str {
    match raw {
        0 => "notDetermined",
        1 => "denied",
        2 => "authorized",
        3 => "provisional",
        _ => "authorized",
    }
}

/// At most `n` characters, ending in "…" when cut.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let kept: String = s.chars().take(n.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// The last banner click, kept until the front end takes it: a click that launches zMail is
/// emitted before the front end listens, so the event alone would be lost. The front end calls
/// `notify_take_pending` once after it starts listening, and again on every live event (ignoring
/// the result) so a click it already handled isn't handled a second time.
static PENDING: Mutex<Option<serde_json::Value>> = Mutex::new(None);

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn put_pending(slot: &Mutex<Option<serde_json::Value>>, v: serde_json::Value) {
    if let Ok(mut g) = slot.lock() {
        *g = Some(v);
    }
}

fn take_pending(slot: &Mutex<Option<serde_json::Value>>) -> Option<serde_json::Value> {
    slot.lock().ok().and_then(|mut g| g.take())
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AnyThread, DefinedClass, define_class, msg_send};
    use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSString, ns_string};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
    use std::sync::{OnceLock, mpsc};
    use std::time::Duration;
    use tauri::{Emitter, Manager};

    const WAIT: Duration = Duration::from_secs(10);

    /// `currentNotificationCenter` raises an Objective-C exception (killing the process) when
    /// there's no bundle identifier, as in an unbundled binary. Every entry point checks this.
    fn bundled() -> bool {
        NSBundle::mainBundle().bundleIdentifier().is_some()
    }

    /// A one-shot sender a completion block can own (blocks must be `Fn`).
    fn once<T>(tx: mpsc::Sender<T>) -> impl Fn(T) {
        let tx = Mutex::new(Some(tx));
        move |v| {
            if let Some(tx) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = tx.send(v);
            }
        }
    }

    pub async fn status() -> String {
        if !bundled() {
            return "unavailable".into();
        }
        tauri::async_runtime::spawn_blocking(|| {
            let (tx, rx) = mpsc::channel::<isize>();
            let send = once(tx);
            let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                // SAFETY: macOS passes a valid settings object for the duration of the call.
                send(unsafe { settings.as_ref() }.authorizationStatus().0);
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .getNotificationSettingsWithCompletionHandler(&block);
            rx.recv_timeout(WAIT).map_or("unavailable", status_name)
        })
        .await
        .map_or_else(|_| "unavailable".into(), String::from)
    }

    pub async fn request() -> Result<bool, String> {
        if !bundled() {
            return Ok(false);
        }
        tauri::async_runtime::spawn_blocking(|| {
            let (tx, rx) = mpsc::channel::<bool>();
            let send = once(tx);
            let block =
                RcBlock::new(move |granted: Bool, _err: *mut NSError| send(granted.as_bool()));
            let options = UNAuthorizationOptions::Alert
                | UNAuthorizationOptions::Sound
                | UNAuthorizationOptions::Badge;
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(options, &block);
            // The user may sit on the macOS prompt for a while.
            Ok(rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn show(note: Note) -> Result<(), String> {
        if !bundled() {
            return Ok(());
        }
        tauri::async_runtime::spawn_blocking(move || {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&clip(&note.title, TITLE_MAX)));
            if let Some(s) = note.subtitle.as_deref().filter(|s| !s.is_empty()) {
                content.setSubtitle(&NSString::from_str(&clip(s, SUBTITLE_MAX)));
            }
            if let Some(s) = note.body.as_deref().filter(|s| !s.is_empty()) {
                content.setBody(&NSString::from_str(&clip(s, BODY_MAX)));
            }
            if let Some(t) = note.thread.as_deref().filter(|s| !s.is_empty()) {
                content.setThreadIdentifier(&NSString::from_str(t));
            }
            if note.sound {
                content.setSound(Some(&UNNotificationSound::defaultSound()));
            }
            let mut keys: Vec<&NSString> = Vec::new();
            let mut values: Vec<Retained<NSString>> = Vec::new();
            if let Some(id) = &note.email_id {
                keys.push(ns_string!("emailId"));
                values.push(NSString::from_str(id));
            }
            if let Some(id) = &note.account_id {
                keys.push(ns_string!("accountId"));
                values.push(NSString::from_str(id));
            }
            if !keys.is_empty() {
                let refs: Vec<&NSString> = values.iter().map(|v| &**v).collect();
                let info = NSDictionary::<NSString, NSString>::from_slices(&keys, &refs);
                // SAFETY: a dictionary of strings is a valid property list, which userInfo needs;
                // the cast only forgets the generic key/value types.
                unsafe {
                    let info: Retained<NSDictionary> = Retained::cast_unchecked(info);
                    content.setUserInfo(&info);
                }
            }
            // No trigger: deliver now.
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(&note.id),
                &content,
                None,
            );
            let (tx, rx) = mpsc::channel::<Option<String>>();
            let send = once(tx);
            let block = RcBlock::new(move |err: *mut NSError| {
                // SAFETY: a non-null error is a valid NSError for the duration of the call.
                send(unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string()));
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, Some(&block));
            match rx.recv_timeout(WAIT) {
                Ok(None) => Ok(()),
                Ok(Some(e)) => Err(e),
                Err(_) => Err("macOS didn't confirm the notification".into()),
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Identifiers of the banners still in Notification Center, from this session or earlier ones.
    pub async fn delivered() -> Vec<String> {
        if !bundled() {
            return Vec::new();
        }
        tauri::async_runtime::spawn_blocking(|| {
            let (tx, rx) = mpsc::channel::<Vec<String>>();
            let send = once(tx);
            let block = RcBlock::new(move |list: NonNull<NSArray<UNNotification>>| {
                // SAFETY: macOS passes a valid array for the duration of the call.
                let list = unsafe { list.as_ref() };
                send(
                    list.iter()
                        .map(|n| n.request().identifier().to_string())
                        .collect(),
                );
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .getDeliveredNotificationsWithCompletionHandler(&block);
            rx.recv_timeout(WAIT).unwrap_or_default()
        })
        .await
        .unwrap_or_default()
    }

    pub fn remove(ids: Vec<String>) {
        if ids.is_empty() || !bundled() {
            return;
        }
        let ids: Vec<Retained<NSString>> = ids.iter().map(|s| NSString::from_str(s)).collect();
        UNUserNotificationCenter::currentNotificationCenter()
            .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&ids));
    }

    pub struct Ivars {
        app: tauri::AppHandle,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and NotifyDelegate doesn't
        // implement Drop.
        #[unsafe(super(NSObject))]
        #[name = "ZMailNotificationDelegate"]
        #[ivars = Ivars]
        pub struct NotifyDelegate;

        // SAFETY: NSObjectProtocol has no safety requirements.
        unsafe impl NSObjectProtocol for NotifyDelegate {}

        // SAFETY: the method signatures match the protocol's.
        unsafe impl UNUserNotificationCenterDelegate for NotifyDelegate {
            /// The front end already decided this banner should show, so show it even while
            /// zMail is frontmost (the test notification relies on that).
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            /// A click: bring the window forward and tell the front end which email to open.
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let request = response.notification().request();
                let info = request.content().userInfo();
                let text = |key: &NSString| {
                    info.objectForKey(key)
                        .and_then(|v| v.downcast::<NSString>().ok())
                        .map(|s| s.to_string())
                };
                let app = &self.ivars().app;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
                let payload = serde_json::json!({
                    "emailId": text(ns_string!("emailId")),
                    "accountId": text(ns_string!("accountId")),
                    "id": request.identifier().to_string(),
                });
                // Kept as well as emitted: when this click launched zMail, nobody listens yet.
                put_pending(&PENDING, payload.clone());
                let _ = app.emit("notification-open", payload);
                handler.call(());
            }
        }
    );

    impl NotifyDelegate {
        fn new(app: tauri::AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars { app });
            // SAFETY: NSObject's init has this signature.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// `setDelegate` holds the delegate weakly, so something must keep it alive for the life
    /// of the app or clicks stop arriving. The class is Send + Sync (NSObject superclass,
    /// thread-safe ivars), so a static holds it; it also makes `install` run once.
    static DELEGATE: OnceLock<Retained<NotifyDelegate>> = OnceLock::new();

    pub fn install(app: &tauri::AppHandle) {
        if !bundled() {
            return;
        }
        let delegate = DELEGATE.get_or_init(|| NotifyDelegate::new(app.clone()));
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Note;

    pub async fn status() -> String {
        "unavailable".into()
    }
    pub async fn request() -> Result<bool, String> {
        Ok(false)
    }
    pub async fn show(_note: Note) -> Result<(), String> {
        Ok(())
    }
    pub async fn delivered() -> Vec<String> {
        Vec::new()
    }
    pub fn remove(_ids: Vec<String>) {}
    pub fn install(_app: &tauri::AppHandle) {}
}

/// Installs the click handler. Call once from `setup`; does nothing in an unbundled process.
pub fn install(app: &tauri::AppHandle) {
    imp::install(app);
}

/// "notDetermined" | "denied" | "authorized" | "provisional" | "unavailable"
#[tauri::command]
pub async fn notify_status() -> String {
    imp::status().await
}

/// Asks macOS for Alert, Sound and Badge (shows the system prompt once). True when granted.
#[tauri::command]
pub async fn notify_request() -> Result<bool, String> {
    imp::request().await
}

/// Shows one banner now.
#[tauri::command]
pub async fn notify_show(note: Note) -> Result<(), String> {
    imp::show(note).await
}

/// The banner click the front end hasn't taken yet (one that launched zMail), at most once.
#[tauri::command]
pub fn notify_take_pending() -> Option<serde_json::Value> {
    take_pending(&PENDING)
}

/// Identifiers of the banners still in Notification Center, including earlier sessions'.
#[tauri::command]
pub async fn notify_delivered() -> Vec<String> {
    imp::delivered().await
}

/// Takes delivered banners out of Notification Center (the email was read or moved).
#[tauri::command]
pub fn notify_remove(ids: Vec<String>) {
    imp::remove(ids);
}

/// System Settings → Notifications.
#[tauri::command]
pub fn notify_open_settings(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notify_status_names() {
        assert_eq!(status_name(0), "notDetermined");
        assert_eq!(status_name(1), "denied");
        assert_eq!(status_name(2), "authorized");
        assert_eq!(status_name(3), "provisional");
        assert_eq!(status_name(4), "authorized");
        assert_eq!(status_name(9), "authorized");
    }

    #[test]
    fn notify_clip() {
        assert_eq!(clip("hello", 10), "hello");
        assert_eq!(clip("hello", 5), "hello");
        assert_eq!(clip("hello world", 6), "hello…");
        assert_eq!(clip("hello world", 7), "hello…");
        assert_eq!(clip("héllo wörld", 9), "héllo wö…");
        assert_eq!(clip("日本語のテキスト", 4), "日本語…");
        assert_eq!(clip("", 3), "");
        assert!(clip(&"x".repeat(500), 120).chars().count() == 120);
    }

    #[test]
    fn notify_pending_takes_once() {
        let slot = Mutex::new(None);
        assert!(take_pending(&slot).is_none());
        put_pending(&slot, serde_json::json!({ "id": "e1", "emailId": "e1" }));
        put_pending(&slot, serde_json::json!({ "id": "e2", "emailId": "e2" }));
        // The latest click wins, and it is handed out once.
        assert_eq!(take_pending(&slot).unwrap()["emailId"], "e2");
        assert!(take_pending(&slot).is_none());
    }

    #[test]
    fn notify_note_camel_case() {
        let n: Note = serde_json::from_str(
            r#"{"id":"e1","title":"Sherri Dugan","subtitle":"Budget","body":null,"thread":"acc","sound":true,"emailId":"e1","accountId":"acc"}"#,
        )
        .unwrap();
        assert_eq!(n.id, "e1");
        assert_eq!(n.title, "Sherri Dugan");
        assert_eq!(n.subtitle.as_deref(), Some("Budget"));
        assert!(n.body.is_none());
        assert_eq!(n.thread.as_deref(), Some("acc"));
        assert!(n.sound);
        assert_eq!(n.email_id.as_deref(), Some("e1"));
        assert_eq!(n.account_id.as_deref(), Some("acc"));

        let summary: Note =
            serde_json::from_str(r#"{"id":"summary-1","title":"4 emails need you","sound":false}"#)
                .unwrap();
        assert!(summary.email_id.is_none() && summary.subtitle.is_none());
    }
}
