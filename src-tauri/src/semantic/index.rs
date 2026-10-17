//! The vector index: one vector per cached email and up to `PASSAGES_MAX` passage vectors, keyed
//! to `messages.rowid` like `messages_fts` (the same rowid caveats apply: see db.rs).
//!
//! `vec_pending` lists the emails still to embed, newest first. Triggers keep all three tables in
//! step with `messages`: a new or changed email is queued (and loses its old vectors), a deleted
//! one leaves nothing behind, so removing an account removes its vectors too. The triggers exist
//! from the first time the feature is turned on until its index is deleted, so vectors kept while
//! it's off are still cleaned up.
//!
//! Embedding happens without the database lock. A batch's vectors are written only if each email
//! still reads exactly as it did when it was embedded; otherwise it stays queued for another pass.

use super::embed::{DIMS, Embed, Priority};
use super::text;
use crate::db;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;

/// Bump when what's embedded changes (prompts, cleaning, passages, dims) or the triggers do:
/// with a different model revision too, every email is embedded again.
const INDEX_VERSION: &str = "1";
const VERSION_KEY: &str = "vec.version";

pub fn version() -> String {
    format!("{}:{INDEX_VERSION}", super::model::MODEL_REVISION)
}

const TABLES: &str = "
CREATE TABLE IF NOT EXISTS vec_docs (id INTEGER PRIMARY KEY, v BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS vec_passages (id INTEGER PRIMARY KEY, v BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS vec_pending (id INTEGER PRIMARY KEY, date TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS vec_pending_date ON vec_pending(date DESC);
";

const TRIGGERS: [&str; 3] = ["messages_vec_ai", "messages_vec_ad", "messages_vec_au"];

/// The embedded fields of a JSON value `j`, as one SQL row value: what decides an email's vectors.
fn fields(j: &str) -> String {
    format!(
        "{j} ->> '$.subject', {j} ->> '$.from.name', {j} ->> '$.from.address', \
         coalesce(nullif({j} ->> '$.text', ''), {j} ->> '$.snippet')"
    )
}

fn json_or_empty(src: &str) -> String {
    format!("CASE WHEN json_valid({src}) THEN {src} ELSE '{{}}' END")
}

fn triggers_sql() -> String {
    let row = |r: &str| {
        format!(
            "(SELECT {} FROM (SELECT {} AS j))",
            fields("j"),
            json_or_empty(&format!("{r}.json"))
        )
    };
    let queue = "INSERT INTO vec_pending(id, date) VALUES (NEW.rowid, NEW.date)
                 ON CONFLICT(id) DO UPDATE SET date = excluded.date;";
    let forget = |r: &str| {
        format!(
            "DELETE FROM vec_docs WHERE id = {r}.rowid; DELETE FROM vec_passages WHERE id = {r}.rowid;"
        )
    };
    format!(
        "DROP TRIGGER IF EXISTS messages_vec_ai;
         DROP TRIGGER IF EXISTS messages_vec_ad;
         DROP TRIGGER IF EXISTS messages_vec_au;
         CREATE TRIGGER messages_vec_ai AFTER INSERT ON messages BEGIN
           {queue}
         END;
         CREATE TRIGGER messages_vec_ad AFTER DELETE ON messages BEGIN
           {forget_old}
           DELETE FROM vec_pending WHERE id = OLD.rowid;
         END;
         -- Only when an embedded value changes: flag and folder write-backs keep the vectors.
         CREATE TRIGGER messages_vec_au AFTER UPDATE ON messages
         WHEN OLD.rowid IS NOT NEW.rowid OR (OLD.json IS NOT NEW.json AND {old} IS NOT {new})
         BEGIN
           {forget_old}
           DELETE FROM vec_pending WHERE id = OLD.rowid AND OLD.rowid IS NOT NEW.rowid;
           {queue}
         END;",
        forget_old = forget("OLD"),
        old = row("OLD"),
        new = row("NEW"),
    )
}

/// The tables (empty until the feature is turned on). Called from `db::init`.
pub fn init_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(TABLES).map_err(|e| e.to_string())
}

pub fn installed(conn: &Connection) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (?1, ?2, ?3)",
            params![TRIGGERS[0], TRIGGERS[1], TRIGGERS[2]],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n == 3)
}

/// Start (or keep) indexing: the triggers, and every email without vectors queued. Vectors made
/// for another model revision or index version are dropped and everything is queued again. One
/// transaction, so every email is either written after the triggers or queued here. Cheap when
/// it's already in place at this version (each launch calls it): nothing is read then.
pub fn install(conn: &Connection) -> Result<(), String> {
    let e = |e: rusqlite::Error| e.to_string();
    let same_version = db::kv_get_conn(conn, VERSION_KEY)?.as_deref() == Some(version().as_str());
    if same_version && installed(conn)? {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute_batch(&triggers_sql()).map_err(e)?;
    if !same_version {
        tx.execute_batch(
            "DELETE FROM vec_docs; DELETE FROM vec_passages; DELETE FROM vec_pending;",
        )
        .map_err(e)?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO vec_pending(id, date)
         SELECT rowid, date FROM messages m WHERE NOT EXISTS (SELECT 1 FROM vec_docs v WHERE v.id = m.rowid)",
        [],
    )
    .map_err(e)?;
    db::kv_set_conn(&tx, VERSION_KEY, &version())?;
    tx.commit().map_err(e)
}

/// Delete the index: every vector, the queue and the triggers.
pub fn uninstall(conn: &Connection) -> Result<(), String> {
    let e = |e: rusqlite::Error| e.to_string();
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute_batch(
        "DROP TRIGGER IF EXISTS messages_vec_ai;
         DROP TRIGGER IF EXISTS messages_vec_ad;
         DROP TRIGGER IF EXISTS messages_vec_au;
         DELETE FROM vec_docs; DELETE FROM vec_passages; DELETE FROM vec_pending;",
    )
    .map_err(e)?;
    tx.execute("DELETE FROM kv WHERE key = ?1", params![VERSION_KEY])
        .map_err(e)?;
    tx.commit().map_err(e)
}

/// (emails with vectors, cached emails). Cheap: counts the queue and the mail, never the vectors.
pub fn progress(conn: &Connection) -> Result<(u64, u64), String> {
    let e = |e: rusqlite::Error| e.to_string();
    let total: i64 = conn
        .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
        .map_err(e)?;
    if !installed(conn)? {
        return Ok((0, total as u64));
    }
    let pending: i64 = conn
        .query_row("SELECT count(*) FROM vec_pending", [], |r| r.get(0))
        .map_err(e)?;
    Ok(((total - pending).max(0) as u64, total as u64))
}

/// Whether any email has a vector.
pub fn has_vectors(conn: &Connection) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS (SELECT 1 FROM vec_docs)", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// What an email's vectors are made from, as it read when queued.
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub id: i64,
    pub subject: Option<String>,
    pub name: Option<String>,
    pub address: Option<String>,
    pub body: Option<String>,
}

fn read_sources(
    conn: &Connection,
    where_sql: &str,
    p: impl rusqlite::Params,
) -> Result<Vec<Source>, String> {
    let sql = format!(
        "SELECT id, {} FROM (SELECT m.rowid AS id, {} AS j FROM {where_sql})",
        fields("j"),
        json_or_empty("m.json")
    );
    let mut stmt = conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
    // Read lossily: one email whose text isn't valid UTF-8 would otherwise fail every batch it's
    // in, and stay queued (newest first) so the indexer never got past it.
    stmt.query_map(p, |r| {
        Ok(Source {
            id: r.get(0)?,
            subject: db::lossy_text(r, 1)?,
            name: db::lossy_text(r, 2)?,
            address: db::lossy_text(r, 3)?,
            body: db::lossy_text(r, 4)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<_, _>>()
    .map_err(|e| e.to_string())
}

/// The newest `n` queued emails.
pub fn next_batch(conn: &Connection, n: u32) -> Result<Vec<Source>, String> {
    read_sources(
        conn,
        "vec_pending p JOIN messages m ON m.rowid = p.id ORDER BY p.date DESC LIMIT ?1",
        params![n.max(1)],
    )
}

fn source_of(conn: &Connection, id: i64) -> Result<Option<Source>, String> {
    Ok(read_sources(conn, "messages m WHERE m.rowid = ?1", params![id])?.pop())
}

/// An email's prompts: its document, and its passages (with each passage's text).
pub struct Prompts {
    pub doc: String,
    pub passages: Vec<String>,
}

pub fn prompts(s: &Source) -> Prompts {
    let subject = s.subject.as_deref().unwrap_or("");
    let body = text::clean_body(s.body.as_deref().unwrap_or(""));
    Prompts {
        doc: text::doc_prompt(
            subject,
            s.name.as_deref().unwrap_or(""),
            s.address.as_deref().unwrap_or(""),
            &body,
        ),
        passages: text::passages(&body)
            .iter()
            .map(|p| text::passage_prompt(subject, p))
            .collect(),
    }
}

/// The text of an email's passage `n`, as it was embedded (None past its last one).
pub fn passage_text(s: &Source, n: usize) -> Option<String> {
    let body = text::clean_body(s.body.as_deref().unwrap_or(""));
    text::passages(&body).into_iter().nth(n)
}

pub fn to_blob(vs: &[Vec<f32>]) -> Vec<u8> {
    vs.iter().flatten().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// One embedded email, ready to write.
pub struct Embedded {
    pub source: Source,
    pub doc: Option<Vec<f32>>,
    pub passages: Vec<Vec<f32>>,
}

/// Embed `batch` (no lock needed). Documents and passages go in separate, small jobs so a search
/// never waits long behind them.
pub fn embed_batch(embedder: &dyn Embed, batch: Vec<Source>) -> Result<Vec<Embedded>, String> {
    const DOCS_PER_JOB: usize = 8;
    const PASSAGES_PER_JOB: usize = 32;
    let prompts: Vec<Prompts> = batch.iter().map(prompts).collect();
    let docs: Vec<String> = prompts.iter().map(|p| p.doc.clone()).collect();
    let mut doc_vecs = Vec::with_capacity(docs.len());
    for chunk in docs.chunks(DOCS_PER_JOB) {
        doc_vecs.extend(embedder.embed(chunk, Priority::Index)?);
    }
    let all: Vec<String> = prompts.iter().flat_map(|p| p.passages.clone()).collect();
    let mut passage_vecs = Vec::with_capacity(all.len());
    for chunk in all.chunks(PASSAGES_PER_JOB) {
        passage_vecs.extend(embedder.embed(chunk, Priority::Index)?);
    }
    let mut passage_vecs = passage_vecs.into_iter();
    Ok(batch
        .into_iter()
        .zip(prompts)
        .zip(doc_vecs)
        .map(|((source, p), doc)| {
            // A non-finite passage vector is a zero vector: kept so passage numbers stay aligned.
            let passages = passage_vecs
                .by_ref()
                .take(p.passages.len())
                .map(|v| v.unwrap_or_else(|| vec![0.0; DIMS]))
                .collect();
            Embedded {
                source,
                doc,
                passages,
            }
        })
        .collect())
}

/// Write what still matches the email it was made from, and take those emails off the queue.
/// Returns the document vectors written, for the in-memory copy. An email that changed or went
/// away meanwhile writes nothing (a change re-queued it; a deletion removed it from the queue).
pub fn write_batch(
    conn: &mut Connection,
    done: Vec<Embedded>,
) -> Result<Vec<(i64, Vec<f32>)>, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let tx = conn.transaction().map_err(e)?;
    let mut written = vec![];
    if installed(&tx)? {
        for item in done {
            let id = item.source.id;
            if source_of(&tx, id)?.as_ref() != Some(&item.source) {
                continue;
            }
            if let Some(doc) = &item.doc {
                tx.execute(
                    "INSERT OR REPLACE INTO vec_docs(id, v) VALUES (?1, ?2)",
                    params![id, to_blob(std::slice::from_ref(doc))],
                )
                .map_err(e)?;
                if !item.passages.is_empty() {
                    tx.execute(
                        "INSERT OR REPLACE INTO vec_passages(id, v) VALUES (?1, ?2)",
                        params![id, to_blob(&item.passages)],
                    )
                    .map_err(e)?;
                }
                written.push((id, doc.clone()));
            }
            // A vector that came out non-finite isn't retried forever: the email just has none.
            tx.execute("DELETE FROM vec_pending WHERE id = ?1", params![id])
                .map_err(e)?;
        }
    }
    tx.commit().map_err(e)?;
    Ok(written)
}

/// Every document vector, for the in-memory copy search scans.
pub fn load_all(conn: &Connection) -> Result<Vec<(i64, Vec<f32>)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, v FROM vec_docs")
        .map_err(|e| e.to_string())?;
    stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, from_blob(&r.get::<_, Vec<u8>>(1)?)))
    })
    .map_err(|e| e.to_string())?
    .filter(|r| r.as_ref().map_or(true, |(_, v)| v.len() == DIMS))
    .collect::<Result<_, _>>()
    .map_err(|e| e.to_string())
}

/// An email's passage vectors.
pub fn passage_vectors(conn: &Connection, id: i64) -> Result<Vec<Vec<f32>>, String> {
    let blob: Option<Vec<u8>> = conn
        .query_row(
            "SELECT v FROM vec_passages WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(blob
        .map(|b| {
            from_blob(&b)
                .chunks_exact(DIMS)
                .map(<[f32]>::to_vec)
                .collect()
        })
        .unwrap_or_default())
}

/// The source fields of these emails, by rowid.
pub fn sources(conn: &Connection, ids: &[i64]) -> Result<HashMap<i64, Source>, String> {
    let list = serde_json::to_string(ids).map_err(|e| e.to_string())?;
    Ok(read_sources(
        conn,
        "messages m WHERE m.rowid IN (SELECT value FROM json_each(?1))",
        params![list],
    )?
    .into_iter()
    .map(|s| (s.id, s))
    .collect())
}

/// Document vectors in memory for brute-force cosine: `DIMS` f32 per email (1 KiB; about 38 MB
/// for 37,000 emails). Rows deleted since it was built stay until it's rebuilt, so search checks
/// every candidate against `vec_docs`.
#[derive(Default)]
pub struct VecCache {
    ids: Vec<i64>,
    data: Vec<f32>,
    at: HashMap<i64, usize>,
}

impl VecCache {
    pub fn new(rows: Vec<(i64, Vec<f32>)>) -> Self {
        let mut c = Self::default();
        for (id, v) in rows {
            c.put(id, &v);
        }
        c
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn put(&mut self, id: i64, v: &[f32]) {
        if v.len() != DIMS {
            return;
        }
        match self.at.get(&id) {
            Some(&i) => self.data[i * DIMS..(i + 1) * DIMS].copy_from_slice(v),
            None => {
                self.at.insert(id, self.ids.len());
                self.ids.push(id);
                self.data.extend_from_slice(v);
            }
        }
    }

    /// The `k` most similar rows to `q` (a unit vector), best first: (rowid, cosine).
    pub fn top(&self, q: &[f32], k: usize) -> Vec<(i64, f32)> {
        if q.len() != DIMS || self.ids.is_empty() || k == 0 {
            return vec![];
        }
        let mut scores: Vec<(f32, usize)> = self
            .data
            .chunks_exact(DIMS)
            .enumerate()
            .map(|(i, row)| (row.iter().zip(q).map(|(a, b)| a * b).sum::<f32>(), i))
            .collect();
        let by_score = |a: &(f32, usize), b: &(f32, usize)| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1));
        if scores.len() > k {
            scores.select_nth_unstable_by(k - 1, by_score);
            scores.truncate(k);
        }
        scores.sort_by(by_score);
        scores.into_iter().map(|(s, i)| (self.ids[i], s)).collect()
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::db::{CachedMessage, delete_account_conn, delete_messages_conn, put_messages_conn};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A stand-in model: a unit bag-of-words vector (each word hashed to a dimension), so texts
    /// sharing words are similar. Counts the texts it embeds.
    #[derive(Default)]
    pub struct FakeEmbed {
        pub calls: AtomicUsize,
    }

    pub fn bag(text: &str) -> Vec<f32> {
        let mut v = vec![0.0f32; DIMS];
        // Only the text after the prompt's framing counts, so prompts don't look alike.
        let body = text.rsplit(" | ").next().unwrap_or(text);
        for w in body
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2 && !["text", "query", "title", "none"].contains(w))
        {
            let h = w
                .bytes()
                .fold(7u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64));
            v[(h % DIMS as u64) as usize] += 1.0;
        }
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > 0.0 {
            v.iter_mut().for_each(|x| *x /= n);
        } else {
            v[0] = 1.0;
        }
        v
    }

    impl Embed for FakeEmbed {
        fn embed(&self, texts: &[String], _: Priority) -> Result<Vec<Option<Vec<f32>>>, String> {
            self.calls.fetch_add(texts.len(), Ordering::Relaxed);
            Ok(texts.iter().map(|t| Some(bag(t))).collect())
        }
    }

    pub fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        conn
    }

    pub fn mail(id: &str, folder: &str, date: &str, subject: &str, text: &str) -> CachedMessage {
        CachedMessage {
            id: id.into(),
            folder_id: folder.into(),
            date: date.into(),
            json: serde_json::json!({
                "id": id, "from": { "name": "Sender", "address": "s@example.com" },
                "subject": subject, "snippet": "", "text": text, "unread": true,
            })
            .to_string(),
        }
    }

    /// Run the indexer to the end, the way the background thread does.
    pub fn index_all(conn: &mut Connection, e: &dyn Embed) -> usize {
        let mut written = 0;
        loop {
            let batch = next_batch(conn, 4).unwrap();
            if batch.is_empty() {
                return written;
            }
            let done = embed_batch(e, batch).unwrap();
            written += write_batch(conn, done).unwrap().len();
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn nothing_is_queued_until_installed() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "a",
            &[mail("1", "inbox", "2026-10-01", "Hi", "there")],
        )
        .unwrap();
        assert!(!installed(&conn).unwrap());
        assert_eq!(count(&conn, "vec_pending"), 0);
        assert_eq!(progress(&conn).unwrap(), (0, 1));
    }

    #[test]
    fn install_queues_everything_newest_first_and_indexes() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "a",
            &[
                mail("old", "inbox", "2026-01-01", "Old", "old words"),
                mail("new", "inbox", "2026-10-01", "New", "fresh words here"),
            ],
        )
        .unwrap();
        install(&conn).unwrap();
        assert_eq!(progress(&conn).unwrap(), (0, 2));
        let batch = next_batch(&conn, 1).unwrap();
        assert_eq!(batch[0].subject.as_deref(), Some("New"));
        let e = FakeEmbed::default();
        assert_eq!(index_all(&mut conn, &e), 2);
        assert_eq!(progress(&conn).unwrap(), (2, 2));
        assert_eq!(count(&conn, "vec_docs"), 2);
        assert_eq!(count(&conn, "vec_passages"), 2);
        // New mail is queued by the trigger and indexed next.
        put_messages_conn(
            &mut conn,
            "a",
            &[mail("x", "inbox", "2026-10-02", "X", "x body")],
        )
        .unwrap();
        assert_eq!(progress(&conn).unwrap(), (2, 3));
        assert_eq!(index_all(&mut conn, &e), 1);
        // Install again (a restart) re-queues nothing.
        install(&conn).unwrap();
        assert_eq!(progress(&conn).unwrap(), (3, 3));
    }

    #[test]
    fn flag_changes_keep_vectors_and_edits_requeue() {
        let mut conn = mem();
        let m = mail("1", "inbox", "2026-10-01", "Budget", "the quarterly budget");
        put_messages_conn(&mut conn, "a", std::slice::from_ref(&m)).unwrap();
        install(&conn).unwrap();
        let e = FakeEmbed::default();
        index_all(&mut conn, &e);
        // Read and moved: same embedded fields.
        let mut v: serde_json::Value = serde_json::from_str(&m.json).unwrap();
        v["unread"] = false.into();
        put_messages_conn(
            &mut conn,
            "a",
            &[CachedMessage {
                json: v.to_string(),
                folder_id: "archive".into(),
                ..m.clone()
            }],
        )
        .unwrap();
        assert_eq!(count(&conn, "vec_pending"), 0);
        assert_eq!(count(&conn, "vec_docs"), 1);
        // The body changed: old vectors go, the email is queued again.
        put_messages_conn(
            &mut conn,
            "a",
            &[mail("1", "inbox", "2026-10-01", "Budget", "a new body")],
        )
        .unwrap();
        assert_eq!(count(&conn, "vec_docs"), 0);
        assert_eq!(count(&conn, "vec_passages"), 0);
        assert_eq!(count(&conn, "vec_pending"), 1);
        index_all(&mut conn, &e);
        assert_eq!(count(&conn, "vec_docs"), 1);
    }

    #[test]
    fn an_email_changed_or_deleted_while_embedding_writes_nothing() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "a",
            &[
                mail("1", "inbox", "2026-10-01", "One", "first body"),
                mail("2", "inbox", "2026-10-02", "Two", "second body"),
                mail("3", "inbox", "2026-10-03", "Three", "third body"),
            ],
        )
        .unwrap();
        install(&conn).unwrap();
        let batch = next_batch(&conn, 10).unwrap();
        let done = embed_batch(&FakeEmbed::default(), batch).unwrap();
        // Meanwhile (the lock was free while embedding): 3 is rewritten, 2 deleted.
        put_messages_conn(
            &mut conn,
            "a",
            &[mail("3", "inbox", "2026-10-03", "Three", "edited")],
        )
        .unwrap();
        delete_messages_conn(&mut conn, &["2".to_string()]).unwrap();
        let written = write_batch(&mut conn, done).unwrap();
        assert_eq!(written.len(), 1);
        assert_eq!(count(&conn, "vec_docs"), 1);
        // 3 stays queued for its new text; 2 left nothing.
        let left: Vec<i64> = conn
            .prepare("SELECT id FROM vec_pending")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(left.len(), 1);
        assert_eq!(
            source_of(&conn, left[0]).unwrap().unwrap().body.as_deref(),
            Some("edited")
        );
        // A rowid reused by a new email after a delete doesn't take the old vectors.
        let ghosts: i64 = conn
            .query_row(
                "SELECT count(*) FROM vec_docs WHERE id NOT IN (SELECT rowid FROM messages)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ghosts, 0);
    }

    #[test]
    fn removing_an_account_leaves_no_vectors() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "gone",
            &[
                mail("1", "inbox", "2026-10-01", "A", "aaa bbb"),
                mail("2", "inbox", "2026-10-01", "B", "ccc"),
            ],
        )
        .unwrap();
        put_messages_conn(
            &mut conn,
            "kept",
            &[mail("3", "inbox", "2026-10-01", "C", "ddd")],
        )
        .unwrap();
        install(&conn).unwrap();
        index_all(&mut conn, &FakeEmbed::default());
        // One more email arrives for the removed account but isn't indexed yet.
        put_messages_conn(
            &mut conn,
            "gone",
            &[mail("4", "inbox", "2026-10-02", "D", "eee")],
        )
        .unwrap();
        delete_account_conn(&mut conn, "gone").unwrap();
        assert_eq!(count(&conn, "vec_docs"), 1);
        assert_eq!(count(&conn, "vec_passages"), 1);
        assert_eq!(count(&conn, "vec_pending"), 0);
        let orphans: i64 = conn
            .query_row(
                "SELECT (SELECT count(*) FROM vec_docs WHERE id NOT IN (SELECT rowid FROM messages))
                      + (SELECT count(*) FROM vec_passages WHERE id NOT IN (SELECT rowid FROM messages))",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn a_new_model_revision_rebuilds_and_uninstall_clears() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "a",
            &[mail("1", "inbox", "2026-10-01", "A", "aaa")],
        )
        .unwrap();
        install(&conn).unwrap();
        index_all(&mut conn, &FakeEmbed::default());
        assert_eq!(progress(&conn).unwrap(), (1, 1));
        db::kv_set_conn(&conn, VERSION_KEY, "other-revision:1").unwrap();
        install(&conn).unwrap();
        assert_eq!(count(&conn, "vec_docs"), 0);
        assert_eq!(progress(&conn).unwrap(), (0, 1));
        assert_eq!(
            db::kv_get_conn(&conn, VERSION_KEY).unwrap(),
            Some(version())
        );
        index_all(&mut conn, &FakeEmbed::default());
        // A missing trigger is put back, and mail cached without it is queued.
        conn.execute_batch("DROP TRIGGER messages_vec_ai").unwrap();
        put_messages_conn(
            &mut conn,
            "a",
            &[mail("late", "inbox", "2026-10-02", "L", "lll")],
        )
        .unwrap();
        assert!(!installed(&conn).unwrap());
        install(&conn).unwrap();
        assert!(installed(&conn).unwrap());
        assert_eq!(progress(&conn).unwrap(), (1, 2));
        index_all(&mut conn, &FakeEmbed::default());
        uninstall(&conn).unwrap();
        assert!(!installed(&conn).unwrap());
        assert_eq!(
            count(&conn, "vec_docs") + count(&conn, "vec_passages") + count(&conn, "vec_pending"),
            0
        );
        // Without triggers, new mail isn't queued.
        put_messages_conn(
            &mut conn,
            "a",
            &[mail("2", "inbox", "2026-10-01", "B", "bbb")],
        )
        .unwrap();
        assert_eq!(count(&conn, "vec_pending"), 0);
        // Writes after uninstall are dropped.
        assert!(write_batch(&mut conn, vec![]).unwrap().is_empty());
    }

    #[test]
    fn passages_are_bounded_and_aligned_with_their_text() {
        let mut conn = mem();
        let body = (0..2000)
            .map(|i| format!("w{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        put_messages_conn(
            &mut conn,
            "a",
            &[mail("1", "inbox", "2026-10-01", "Long", &body)],
        )
        .unwrap();
        install(&conn).unwrap();
        index_all(&mut conn, &FakeEmbed::default());
        let id: i64 = conn
            .query_row("SELECT rowid FROM messages", [], |r| r.get(0))
            .unwrap();
        let pv = passage_vectors(&conn, id).unwrap();
        assert_eq!(pv.len(), text::PASSAGES_MAX);
        let src = sources(&conn, &[id]).unwrap().remove(&id).unwrap();
        let third = passage_text(&src, 2).unwrap();
        let best = pv
            .iter()
            .enumerate()
            .max_by(|a, b| {
                let d = |v: &Vec<f32>| v.iter().zip(bag(&third)).map(|(x, y)| x * y).sum::<f32>();
                d(a.1).total_cmp(&d(b.1))
            })
            .unwrap()
            .0;
        assert_eq!(best, 2);
        assert!(passage_text(&src, text::PASSAGES_MAX).is_none());
    }

    #[test]
    fn a_lone_surrogate_row_is_indexed_not_retried() {
        let mut conn = mem();
        // Half an emoji, as JSON.stringify writes it: `->>` decodes it to bytes that aren't UTF-8.
        let bad = CachedMessage {
            json: r#"{"id":"bad","from":{"name":"Sender","address":"s@example.com"},"subject":"Cut","snippet":"","text":"half \ud83d"}"#.into(),
            ..mail("bad", "inbox", "2026-10-02", "", "")
        };
        put_messages_conn(
            &mut conn,
            "a",
            &[bad, mail("old", "inbox", "2026-10-01", "Old", "old words")],
        )
        .unwrap();
        install(&conn).unwrap();
        let batch = next_batch(&conn, 16).unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0].subject.as_deref(), Some("Cut"));
        assert!(batch[0].body.as_deref().unwrap().starts_with("half "));
        assert_eq!(sources(&conn, &[batch[0].id]).unwrap().len(), 1);
        // Both are embedded and leave the queue, so the indexer moves past the bad one.
        assert_eq!(index_all(&mut conn, &FakeEmbed::default()), 2);
        assert_eq!(count(&conn, "vec_pending"), 0);
    }

    #[test]
    fn cache_top_k_is_ordered_and_replaces() {
        let mut c = VecCache::default();
        let unit = |i: usize| {
            let mut v = vec![0.0; DIMS];
            v[i] = 1.0;
            v
        };
        c.put(10, &unit(0));
        c.put(11, &unit(1));
        let mut mix = vec![0.0; DIMS];
        mix[0] = 0.6;
        mix[1] = 0.8;
        c.put(12, &mix);
        assert_eq!(
            c.top(&unit(1), 2).iter().map(|x| x.0).collect::<Vec<_>>(),
            vec![11, 12]
        );
        c.put(11, &unit(5));
        assert_eq!(c.len(), 3);
        assert_eq!(c.top(&unit(1), 1)[0].0, 12);
        c.put(13, &[1.0; 3]);
        assert_eq!(c.len(), 3);
    }
}
