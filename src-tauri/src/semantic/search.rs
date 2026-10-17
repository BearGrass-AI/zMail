//! Hybrid search: keyword matches (FTS5, any word, bm25) fused with the nearest email vectors by
//! reciprocal rank fusion, as the trial measured it. Keywords keep exact numbers and names
//! findable; vectors find mail that says the same thing in other words.

use super::embed::{Embed, Priority};
use super::index::{self, VecCache};
use super::text;
use crate::db::{self, SearchFilter, SearchHit};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Mutex;

/// Hits each side contributes to the fusion.
const DEPTH: usize = 100;
/// Vector candidates checked against the filter, best first.
const CANDIDATES: usize = 1_000;
/// RRF's constant: a hit at rank r (from 0) scores 1 / (RRF_K + r + 1) on each side.
const RRF_K: f64 = 60.0;
/// A hit that only the vectors found (no keyword match) needs at least this cosine: every query
/// has nearest emails, even one about nothing in the mailbox. Measured with this model at 256
/// dims, a query and an email about the same thing scored 0.64-0.82 and unrelated pairs 0.48-0.67
/// (nonsense queries topped out at 0.63), so this keeps clear matches by meaning and leaves weaker
/// ones to their keywords. Hits with a keyword match are ranked by both, as the trial did.
pub const VECTOR_ONLY_MIN: f32 = 0.70;
/// Characters of a query read (as `cache_search` caps it).
const QUERY_MAX_CHARS: usize = 1_000;

/// Fuse two rankings (rowids, best first) by RRF. Equal scores keep keyword hits first, in their
/// order, then vector hits in theirs.
pub fn rrf(keyword: &[i64], vector: &[i64]) -> Vec<(i64, f64)> {
    let mut score: HashMap<i64, (f64, usize)> = HashMap::new();
    let mut order = 0;
    for list in [keyword, vector] {
        for (r, id) in list.iter().enumerate() {
            let e = score.entry(*id).or_insert_with(|| {
                order += 1;
                (0.0, order)
            });
            e.0 += 1.0 / (RRF_K + r as f64 + 1.0);
        }
    }
    let mut out: Vec<(i64, f64, usize)> =
        score.into_iter().map(|(id, (s, o))| (id, s, o)).collect();
    out.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.2.cmp(&b.2)));
    out.into_iter().map(|(id, s, _)| (id, s)).collect()
}

/// The fused hits and the query's vector, or None when there's nothing to search.
pub type Answer = Option<(Vec<Fused>, Vec<f32>)>;

pub struct Fused {
    pub rowid: i64,
    pub hit: SearchHit,
}

/// The best `limit` emails for `query` within `filter`, and the query's vector. None when there
/// are no vectors to search (the feature is off or nothing is indexed yet). The database lock is
/// let go while the query is embedded; everything returned is re-read after that, so an email
/// (or account) removed meanwhile isn't in the answer.
pub fn hybrid(
    db: &Mutex<Connection>,
    embedder: &dyn Embed,
    cache: &Mutex<Option<VecCache>>,
    query: &str,
    filter: &SearchFilter,
    limit: usize,
) -> Result<Answer, String> {
    let query: String = query
        .chars()
        .take(QUERY_MAX_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let query = query.trim();
    let keyword: Vec<i64> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if !index::installed(&conn)? || !index::has_vectors(&conn)? {
            return Ok(None);
        }
        let mut cache = cache.lock().map_err(|e| e.to_string())?;
        if cache.is_none() {
            *cache = Some(VecCache::new(index::load_all(&conn)?));
        }
        db::search_any_conn(&conn, query, filter, DEPTH as i64)?
            .into_iter()
            .map(|(rowid, _)| rowid)
            .collect()
    };
    if query.is_empty() {
        return Ok(Some((vec![], vec![])));
    }
    let qv = embedder
        .embed(&[text::query_prompt(query)], Priority::Query)?
        .pop()
        .flatten()
        .unwrap_or_default();
    let scored: Vec<(i64, f32)> = {
        let cache = cache.lock().map_err(|e| e.to_string())?;
        cache
            .as_ref()
            .map(|c| c.top(&qv, CANDIDATES))
            .unwrap_or_default()
    };
    let cosine: HashMap<i64, f32> = scored.iter().copied().collect();
    let candidates: Vec<i64> = scored.into_iter().map(|(id, _)| id).collect();
    let conn = db.lock().map_err(|e| e.to_string())?;
    let with_vectors = "EXISTS (SELECT 1 FROM vec_docs v WHERE v.id = m.rowid)";
    let vector_scope = db::rows_in_scope_conn(&conn, &candidates, filter, with_vectors)?;
    let vector: Vec<i64> = candidates
        .into_iter()
        .filter(|id| vector_scope.contains_key(id))
        .take(DEPTH)
        .collect();
    let mut rows = db::rows_in_scope_conn(&conn, &keyword, filter, "1")?;
    let keyword: Vec<i64> = keyword
        .into_iter()
        .filter(|id| rows.contains_key(id))
        .collect();
    rows.extend(vector_scope);
    let by_keyword: std::collections::HashSet<i64> = keyword.iter().copied().collect();
    let fused = rrf(&keyword, &vector)
        .into_iter()
        .filter(|(id, _)| {
            by_keyword.contains(id) || cosine.get(id).is_some_and(|c| *c >= VECTOR_ONLY_MIN)
        })
        .take(limit)
        .filter_map(|(rowid, score)| {
            rows.remove(&rowid).map(|hit| Fused {
                rowid,
                hit: SearchHit { rank: score, ..hit },
            })
        })
        .collect();
    Ok(Some((fused, qv)))
}

/// A hit with what the assistant reads instead of the whole email.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct PassageHit {
    pub id: String,
    pub account_id: String,
    pub folder_id: String,
    pub date: String,
    pub from_name: String,
    pub from_address: String,
    pub subject: String,
    /// The email's passage most like the query (at most `text::PASSAGE_CHARS` characters).
    pub passage: String,
}

fn cap(s: Option<&str>, n: usize) -> String {
    s.unwrap_or("").chars().take(n).collect()
}

/// Each hit's best passage by vector similarity to `qv`; its opening when it has no passages.
pub fn passages(conn: &Connection, hits: &[Fused], qv: &[f32]) -> Result<Vec<PassageHit>, String> {
    let ids: Vec<i64> = hits.iter().map(|h| h.rowid).collect();
    let sources = index::sources(conn, &ids)?;
    let mut out = vec![];
    for h in hits {
        let Some(src) = sources.get(&h.rowid) else {
            continue;
        };
        let best = index::passage_vectors(conn, h.rowid)?
            .iter()
            .map(|v| v.iter().zip(qv).map(|(a, b)| a * b).sum::<f32>())
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(n, _)| n);
        let passage = best
            .and_then(|n| index::passage_text(src, n))
            .unwrap_or_else(|| text::clean_body(src.body.as_deref().unwrap_or("")));
        out.push(PassageHit {
            id: h.hit.id.clone(),
            account_id: h.hit.account_id.clone(),
            folder_id: h.hit.folder_id.clone(),
            date: h.hit.date.clone(),
            from_name: cap(src.name.as_deref(), 200),
            from_address: cap(src.address.as_deref(), 200),
            subject: cap(src.subject.as_deref(), 200),
            passage: cap(Some(&passage), text::PASSAGE_CHARS),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{delete_account_conn, put_messages_conn};
    use crate::semantic::index::tests::{FakeEmbed, index_all, mail, mem};

    #[test]
    fn rrf_sums_ranks_and_keyword_wins_ties() {
        // 7 is first on both sides; 1 (keyword #2) ties 9 (vector #2): the keyword hit goes first.
        let got: Vec<i64> = rrf(&[7, 1, 2], &[7, 9, 3])
            .into_iter()
            .map(|x| x.0)
            .collect();
        assert_eq!(got, vec![7, 1, 9, 2, 3]);
        assert!(rrf(&[], &[]).is_empty());
        let s = rrf(&[5], &[]);
        assert!((s[0].1 - 1.0 / 61.0).abs() < 1e-12);
    }

    fn setup() -> (Mutex<Connection>, FakeEmbed) {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "a",
            &[
                mail(
                    "flight",
                    "inbox",
                    "2026-09-01",
                    "Your trip",
                    "Your flight to Tokyo Haneda departs November 3 at 9am",
                ),
                mail(
                    "budget",
                    "inbox",
                    "2026-09-02",
                    "Q3 numbers",
                    "The quarterly budget spreadsheet is attached",
                ),
                mail(
                    "order",
                    "archive",
                    "2026-09-03",
                    "Order 4417",
                    "Order number 4417 has shipped",
                ),
                mail(
                    "spam",
                    "spam",
                    "2026-09-04",
                    "Tokyo deals",
                    "Cheap flight deals to Tokyo",
                ),
            ],
        )
        .unwrap();
        put_messages_conn(
            &mut conn,
            "b",
            &[mail(
                "other",
                "inbox",
                "2026-09-05",
                "Hello",
                "Tokyo flight plans for the team",
            )],
        )
        .unwrap();
        index::install(&conn).unwrap();
        let e = FakeEmbed::default();
        index_all(&mut conn, &e);
        (Mutex::new(conn), e)
    }

    fn ids(r: Answer) -> Vec<String> {
        r.unwrap().0.into_iter().map(|f| f.hit.id).collect()
    }

    #[test]
    fn finds_by_meaning_and_by_number_within_the_filter() {
        let (db, e) = setup();
        let cache = Mutex::new(None);
        let all = SearchFilter::default();
        let got = ids(hybrid(
            &db,
            &e,
            &cache,
            "when does my plane to tokyo leave",
            &all,
            3,
        )
        .unwrap());
        assert!(got.contains(&"flight".to_string()), "{got:?}");
        // A number typed alone: the keyword side finds it.
        assert_eq!(
            ids(hybrid(&db, &e, &cache, "4417", &all, 3).unwrap())[0],
            "order"
        );
        // Spam left out, one account only.
        let spam = vec!["spam".to_string()];
        let a = vec!["a".to_string()];
        let scoped = SearchFilter {
            account_ids: Some(&a),
            exclude_folder_ids: Some(&spam),
            ..SearchFilter::default()
        };
        let got = ids(hybrid(&db, &e, &cache, "tokyo flight", &scoped, 10).unwrap());
        assert!(
            !got.contains(&"spam".to_string()) && !got.contains(&"other".to_string()),
            "{got:?}"
        );
        assert!(got.contains(&"flight".to_string()));
        let inbox = vec!["archive".to_string()];
        let folder = SearchFilter {
            folder_ids: Some(&inbox),
            ..SearchFilter::default()
        };
        assert_eq!(
            ids(hybrid(&db, &e, &cache, "tokyo order shipped", &folder, 10).unwrap()),
            vec!["order"]
        );
    }

    #[test]
    fn not_ready_without_vectors_and_removed_accounts_drop_out() {
        let conn = mem();
        let empty = Mutex::new(conn);
        let e = FakeEmbed::default();
        let cache = Mutex::new(None);
        assert!(
            hybrid(&empty, &e, &cache, "anything", &SearchFilter::default(), 3)
                .unwrap()
                .is_none()
        );
        assert_eq!(e.calls.load(std::sync::atomic::Ordering::Relaxed), 0);

        let (db, e) = setup();
        let cache = Mutex::new(None);
        // Warm the cache, then remove an account: its emails can't come back from the cache.
        hybrid(&db, &e, &cache, "tokyo", &SearchFilter::default(), 10).unwrap();
        delete_account_conn(&mut db.lock().unwrap(), "b").unwrap();
        let got = ids(hybrid(
            &db,
            &e,
            &cache,
            "tokyo flight plans team",
            &SearchFilter::default(),
            10,
        )
        .unwrap());
        assert!(!got.contains(&"other".to_string()), "{got:?}");
    }

    /// Fixed vectors by keyword in the text: e0 for "alpha" (and the query "gamma"), 0.6·e0 + 0.8·e1
    /// for "beta", e2 otherwise.
    struct Fixed;
    impl Embed for Fixed {
        fn embed(&self, texts: &[String], _: Priority) -> Result<Vec<Option<Vec<f32>>>, String> {
            Ok(texts
                .iter()
                .map(|t| {
                    let mut v = vec![0.0; crate::semantic::embed::DIMS];
                    if t.contains("alpha") || t.contains("gamma") {
                        v[0] = 1.0;
                    } else if t.contains("beta") {
                        v[0] = 0.6;
                        v[1] = 0.8;
                    } else {
                        v[2] = 1.0;
                    }
                    Some(v)
                })
                .collect())
        }
    }

    #[test]
    fn a_match_by_meaning_alone_must_be_close() {
        let mut conn = mem();
        put_messages_conn(
            &mut conn,
            "a",
            &[
                mail("close", "inbox", "2026-09-01", "One", "alpha words"),
                mail("far", "inbox", "2026-09-02", "Two", "beta words"),
            ],
        )
        .unwrap();
        index::install(&conn).unwrap();
        index_all(&mut conn, &Fixed);
        let db = Mutex::new(conn);
        let cache = Mutex::new(None);
        let all = SearchFilter::default();
        // No keyword matches "gamma": only the close one (cosine 1.0) counts, not the 0.6 one.
        assert_eq!(
            ids(hybrid(&db, &Fixed, &cache, "gamma", &all, 5).unwrap()),
            vec!["close"]
        );
        // With a keyword match, a far vector still ranks (by its keywords).
        let got = ids(hybrid(&db, &Fixed, &cache, "gamma words", &all, 5).unwrap());
        assert_eq!(got.len(), 2, "{got:?}");
    }

    #[test]
    fn hostile_and_huge_queries_are_bounded() {
        let (db, e) = setup();
        let cache = Mutex::new(None);
        let all = SearchFilter::default();
        for q in [
            "\"",
            "NEAR(a b)",
            "*",
            "subject:x OR",
            "') OR 1=1 --",
            "\0\u{7}",
            "",
        ] {
            hybrid(&db, &e, &cache, q, &all, 3).unwrap();
        }
        let huge = "tokyo ".repeat(10_000);
        let r = hybrid(&db, &e, &cache, &huge, &all, 3).unwrap().unwrap();
        assert!(r.0.len() <= 3);
    }

    #[test]
    fn passages_pick_the_best_matching_piece() {
        let mut conn = mem();
        let body = format!(
            "{} The parking garage on Fifth Street closes at midnight on weekends. {}",
            "lorem ipsum dolor sit amet ".repeat(20),
            "consectetur adipiscing elit ".repeat(20)
        );
        put_messages_conn(
            &mut conn,
            "a",
            &[mail("1", "inbox", "2026-09-01", "Notes", &body)],
        )
        .unwrap();
        index::install(&conn).unwrap();
        let e = FakeEmbed::default();
        index_all(&mut conn, &e);
        let db = Mutex::new(conn);
        let cache = Mutex::new(None);
        let (hits, qv) = hybrid(
            &db,
            &e,
            &cache,
            "when does the parking garage close",
            &SearchFilter::default(),
            5,
        )
        .unwrap()
        .unwrap();
        let ps = passages(&db.lock().unwrap(), &hits, &qv).unwrap();
        assert_eq!(ps.len(), 1);
        assert!(
            ps[0].passage.contains("parking garage"),
            "{}",
            ps[0].passage
        );
        assert!(ps[0].passage.chars().count() <= text::PASSAGE_CHARS);
        assert_eq!(ps[0].subject, "Notes");
        assert_eq!(ps[0].from_address, "s@example.com");
    }
}
