//! Meaning-based search, on this Mac only: a local embedding model (EmbeddingGemma 2, downloaded
//! on request), a vector index of the mail cache built in the background, and hybrid search over
//! it and the keyword index. Nothing here sends mail text anywhere; the only network use is the
//! model's one pinned download.
//!
//! Off until turned on in Settings. "Ready" needs the verified model file, the setting on, and
//! at least one email indexed; until then every search answers `ready: false` without loading
//! anything, and the app searches exactly as it does without this.

#[cfg(test)]
mod bench;
pub mod embed;
pub mod index;
pub mod model;
pub mod search;
pub mod text;

use crate::db::{self, Db, SearchFilter, SearchHit};
use embed::Embedder;
use index::VecCache;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const ENABLED_KEY: &str = "semantic.enabled";
/// Emails per indexing batch, and the pause between batches so the UI's reads get the lock.
const BATCH: u32 = 16;
const PAUSE: Duration = Duration::from_millis(20);
/// How long the indexer waits for new mail before checking again on its own.
const IDLE_CHECK: Duration = Duration::from_secs(60);
/// The in-memory vectors are dropped after this long without a search (rebuilt on the next).
const CACHE_IDLE: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq, Default)]
enum Download {
    #[default]
    Idle,
    Running,
    Verifying,
    Failed(String),
}

pub struct Semantic {
    models: PathBuf,
    embedder: Embedder,
    download: Mutex<Download>,
    downloaded: Mutex<(u64, u64)>,
    cancel: AtomicBool,
    cache: Mutex<Option<VecCache>>,
    last_search: Mutex<Option<Instant>>,
    /// Set while the indexer thread runs; `wake` tells it new mail may be queued.
    indexing: AtomicBool,
    wake: (Mutex<bool>, Condvar),
    index_error: Mutex<Option<String>>,
}

impl Semantic {
    pub fn new(app_data: &std::path::Path) -> Self {
        let models = model::models_dir(app_data);
        Self {
            embedder: Embedder::new(model::model_path(&models, &model::MODEL)),
            models,
            download: Default::default(),
            downloaded: Default::default(),
            cancel: AtomicBool::new(false),
            cache: Mutex::new(None),
            last_search: Mutex::new(None),
            indexing: AtomicBool::new(false),
            wake: (Mutex::new(false), Condvar::new()),
            index_error: Mutex::new(None),
        }
    }

    fn model_ready(&self) -> bool {
        model::ready_path(&self.models, &model::MODEL).is_some()
    }

    fn drop_cache(&self) {
        if let Ok(mut c) = self.cache.lock() {
            *c = None;
        }
    }
}

fn enabled(conn: &rusqlite::Connection) -> Result<bool, String> {
    Ok(db::kv_get_conn(conn, ENABLED_KEY)?.as_deref() == Some("true"))
}

fn set_enabled(conn: &rusqlite::Connection, on: bool) -> Result<(), String> {
    db::kv_set_conn(conn, ENABLED_KEY, if on { "true" } else { "false" })
}

/// Tell the indexer that mail was cached (it may have been queued).
pub fn wake(app: &AppHandle) {
    let sem = app.state::<Semantic>();
    if !sem.indexing.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(mut w) = sem.wake.0.lock() {
        *w = true;
        sem.wake.1.notify_one();
    }
}

/// Start the indexer if the setting is on and the model is in place (at launch, after a
/// download, when turned on). Only one runs; it stops itself when either goes away.
pub fn spawn_indexer(app: AppHandle, delay: Duration) {
    if app
        .state::<Semantic>()
        .indexing
        .swap(true, Ordering::SeqCst)
    {
        return wake(&app);
    }
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("vec-index".into())
        .spawn(move || {
            std::thread::sleep(delay);
            run_indexer(&handle);
            handle
                .state::<Semantic>()
                .indexing
                .store(false, Ordering::SeqCst);
        });
    if let Err(e) = spawned {
        app.state::<Semantic>()
            .indexing
            .store(false, Ordering::SeqCst);
        eprintln!("[semantic] couldn't start the indexer: {e}");
    }
}

fn run_indexer(app: &AppHandle) {
    let db = app.state::<Db>();
    let sem = app.state::<Semantic>();
    // A new model revision or index version rebuilds here (a no-op otherwise).
    {
        let Ok(conn) = db.0.lock() else { return };
        match enabled(&conn) {
            Ok(true) if sem.model_ready() => {
                if let Err(e) = index::install(&conn) {
                    eprintln!("[semantic] {e}");
                    return;
                }
            }
            _ => return,
        }
    }
    let mut failures = 0;
    loop {
        if !sem.model_ready() {
            return;
        }
        let batch = {
            let Ok(conn) = db.0.lock() else { return };
            match enabled(&conn).and_then(|on| Ok(on && index::installed(&conn)?)) {
                Ok(true) => {}
                Ok(false) => return,
                Err(e) => {
                    eprintln!("[semantic] {e}");
                    return;
                }
            }
            index::next_batch(&conn, BATCH)
        };
        let step = batch.and_then(|batch| {
            if batch.is_empty() {
                return Ok(false);
            }
            let done = index::embed_batch(&sem.embedder, batch)?;
            let mut conn = db.0.lock().map_err(|e| e.to_string())?;
            let written = index::write_batch(&mut conn, done)?;
            // Same lock order as search (database, then the vectors).
            if let Ok(mut cache) = sem.cache.lock()
                && let Some(cache) = cache.as_mut()
            {
                for (id, v) in &written {
                    cache.put(*id, v);
                }
            }
            Ok(true)
        });
        match step {
            Ok(true) => {
                failures = 0;
                if let Ok(mut e) = sem.index_error.lock() {
                    *e = None;
                }
                std::thread::sleep(PAUSE);
            }
            Ok(false) => {
                // Caught up: drop the in-memory vectors if nobody searched lately, then wait for mail.
                let idle = sem
                    .last_search
                    .lock()
                    .map_or(true, |t| t.is_none_or(|t| t.elapsed() > CACHE_IDLE));
                if idle {
                    sem.drop_cache();
                }
                let Ok(mut woken) = sem.wake.0.lock() else {
                    return;
                };
                if !*woken {
                    woken = match sem.wake.1.wait_timeout(woken, IDLE_CHECK) {
                        Ok((w, _)) => w,
                        Err(_) => return,
                    };
                }
                *woken = false;
            }
            Err(e) => {
                failures += 1;
                eprintln!("[semantic] indexing batch failed ({failures}): {e}");
                if let Ok(mut slot) = sem.index_error.lock() {
                    *slot = Some(e);
                }
                if failures >= 5 {
                    return;
                }
                std::thread::sleep(Duration::from_secs(30));
            }
        }
    }
}

/// What Settings shows.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Status {
    pub enabled: bool,
    /// "missing", "partial" (a download to resume), "downloading", "verifying" or "ready".
    pub model: &'static str,
    pub downloaded: u64,
    pub size: u64,
    pub error: Option<String>,
    /// Emails with vectors, of all cached emails.
    pub indexed: u64,
    pub total: u64,
    pub indexing: bool,
}

fn status_of(db: &Db, sem: &Semantic) -> Result<Status, String> {
    let (on, (indexed, total)) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (enabled(&conn)?, index::progress(&conn)?)
    };
    let download = sem.download.lock().map_err(|e| e.to_string())?.clone();
    let (mut downloaded, size) = *sem.downloaded.lock().map_err(|e| e.to_string())?;
    let ready = sem.model_ready();
    let partial = model::partial_len(&sem.models, &model::MODEL);
    let model = match download {
        Download::Running => "downloading",
        Download::Verifying => "verifying",
        _ if ready => "ready",
        _ if partial > 0 => {
            downloaded = partial;
            "partial"
        }
        _ => "missing",
    };
    let error = match download {
        Download::Failed(e) => Some(e),
        _ => sem.index_error.lock().map_err(|e| e.to_string())?.clone(),
    };
    Ok(Status {
        enabled: on,
        model,
        downloaded: if ready { model::MODEL.size } else { downloaded },
        size: if size > 0 { size } else { model::MODEL.size },
        error,
        indexed,
        total,
        indexing: on && ready && indexed < total && sem.indexing.load(Ordering::Relaxed),
    })
}

#[tauri::command(async)]
pub fn semantic_status(db: State<Db>, sem: State<Semantic>) -> Result<Status, String> {
    status_of(&db, &sem)
}

/// Download the model, then index. The answer comes back as soon as the download starts; Settings
/// follows it with `semantic_status`.
fn start_download(app: &AppHandle) -> Result<(), String> {
    let sem = app.state::<Semantic>();
    {
        let mut d = sem.download.lock().map_err(|e| e.to_string())?;
        if matches!(*d, Download::Running | Download::Verifying) {
            return Ok(());
        }
        *d = Download::Running;
    }
    sem.cancel.store(false, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let sem = app.state::<Semantic>();
        let result = match model::client() {
            Ok(client) => {
                model::download(
                    &client,
                    &model::MODEL,
                    &sem.models,
                    &sem.cancel,
                    |done, total| {
                        if let Ok(mut d) = sem.downloaded.lock() {
                            *d = (done, total);
                        }
                        if done == total
                            && let Ok(mut d) = sem.download.lock()
                        {
                            *d = Download::Verifying;
                        }
                    },
                )
                .await
            }
            Err(e) => Err(model::DownloadError::Failed(e)),
        };
        let next = match result {
            Ok(_) => Download::Idle,
            Err(model::DownloadError::Cancelled) => Download::Idle,
            Err(e) => Download::Failed(e.to_string()),
        };
        let ok = next == Download::Idle && sem.model_ready();
        if let Ok(mut d) = sem.download.lock() {
            *d = next;
        }
        if ok {
            // Turned off while downloading: keep the file, start nothing.
            let start = app
                .state::<Db>()
                .0
                .lock()
                .map_err(|e| e.to_string())
                .and_then(|conn| Ok(enabled(&conn)? && index::install(&conn).is_ok()));
            if start == Ok(true) {
                spawn_indexer(app.clone(), Duration::ZERO);
            }
        }
    });
    Ok(())
}

/// Turn meaning-based search on: download the model if it isn't here (or resume it), then index.
#[tauri::command(async)]
pub fn semantic_enable(
    app: AppHandle,
    db: State<Db>,
    sem: State<Semantic>,
) -> Result<Status, String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        set_enabled(&conn, true)?;
        if sem.model_ready() {
            index::install(&conn)?;
        }
    }
    if let Ok(mut e) = sem.index_error.lock() {
        *e = None;
    }
    if sem.model_ready() {
        spawn_indexer(app, Duration::ZERO);
    } else {
        start_download(&app)?;
    }
    status_of(&db, &sem)
}

/// Stop a download between chunks, keeping what arrived for a resume.
#[tauri::command(async)]
pub fn semantic_cancel_download(db: State<Db>, sem: State<Semantic>) -> Result<Status, String> {
    sem.cancel.store(true, Ordering::SeqCst);
    status_of(&db, &sem)
}

/// Turn it off. `delete`: also delete the model file and the index; the answer comes only after
/// both are gone.
#[tauri::command(async)]
pub fn semantic_disable(
    db: State<Db>,
    sem: State<Semantic>,
    delete: bool,
) -> Result<Status, String> {
    sem.cancel.store(true, Ordering::SeqCst);
    if delete {
        // Let a running download notice and stop, so it can't rename a file into place after
        // the delete (it checks between chunks and before the rename).
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until
            && matches!(
                *sem.download.lock().map_err(|e| e.to_string())?,
                Download::Running | Download::Verifying
            )
        {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        set_enabled(&conn, false)?;
        if delete {
            index::uninstall(&conn)?;
        }
    }
    if delete {
        sem.drop_cache();
        model::remove(&sem.models, &model::MODEL)?;
    }
    status_of(&db, &sem)
}

/// Untrusted search options from the webview, as `cache_search` takes them.
#[derive(serde::Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    account_ids: Option<Vec<String>>,
    folder_ids: Option<Vec<String>>,
    exclude_folder_ids: Option<Vec<String>>,
    #[serde(default)]
    starred: bool,
}

impl Scope {
    fn filter(&self) -> SearchFilter<'_> {
        SearchFilter {
            account_ids: self.account_ids.as_deref(),
            folder_ids: self.folder_ids.as_deref(),
            exclude_folder_ids: self.exclude_folder_ids.as_deref(),
            starred: self.starred,
            order: db::SearchOrder::Rank,
        }
    }
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct HybridResults<T> {
    /// False: meaning-based search is off, its model isn't here, or nothing is indexed yet.
    pub ready: bool,
    pub hits: Vec<T>,
}

fn ready_to_search(db: &Db, sem: &Semantic) -> Result<bool, String> {
    if !sem.model_ready() {
        return Ok(false);
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    enabled(&conn)
}

/// The best `limit` (1..=20) emails for `query` by keywords and meaning, within `scope`.
#[tauri::command(async)]
pub fn semantic_search(
    db: State<Db>,
    sem: State<Semantic>,
    query: String,
    scope: Scope,
    limit: u32,
) -> Result<HybridResults<SearchHit>, String> {
    let not_ready = || HybridResults {
        ready: false,
        hits: vec![],
    };
    if !ready_to_search(&db, &sem)? {
        return Ok(not_ready());
    }
    if let Ok(mut t) = sem.last_search.lock() {
        *t = Some(Instant::now());
    }
    let filter = scope.filter();
    let found = search::hybrid(
        &db.0,
        &sem.embedder,
        &sem.cache,
        &query,
        &filter,
        limit.clamp(1, 20) as usize,
    )?;
    Ok(match found {
        Some((hits, _)) => HybridResults {
            ready: true,
            hits: hits.into_iter().map(|f| f.hit).collect(),
        },
        None => not_ready(),
    })
}

/// For the assistant: the best `limit` (1..=5) emails with each one's best-matching passage.
#[tauri::command(async)]
pub fn semantic_passages(
    db: State<Db>,
    sem: State<Semantic>,
    query: String,
    scope: Scope,
    limit: u32,
) -> Result<HybridResults<search::PassageHit>, String> {
    let not_ready = || HybridResults {
        ready: false,
        hits: vec![],
    };
    if !ready_to_search(&db, &sem)? {
        return Ok(not_ready());
    }
    if let Ok(mut t) = sem.last_search.lock() {
        *t = Some(Instant::now());
    }
    let filter = scope.filter();
    let found = search::hybrid(
        &db.0,
        &sem.embedder,
        &sem.cache,
        &query,
        &filter,
        limit.clamp(1, 5) as usize,
    )?;
    let Some((hits, qv)) = found else {
        return Ok(not_ready());
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(HybridResults {
        ready: true,
        hits: search::passages(&conn, &hits, &qv)?,
    })
}

/// Before the app exits: free the model (see `Embedder::shutdown`).
pub fn shutdown(app: &AppHandle) {
    if let Some(sem) = app.try_state::<Semantic>() {
        sem.embedder.shutdown();
    }
}

/// For the app's setup: the state, managed before anything can search.
pub fn manage(app: &tauri::App) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    app.manage(Semantic::new(&dir));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_flag_round_trips() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        assert!(!enabled(&conn).unwrap());
        set_enabled(&conn, true).unwrap();
        assert!(enabled(&conn).unwrap());
        set_enabled(&conn, false).unwrap();
        assert!(!enabled(&conn).unwrap());
    }

    #[test]
    fn scope_takes_the_webview_shape() {
        let s: Scope =
            serde_json::from_str(r#"{"accountIds":["a"],"excludeFolderIds":["s","t"]}"#).unwrap();
        let f = s.filter();
        assert_eq!(f.account_ids.unwrap(), ["a".to_string()]);
        assert!(f.folder_ids.is_none());
        assert_eq!(f.exclude_folder_ids.unwrap().len(), 2);
        assert!(!f.starred);
    }
}
