//! Measurements with the real model on synthetic mail (never real mail). Ignored by default:
//!
//! ```text
//! ZMAIL_EMBED_MODEL=/path/to/embeddinggemma-2-Q8_0.gguf \
//! ZMAIL_SEMANTIC_BENCH_DB=/tmp/scratch/bench.sqlite3 ZMAIL_SEMANTIC_BENCH_N=37311 \
//!   cargo test --release --lib semantic::bench -- --ignored --nocapture --test-threads 1
//! ```

use super::embed::{Embed, Embedder, Priority};
use super::index::{self, VecCache};
use super::search;
use super::text;
use crate::db::{self, CachedMessage, SearchFilter};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn model() -> PathBuf {
    std::env::var("ZMAIL_EMBED_MODEL")
        .expect("set ZMAIL_EMBED_MODEL")
        .into()
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// How similar related and unrelated query/email pairs come out, to place `search::MIN_COSINE`.
#[test]
#[ignore = "needs the model file; set ZMAIL_EMBED_MODEL"]
fn cosine_ranges() {
    let e = Embedder::new(model());
    let docs = [
        (
            "Your flight itinerary",
            "Delta flight 1432 from Boise to Denver departs Friday at 7:10 AM from gate 3. Check in opens 24 hours before.",
        ),
        (
            "Q3 budget review",
            "Attached is the third-quarter budget spreadsheet. Please review the travel and equipment lines before Thursday's meeting.",
        ),
        (
            "Parking permit renewal",
            "Your campus parking permit expires on August 31. Renew online to keep your spot in Lot P.",
        ),
        (
            "Dinner Saturday?",
            "Are you free for dinner Saturday night? We were thinking of the Thai place downtown around 7.",
        ),
        (
            "Your order has shipped",
            "Your order of running shoes has shipped and will arrive Tuesday. Track your package with UPS.",
        ),
        (
            "Password reset",
            "We received a request to reset your password. If this wasn't you, you can ignore this email.",
        ),
        (
            "Board meeting minutes",
            "Minutes from the October board meeting are attached, including the vote on the new library hours.",
        ),
        (
            "Invoice 20931",
            "Invoice 20931 for consulting services in September is due net 30. Payment details are below.",
        ),
    ];
    let doc_prompts: Vec<String> = docs
        .iter()
        .map(|(s, b)| text::doc_prompt(s, "Someone", "someone@example.com", b))
        .collect();
    let dv: Vec<Vec<f32>> = e
        .embed(&doc_prompts, Priority::Index)
        .unwrap()
        .into_iter()
        .map(Option::unwrap)
        .collect();
    let queries = [
        ("when does my plane to denver leave", Some(0)),
        ("how much did we spend on equipment", Some(1)),
        ("car park pass", Some(2)),
        ("weekend dinner plans", Some(3)),
        ("where are my sneakers", Some(4)),
        ("account security", Some(5)),
        ("library hours decision", Some(6)),
        ("bill for consulting", Some(7)),
        ("xyzzy plugh", None),
        ("asdf qwerty", None),
        ("quantum chromodynamics lecture", None),
        ("my grandmother's lasagna recipe", None),
    ];
    let qp: Vec<String> = queries.iter().map(|(q, _)| text::query_prompt(q)).collect();
    let qv = e.embed(&qp, Priority::Query).unwrap();
    let (mut related, mut unrelated, mut nonsense_top) = (vec![], vec![], vec![]);
    for ((q, want), v) in queries.iter().zip(qv) {
        let v = v.unwrap();
        let scores: Vec<f32> = dv.iter().map(|d| dot(d, &v)).collect();
        let top = scores.iter().cloned().fold(f32::MIN, f32::max);
        match want {
            Some(i) => {
                related.push(scores[*i]);
                unrelated.extend(
                    scores
                        .iter()
                        .enumerate()
                        .filter(|(j, _)| j != i)
                        .map(|(_, s)| *s),
                );
            }
            None => nonsense_top.push(top),
        }
        println!(
            "{q:40} top {top:.3}  {}",
            scores
                .iter()
                .map(|s| format!("{s:.2}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
    }
    let range = |v: &[f32]| {
        (
            v.iter().cloned().fold(f32::MAX, f32::min),
            v.iter().cloned().fold(f32::MIN, f32::max),
        )
    };
    println!(
        "related {:?}  unrelated {:?}  nonsense top {:?}",
        range(&related),
        range(&unrelated),
        range(&nonsense_top)
    );
}

const WORDS: &str = "meeting budget report schedule project review team update deadline invoice payment order shipped delivery \
account password security campus parking permit library board minutes vote agenda travel flight hotel itinerary conference \
student course grade semester faculty research grant proposal funding committee department office hours lunch dinner weekend \
family photos birthday party gift card receipt subscription renewal newsletter event registration ticket concert game season \
network server outage maintenance window ticket request approval policy training deadline reminder survey feedback results";

/// A deterministic synthetic email: a few sentences of common mail words, sometimes with a
/// quoted reply below (what the trial found in real mail: about 1.3k characters of own text).
fn synthetic(i: usize) -> CachedMessage {
    let words: Vec<&str> = WORDS.split_whitespace().collect();
    let mut seed = (i as u64)
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    let mut next = |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % n as u64) as usize
    };
    let sentence = |next: &mut dyn FnMut(usize) -> usize| {
        let n = 8 + next(14);
        let mut s: Vec<String> = (0..n)
            .map(|_| words[next(words.len())].to_string())
            .collect();
        s[0] = format!("{}{}", s[0][..1].to_uppercase(), &s[0][1..]);
        format!("{}.", s.join(" "))
    };
    let own_len = 200 + next(2400);
    let mut body = String::new();
    while body.len() < own_len {
        body.push_str(&sentence(&mut next));
        body.push(' ');
    }
    if next(3) == 0 {
        body.push_str("\n\nOn Mon, Oct 5, 2026 at 9:00 AM Someone <someone@example.com> wrote:\n");
        for _ in 0..(5 + next(40)) {
            body.push_str(&format!("> {}\n", sentence(&mut next)));
        }
    }
    let subject = (0..(2 + next(5)))
        .map(|_| words[next(words.len())])
        .collect::<Vec<_>>()
        .join(" ");
    CachedMessage {
        id: format!("bench{i}"),
        folder_id: if next(10) == 0 { "archive".into() } else { "inbox".into() },
        date: format!("2026-{:02}-{:02}T{:02}:00:00Z", 1 + i % 12, 1 + i % 28, i % 24),
        json: serde_json::json!({
            "id": format!("bench{i}"),
            "from": { "name": format!("Sender {}", i % 500), "address": format!("s{}@example.com", i % 500) },
            "subject": subject, "snippet": "", "text": body, "unread": false,
        })
        .to_string(),
    }
}

#[test]
#[ignore = "needs the model file and a scratch path; see the module docs"]
fn index_bench() {
    let path = std::env::var("ZMAIL_SEMANTIC_BENCH_DB").expect("set ZMAIL_SEMANTIC_BENCH_DB");
    let n: usize = std::env::var("ZMAIL_SEMANTIC_BENCH_N").map_or(37_311, |v| v.parse().unwrap());
    let _ = std::fs::remove_file(&path);
    let mut conn = Connection::open(&path).unwrap();
    db::init(&conn).unwrap();
    for chunk in (0..n).collect::<Vec<_>>().chunks(2_000) {
        let rows: Vec<CachedMessage> = chunk.iter().map(|&i| synthetic(i)).collect();
        db::put_messages_conn(
            &mut conn,
            if chunk[0] % 4_000 == 0 { "a" } else { "b" },
            &rows,
        )
        .unwrap();
    }
    let e = Embedder::new(model());
    let t = Instant::now();
    index::install(&conn).unwrap();
    println!("rows {n}; install {:?}", t.elapsed());
    let t = Instant::now();
    let (mut batches, mut slow_write, mut passages) = (0, Duration::ZERO, 0usize);
    loop {
        let batch = index::next_batch(&conn, 16).unwrap();
        if batch.is_empty() {
            break;
        }
        let done = index::embed_batch(&e, batch).unwrap();
        passages += done.iter().map(|d| d.passages.len()).sum::<usize>();
        let w = Instant::now();
        index::write_batch(&mut conn, done).unwrap();
        slow_write = slow_write.max(w.elapsed());
        batches += 1;
        if batches % 200 == 0 {
            println!("  {} emails in {:?}", batches * 16, t.elapsed());
        }
    }
    let took = t.elapsed();
    println!(
        "indexed {n} in {took:?} ({:.0}/s), {batches} batches; slowest write (lock held) {slow_write:?}; {passages} passages ({:.1}/email)",
        n as f64 / took.as_secs_f64(),
        passages as f64 / n as f64
    );
    let size = |like: &str| -> f64 {
        conn.query_row(
            "SELECT coalesce(sum(pgsize), 0) FROM dbstat WHERE name LIKE ?1",
            [like],
            |r| r.get::<_, i64>(0),
        )
        .unwrap() as f64
            / 1e6
    };
    println!(
        "vec_docs {:.1} MB, vec_passages {:.1} MB, vec_pending {:.2} MB",
        size("vec_docs%"),
        size("vec_passages%"),
        size("vec_pending%")
    );
    let t = Instant::now();
    let cache = VecCache::new(index::load_all(&conn).unwrap());
    println!(
        "cache load {:?}, {:.1} MB of vectors",
        t.elapsed(),
        (cache.len() * 256 * 4) as f64 / 1e6
    );

    let db = Mutex::new(conn);
    let cache = Mutex::new(Some(cache));
    let queries = [
        "budget meeting next week",
        "flight itinerary",
        "parking permit renewal",
        "invoice payment",
        "server outage",
        "grant proposal deadline",
        "birthday party",
        "concert tickets",
        "library board vote",
        "course grades",
        "who approved the travel request",
        "subscription renewal reminder",
    ];
    let all = SearchFilter::default();
    let inbox = vec!["inbox".to_string()];
    let scoped = SearchFilter {
        folder_ids: Some(&inbox),
        ..SearchFilter::default()
    };
    let t = Instant::now();
    search::hybrid(&db, &e, &cache, "warm up", &all, 3).unwrap();
    println!("first query (model warm-up) {:?}", t.elapsed());
    let mut times = vec![];
    for round in 0..3 {
        for q in &queries {
            let f = if round == 1 { &scoped } else { &all };
            let t = Instant::now();
            let r = search::hybrid(&db, &e, &cache, q, f, 5).unwrap().unwrap();
            times.push(t.elapsed());
            assert!(!r.0.is_empty());
        }
    }
    times.sort();
    println!(
        "hybrid query p50 {:?}, p95 {:?}, max {:?}",
        times[times.len() / 2],
        times[times.len() * 95 / 100],
        times.last().unwrap()
    );
    let t = Instant::now();
    let (hits, qv) = search::hybrid(&db, &e, &cache, "who approved the travel request", &all, 5)
        .unwrap()
        .unwrap();
    let ps = search::passages(&db.lock().unwrap(), &hits, &qv).unwrap();
    println!(
        "passages query {:?}, {} chars of passages for {} hits",
        t.elapsed(),
        ps.iter().map(|p| p.passage.len()).sum::<usize>(),
        ps.len()
    );
}

/// Where a query's time goes, on the database `index_bench` left (run that first).
#[test]
#[ignore = "needs the model file and index_bench's database; see the module docs"]
fn query_bench() {
    let path = std::env::var("ZMAIL_SEMANTIC_BENCH_DB").expect("set ZMAIL_SEMANTIC_BENCH_DB");
    let conn = Connection::open(&path).unwrap();
    let e = Embedder::new(model());
    let all = SearchFilter::default();
    let t = Instant::now();
    let cache = VecCache::new(index::load_all(&conn).unwrap());
    println!("cache load {:?}", t.elapsed());
    e.embed(&[text::query_prompt("warm up")], Priority::Query)
        .unwrap();
    let q = "who approved the travel request";
    let time = |label: &str, f: &mut dyn FnMut()| {
        let t = Instant::now();
        for _ in 0..10 {
            f();
        }
        println!("{label:24} {:?}", t.elapsed() / 10);
    };
    let mut qv = vec![];
    time("embed query", &mut || {
        qv = e
            .embed(&[text::query_prompt(q)], Priority::Query)
            .unwrap()
            .pop()
            .flatten()
            .unwrap();
    });
    let mut top = vec![];
    time("cosine top 1000", &mut || top = cache.top(&qv, 1000));
    let ids: Vec<i64> = top.iter().map(|x| x.0).collect();
    let with = "EXISTS (SELECT 1 FROM vec_docs v WHERE v.id = m.rowid)";
    time("scope 1000", &mut || {
        db::rows_in_scope_conn(&conn, &ids, &all, with).unwrap();
    });
    time("scope 200", &mut || {
        db::rows_in_scope_conn(&conn, &ids[..200], &all, with).unwrap();
    });
    time("fts any 100", &mut || {
        db::search_any_conn(&conn, q, &all, 100).unwrap();
    });
    let db = Mutex::new(conn);
    let cache = Mutex::new(Some(cache));
    time("hybrid", &mut || {
        search::hybrid(&db, &e, &cache, q, &all, 5).unwrap();
    });
}
