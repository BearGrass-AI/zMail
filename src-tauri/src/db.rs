//! Local SQLite store: app state (kv), the mail/folder cache for synced
//! accounts, and per-account sync cursors (Gmail historyId, Graph deltaLink).

use rusqlite::{Connection, OptionalExtension, params};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

pub struct Db(pub Mutex<Connection>);

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS folders_account ON folders(account_id);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  date       TEXT NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_account_date ON messages(account_id, date DESC);
CREATE INDEX IF NOT EXISTS messages_account_folder ON messages(account_id, folder_id);
CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL
);
"#;

pub fn open(app: &AppHandle) -> Result<Db, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("zmail.sqlite3")).map_err(|e| e.to_string())?;
    init(&conn)?;
    Ok(Db(Mutex::new(conn)))
}

pub fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA journal_size_limit=67108864;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    // So a row removed by REPLACE conflict resolution still fires the index's delete trigger
    // (the triggers write only to `messages_fts`, so nothing recurses).
    conn.execute_batch("PRAGMA recursive_triggers=ON;")
        .map_err(|e| e.to_string())?;
    init_fts(conn)?;
    crate::semantic::index::init_tables(conn)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---- kv ----------------------------------------------------------------------

pub fn kv_get_conn(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(err)
}

pub fn kv_set_conn(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO kv(key, value, updated_at) VALUES (?1, ?2, unixepoch())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value],
    )
    .map(|_| ())
    .map_err(err)
}

#[tauri::command(async)]
pub fn kv_get(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(err)?;
    kv_get_conn(&conn, &key)
}

#[tauri::command(async)]
pub fn kv_set(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    kv_set_conn(&conn, &key, &value)
}

// ---- mail cache ------------------------------------------------------------------

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, PartialEq)]
pub struct CachedMessage {
    pub id: String,
    pub folder_id: String,
    pub date: String,
    pub json: String,
}

/// Upsert rows. A slim row (`bodyTrimmed`, e.g. the store writing back a flag change on a
/// listed email) keeps the stored row's full `html` and `text` instead of overwriting them.
pub fn put_messages_conn(
    conn: &mut Connection,
    account_id: &str,
    messages: &[CachedMessage],
) -> Result<(), String> {
    let tx = conn.transaction().map_err(err)?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO messages(id, account_id, folder_id, date, json) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET folder_id = excluded.folder_id, date = excluded.date, json =
                   CASE WHEN coalesce(json_extract(excluded.json, '$.bodyTrimmed'), 0) AND NOT coalesce(json_extract(messages.json, '$.bodyTrimmed'), 0)
                   THEN json_patch(json_remove(excluded.json, '$.bodyTrimmed'), json_object(
                     'html', json_extract(messages.json, '$.html'),
                     'text', coalesce(json_extract(messages.json, '$.text'), json_extract(excluded.json, '$.text'))))
                   ELSE excluded.json END",
            )
            .map_err(err)?;
        for m in messages {
            stmt.execute(params![m.id, account_id, m.folder_id, m.date, m.json])
                .map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

/// List rows drop the `html` body and cap `text` at 8,000 characters, flagged `bodyTrimmed`;
/// the full row comes from `get_message_conn` when an email is opened.
const SLIM_JSON: &str = "json_set(json_remove(json, '$.html'), '$.text', coalesce(substr(json_extract(json, '$.text'), 1, 8000), ''), '$.bodyTrimmed', json('true'))";

/// Newest `limit` rows for the account; with `folders`, also every row in those folders
/// (so a whole Inbox survives the limit). Deduplicated by id, newest first. Rows are slim
/// (see `SLIM_JSON`).
pub fn list_messages_conn(
    conn: &Connection,
    account_id: &str,
    limit: u32,
    folders: Option<&[String]>,
) -> Result<Vec<CachedMessage>, String> {
    let map = |r: &rusqlite::Row| -> rusqlite::Result<CachedMessage> {
        Ok(CachedMessage {
            id: r.get(0)?,
            folder_id: r.get(1)?,
            date: r.get(2)?,
            json: r.get(3)?,
        })
    };
    let mut stmt = conn
        .prepare(&format!("SELECT id, folder_id, date, {SLIM_JSON} FROM messages WHERE account_id = ?1 ORDER BY date DESC LIMIT ?2"))
        .map_err(err)?;
    let mut out = stmt
        .query_map(params![account_id, limit], map)
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    if let Some(folders) = folders.filter(|f| !f.is_empty()) {
        let mut seen: std::collections::HashSet<String> =
            out.iter().map(|m| m.id.clone()).collect();
        let mut stmt = conn
            .prepare(&format!("SELECT id, folder_id, date, {SLIM_JSON} FROM messages WHERE account_id = ?1 AND folder_id = ?2"))
            .map_err(err)?;
        for folder in folders {
            for m in stmt
                .query_map(params![account_id, folder], map)
                .map_err(err)?
            {
                let m = m.map_err(err)?;
                if seen.insert(m.id.clone()) {
                    out.push(m);
                }
            }
        }
        out.sort_by(|a, b| b.date.cmp(&a.date));
    }
    Ok(out)
}

/// One full cached row (with `html` and the whole `text`), or None if it isn't cached.
pub fn get_message_conn(conn: &Connection, id: &str) -> Result<Option<CachedMessage>, String> {
    conn.query_row(
        "SELECT id, folder_id, date, json FROM messages WHERE id = ?1",
        params![id],
        |r| {
            Ok(CachedMessage {
                id: r.get(0)?,
                folder_id: r.get(1)?,
                date: r.get(2)?,
                json: r.get(3)?,
            })
        },
    )
    .optional()
    .map_err(err)
}

/// Ids only, with the same rows as `list_messages_conn` (newest `limit`, plus every row in
/// `folders`), so callers building "have" sets don't pull each message's JSON.
pub fn list_ids_conn(
    conn: &Connection,
    account_id: &str,
    limit: u32,
    folders: Option<&[String]>,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM messages WHERE account_id = ?1 ORDER BY date DESC LIMIT ?2")
        .map_err(err)?;
    let mut out = stmt
        .query_map(params![account_id, limit], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    if let Some(folders) = folders.filter(|f| !f.is_empty()) {
        let mut seen: std::collections::HashSet<String> = out.iter().cloned().collect();
        let mut stmt = conn
            .prepare("SELECT id FROM messages WHERE account_id = ?1 AND folder_id = ?2")
            .map_err(err)?;
        for folder in folders {
            for id in stmt
                .query_map(params![account_id, folder], |r| r.get::<_, String>(0))
                .map_err(err)?
            {
                let id = id.map_err(err)?;
                if seen.insert(id.clone()) {
                    out.push(id);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn cache_put_messages(
    app: AppHandle,
    db: State<Db>,
    account_id: String,
    messages: Vec<CachedMessage>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(err)?;
    put_messages_conn(&mut conn, &account_id, &messages)?;
    drop(conn);
    // New or changed mail may be queued for the vector index.
    crate::semantic::wake(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn cache_list_messages(
    db: State<Db>,
    account_id: String,
    limit: Option<u32>,
    folders: Option<Vec<String>>,
) -> Result<Vec<CachedMessage>, String> {
    let conn = db.0.lock().map_err(err)?;
    list_messages_conn(
        &conn,
        &account_id,
        limit.unwrap_or(2000),
        folders.as_deref(),
    )
}

#[tauri::command(async)]
pub fn cache_get_message(db: State<Db>, id: String) -> Result<Option<CachedMessage>, String> {
    let conn = db.0.lock().map_err(err)?;
    get_message_conn(&conn, &id)
}

#[tauri::command(async)]
pub fn cache_list_ids(
    db: State<Db>,
    account_id: String,
    limit: Option<u32>,
    folders: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(err)?;
    list_ids_conn(
        &conn,
        &account_id,
        limit.unwrap_or(2000),
        folders.as_deref(),
    )
}

#[tauri::command(async)]
pub fn cache_delete_messages(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(err)?;
    delete_messages_conn(&mut conn, &ids)
}

pub fn delete_messages_conn(conn: &mut Connection, ids: &[String]) -> Result<(), String> {
    let tx = conn.transaction().map_err(err)?;
    {
        let mut stmt = tx
            .prepare("DELETE FROM messages WHERE id = ?1")
            .map_err(err)?;
        for id in ids {
            stmt.execute(params![id]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

/// Everything cached for a removed account: its mail, folders, sync cursor and Inbox backfill
/// cursor (kv `backfill.<id>`). Returns the deleted message ids so the app can drop results kept for them.
pub fn delete_account_conn(conn: &mut Connection, account_id: &str) -> Result<Vec<String>, String> {
    let tx = conn.transaction().map_err(err)?;
    let ids = {
        let mut stmt = tx
            .prepare("DELETE FROM messages WHERE account_id = ?1 RETURNING id")
            .map_err(err)?;
        stmt.query_map(params![account_id], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?
    };
    tx.execute(
        "DELETE FROM folders WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(err)?;
    tx.execute(
        "DELETE FROM sync_state WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(err)?;
    tx.execute(
        "DELETE FROM kv WHERE key = 'backfill.' || ?1",
        params![account_id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(ids)
}

#[tauri::command(async)]
pub fn cache_delete_account(db: State<Db>, account_id: String) -> Result<Vec<String>, String> {
    let mut conn = db.0.lock().map_err(err)?;
    delete_account_conn(&mut conn, &account_id)
}

#[tauri::command(async)]
pub fn cache_put_folders(
    db: State<Db>,
    account_id: String,
    folders: Vec<(String, String)>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    tx.execute(
        "DELETE FROM folders WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(err)?;
    for (id, json) in folders {
        tx.execute(
            "INSERT INTO folders(id, account_id, json) VALUES (?1, ?2, ?3)",
            params![id, account_id, json],
        )
        .map_err(err)?;
    }
    tx.commit().map_err(err)
}

#[tauri::command(async)]
pub fn cache_list_folders(db: State<Db>, account_id: String) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn
        .prepare("SELECT json FROM folders WHERE account_id = ?1")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![account_id], |r| r.get(0))
        .map_err(err)?;
    rows.collect::<Result<Vec<String>, _>>().map_err(err)
}

// ---- full-text search ------------------------------------------------------------
//
// `messages_fts` is a *contentless* FTS5 table with `contentless_delete=1`: it stores only the
// inverted index (and per-row token counts for bm25), never a second copy of the text. The
// text already lives in `messages.json`, and external content would have to re-read and
// re-tokenize the OLD row from that JSON on every delete/update, while a contentless-delete
// table deletes by rowid alone. Search returns ids, not snippets, so the stored content an
// external-content table offers (snippet/highlight) isn't needed. Its rowid is `messages.rowid`;
// `messages` has no INTEGER PRIMARY KEY, so rowids are only stable while a row exists, which
// is exactly how long the triggers keep its index entry. `VACUUM` may renumber such rowids:
// anything that ever runs it must rebuild the index after (delete kv `fts.version`).
//
// Triggers keep it in sync with every write path (upsert, slim write-back, delete, delete
// account). Rows that predate the index are indexed by `fts_backfill_step`, in small batches
// off the main thread (`spawn_fts_backfill`), resumable through kv `fts.backfill`.

/// Bump when the indexed columns, tokenizer or extraction change: `init_fts` then drops the
/// index and its triggers, recreates them and queues every existing row for the backfill.
const FTS_VERSION: &str = "1";
const FTS_VERSION_KEY: &str = "fts.version";
/// `{"after": rowid, "end": rowid}` while rows that predate the index (rowid <= end) are still
/// being indexed; removed once the backfill reaches `end`. Rows written after the index exists
/// are indexed by the triggers, whatever their rowid.
const FTS_BACKFILL_KEY: &str = "fts.backfill";
/// Indexed characters per message: the body's first 20,000, each of the other fields' 1,000.
const FTS_BODY_CAP: u32 = 20_000;
const FTS_FIELD_CAP: u32 = 1_000;
/// bm25 column weights, in column order (name, address, subject, body): subject and sender
/// count above the body.
const FTS_BM25: &str = "bm25(messages_fts, 4.0, 4.0, 6.0, 1.0)";
/// Rows per backfill batch, and the pause between batches so the UI's reads get the lock.
const FTS_BACKFILL_BATCH: u32 = 100;
const FTS_BACKFILL_PAUSE: Duration = Duration::from_millis(30);
/// Untrusted query bounds: characters read and words kept.
const FTS_QUERY_MAX_CHARS: usize = 1_000;
const FTS_QUERY_MAX_WORDS: usize = 16;

/// `src` (a JSON text column) when it's valid JSON, else `'{}'`, so a malformed row indexes as
/// empty instead of failing the write that stores it.
fn fts_json(src: &str) -> String {
    format!("CASE WHEN json_valid({src}) THEN {src} ELSE '{{}}' END")
}

/// The four indexed values, as SQL over a JSON value `j`. An empty `text` (a header-only row)
/// falls back to the snippet.
fn fts_cols(j: &str) -> String {
    format!(
        "substr({j} ->> '$.from.name', 1, {FTS_FIELD_CAP}), \
         substr({j} ->> '$.from.address', 1, {FTS_FIELD_CAP}), \
         substr({j} ->> '$.subject', 1, {FTS_FIELD_CAP}), \
         substr(coalesce(nullif({j} ->> '$.text', ''), {j} ->> '$.snippet'), 1, {FTS_BODY_CAP})"
    )
}

/// Index the row `NEW` (inside a trigger).
fn fts_insert_new() -> String {
    format!(
        "INSERT INTO messages_fts(rowid, name, address, subject, body) SELECT NEW.rowid, {} FROM (SELECT {} AS j);",
        fts_cols("j"),
        fts_json("NEW.json")
    )
}

/// The indexed values of a trigger row (`OLD` or `NEW`), as one row value.
fn fts_doc(row: &str) -> String {
    format!(
        "(SELECT {} FROM (SELECT {} AS j))",
        fts_cols("j"),
        fts_json(&format!("{row}.json"))
    )
}

fn fts_schema() -> String {
    format!(
        "DROP TRIGGER IF EXISTS messages_fts_ai;
         DROP TRIGGER IF EXISTS messages_fts_ad;
         DROP TRIGGER IF EXISTS messages_fts_au;
         DROP TABLE IF EXISTS messages_fts;
         CREATE VIRTUAL TABLE messages_fts USING fts5(
           name, address, subject, body,
           content='', contentless_delete=1,
           tokenize='unicode61 remove_diacritics 2'
         );
         CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
           {insert}
         END;
         CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
           DELETE FROM messages_fts WHERE rowid = OLD.rowid;
         END;
         -- Only when an indexed value changes: flag and folder write-backs don't touch the index.
         CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages
         WHEN OLD.rowid IS NOT NEW.rowid OR (OLD.json IS NOT NEW.json AND {old} IS NOT {new})
         BEGIN
           DELETE FROM messages_fts WHERE rowid = OLD.rowid;
           {insert}
         END;",
        insert = fts_insert_new(),
        old = fts_doc("OLD"),
        new = fts_doc("NEW"),
    )
}

/// Create (or, after an `FTS_VERSION` bump, rebuild) the index and its triggers. Cheap: rows
/// already cached are only queued here, and indexed later by the backfill.
fn init_fts(conn: &Connection) -> Result<(), String> {
    let objects: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name IN
               ('messages_fts', 'messages_fts_ai', 'messages_fts_ad', 'messages_fts_au')",
            [],
            |r| r.get(0),
        )
        .map_err(err)?;
    if objects == 4 && kv_get_conn(conn, FTS_VERSION_KEY)?.as_deref() == Some(FTS_VERSION) {
        return Ok(());
    }
    // One transaction: the index, its triggers and the backfill's end mark appear together,
    // so every row is either written after the triggers or at or below `end`.
    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute_batch(&fts_schema()).map_err(err)?;
    tx.execute("DELETE FROM kv WHERE key = ?1", params![FTS_BACKFILL_KEY])
        .map_err(err)?;
    tx.execute(
        "INSERT INTO kv(key, value)
         SELECT ?1, json_object('after', 0, 'end', max(rowid)) FROM messages HAVING max(rowid) IS NOT NULL",
        params![FTS_BACKFILL_KEY],
    )
    .map_err(err)?;
    kv_set_conn(&tx, FTS_VERSION_KEY, FTS_VERSION)?;
    tx.commit().map_err(err)
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, Copy, PartialEq)]
struct FtsBackfill {
    after: i64,
    end: i64,
}

fn fts_backfill_get(conn: &Connection) -> Result<Option<FtsBackfill>, String> {
    kv_get_conn(conn, FTS_BACKFILL_KEY)?
        .map(|v| serde_json::from_str(&v).map_err(err))
        .transpose()
}

/// Index the next `batch` rows that predate the index. One transaction under the caller's
/// lock: rows are read from `messages` as they are now, so a row deleted before its batch is
/// never indexed, and one rewritten in the meantime (and so already indexed by a trigger) is
/// replaced, not doubled. Returns whether rows remain.
pub fn fts_backfill_step(conn: &mut Connection, batch: u32) -> Result<bool, String> {
    let tx = conn.transaction().map_err(err)?;
    let Some(progress) = fts_backfill_get(&tx)? else {
        return Ok(false);
    };
    let last: Option<i64> = tx
        .query_row(
            "SELECT max(rowid) FROM (SELECT rowid FROM messages WHERE rowid > ?1 AND rowid <= ?2 ORDER BY rowid LIMIT ?3)",
            params![progress.after, progress.end, batch.max(1)],
            |r| r.get(0),
        )
        .map_err(err)?;
    let more = match last {
        Some(last) => {
            tx.execute(
                &format!(
                    "INSERT OR REPLACE INTO messages_fts(rowid, name, address, subject, body)
                     SELECT rowid, {} FROM (SELECT rowid, {} AS j FROM messages WHERE rowid > ?1 AND rowid <= ?2)",
                    fts_cols("j"),
                    fts_json("json")
                ),
                params![progress.after, last],
            )
            .map_err(err)?;
            last < progress.end
        }
        None => false,
    };
    if more {
        let next = serde_json::to_string(&FtsBackfill {
            after: last.unwrap_or(progress.end),
            end: progress.end,
        })
        .map_err(err)?;
        kv_set_conn(&tx, FTS_BACKFILL_KEY, &next)?;
    } else {
        tx.execute("DELETE FROM kv WHERE key = ?1", params![FTS_BACKFILL_KEY])
            .map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(more)
}

/// Run the backfill on a background thread, one short batch per lock, until it's done. Never
/// blocks startup; a search meanwhile covers what's indexed and reports `indexing`.
pub fn spawn_fts_backfill(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("fts-backfill".into())
        .spawn(move || {
            // Let the window's first cache reads go first.
            std::thread::sleep(Duration::from_secs(3));
            let db = app.state::<Db>();
            let mut failures = 0;
            loop {
                let step = match db.0.lock() {
                    Ok(mut conn) => fts_backfill_step(&mut conn, FTS_BACKFILL_BATCH),
                    Err(_) => return,
                };
                match step {
                    Ok(true) => {
                        failures = 0;
                        std::thread::sleep(FTS_BACKFILL_PAUSE);
                    }
                    Ok(false) => return,
                    Err(e) => {
                        failures += 1;
                        eprintln!("[fts] backfill batch failed ({failures}): {e}");
                        if failures >= 5 {
                            return;
                        }
                        std::thread::sleep(Duration::from_secs(30));
                    }
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("[fts] couldn't start the backfill: {e}");
    }
}

/// A safe FTS5 expression for untrusted search text, or None when it has no words. Each
/// whitespace-separated word becomes a double-quoted string (quotes doubled), so operators,
/// column filters, `*`, `^`, `NEAR(...)` and parentheses are plain text the tokenizer splits;
/// the words are ANDed, and the last is a prefix so results follow typing. Words with no
/// letter or digit are dropped: they'd quote to a phrase with no tokens.
pub fn fts_query(input: &str) -> Option<String> {
    let cleaned: String = input
        .chars()
        .take(FTS_QUERY_MAX_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let words: Vec<String> = cleaned
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .take(FTS_QUERY_MAX_WORDS)
        .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
        .collect();
    if words.is_empty() {
        return None;
    }
    Some(format!("{}*", words.join(" AND ")))
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub account_id: String,
    pub folder_id: String,
    pub date: String,
    /// bm25: lower (more negative) is a better match.
    pub rank: f64,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    /// The backfill hasn't finished: older rows may be missing from `hits`.
    pub indexing: bool,
}

/// How search hits are ordered.
#[derive(serde::Deserialize, Debug, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchOrder {
    /// Best bm25 first, newest first among ties.
    #[default]
    Rank,
    /// Newest first over every match, so `limit` keeps the newest matches (not the newest of
    /// the best ones).
    Date,
}

/// Which messages a search may return. A `None` list doesn't restrict; an empty list matches
/// nothing (for `exclude_folder_ids`: leaves nothing out).
#[derive(Debug, Clone, Copy, Default)]
pub struct SearchFilter<'a> {
    pub account_ids: Option<&'a [String]>,
    pub folder_ids: Option<&'a [String]>,
    /// Folders to leave out (Spam and Trash, for "all mail").
    pub exclude_folder_ids: Option<&'a [String]>,
    /// Starred mail only.
    pub starred: bool,
    pub order: SearchOrder,
}

/// `filter` as SQL over `messages m`, with its values bound as ?2..?5 (`filter_params`).
const FILTER_SQL: &str = "(?2 IS NULL OR m.account_id IN (SELECT value FROM json_each(?2)))
   AND (?3 IS NULL OR m.folder_id IN (SELECT value FROM json_each(?3)))
   AND (?4 IS NULL OR m.folder_id NOT IN (SELECT value FROM json_each(?4)))
   AND (?5 = 0 OR coalesce(json_extract(m.json, '$.starred'), 0) = 1)";

type FilterParams = (Option<String>, Option<String>, Option<String>, bool);

fn filter_params(filter: &SearchFilter) -> Result<FilterParams, String> {
    let list = |ids: Option<&[String]>| ids.map(serde_json::to_string).transpose().map_err(err);
    Ok((
        list(filter.account_ids)?,
        list(filter.folder_ids)?,
        list(filter.exclude_folder_ids)?,
        filter.starred,
    ))
}

fn search_hit(r: &rusqlite::Row, first: usize) -> rusqlite::Result<SearchHit> {
    Ok(SearchHit {
        id: r.get(first)?,
        account_id: r.get(first + 1)?,
        folder_id: r.get(first + 2)?,
        date: r.get(first + 3)?,
        rank: r.get(first + 4)?,
    })
}

/// Messages matching every word of `query` (the last as a prefix), restricted by `filter`, in
/// `filter.order` (best bm25 first by default). `limit` is clamped to 1..=500. The SQL is fixed
/// text (one statement per order); the query and the id lists only ever travel as bound parameters.
pub fn search_filtered_conn(
    conn: &Connection,
    query: &str,
    filter: &SearchFilter,
    limit: i64,
) -> Result<SearchResults, String> {
    let indexing = fts_backfill_get(conn)?.is_some();
    let Some(expr) = fts_query(query) else {
        return Ok(SearchResults {
            hits: vec![],
            indexing,
        });
    };
    let order = match filter.order {
        SearchOrder::Rank => "score, m.date DESC, m.id",
        SearchOrder::Date => "m.date DESC, m.id",
    };
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT m.id, m.account_id, m.folder_id, m.date, {FTS_BM25} AS score
             FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH ?1 AND {FILTER_SQL}
             ORDER BY {order}
             LIMIT ?6"
        ))
        .map_err(err)?;
    let (a, f, x, s) = filter_params(filter)?;
    let hits = stmt
        .query_map(params![expr, a, f, x, s, limit.clamp(1, 500)], |r| {
            search_hit(r, 0)
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(SearchResults { hits, indexing })
}

/// Words never worth matching on their own in an any-word search.
const STOP_WORDS: &str = "a an the of to for and or in on at by with from about that this is are was were be been it its my our your
his her their them they he she we i me you what which who whom when where why how can could would should will just
some any all no not do does did so as if than then into out up over under after before also only very really thing
something someone email mail message";

/// An FTS5 expression matching ANY word of untrusted `input` (stop words left out, each word
/// quoted, no prefix), or None when none is left. Bounded like `fts_query`.
pub fn fts_query_any(input: &str) -> Option<String> {
    let stop: std::collections::HashSet<&str> = STOP_WORDS.split_whitespace().collect();
    let cleaned: String = input.chars().take(FTS_QUERY_MAX_CHARS).collect();
    let lower = cleaned.to_lowercase();
    let mut seen = std::collections::HashSet::new();
    let words: Vec<String> = lower
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty() && !stop.contains(w) && seen.insert(*w))
        .take(FTS_QUERY_MAX_WORDS)
        .map(|w| format!("\"{w}\""))
        .collect();
    (!words.is_empty()).then(|| words.join(" OR "))
}

/// The best `limit` (1..=500) messages by bm25 matching any word of `query`, restricted by
/// `filter`, each with its `messages` rowid. Ranking for hybrid search, not a result list.
pub fn search_any_conn(
    conn: &Connection,
    query: &str,
    filter: &SearchFilter,
    limit: i64,
) -> Result<Vec<(i64, SearchHit)>, String> {
    let Some(expr) = fts_query_any(query) else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT m.rowid, m.id, m.account_id, m.folder_id, m.date, {FTS_BM25} AS score
             FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH ?1 AND {FILTER_SQL}
             ORDER BY score, m.date DESC, m.id
             LIMIT ?6"
        ))
        .map_err(err)?;
    let (a, f, x, s) = filter_params(filter)?;
    stmt.query_map(params![expr, a, f, x, s, limit.clamp(1, 500)], |r| {
        Ok((r.get(0)?, search_hit(r, 1)?))
    })
    .map_err(err)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(err)
}

/// Of these `messages` rowids, the ones that exist, match `filter` and pass `extra` (SQL over
/// `m`, fixed text), with their hit fields (`rank` 0). At most 1,000 rowids are read.
pub fn rows_in_scope_conn(
    conn: &Connection,
    rowids: &[i64],
    filter: &SearchFilter,
    extra: &str,
) -> Result<std::collections::HashMap<i64, SearchHit>, String> {
    if rowids.is_empty() {
        return Ok(Default::default());
    }
    let ids = serde_json::to_string(&rowids[..rowids.len().min(1_000)]).map_err(err)?;
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT m.rowid, m.id, m.account_id, m.folder_id, m.date, 0.0
             FROM messages m
             WHERE m.rowid IN (SELECT value FROM json_each(?1)) AND {FILTER_SQL} AND ({extra})"
        ))
        .map_err(err)?;
    let (a, f, x, s) = filter_params(filter)?;
    stmt.query_map(params![ids, a, f, x, s], |r| {
        Ok((r.get(0)?, search_hit(r, 1)?))
    })
    .map_err(err)?
    .collect::<Result<_, _>>()
    .map_err(err)
}

#[expect(
    clippy::too_many_arguments,
    reason = "a Tauri command's arguments are the fields the app sends; the filters are bundled into SearchFilter right away"
)]
#[tauri::command(async)]
pub fn cache_search(
    db: State<Db>,
    query: String,
    account_ids: Option<Vec<String>>,
    folder_ids: Option<Vec<String>>,
    exclude_folder_ids: Option<Vec<String>>,
    starred: Option<bool>,
    order: Option<SearchOrder>,
    limit: i64,
) -> Result<SearchResults, String> {
    let conn = db.0.lock().map_err(err)?;
    let filter = SearchFilter {
        account_ids: account_ids.as_deref(),
        folder_ids: folder_ids.as_deref(),
        exclude_folder_ids: exclude_folder_ids.as_deref(),
        starred: starred.unwrap_or(false),
        order: order.unwrap_or_default(),
    };
    search_filtered_conn(&conn, &query, &filter, limit)
}

/// Most rows `get_rows_conn` reads in one call (a search shows at most this many).
pub const ROWS_MAX: usize = 500;

/// Slim rows (see `SLIM_JSON`) for these ids, newest first. Ids that aren't cached are left
/// out, and only the first `ROWS_MAX` ids are read. The ids are bound as one JSON array.
pub fn get_rows_conn(conn: &Connection, ids: &[String]) -> Result<Vec<CachedMessage>, String> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let ids = serde_json::to_string(&ids[..ids.len().min(ROWS_MAX)]).map_err(err)?;
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT id, folder_id, date, {SLIM_JSON} FROM messages
             WHERE id IN (SELECT value FROM json_each(?1))
             ORDER BY date DESC, id"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(params![ids], |r| {
            Ok(CachedMessage {
                id: r.get(0)?,
                folder_id: r.get(1)?,
                date: r.get(2)?,
                json: r.get(3)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

#[tauri::command(async)]
pub fn cache_get_rows(db: State<Db>, ids: Vec<String>) -> Result<Vec<CachedMessage>, String> {
    let conn = db.0.lock().map_err(err)?;
    get_rows_conn(&conn, &ids)
}

#[tauri::command(async)]
pub fn sync_get(db: State<Db>, account_id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(err)?;
    conn.query_row(
        "SELECT cursor FROM sync_state WHERE account_id = ?1",
        params![account_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(err)
}

#[tauri::command(async)]
pub fn sync_set(db: State<Db>, account_id: String, cursor: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "INSERT INTO sync_state(account_id, cursor) VALUES (?1, ?2)
         ON CONFLICT(account_id) DO UPDATE SET cursor = excluded.cursor",
        params![account_id, cursor],
    )
    .map(|_| ())
    .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn
    }

    #[test]
    fn init_sets_synchronous_normal() {
        let conn = mem();
        let v: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
    }

    #[test]
    fn bulk_delete_removes_only_given_ids() {
        let mut conn = mem();
        let m = |id: &str| CachedMessage {
            id: id.into(),
            folder_id: "inbox".into(),
            date: "2026-10-01".into(),
            json: "{}".into(),
        };
        put_messages_conn(&mut conn, "acct", &[m("1"), m("2"), m("3")]).unwrap();
        delete_messages_conn(&mut conn, &["1".to_string(), "3".to_string()]).unwrap();
        assert_eq!(
            list_ids_conn(&conn, "acct", 10, None).unwrap(),
            vec!["2".to_string()]
        );
    }

    #[test]
    fn delete_account_removes_only_that_accounts_rows() {
        let mut conn = mem();
        let m = |id: &str| CachedMessage {
            id: id.into(),
            folder_id: "inbox".into(),
            date: "2026-10-01".into(),
            json: "{}".into(),
        };
        put_messages_conn(&mut conn, "gone", &[m("1"), m("2")]).unwrap();
        put_messages_conn(&mut conn, "kept", &[m("3")]).unwrap();
        for (acct, folder) in [("gone", "gone:INBOX"), ("kept", "kept:INBOX")] {
            conn.execute(
                "INSERT INTO folders(id, account_id, json) VALUES (?1, ?2, '{}')",
                params![folder, acct],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_state(account_id, cursor) VALUES (?1, 'c')",
                params![acct],
            )
            .unwrap();
            kv_set_conn(&conn, &format!("backfill.{acct}"), "{}").unwrap();
        }
        kv_set_conn(&conn, "state.v1", "{}").unwrap();

        let mut ids = delete_account_conn(&mut conn, "gone").unwrap();
        ids.sort();
        assert_eq!(ids, vec!["1".to_string(), "2".to_string()]);
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            count("SELECT count(*) FROM messages WHERE account_id = 'gone'"),
            0
        );
        assert_eq!(
            count("SELECT count(*) FROM folders WHERE account_id = 'gone'"),
            0
        );
        assert_eq!(
            count("SELECT count(*) FROM sync_state WHERE account_id = 'gone'"),
            0
        );
        assert_eq!(kv_get_conn(&conn, "backfill.gone").unwrap(), None);
        // The other account and app state are untouched.
        assert_eq!(
            list_ids_conn(&conn, "kept", 10, None).unwrap(),
            vec!["3".to_string()]
        );
        assert_eq!(
            count("SELECT count(*) FROM folders WHERE account_id = 'kept'"),
            1
        );
        assert_eq!(
            count("SELECT count(*) FROM sync_state WHERE account_id = 'kept'"),
            1
        );
        assert!(kv_get_conn(&conn, "backfill.kept").unwrap().is_some());
        assert!(kv_get_conn(&conn, "state.v1").unwrap().is_some());
    }

    #[test]
    fn kv_upserts() {
        let conn = mem();
        assert_eq!(kv_get_conn(&conn, "a").unwrap(), None);
        kv_set_conn(&conn, "a", "1").unwrap();
        kv_set_conn(&conn, "a", "2").unwrap();
        assert_eq!(kv_get_conn(&conn, "a").unwrap().as_deref(), Some("2"));
    }

    #[test]
    fn messages_upsert_and_order_newest_first() {
        let mut conn = mem();
        let m = |id: &str, date: &str| CachedMessage {
            id: id.into(),
            folder_id: "inbox".into(),
            date: date.into(),
            json: "{}".into(),
        };
        put_messages_conn(
            &mut conn,
            "acct",
            &[m("1", "2026-10-01"), m("2", "2026-10-03")],
        )
        .unwrap();
        put_messages_conn(
            &mut conn,
            "acct",
            &[CachedMessage {
                folder_id: "archive".into(),
                ..m("1", "2026-10-01")
            }],
        )
        .unwrap();
        let rows = list_messages_conn(&conn, "acct", 10, None).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["2", "1"]
        );
        assert_eq!(rows[1].folder_id, "archive");
        assert!(
            list_messages_conn(&conn, "other", 10, None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn folders_keep_whole_inbox_beyond_limit() {
        let mut conn = mem();
        let mut rows = vec![];
        // 2,100 older Inbox rows, 400 newer non-Inbox rows.
        for i in 0..2100 {
            rows.push(CachedMessage {
                id: format!("i{i}"),
                folder_id: "inbox".into(),
                date: format!("2026-01-01T{:08}", i),
                json: "{}".into(),
            });
        }
        for i in 0..400 {
            rows.push(CachedMessage {
                id: format!("o{i}"),
                folder_id: "archive".into(),
                date: format!("2026-06-01T{:08}", i),
                json: "{}".into(),
            });
        }
        put_messages_conn(&mut conn, "acct", &rows).unwrap();
        assert_eq!(
            list_messages_conn(&conn, "acct", 500, None).unwrap().len(),
            500
        );
        let inbox = vec!["inbox".to_string()];
        let got = list_messages_conn(&conn, "acct", 500, Some(&inbox)).unwrap();
        assert_eq!(got.len(), 2100 + 400);
        assert_eq!(got.iter().filter(|m| m.folder_id == "inbox").count(), 2100);
        let ids: std::collections::HashSet<_> = got.iter().map(|m| &m.id).collect();
        assert_eq!(ids.len(), got.len());
        assert!(got.windows(2).all(|w| w[0].date >= w[1].date));
        assert!(
            list_messages_conn(&conn, "other", 500, Some(&inbox))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn list_rows_are_slim_and_get_returns_full() {
        let mut conn = mem();
        let text = "a".repeat(10_000);
        let full =
            serde_json::json!({ "id": "1", "subject": "Hi", "text": text, "html": "<p>big</p>" })
                .to_string();
        let row = |id: &str, date: &str, json: &str| CachedMessage {
            id: id.into(),
            folder_id: "inbox".into(),
            date: date.into(),
            json: json.into(),
        };
        put_messages_conn(&mut conn, "acct", &[row("1", "2026-10-01", &full)]).unwrap();
        let inbox = ["inbox".to_string()];
        // Both queries: the newest-`limit` one, and the folder one (limit 0 forces it).
        for (limit, folders) in [(10, None), (0, Some(&inbox[..]))] {
            let rows = list_messages_conn(&conn, "acct", limit, folders).unwrap();
            let v: serde_json::Value = serde_json::from_str(&rows[0].json).unwrap();
            assert!(v.get("html").is_none());
            assert_eq!(v["text"].as_str().unwrap().len(), 8000);
            assert_eq!(v["bodyTrimmed"], serde_json::Value::Bool(true));
            assert_eq!(v["subject"], "Hi");
        }
        // A row without text gets an empty string, not null.
        put_messages_conn(&mut conn, "acct", &[row("2", "2026-09-01", "{}")]).unwrap();
        let rows = list_messages_conn(&conn, "acct", 10, None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&rows[1].json).unwrap();
        assert_eq!(v["text"], "");
        // The full row is untouched.
        let got = get_message_conn(&conn, "1").unwrap().unwrap();
        assert_eq!(got.json, full);
        assert_eq!(got.folder_id, "inbox");
        assert!(get_message_conn(&conn, "missing").unwrap().is_none());
    }

    #[test]
    fn slim_write_back_keeps_stored_body() {
        let mut conn = mem();
        let text = "b".repeat(9_000);
        let full =
            serde_json::json!({ "id": "1", "unread": true, "text": text, "html": "<p>big</p>" })
                .to_string();
        let row = |json: &str, folder: &str| CachedMessage {
            id: "1".into(),
            folder_id: folder.into(),
            date: "2026-10-01".into(),
            json: json.into(),
        };
        put_messages_conn(&mut conn, "acct", &[row(&full, "inbox")]).unwrap();
        // The store writes back a listed (slim) row after marking it read and moving it.
        let mut slim: serde_json::Value =
            serde_json::from_str(&list_messages_conn(&conn, "acct", 10, None).unwrap()[0].json)
                .unwrap();
        slim["unread"] = serde_json::Value::Bool(false);
        put_messages_conn(&mut conn, "acct", &[row(&slim.to_string(), "archive")]).unwrap();
        let got = get_message_conn(&conn, "1").unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&got.json).unwrap();
        assert_eq!(got.folder_id, "archive");
        assert_eq!(v["unread"], serde_json::Value::Bool(false));
        assert_eq!(v["html"], "<p>big</p>");
        assert_eq!(v["text"].as_str().unwrap().len(), 9_000);
        assert!(v.get("bodyTrimmed").is_none());
        // A full write still replaces everything.
        let fresh = serde_json::json!({ "id": "1", "text": "new" }).to_string();
        put_messages_conn(&mut conn, "acct", &[row(&fresh, "inbox")]).unwrap();
        assert_eq!(get_message_conn(&conn, "1").unwrap().unwrap().json, fresh);
        // A stored row without html stays without html after a slim write.
        let slim2 = serde_json::json!({ "id": "1", "text": "n", "bodyTrimmed": true }).to_string();
        put_messages_conn(&mut conn, "acct", &[row(&slim2, "inbox")]).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&get_message_conn(&conn, "1").unwrap().unwrap().json).unwrap();
        assert!(v.get("html").is_none());
        assert_eq!(v["text"], "new");
    }

    #[test]
    fn ids_match_listing_rows() {
        let mut conn = mem();
        let m = |id: &str, folder: &str, date: &str| CachedMessage {
            id: id.into(),
            folder_id: folder.into(),
            date: date.into(),
            json: "{\"big\":1}".into(),
        };
        put_messages_conn(
            &mut conn,
            "acct",
            &[
                m("old-inbox", "inbox", "2026-01-01"),
                m("new-arch", "archive", "2026-10-03"),
                m("mid-inbox", "inbox", "2026-06-01"),
            ],
        )
        .unwrap();
        put_messages_conn(&mut conn, "other", &[m("x", "inbox", "2026-10-04")]).unwrap();
        let sorted = |mut v: Vec<String>| {
            v.sort();
            v
        };
        let inbox = vec!["inbox".to_string()];
        for (limit, folders) in [
            (1, None),
            (10, None),
            (1, Some(&inbox[..])),
            (0, Some(&inbox[..])),
        ] {
            let rows = list_messages_conn(&conn, "acct", limit, folders)
                .unwrap()
                .into_iter()
                .map(|r| r.id)
                .collect();
            assert_eq!(
                sorted(list_ids_conn(&conn, "acct", limit, folders).unwrap()),
                sorted(rows)
            );
        }
        assert_eq!(
            list_ids_conn(&conn, "acct", 1, None).unwrap(),
            vec!["new-arch"]
        );
        assert_eq!(
            sorted(list_ids_conn(&conn, "acct", 0, Some(&inbox)).unwrap()),
            vec!["mid-inbox", "old-inbox"]
        );
        assert_eq!(
            sorted(list_ids_conn(&conn, "acct", 1, Some(&inbox)).unwrap()),
            vec!["mid-inbox", "new-arch", "old-inbox"]
        );
        assert!(
            list_ids_conn(&conn, "nobody", 10, Some(&inbox))
                .unwrap()
                .is_empty()
        );
    }

    // ---- full-text search ----

    /// Best bm25 first, restricted to these accounts / folders (an empty list matches nothing).
    fn search_conn(
        conn: &Connection,
        query: &str,
        account_ids: Option<&[String]>,
        folder_ids: Option<&[String]>,
        limit: i64,
    ) -> Result<SearchResults, String> {
        let filter = SearchFilter {
            account_ids,
            folder_ids,
            ..SearchFilter::default()
        };
        search_filtered_conn(conn, query, &filter, limit)
    }

    fn mail(
        id: &str,
        folder: &str,
        date: &str,
        from: (&str, &str),
        subject: &str,
        text: &str,
    ) -> CachedMessage {
        CachedMessage {
            id: id.into(),
            folder_id: folder.into(),
            date: date.into(),
            json: serde_json::json!({
                "id": id,
                "from": { "name": from.0, "address": from.1 },
                "subject": subject,
                "snippet": "",
                "text": text,
                "html": "<p>html only words like htmlonlyword</p>",
                "unread": true,
            })
            .to_string(),
        }
    }

    fn hits(conn: &Connection, q: &str) -> Vec<String> {
        search_conn(conn, q, None, None, 500)
            .unwrap()
            .hits
            .into_iter()
            .map(|h| h.id)
            .collect()
    }

    fn sorted_hits(conn: &Connection, q: &str) -> Vec<String> {
        let mut v = hits(conn, q);
        v.sort();
        v
    }

    #[test]
    fn fts_insert_indexes_sender_subject_and_body() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "acct",
            &[
                mail(
                    "1",
                    "inbox",
                    "2026-10-01",
                    ("Alice Smith", "alice@example.com"),
                    "Quarterly budget",
                    "Please review the spreadsheet.",
                ),
                mail(
                    "2",
                    "inbox",
                    "2026-10-02",
                    ("Bob", "bob@other.org"),
                    "Lunch",
                    "Tacos tomorrow?",
                ),
            ],
        )
        .unwrap();
        assert_eq!(hits(&conn, "alice"), vec!["1"]);
        assert_eq!(hits(&conn, "alice@example.com"), vec!["1"]);
        assert_eq!(hits(&conn, "other.org"), vec!["2"]);
        assert_eq!(hits(&conn, "budget"), vec!["1"]);
        assert_eq!(hits(&conn, "spreadsheet"), vec!["1"]);
        assert_eq!(hits(&conn, "TACOS"), vec!["2"]);
        assert!(hits(&conn, "nonexistentword").is_empty());
        // html isn't indexed (text is the body).
        assert!(hits(&conn, "htmlonlyword").is_empty());
        let r = search_conn(&conn, "lunch", None, None, 10).unwrap();
        assert!(!r.indexing);
        assert_eq!(r.hits[0].account_id, "acct");
        assert_eq!(r.hits[0].folder_id, "inbox");
        assert_eq!(r.hits[0].date, "2026-10-02");
        assert!(r.hits[0].rank < 0.0);
    }

    #[test]
    fn fts_ranks_subject_and_sender_above_body_then_newest() {
        let mut conn = mem();
        let filler = "lorem ipsum dolor sit amet";
        put_messages_conn(
            &mut conn,
            "acct",
            &[
                mail(
                    "body",
                    "inbox",
                    "2026-10-05",
                    ("X", "x@x.com"),
                    "Hello",
                    &format!("{filler} kiwi {filler}"),
                ),
                mail(
                    "subj",
                    "inbox",
                    "2026-10-01",
                    ("Y", "y@y.com"),
                    "Kiwi",
                    filler,
                ),
                mail(
                    "from",
                    "inbox",
                    "2026-10-02",
                    ("Kiwi", "z@z.com"),
                    "Hello",
                    filler,
                ),
                mail(
                    "old",
                    "inbox",
                    "2026-01-01",
                    ("Q", "q@q.com"),
                    "Same",
                    "same",
                ),
                mail(
                    "new",
                    "inbox",
                    "2026-09-01",
                    ("Q", "q@q.com"),
                    "Same",
                    "same",
                ),
            ],
        )
        .unwrap();
        let got = hits(&conn, "kiwi");
        assert_eq!(got.len(), 3);
        assert_eq!(got.last().map(String::as_str), Some("body"));
        // Equal scores: newest first.
        assert_eq!(hits(&conn, "same"), vec!["new", "old"]);
    }

    #[test]
    fn fts_upsert_reindexes_and_flag_changes_keep_index() {
        let mut conn = mem();
        let m = |subject: &str, text: &str| {
            mail("1", "inbox", "2026-10-01", ("A", "a@a.com"), subject, text)
        };
        put_messages_conn(&mut conn, "acct", &[m("apple", "orchard")]).unwrap();
        assert_eq!(hits(&conn, "apple"), vec!["1"]);
        put_messages_conn(&mut conn, "acct", &[m("banana", "plantation")]).unwrap();
        assert!(hits(&conn, "apple").is_empty());
        assert!(hits(&conn, "orchard").is_empty());
        assert_eq!(hits(&conn, "banana"), vec!["1"]);
        assert_eq!(hits(&conn, "plantation"), vec!["1"]);
        // A flag-only change (indexed values unchanged) and a move keep the row, found once.
        let mut v: serde_json::Value =
            serde_json::from_str(&m("banana", "plantation").json).unwrap();
        v["unread"] = serde_json::Value::Bool(false);
        put_messages_conn(
            &mut conn,
            "acct",
            &[CachedMessage {
                json: v.to_string(),
                folder_id: "archive".into(),
                ..m("banana", "plantation")
            }],
        )
        .unwrap();
        let r = search_conn(&conn, "banana", None, None, 10).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].folder_id, "archive");
    }

    #[test]
    fn fts_slim_write_back_keeps_body_words() {
        let mut conn = mem();
        // A word past the 8,000 characters list rows keep.
        let text = format!("{} zebracrossing", "word ".repeat(1_800));
        put_messages_conn(
            &mut conn,
            "acct",
            &[mail(
                "1",
                "inbox",
                "2026-10-01",
                ("A", "a@a.com"),
                "Hi",
                &text,
            )],
        )
        .unwrap();
        assert_eq!(hits(&conn, "zebracrossing"), vec!["1"]);
        let mut slim: serde_json::Value =
            serde_json::from_str(&list_messages_conn(&conn, "acct", 10, None).unwrap()[0].json)
                .unwrap();
        assert!(!slim["text"].as_str().unwrap().contains("zebracrossing"));
        slim["unread"] = serde_json::Value::Bool(false);
        put_messages_conn(
            &mut conn,
            "acct",
            &[CachedMessage {
                id: "1".into(),
                folder_id: "archive".into(),
                date: "2026-10-01".into(),
                json: slim.to_string(),
            }],
        )
        .unwrap();
        assert_eq!(hits(&conn, "zebracrossing"), vec!["1"]);
    }

    #[test]
    fn fts_delete_and_delete_account() {
        let mut conn = mem();
        let m = |id: &str| {
            mail(
                id,
                "inbox",
                "2026-10-01",
                ("A", "a@a.com"),
                "shared",
                "words",
            )
        };
        put_messages_conn(&mut conn, "gone", &[m("1"), m("2")]).unwrap();
        put_messages_conn(&mut conn, "kept", &[m("3"), m("4")]).unwrap();
        delete_messages_conn(&mut conn, &["4".to_string()]).unwrap();
        assert_eq!(sorted_hits(&conn, "shared"), vec!["1", "2", "3"]);
        delete_account_conn(&mut conn, "gone").unwrap();
        assert_eq!(hits(&conn, "shared"), vec!["3"]);
        // Nothing is left for removed rows: a new row reusing a freed rowid starts clean.
        put_messages_conn(
            &mut conn,
            "kept",
            &[mail(
                "5",
                "inbox",
                "2026-10-01",
                ("B", "b@b.com"),
                "fresh",
                "content",
            )],
        )
        .unwrap();
        assert_eq!(hits(&conn, "shared"), vec!["3"]);
        assert_eq!(hits(&conn, "fresh"), vec!["5"]);
        // A row replaced by REPLACE conflict resolution (a new rowid) leaves nothing behind.
        conn.execute(
            "INSERT OR REPLACE INTO messages(id, account_id, folder_id, date, json)
             VALUES ('5', 'kept', 'inbox', '2026-10-01', '{\"subject\": \"replaced\"}')",
            [],
        )
        .unwrap();
        assert!(hits(&conn, "fresh").is_empty());
        assert_eq!(hits(&conn, "replaced"), vec!["5"]);
        let ghosts: i64 = conn
            .query_row(
                "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'fresh OR shared OR replaced'
                   AND rowid NOT IN (SELECT rowid FROM messages)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ghosts, 0);
    }

    #[test]
    fn fts_prefix_applies_to_last_word_only() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "acct",
            &[mail(
                "1",
                "inbox",
                "2026-10-01",
                ("A", "a@a.com"),
                "Invoice report",
                "",
            )],
        )
        .unwrap();
        assert_eq!(hits(&conn, "inv"), vec!["1"]);
        assert_eq!(hits(&conn, "report inv"), vec!["1"]);
        assert!(hits(&conn, "inv report").is_empty());
        assert_eq!(hits(&conn, "invoice report"), vec!["1"]);
    }

    #[test]
    fn fts_folds_diacritics_and_case() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "acct",
            &[
                mail(
                    "1",
                    "inbox",
                    "2026-10-01",
                    ("José Müller", "j@a.com"),
                    "Café",
                    "",
                ),
                mail(
                    "2",
                    "inbox",
                    "2026-10-01",
                    ("Plain", "p@a.com"),
                    "resume naive",
                    "",
                ),
            ],
        )
        .unwrap();
        assert_eq!(hits(&conn, "jose"), vec!["1"]);
        assert_eq!(hits(&conn, "MULLER"), vec!["1"]);
        assert_eq!(hits(&conn, "cafe"), vec!["1"]);
        assert_eq!(hits(&conn, "résumé naïve"), vec!["2"]);
    }

    #[test]
    fn fts_filters_by_account_and_folder() {
        let mut conn = mem();
        let m =
            |id: &str, folder: &str| mail(id, folder, "2026-10-01", ("A", "a@a.com"), "needle", "");
        put_messages_conn(&mut conn, "a1", &[m("1", "inbox"), m("2", "archive")]).unwrap();
        put_messages_conn(&mut conn, "a2", &[m("3", "inbox"), m("4", "spam")]).unwrap();
        let ids = |accounts: Option<&[&str]>, folders: Option<&[&str]>| {
            let own = |v: Option<&[&str]>| {
                v.map(|v| v.iter().map(ToString::to_string).collect::<Vec<_>>())
            };
            let (a, f) = (own(accounts), own(folders));
            let mut v: Vec<String> = search_conn(&conn, "needle", a.as_deref(), f.as_deref(), 100)
                .unwrap()
                .hits
                .into_iter()
                .map(|h| h.id)
                .collect();
            v.sort();
            v
        };
        assert_eq!(ids(None, None), vec!["1", "2", "3", "4"]);
        assert_eq!(ids(Some(&["a1"]), None), vec!["1", "2"]);
        assert_eq!(ids(None, Some(&["inbox"])), vec!["1", "3"]);
        assert_eq!(ids(Some(&["a2"]), Some(&["inbox", "archive"])), vec!["3"]);
        assert_eq!(ids(Some(&["a1", "a2"]), Some(&["spam"])), vec!["4"]);
        assert!(ids(Some(&[]), None).is_empty());
        assert!(ids(Some(&["nobody"]), None).is_empty());
        // Hostile ids are data, not SQL.
        assert!(ids(Some(&["a1') OR 1=1 --"]), None).is_empty());
    }

    #[test]
    fn fts_date_order_keeps_the_newest_matches() {
        let mut conn = mem();
        // 520 strong matches (word in the subject), all older than 30 weak ones (word in the body).
        let mut rows: Vec<_> = (0..520)
            .map(|i| {
                mail(
                    &format!("s{i:03}"),
                    "archive",
                    &format!("2024-01-01T{i:08}"),
                    ("A", "a@a.com"),
                    "parking",
                    "",
                )
            })
            .collect();
        rows.extend((0..30).map(|i| {
            mail(
                &format!("w{i:02}"),
                "inbox",
                &format!("2026-01-01T{i:08}"),
                ("B", "b@b.com"),
                "hello",
                "about parking later",
            )
        }));
        put_messages_conn(&mut conn, "acct", &rows).unwrap();
        let run = |order: SearchOrder, limit: i64| {
            let filter = SearchFilter {
                order,
                ..SearchFilter::default()
            };
            search_filtered_conn(&conn, "parking", &filter, limit)
                .unwrap()
                .hits
        };
        // Best matches first: the newest of the strong ones, none of the newer weak ones.
        let ranked = run(SearchOrder::Rank, 500);
        assert_eq!(ranked.len(), 500);
        assert!(ranked.iter().all(|h| h.id.starts_with('s')));
        // By date over every match: the 30 newest are the weak ones, then the newest strong ones.
        let dated = run(SearchOrder::Date, 500);
        assert_eq!(dated.len(), 500);
        let ids: Vec<&str> = dated.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids[0], "w29");
        assert_eq!(ids[29], "w00");
        assert_eq!(ids[30], "s519");
        assert_eq!(ids[499], "s050");
        assert!(dated.windows(2).all(|w| w[0].date >= w[1].date));
        // The default order is still rank, as search_conn uses.
        assert_eq!(SearchOrder::default(), SearchOrder::Rank);
        assert_eq!(run(SearchOrder::Date, 3).len(), 3);
        assert_eq!(
            search_conn(&conn, "parking", None, None, 500).unwrap().hits,
            ranked
        );
    }

    #[test]
    fn fts_excludes_folders_and_filters_starred() {
        let mut conn = mem();
        let m = |id: &str, folder: &str, starred: bool| {
            let mut c = mail(id, folder, "2026-10-01", ("A", "a@a.com"), "needle", "");
            let mut j: serde_json::Value = serde_json::from_str(&c.json).unwrap();
            j["starred"] = serde_json::Value::Bool(starred);
            c.json = j.to_string();
            c
        };
        put_messages_conn(
            &mut conn,
            "a1",
            &[
                m("1", "inbox", false),
                m("2", "archive", true),
                m("3", "spam", true),
                m("4", "trash", false),
            ],
        )
        .unwrap();
        let own = |v: &[&str]| v.iter().map(ToString::to_string).collect::<Vec<_>>();
        let ids = |filter: SearchFilter| {
            let mut v: Vec<String> = search_filtered_conn(&conn, "needle", &filter, 100)
                .unwrap()
                .hits
                .into_iter()
                .map(|h| h.id)
                .collect();
            v.sort();
            v
        };
        let junk = own(&["spam", "trash"]);
        let none: Vec<String> = vec![];
        let hostile = own(&["spam') OR 1=1 --"]);
        let inbox = own(&["inbox", "archive"]);
        assert_eq!(
            ids(SearchFilter {
                exclude_folder_ids: Some(&junk),
                ..SearchFilter::default()
            }),
            vec!["1", "2"]
        );
        // An empty exclude list leaves nothing out; a hostile id is data.
        assert_eq!(
            ids(SearchFilter {
                exclude_folder_ids: Some(&none),
                ..SearchFilter::default()
            }),
            vec!["1", "2", "3", "4"]
        );
        assert_eq!(
            ids(SearchFilter {
                exclude_folder_ids: Some(&hostile),
                ..SearchFilter::default()
            }),
            vec!["1", "2", "3", "4"]
        );
        assert_eq!(
            ids(SearchFilter {
                starred: true,
                ..SearchFilter::default()
            }),
            vec!["2", "3"]
        );
        assert_eq!(
            ids(SearchFilter {
                starred: true,
                exclude_folder_ids: Some(&junk),
                ..SearchFilter::default()
            }),
            vec!["2"]
        );
        assert_eq!(
            ids(SearchFilter {
                folder_ids: Some(&inbox),
                exclude_folder_ids: Some(&junk),
                ..SearchFilter::default()
            }),
            vec!["1", "2"]
        );
    }

    #[test]
    fn rows_by_id_are_slim_newest_first_and_bounded() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "acct",
            &[
                mail("old", "archive", "2020-01-01", ("A", "a@a.com"), "s", "old body"),
                mail("new", "inbox", "2026-01-01", ("A", "a@a.com"), "s", "new body"),
                mail("mid", "sent", "2023-01-01", ("A", "a@a.com"), "s", &"x".repeat(9000)),
            ],
        )
        .unwrap();
        let ids = |v: &[&str]| v.iter().map(ToString::to_string).collect::<Vec<_>>();
        let rows = get_rows_conn(&conn, &ids(&["old", "mid", "missing", "new"])).unwrap();
        let got: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| (r.id.as_str(), r.folder_id.as_str()))
            .collect();
        assert_eq!(got, vec![("new", "inbox"), ("mid", "sent"), ("old", "archive")]);
        for r in &rows {
            let j: serde_json::Value = serde_json::from_str(&r.json).unwrap();
            assert!(j.get("html").is_none(), "{} kept its html", r.id);
            assert_eq!(j["bodyTrimmed"], serde_json::Value::Bool(true));
        }
        let mid: serde_json::Value = serde_json::from_str(&rows[1].json).unwrap();
        assert_eq!(mid["text"].as_str().unwrap().len(), 8000);
        // Same shape as the listing's rows.
        let listed = list_messages_conn(&conn, "acct", 10, None).unwrap();
        assert_eq!(listed, rows);
        assert!(get_rows_conn(&conn, &[]).unwrap().is_empty());
        assert!(get_rows_conn(&conn, &ids(&["old') OR 1=1 --"])).unwrap().is_empty());
        // At most ROWS_MAX ids are read.
        let many: Vec<_> = (0..ROWS_MAX + 20)
            .map(|i| mail(&format!("m{i}"), "inbox", "2025-01-01", ("A", "a@a.com"), "s", ""))
            .collect();
        put_messages_conn(&mut conn, "acct", &many).unwrap();
        let all: Vec<String> = many.iter().map(|m| m.id.clone()).collect();
        assert_eq!(get_rows_conn(&conn, &all).unwrap().len(), ROWS_MAX);
    }

    #[test]
    fn fts_limit_is_clamped() {
        let mut conn = mem();
        let rows: Vec<_> = (0..600)
            .map(|i| {
                mail(
                    &format!("m{i}"),
                    "inbox",
                    &format!("2026-01-01T{i:08}"),
                    ("A", "a@a.com"),
                    "common",
                    "",
                )
            })
            .collect();
        put_messages_conn(&mut conn, "acct", &rows).unwrap();
        let n = |limit: i64| {
            search_conn(&conn, "common", None, None, limit)
                .unwrap()
                .hits
                .len()
        };
        assert_eq!(n(0), 1);
        assert_eq!(n(-5), 1);
        assert_eq!(n(i64::MIN), 1);
        assert_eq!(n(7), 7);
        assert_eq!(n(500), 500);
        assert_eq!(n(10_000), 500);
        assert_eq!(n(i64::MAX), 500);
    }

    #[test]
    fn fts_query_quotes_every_word() {
        assert_eq!(fts_query("hello"), Some("\"hello\"*".into()));
        assert_eq!(fts_query("  a   b "), Some("\"a\" AND \"b\"*".into()));
        assert_eq!(
            fts_query("say \"hi\""),
            Some("\"say\" AND \"\"\"hi\"\"\"*".into())
        );
        assert_eq!(
            fts_query("subject:foo OR bar"),
            Some("\"subject:foo\" AND \"OR\" AND \"bar\"*".into())
        );
        assert_eq!(fts_query(""), None);
        assert_eq!(fts_query(" \t\n "), None);
        assert_eq!(fts_query("\" * ( ) : ^ - + ."), None);
        assert_eq!(fts_query("a\0b"), Some("\"a\" AND \"b\"*".into()));
        let many = "w ".repeat(100);
        assert_eq!(
            fts_query(&many).unwrap().matches("AND").count(),
            FTS_QUERY_MAX_WORDS - 1
        );
    }

    #[test]
    fn fts_hostile_input_is_literal_and_never_errors() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "acct",
            &[
                mail(
                    "apple",
                    "inbox",
                    "2026-10-01",
                    ("A", "a@a.com"),
                    "apple pie",
                    "fruit",
                ),
                mail(
                    "banana",
                    "inbox",
                    "2026-10-02",
                    ("B", "b@b.com"),
                    "banana bread",
                    "fruit",
                ),
                mail(
                    "ops",
                    "inbox",
                    "2026-10-03",
                    ("C", "c@c.com"),
                    "not near or and",
                    "subject foo",
                ),
            ],
        )
        .unwrap();
        let hostile = [
            "",
            " ",
            "\t\n",
            "\"",
            "\"\"",
            "\"\"\"",
            "*",
            "**",
            "(",
            ")",
            "()",
            ":",
            "^",
            "-",
            "+",
            "NEAR",
            "NEAR(",
            "NEAR(apple banana, 2)",
            "AND",
            "OR",
            "NOT",
            "apple AND",
            "OR apple",
            "NOT apple",
            "apple NOT banana",
            "apple OR banana",
            "-apple",
            "^apple",
            "apple*",
            "*apple",
            "\"apple",
            "apple\"",
            "\"apple pie\"",
            "(apple",
            "apple)",
            "subject:apple",
            "subject : apple",
            "{subject body}:apple",
            "body:",
            "rank:",
            "rowid:1",
            "-subject:apple",
            "a\0pple",
            "\u{200b}",
            "🍎",
            "apple 🍎",
            "%",
            "_",
            "'",
            "';--",
            "\\",
            "apple\\",
            "x:y:z",
            "NEAR/2",
            "apple + banana",
            "col1 : (",
            ") OR (",
            "\u{0301}",
            "e\u{0301}",
        ];
        for q in hostile {
            let r = search_conn(&conn, q, None, None, 50);
            assert!(r.is_ok(), "query {q:?} errored: {r:?}");
        }
        // Operators are words, not operators: no row has "or" alongside apple and banana...
        assert!(hits(&conn, "apple OR banana").is_empty());
        // ...and NOT, '-', '^' and column filters don't exclude, anchor or restrict.
        assert_eq!(hits(&conn, "-apple"), vec!["apple"]);
        assert_eq!(hits(&conn, "^apple"), vec!["apple"]);
        assert_eq!(hits(&conn, "not near"), vec!["ops"]);
        // A word with punctuation inside is a phrase of its parts, as the tokenizer splits it.
        assert!(hits(&conn, "NEAR(apple").is_empty());
        assert_eq!(hits(&conn, "NEAR(or"), vec!["ops"]);
        assert_eq!(hits(&conn, "subject:foo"), vec!["ops"]);
        assert_eq!(hits(&conn, "\"apple pie\""), vec!["apple"]);
        assert_eq!(sorted_hits(&conn, "fruit*"), vec!["apple", "banana"]);
        for q in ["", "   ", "\"", "* ( ) : ^ -"] {
            let r = search_conn(&conn, q, None, None, 50).unwrap();
            assert!(r.hits.is_empty());
        }
    }

    #[test]
    fn fts_body_is_capped_and_snippet_backs_up_empty_text() {
        let mut conn = mem();
        let before = format!("{} earlyword", "x".repeat(FTS_BODY_CAP as usize - 20));
        let text = format!("{before} {} lateword", "y ".repeat(100));
        put_messages_conn(
            &mut conn,
            "acct",
            &[mail(
                "1",
                "inbox",
                "2026-10-01",
                ("A", "a@a.com"),
                "Hi",
                &text,
            )],
        )
        .unwrap();
        assert_eq!(hits(&conn, "earlyword"), vec!["1"]);
        assert!(hits(&conn, "lateword").is_empty());
        // A header-only row (no text yet) is found by its snippet.
        let partial =
            serde_json::json!({ "id": "2", "subject": "s", "snippet": "previewword", "text": "" })
                .to_string();
        put_messages_conn(
            &mut conn,
            "acct",
            &[CachedMessage {
                id: "2".into(),
                folder_id: "inbox".into(),
                date: "2026-10-01".into(),
                json: partial,
            }],
        )
        .unwrap();
        assert_eq!(hits(&conn, "previewword"), vec!["2"]);
        // A row that isn't valid JSON still stores (and deletes), just unindexed.
        put_messages_conn(
            &mut conn,
            "acct",
            &[CachedMessage {
                id: "3".into(),
                folder_id: "inbox".into(),
                date: "2026-10-01".into(),
                json: "not json".into(),
            }],
        )
        .unwrap();
        assert!(get_message_conn(&conn, "3").unwrap().is_some());
        delete_messages_conn(&mut conn, &["3".to_string()]).unwrap();
        assert!(get_message_conn(&conn, "3").unwrap().is_none());
    }

    #[test]
    fn fts_backfill_indexes_old_rows_and_resumes() {
        // A cache written before the index existed: no FTS table, no triggers.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let rows: Vec<_> = (0..10)
            .map(|i| {
                mail(
                    &format!("m{i}"),
                    "inbox",
                    &format!("2026-10-{:02}", i + 1),
                    ("A", "a@a.com"),
                    "oldmail",
                    &format!("unique{i}"),
                )
            })
            .collect();
        put_messages_conn(&mut conn, "acct", &rows).unwrap();
        init(&conn).unwrap();
        let r = search_conn(&conn, "oldmail", None, None, 50).unwrap();
        assert!(r.indexing);
        assert!(r.hits.is_empty());

        // A partial run.
        assert!(fts_backfill_step(&mut conn, 3).unwrap());
        assert_eq!(hits(&conn, "oldmail").len(), 3);
        assert!(
            search_conn(&conn, "oldmail", None, None, 50)
                .unwrap()
                .indexing
        );

        // Meanwhile: a not-yet-indexed row is deleted, another rewritten, a new one arrives,
        // and an already-indexed one is rewritten.
        delete_messages_conn(&mut conn, &["m7".to_string()]).unwrap();
        put_messages_conn(
            &mut conn,
            "acct",
            &[mail(
                "m8",
                "inbox",
                "2026-10-09",
                ("A", "a@a.com"),
                "oldmail",
                "rewritten",
            )],
        )
        .unwrap();
        put_messages_conn(
            &mut conn,
            "acct",
            &[mail(
                "new",
                "inbox",
                "2026-10-20",
                ("A", "a@a.com"),
                "oldmail",
                "arrived",
            )],
        )
        .unwrap();
        put_messages_conn(
            &mut conn,
            "acct",
            &[mail(
                "m0",
                "inbox",
                "2026-10-01",
                ("A", "a@a.com"),
                "oldmail",
                "changed",
            )],
        )
        .unwrap();

        // A restart: init again keeps the progress.
        init(&conn).unwrap();
        assert!(
            search_conn(&conn, "oldmail", None, None, 50)
                .unwrap()
                .indexing
        );
        let mut steps = 0;
        while fts_backfill_step(&mut conn, 3).unwrap() {
            steps += 1;
            assert!(steps < 10);
        }
        let r = search_conn(&conn, "oldmail", None, None, 50).unwrap();
        assert!(!r.indexing);
        let mut ids: Vec<_> = r.hits.into_iter().map(|h| h.id).collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m8", "m9", "new"]
        );
        assert!(hits(&conn, "unique7").is_empty());
        assert!(hits(&conn, "unique8").is_empty());
        assert!(hits(&conn, "unique0").is_empty());
        assert_eq!(hits(&conn, "rewritten"), vec!["m8"]);
        assert_eq!(hits(&conn, "changed"), vec!["m0"]);
        assert_eq!(hits(&conn, "arrived"), vec!["new"]);
        assert_eq!(hits(&conn, "unique9"), vec!["m9"]);
        // Done: further steps are no-ops.
        assert!(!fts_backfill_step(&mut conn, 3).unwrap());
    }

    #[test]
    fn fts_version_bump_rebuilds_the_index() {
        let mut conn = mem();
        assert_eq!(
            kv_get_conn(&conn, FTS_VERSION_KEY).unwrap().as_deref(),
            Some(FTS_VERSION)
        );
        // An empty cache has nothing to backfill.
        assert!(kv_get_conn(&conn, FTS_BACKFILL_KEY).unwrap().is_none());
        put_messages_conn(
            &mut conn,
            "acct",
            &[mail(
                "1",
                "inbox",
                "2026-10-01",
                ("A", "a@a.com"),
                "keepme",
                "",
            )],
        )
        .unwrap();
        kv_set_conn(&conn, FTS_VERSION_KEY, "0").unwrap();
        init(&conn).unwrap();
        assert_eq!(
            kv_get_conn(&conn, FTS_VERSION_KEY).unwrap().as_deref(),
            Some(FTS_VERSION)
        );
        let r = search_conn(&conn, "keepme", None, None, 50).unwrap();
        assert!(r.indexing && r.hits.is_empty());
        while fts_backfill_step(&mut conn, 100).unwrap() {}
        assert_eq!(hits(&conn, "keepme"), vec!["1"]);
        // A missing trigger is recreated too.
        conn.execute_batch("DROP TRIGGER messages_fts_ad").unwrap();
        init(&conn).unwrap();
        while fts_backfill_step(&mut conn, 100).unwrap() {}
        delete_messages_conn(&mut conn, &["1".to_string()]).unwrap();
        assert!(hits(&conn, "keepme").is_empty());
    }

    #[test]
    fn any_word_search_skips_stop_words_and_keeps_to_the_filter() {
        assert_eq!(
            fts_query_any("When is my FLIGHT to Tokyo? tokyo").as_deref(),
            Some("\"flight\" OR \"tokyo\"")
        );
        assert_eq!(fts_query_any("the and of"), None);
        // Operators are words; quotes and stars never reach FTS5.
        assert_eq!(
            fts_query_any("\"a\" OR NEAR(x)* subject:y").as_deref(),
            Some("\"near\" OR \"x\" OR \"subject\" OR \"y\"")
        );
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "a",
            &[
                mail(
                    "1",
                    "inbox",
                    "2026-10-01",
                    ("A", "a@a.com"),
                    "Flight",
                    "to Tokyo",
                ),
                mail(
                    "2",
                    "spam",
                    "2026-10-02",
                    ("B", "b@b.com"),
                    "Tokyo deals",
                    "cheap",
                ),
                mail(
                    "3",
                    "inbox",
                    "2026-10-03",
                    ("C", "c@c.com"),
                    "Lunch",
                    "tacos",
                ),
            ],
        )
        .unwrap();
        let spam = vec!["spam".to_string()];
        let filter = SearchFilter {
            exclude_folder_ids: Some(&spam),
            ..SearchFilter::default()
        };
        let got = search_any_conn(&conn, "flight to tokyo", &filter, 10).unwrap();
        assert_eq!(
            got.iter().map(|(_, h)| h.id.as_str()).collect::<Vec<_>>(),
            vec!["1"]
        );
        let all = search_any_conn(&conn, "flight tokyo", &SearchFilter::default(), 10).unwrap();
        assert_eq!(all.len(), 2);
        // By rowid, within the filter, with an extra condition.
        let rowids: Vec<i64> = all.iter().map(|(r, _)| *r).collect();
        let kept = rows_in_scope_conn(&conn, &rowids, &filter, "1").unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept.values().next().unwrap().id, "1");
        assert!(
            rows_in_scope_conn(&conn, &rowids, &filter, "0")
                .unwrap()
                .is_empty()
        );
        assert!(
            rows_in_scope_conn(&conn, &[], &filter, "1")
                .unwrap()
                .is_empty()
        );
    }

    /// Measures the backfill on a COPY of a real cache; never point it at the live file.
    /// `ZMAIL_FTS_BENCH_DB=/path/to/copy.sqlite3 cargo test --release --lib fts_bench -- --ignored --nocapture`
    #[test]
    #[ignore = "needs ZMAIL_FTS_BENCH_DB pointing at a copy of a real cache"]
    fn fts_bench() {
        let path = std::env::var("ZMAIL_FTS_BENCH_DB").unwrap();
        let mut conn = Connection::open(&path).unwrap();
        let fts_bytes = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT coalesce(sum(pgsize), 0) FROM dbstat WHERE name LIKE 'messages_fts%'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        let t = std::time::Instant::now();
        init(&conn).unwrap();
        println!("rows {rows}; init {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let (mut batches, mut slowest) = (0, Duration::ZERO);
        loop {
            let b = std::time::Instant::now();
            let more = fts_backfill_step(&mut conn, FTS_BACKFILL_BATCH).unwrap();
            slowest = slowest.max(b.elapsed());
            batches += 1;
            if !more {
                break;
            }
        }
        println!(
            "backfill {:?} in {batches} batches of {FTS_BACKFILL_BATCH}; slowest batch {slowest:?}",
            t.elapsed()
        );
        println!("index size {:.1} MB", fts_bytes(&conn) as f64 / 1e6);
        let words = std::env::var("ZMAIL_FTS_BENCH_WORDS").unwrap_or_else(|_| {
            "the,please,meeting,thanks,a,re,budget report,xylophone,zqxjvw".into()
        });
        for q in words.split(',') {
            let _ = search_conn(&conn, q, None, None, 50).unwrap();
            let n = 5;
            let t = std::time::Instant::now();
            let mut count = 0;
            for _ in 0..n {
                count = search_conn(&conn, q, None, None, 50).unwrap().hits.len();
            }
            let avg = t.elapsed() / n;
            let total: i64 = conn
                .query_row(
                    "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?1",
                    params![fts_query(q).unwrap()],
                    |r| r.get(0),
                )
                .unwrap();
            println!("query {q:?}: {avg:?} avg, {count} returned of {total} matches");
        }
    }
}
