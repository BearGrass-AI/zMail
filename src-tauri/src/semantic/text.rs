//! What the model reads for an email, a passage and a query: the prompts EmbeddingGemma was
//! trained with, over the email's own words (quoted replies, inline link targets and tracking URLs
//! stripped). Kept exactly as the trial that measured them; changing anything here changes the
//! vectors, so bump `index::INDEX_VERSION` with it.

use regex::Regex;
use std::sync::LazyLock;

/// Characters of body text a document prompt carries (the token cut comes later, at 512).
const DOC_BODY_CHARS: usize = 16_000;
/// Passage size in characters, and passages kept per email (its first ones).
pub const PASSAGE_CHARS: usize = 300;
pub const PASSAGES_MAX: usize = 12;

/// Where a quoted reply or forwarded original starts.
static QUOTE_MARKERS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?m)^\s*On .{5,200}wrote:\s*$",
        r"(?mi)^\s*-{2,}\s*Original Message\s*-{2,}",
        r"(?m)^\s*_{10,}\s*$\n+\s*From:",
        r"(?m)^\s*From:\s.+\n(\s*(Sent|Date):\s.+\n)",
        r"(?mi)^\s*-{2,}\s*Forwarded message\s*-{2,}",
        // Outlook's header flattened onto one line.
        r"From:\s[^\n]{1,200}?(Sent|Date):\s",
        r"(?i)-{3,}\s*Original message\s*-{3,}",
        r"On [^\n]{5,120}? wrote:",
        r"_{20,}\s*From:",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("quote marker"))
    .collect()
});
static LINK_TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<https?://[^>]+>").unwrap());
static LONG_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://\S{60,}").unwrap());
static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("[ \t\u{a0}\u{200b}\u{200c}\u{34f}]+").unwrap());
static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n+").unwrap());

/// The email's own text: cut at the first quote marker past its first 40 characters (so a
/// forward whose body *is* the quote keeps it), `>` lines dropped, link targets and long URLs
/// removed, runs of spaces and blank lines collapsed.
pub fn clean_body(text: &str) -> String {
    let t = text.replace("\r\n", "\n");
    let mut cut = t.len();
    for rx in QUOTE_MARKERS.iter() {
        if let Some(m) = rx.find(&t)
            && t[..m.start()].chars().count() > 40
        {
            cut = cut.min(m.start());
        }
    }
    let t = t[..cut]
        .split('\n')
        .filter(|l| !l.trim_start().starts_with('>'))
        .collect::<Vec<_>>()
        .join("\n");
    let t = LINK_TARGET.replace_all(&t, "");
    let t = LONG_URL.replace_all(&t, "[link]");
    let t = SPACES.replace_all(&t, " ");
    let t = BLANK_LINES.replace_all(&t, "\n\n");
    t.trim().to_string()
}

fn title(subject: &str) -> String {
    let t = subject.trim().replace('\n', " ");
    if t.is_empty() { "none".into() } else { t }
}

/// What an email is embedded as: subject as the title, then the sender and the cleaned body.
pub fn doc_prompt(subject: &str, from_name: &str, from_address: &str, body: &str) -> String {
    let body: String = body.chars().take(DOC_BODY_CHARS).collect();
    format!(
        "title: {} | text: {from_name} <{from_address}>\n{body}",
        title(subject)
    )
}

pub fn passage_prompt(subject: &str, passage: &str) -> String {
    format!("title: {} | text: {passage}", title(subject))
}

pub fn query_prompt(query: &str) -> String {
    format!("task: search result | query: {query}")
}

/// The cleaned body's first `PASSAGES_MAX` passages: whole words packed up to `PASSAGE_CHARS`
/// characters (a longer word is cut to that).
pub fn passages(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0;
    for w in body.split_whitespace() {
        let w: String = w.chars().take(PASSAGE_CHARS).collect();
        let len = w.chars().count();
        if cur_len + len + 1 > PASSAGE_CHARS && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
            if out.len() == PASSAGES_MAX {
                return out;
            }
            cur = w;
            cur_len = len;
        } else {
            if !cur.is_empty() {
                cur.push(' ');
                cur_len += 1;
            }
            cur.push_str(&w);
            cur_len += len;
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_gmail_style_quote() {
        let body = "Sounds good, see you at the parking garage on Tuesday.\r\n\r\nOn Mon, Oct 5, 2026 at 9:00 AM Dana <dana@example.com> wrote:\r\n> Where should we meet?\r\n> Thanks";
        assert_eq!(
            clean_body(body),
            "Sounds good, see you at the parking garage on Tuesday."
        );
    }

    #[test]
    fn strips_outlook_headers_even_on_one_line() {
        let body = "Approved, please go ahead with the order for the lab.\nFrom: Sam Lee <sam@x.edu> Sent: Monday, October 5, 2026 9:00 AM To: me Subject: order";
        assert_eq!(
            clean_body(body),
            "Approved, please go ahead with the order for the lab."
        );
        let body2 = "Thanks for the update, I will review it tonight.\n\nFrom: Sam Lee\nSent: Monday\nTo: me\n\nOlder text";
        assert_eq!(
            clean_body(body2),
            "Thanks for the update, I will review it tonight."
        );
    }

    #[test]
    fn keeps_a_forward_whose_body_is_the_quote() {
        // The marker is within the first 40 characters: that's the whole content, so it stays.
        let body = "FYI\n---------- Forwarded message ---------\nFrom: a\nThe real content here.";
        assert!(clean_body(body).contains("The real content here."));
    }

    #[test]
    fn drops_quote_lines_links_and_extra_space() {
        let body = "Hello there\u{a0}\u{a0}friend\n> quoted line\nSee <https://example.com/x> and https://track.example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\n\n\nBye";
        assert_eq!(
            clean_body(body),
            "Hello there friend\nSee and [link]\n\nBye"
        );
    }

    #[test]
    fn prompts_match_the_trained_framing() {
        assert_eq!(
            doc_prompt("  Budget\nQ3 ", "Alice", "a@x.com", "Body"),
            "title: Budget Q3 | text: Alice <a@x.com>\nBody"
        );
        assert_eq!(doc_prompt("", "", "", "b"), "title: none | text:  <>\nb");
        assert_eq!(passage_prompt("Hi", "words"), "title: Hi | text: words");
        assert_eq!(
            query_prompt("flight"),
            "task: search result | query: flight"
        );
        let long = "x".repeat(20_000);
        assert_eq!(
            doc_prompt("s", "n", "a", &long).len(),
            "title: s | text: n <a>\n".len() + 16_000
        );
    }

    #[test]
    fn passages_pack_words_and_are_bounded() {
        let body = (0..1000)
            .map(|i| format!("word{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let ps = passages(&body);
        assert_eq!(ps.len(), PASSAGES_MAX);
        assert!(ps.iter().all(|p| p.chars().count() <= PASSAGE_CHARS));
        assert!(ps[0].starts_with("word0 word1 "));
        // Consecutive: nothing is skipped between passages.
        let joined = ps.join(" ");
        assert!(body.starts_with(&joined));
        assert_eq!(passages("one two"), vec!["one two"]);
        assert!(passages("   ").is_empty());
        let huge = "y".repeat(1000);
        assert_eq!(passages(&huge), vec!["y".repeat(PASSAGE_CHARS)]);
    }
}
