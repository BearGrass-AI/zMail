mod db;
mod display;
mod files;
mod http;
mod mac_contacts;
mod maps;
mod notify;
mod oauth;
mod person_photo;
mod secrets;
mod semantic;
mod sender_logo;
mod spelling;
mod unsubscribe;

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// Whether the main window may load `url`: zMail itself (and the dev server in debug builds)
/// or an about: document (the email frame's srcdoc). Anything else would replace the app.
fn app_navigation(url: &url::Url, dev_url: Option<&url::Url>) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" if url.host_str() == Some("tauri.localhost") => true,
        _ => dev_url.is_some_and(|d| d.origin() == url.origin()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // One copy at a time: two would share the data folder and could both send a scheduled email.
    // Release builds only, so `tauri dev` still runs beside an installed copy.
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch brings the running copy's window forward instead.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        // In-app updates (the endpoint and public key are in tauri.conf.json) and the relaunch after one.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Before the window exists, so its web view starts with spell checking on.
            spelling::enable();
            let db = db::open(app.handle())?;
            app.manage(db);
            semantic::manage(app)?;
            db::spawn_fts_backfill(app.handle().clone());
            // After the keyword backfill's start; does nothing unless the setting is on.
            semantic::spawn_indexer(app.handle().clone(), std::time::Duration::from_secs(10));
            app.manage(oauth::TokenCache::default());
            // The main window is built here rather than from tauri.conf.json so that links
            // asking for a new window (every link in an email) open in the default browser.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("tauri.conf.json has no main window")?;
            let handle = app.handle().clone();
            let dev_url = if cfg!(debug_assertions) {
                app.config().build.dev_url.clone()
            } else {
                None
            };
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                // A link that slips past the app's click handlers can't replace zMail with a web page.
                .on_navigation(move |url| app_navigation(url, dev_url.as_ref()))
                .on_new_window(move |url, _features| {
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            notify::install(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            http::http_request,
            display::reduce_transparency,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            db::kv_get,
            db::kv_set,
            db::cache_put_messages,
            db::cache_list_messages,
            db::cache_get_message,
            db::cache_list_ids,
            db::cache_delete_messages,
            db::cache_delete_account,
            db::cache_put_folders,
            db::cache_list_folders,
            db::cache_search,
            db::cache_get_rows,
            db::sync_get,
            db::sync_set,
            semantic::semantic_status,
            semantic::semantic_enable,
            semantic::semantic_cancel_download,
            semantic::semantic_disable,
            semantic::semantic_search,
            semantic::semantic_passages,
            oauth::oauth_sign_in,
            oauth::oauth_access_token,
            oauth::oauth_cancel_sign_in,
            oauth::oauth_sign_out,
            oauth::oauth_move_account,
            files::save_attachment,
            mac_contacts::mac_contacts_status,
            mac_contacts::mac_contacts_request,
            mac_contacts::mac_contact_photo,
            maps::travel_eta,
            files::open_path,
            files::reveal_path,
            files::extract_text,
            sender_logo::sender_logo,
            unsubscribe::unsubscribe_post,
            person_photo::fetch_photo,
            notify::notify_status,
            notify::notify_request,
            notify::notify_show,
            notify::notify_remove,
            notify::notify_take_pending,
            notify::notify_delivered,
            notify::notify_open_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                semantic::shutdown(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::app_navigation;
    use url::Url;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn main_window_stays_on_the_app() {
        for ok in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "about:srcdoc",
            "about:blank",
        ] {
            assert!(app_navigation(&u(ok), None), "{ok} should load");
        }
        for bad in [
            "https://phish.example/login",
            "http://localhost:1420/",
            "https://tauri.localhost.example/",
            "file:///etc/hosts",
            "mailto:ann@example.com",
            "data:text/html,hi",
        ] {
            assert!(!app_navigation(&u(bad), None), "{bad} should be refused");
        }
    }

    #[test]
    fn dev_server_only_when_configured() {
        let dev = u("http://localhost:1420");
        assert!(app_navigation(&u("http://localhost:1420/"), Some(&dev)));
        assert!(app_navigation(&u("http://localhost:1420/src/main.tsx"), Some(&dev)));
        assert!(!app_navigation(&u("http://localhost:1421/"), Some(&dev)));
        assert!(!app_navigation(&u("https://phish.example/"), Some(&dev)));
    }
}
