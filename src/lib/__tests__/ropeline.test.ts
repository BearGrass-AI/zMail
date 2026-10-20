// RopeLine's on-device check: the same readings it already makes, on mailbox text.
// Made-up names and example.com only. The check does not move mail.
import { describe, expect, it } from "vitest";
import {
  extractDomains,
  fingerprintOf,
  flagFor,
  FREE_MAIL,
  groupFor,
  hamming,
  mailboxSignals,
  MIN_FINGERPRINT_WORDS,
  nextRopeLineFlags,
  normalizeForFingerprint,
  ownDomains,
  SHORTENERS,
  simhash64,
  validRopeLineFlags,
} from "@/lib/ropeline";
import type { Email } from "@/lib/types";

const SITE = ["https://www.acmeplumbing.example/"];
const values = (signals: { kind: string; value: string | null }[], kind: string) => signals.filter((s) => s.kind === kind).map((s) => s.value);
const at = (user: string, domain: string) => `${user}@${domain}`;
const mail = (over: Partial<Email> = {}): Email =>
  ({
    id: "e1",
    accountId: "g",
    threadId: "e1",
    folderId: "g:INBOX",
    from: { name: "Pat Example", address: "pat@example.com" },
    to: [],
    subject: "Hello",
    snippet: "",
    text: "A short note.",
    date: "2026-10-01T00:00:00Z",
    unread: false,
    starred: false,
    labels: [],
    ...over,
  }) as Email;

describe("signals", () => {
  it("keeps the free-mail and shortener names", () => {
    for (const d of ["gmail.com", "yahoo.com", "outlook.com", "proton.me", "mail.ru"]) expect(FREE_MAIL.has(d)).toBe(true);
    for (const d of ["bit.ly", "tinyurl.com", "t.co"]) expect(SHORTENERS.has(d)).toBe(true);
  });

  it("reads hosts from links and ignores the rest", () => {
    const text = [
      "See https://Files.Example.com/doc?id=1, and http://www.shop.example.org/a.",
      "Trick: https://paypal.com@login.example.org/verify (the host is after the @).",
      "Also www.portal.example.net and invoices.example.com.",
      "Write to pat@mail.example.com or call 555 0100.",
      "A bare address http://192.0.2.7/x is not a domain.",
      "Not links: report.pdf, see you.In May, e.g. this, version 2.5, and plain words.",
    ].join("\n");
    expect(extractDomains(text)).toEqual(["files.example.com", "shop.example.org", "login.example.org", "portal.example.net", "invoices.example.com"]);
    expect(extractDomains("https://p\u0430ypal.example/login")).toEqual(["xn--pypal-4ve.example"]);
    expect(extractDomains("bit.ly/abc and shorturl.at/xyz")).toEqual(["bit.ly", "shorturl.at"]);
    expect(extractDomains("")).toEqual([]);
    expect(extractDomains(undefined)).toEqual([]);
  });

  it("counts links, shorteners, bare IPs, punycode and a look-alike of the user's domain", () => {
    const text = "Pay at https://acmeplumbimg.example/pay or https://xn--pple-43d.example/x, short link bit.ly/q, "
      + "raw http://192.0.2.7/a, and our real site https://acmeplumbing.example/about.";
    const s = mailboxSignals({ text, ownDomains: SITE });
    expect(values(s, "url_count")).toEqual(["5"]);
    expect(values(s, "url_domain")).toEqual(["acmeplumbimg.example", "xn--pple-43d.example", "acmeplumbing.example", "bit.ly"]);
    expect(values(s, "shortener")).toEqual(["bit.ly"]);
    expect(values(s, "ip_literal_url")).toEqual(["192.0.2.7"]);
    expect(values(s, "punycode_domain")).toEqual(["xn--pple-43d.example"]);
    expect(values(s, "lookalike_domain")).toEqual(["acmeplumbimg.example"]);
    const far = mailboxSignals({ text: "https://acmeplumbing-shop-online.example/", ownDomains: SITE });
    expect(values(far, "lookalike_domain")).toEqual([]);
  });

  it("reads the sender's own domain and a free-mail sender", () => {
    expect(values(mailboxSignals({ text: "hi", email: at("owner", "acmeplumbing.example"), ownDomains: SITE }), "own_domain_sender")).toEqual(["acmeplumbing.example"]);
    expect(values(mailboxSignals({ text: "hi", email: at("owner", "mail.acmeplumbing.example"), ownDomains: SITE }), "own_domain_sender")).toEqual(["mail.acmeplumbing.example"]);
    expect(values(mailboxSignals({ text: "hi", email: at("pat", "GMail.com"), ownDomains: SITE }), "free_mail_sender")).toEqual(["gmail.com"]);
    expect(values(mailboxSignals({ text: "hi", email: `Pat Example <${at("pat", "yahoo.com")}>` }), "free_mail_sender")).toEqual(["yahoo.com"]);
    expect(mailboxSignals({ text: "hi", email: "pat@example.com", ownDomains: SITE })).toEqual([]);
  });

  it("counts hidden characters, direction controls and a mixed-alphabet word", () => {
    const s = mailboxSignals({ text: "pa\u200Bss\u200Cword \u202Eevil\u202C and p\u0430ypal" });
    expect(values(s, "zero_width_text")).toEqual(["2"]);
    expect(values(s, "bidi_control")).toEqual(["2"]);
    expect(values(s, "mixed_script")).toEqual(["p\u0430ypal"]);
    expect(mailboxSignals({ text: "caf\u00e9 na\u00efve \u0437\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439" })).toEqual([]);
  });

  it("skips a direction pair around a phone number", () => {
    expect(values(mailboxSignals({ text: "Call \u202A+1 (555) 010-0100\u202C or \u2066+44 20 7946 0000\u2069" }), "bidi_control")).toEqual([]);
    expect(values(mailboxSignals({ text: "\u202Eevil\u202C" }), "bidi_control")).toEqual(["2"]);
    expect(values(mailboxSignals({ text: "\u202E5550100\u202C" }), "bidi_control")).toEqual(["2"]);
  });

  it("flags a repeated or random display name and leaves an ordinary name", () => {
    expect(values(mailboxSignals({ text: "hi", name: "Pat Pat" }), "name_repeated")).toEqual(["word"]);
    expect(values(mailboxSignals({ text: "hi", name: "abcd12345" }), "name_random_string")).toEqual(["digits"]);
    expect(values(mailboxSignals({ text: "hi", name: "ncYqmEOFmFbW" }), "name_random_string")).toEqual(["case"]);
    expect(values(mailboxSignals({ text: "hi", name: "Xkqzbtrw" }), "name_random_string")).toEqual(["consonants"]);
    for (const ok of ["Pat Example", "McDONALD", "JOHN SMITH"]) expect(mailboxSignals({ text: "hi", name: ok })).toEqual([]);
  });

  it("caps the lists", () => {
    const many = Array.from({ length: 80 }, (_, i) => `https://host${i}.example/ http://192.0.2.${i}/`).join(" ");
    const s = mailboxSignals({ text: many, name: "Pat Pat", email: at("pat", "gmail.com"), ownDomains: SITE });
    expect(s.length).toBeLessThanOrEqual(60);
    expect(values(s, "ip_literal_url").length).toBe(10);
    expect(values(s, "url_domain").length).toBeLessThanOrEqual(20);
  });
});

describe("fingerprint", () => {
  it("flattens links, addresses, numbers and case", () => {
    expect(normalizeForFingerprint("Hello, PAT! Visit https://x.example/a?b=1 or www.y.example, mail pat@example.com; call 555-0100.")).toBe(
      "hello pat visit url or url mail email call 0 0",
    );
    expect(normalizeForFingerprint("pa\u200Bss\u00ADword")).toBe("password");
    expect(normalizeForFingerprint("\uFF26\uFF52\uFF45\uFF45")).toBe("free");
    expect(normalizeForFingerprint(null)).toBe("");
  });

  it("matches the published 64-bit vectors", () => {
    expect(simhash64("a")).toBe("af63dc4c8601ec8c");
    expect(simhash64("foobar")).toBe("85944171f73967e8");
    expect(simhash64("")).toBe("0000000000000000");
    expect(simhash64("any text at all, of any length")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives one campaign's variants the same fingerprint", () => {
    const template = (link: string, addr: string, ref: string) =>
      `We found images on your website that belong to our client. Review the evidence at ${link} and remove them within 48 hours, or write to ${addr} quoting case ${ref}. Otherwise legal action follows.`;
    const a = simhash64(template("https://evidence.example/a1", "legal@example.org", "CR-1182"));
    const b = simhash64(template("http://proof.example.net/zz", "claims@example.com", "CR-90311"));
    expect(a).toBe(b);
    const c = simhash64("Hi, I would like a quote for a new kitchen sink and tap, fitted next week if you can. Thanks.");
    expect(hamming(a, c)).toBeGreaterThan(10);
  });

  it("counts bits and refuses a bad fingerprint", () => {
    expect(hamming("0123456789abcdef", "0123456789abcdef")).toBe(0);
    expect(hamming("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hamming("8000000000000000", "0000000000000001")).toBe(2);
    expect(() => hamming("xyz", "0000000000000000")).toThrow(TypeError);
  });

  it("joins a nearby group", () => {
    const known = new Map<string, string>();
    expect(groupFor("0000000000000000", known)).toBe("0000000000000000");
    expect(groupFor("0000000000000007", known)).toBe("0000000000000000");
    expect(groupFor("ff00000000000000", known)).toBe("ff00000000000000");
    expect(known.size).toBe(3);
  });

  it("skips a short message", () => {
    expect(MIN_FINGERPRINT_WORDS).toBe(8);
    expect(fingerprintOf("Hi", "Just saying hello today")).toBeNull();
    const long = fingerprintOf("Invoice", "Please review the attached note and send the signed copy back when you can this week.");
    expect(long).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("inbox flags", () => {
  it("flags inbox mail and leaves the message where it is", () => {
    const clean = mail({ id: "clean", text: "See you at the shop." });
    const bad = mail({
      id: "bad",
      from: { name: "Pat Pat", address: "pat@gmail.com" },
      subject: "Pay",
      text: "Use https://bit.ly/q today.",
    });
    const archived = mail({ id: "old", folderId: "g:ARCHIVE", text: "https://bit.ly/old" });
    const folders = new Set(["g:INBOX"]);
    const flags = nextRopeLineFlags([clean, bad, archived], folders, ["acmeplumbing.example"], {});
    expect(flags?.clean.flagged).toBe(false);
    expect(flags?.bad.flagged).toBe(true);
    expect(flags?.bad.signals.some((s) => s.kind === "shortener")).toBe(true);
    expect(flags?.old).toBeUndefined();
    expect(clean.folderId).toBe("g:INBOX");
    expect(bad.folderId).toBe("g:INBOX");
    expect(archived.folderId).toBe("g:ARCHIVE");
  });

  it("reuses a flag when the text is unchanged and ignores a free-mail account as the user's domain", () => {
    const e = mail();
    const first = flagFor(e, []);
    const again = nextRopeLineFlags([e], new Set(["g:INBOX"]), [], { [e.id]: first });
    expect(again).toBeNull();
    expect(ownDomains([{ address: "z@gmail.com" }, { address: "z@acmeplumbing.example" }])).toEqual(["acmeplumbing.example"]);
  });

  it("drops a saved flag that is not one", () => {
    expect(validRopeLineFlags(null)).toEqual({});
    expect(validRopeLineFlags({ a: { key: "abc", signals: [{ kind: "nope", value: "x" }], fingerprint: "zz" } })).toEqual({
      a: { flagged: false, signals: [], fingerprint: null, key: "abc" },
    });
  });
});
