// RopeLine on this Mac: signals and a wording fingerprint, read from the text.
// Links are text. Nothing here is fetched or opened. Nothing is moved.

import { sha256Hex } from "@/lib/sha256";
import type { Email } from "@/lib/types";

export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com", "outlook.com",
  "hotmail.com", "hotmail.co.uk", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.com", "zoho.com", "yandex.com",
  "yandex.ru", "mail.ru", "list.ru", "bk.ru", "inbox.ru", "rambler.ru", "tutanota.com", "tuta.io", "fastmail.com",
  "hushmail.com", "qq.com", "163.com", "126.com", "sina.com", "naver.com", "seznam.cz", "onet.pl", "wp.pl",
]);

export const SHORTENERS = new Set([
  "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "v.gd", "buff.ly", "rebrand.ly",
  "cutt.ly", "shorturl.at", "rb.gy", "tiny.cc", "t.ly", "bl.ink", "short.io", "s.id", "lnkd.in", "qrco.de",
  "shorte.st", "adf.ly", "clck.ru", "snip.ly", "tr.im", "x.co", "u.to", "soo.gd", "urlz.fr", "bit.do",
]);

const COMMON_TLDS = new Set(("com net org info biz io co uk ca au de fr ru cn xyz top online site shop store club app "
  + "dev tk ml ga cf gq ly gl gd gy cc ai nl es pl br jp eu ch se link live click icu buzz vip pro mobi tv ws su ua "
  + "kz ir vn tr pw cfd sbs bond life world website space tech fun cloud email agency digital services "
  + "solutions ltd company business news blog page").split(" "));
const TWO_LEVEL = new Set(("co.uk org.uk me.uk ltd.uk plc.uk ac.uk gov.uk com.au net.au org.au co.nz org.nz co.za "
  + "com.br com.mx co.jp co.in com.cn com.tr co.il com.sg com.hk com.ar co.kr").split(" "));

const VALUE_MAX = 320;
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/u;
const LATIN = /\p{Script=Latin}/u;
const MARK = /\p{M}/u;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/gu;
const PHONE_PAIR = /[\u202A\u202B][\p{Nd}\s+().-]{1,40}\u202C|[\u2066-\u2068][\p{Nd}\s+().-]{1,40}\u2069/gu;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const WWW_RE = /(?<![\p{L}\p{N}\p{M}._@/:-])www\.[\p{L}\p{N}\p{M}.-]+/giu;
const BARE_RE = /(?<![\p{L}\p{N}\p{M}._@/:-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?\.)+[a-z]{2,24}(?![\p{L}\p{N}\p{M}_-]|\.[\p{L}\p{N}])/giu;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

const SIGNAL_KINDS = new Set([
  "url_domain", "url_count", "shortener", "ip_literal_url", "punycode_domain", "lookalike_domain",
  "own_domain_sender", "free_mail_sender", "zero_width_text", "bidi_control", "mixed_script",
  "name_repeated", "name_random_string",
]);

export interface RopeLineSignal {
  kind: string;
  value: string | null;
}

/** What sort stored for one inbox email. `flagged` does not move the message. */
export interface RopeLineFlag {
  flagged: boolean;
  signals: RopeLineSignal[];
  /** 16 lowercase hex digits, or null when the wording is under 8 words. */
  fingerprint: string | null;
  /** Hash of the text this flag was read from. */
  key: string;
  /** Advisory spam questions. Absent until a decision provider has answered. */
  advice?: RopeLineAdvice;
}

export interface RopeLineAdvice {
  advised: boolean;
  alarms: { id: string; yes: boolean; probability: number }[];
  family: string | null;
}

export interface RopeLineInput {
  text?: string;
  name?: string;
  email?: string;
  ownDomains?: string[];
}

function hostOf(raw: string): { ip: string } | { domain: string } | null {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    if (host.startsWith("[") || IPV4.test(host)) return { ip: host };
    if (HOSTNAME.test(host)) return { domain: host.replace(/^www\./, "") };
  } catch { /* not a host */ }
  return null;
}

function scanLinks(text: string): { domains: string[]; ips: string[]; count: number } {
  const domains = new Set<string>();
  const ips = new Set<string>();
  let count = 0;
  let rest = String(text ?? "");
  const pass = (re: RegExp, toUrl: (m: string) => string, accept: (h: { ip: string } | { domain: string }) => boolean) => {
    rest = rest.replace(re, (m) => {
      const host = hostOf(toUrl(m.replace(/[.,;:!?)\]}'"*>-]+$/u, "")));
      if (!host || !accept(host)) return m;
      count++;
      if ("ip" in host) ips.add(host.ip);
      else domains.add(host.domain);
      return " ".repeat(m.length);
    });
  };
  pass(URL_RE, (m) => m, () => true);
  pass(WWW_RE, (m) => "http://" + m, () => true);
  pass(BARE_RE, (m) => "http://" + m, (h) => "domain" in h && (COMMON_TLDS.has(h.domain.split(".").pop() ?? "") || SHORTENERS.has(h.domain)));
  return { domains: [...domains], ips: [...ips], count };
}

/** Hostnames named in the text. Fetches nothing. */
export function extractDomains(text: string | undefined): string[] {
  return scanLinks(text ?? "").domains;
}

function registrable(domain: string): string {
  const labels = domain.split(".");
  return labels.slice(labels.length > 2 && TWO_LEVEL.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
}

function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...row) > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

function siteHost(s: string): string | null {
  if (!s.trim()) return null;
  const host = hostOf(s.includes("://") ? s.trim() : "http://" + s.trim());
  return host && "domain" in host ? host.domain : null;
}

function randomName(name: string): string | null {
  for (const word of name.split(/\s+/)) {
    if (/\p{L}{4}\p{Nd}{4}/u.test(word)) return "digits";
    if ((word.slice(1).match(/\p{Lu}/gu) || []).length >= 4 && (word.match(/\p{Ll}/gu) || []).length >= 3) return "case";
    if (/[bcdfghjklmnpqrstvwxz]{6,}/i.test(word)) return "consonants";
  }
  return null;
}

function repeatedWord(name: string): string | null {
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  return new Set(words).size < words.length ? "word" : null;
}

function hiddenInWords(text: string): number {
  let count = 0;
  let run = 0;
  let afterLatin = false;
  for (const ch of text) {
    if (ZERO_WIDTH.test(ch)) {
      if (afterLatin) run++;
      continue;
    }
    const latin = LATIN.test(ch);
    if (run && latin) count += run;
    afterLatin = latin || (afterLatin && !run && MARK.test(ch));
    run = 0;
  }
  return count;
}

function bidiControls(text: string): number {
  const stripped = text.replace(PHONE_PAIR, (m) => (/\p{Nd}/u.test(m) ? " " : m));
  return (stripped.match(BIDI) || []).length;
}

function senderDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  const host = hostOf("http://" + email.slice(at + 1).trim().replace(/[\s>].*$/s, ""));
  return host && "domain" in host ? host.domain : "";
}

/** Signals that can be read off a mailbox message. No door, no network, no domain-age lookup. */
export function mailboxSignals(input: RopeLineInput = {}): RopeLineSignal[] {
  const out: RopeLineSignal[] = [];
  const add = (kind: string, value: string | number | null = null) => {
    if (!SIGNAL_KINDS.has(kind)) return;
    out.push({ kind, value: value === null ? null : String(value).slice(0, VALUE_MAX) });
  };
  const body = typeof input.text === "string" ? input.text : "";
  const name = typeof input.name === "string" ? input.name : "";
  const email = typeof input.email === "string" ? input.email : "";
  const extra = [name, email].filter((v) => v && !body.includes(v));
  const scan = [body, ...extra].join("\n");
  const sites = (input.ownDomains ?? []).map(siteHost).filter((d): d is string => Boolean(d));
  const isSite = (d: string) => sites.some((s) => d === s || d.endsWith("." + s));
  const sender = senderDomain(email);
  if (sender && isSite(sender)) add("own_domain_sender", sender);
  if (FREE_MAIL.has(sender)) add("free_mail_sender", sender);
  const hidden = hiddenInWords(scan);
  if (hidden) add("zero_width_text", hidden);
  const bidi = bidiControls(scan);
  if (bidi) add("bidi_control", bidi);
  const mixed = (scan.match(/[\p{L}\p{M}]+/gu) || []).find((w) => /\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w));
  if (mixed) add("mixed_script", mixed.slice(0, 64));
  if (name.trim()) {
    const repeated = repeatedWord(name);
    if (repeated) add("name_repeated", repeated);
    const random = randomName(name);
    if (random) add("name_random_string", random);
  }
  const { domains, ips, count: links } = scanLinks(scan);
  if (links) add("url_count", links);
  for (const v of ips.slice(0, 10)) add("ip_literal_url", v);
  for (const d of domains.filter((x) => x.split(".").some((l) => l.startsWith("xn--"))).slice(0, 10)) add("punycode_domain", d);
  const siteLabels = sites.map((s) => registrable(s).split(".")[0]).filter((l) => l.length >= 5);
  const looksLike = (d: string) => {
    const label = registrable(d).split(".")[0];
    return label.length >= 5 && siteLabels.some((s) => s !== label && withinEdits(label, s, 2));
  };
  for (const d of domains.filter((x) => !isSite(x) && looksLike(x)).slice(0, 10)) add("lookalike_domain", d);
  for (const d of domains.filter((x) => SHORTENERS.has(x)).slice(0, 10)) add("shortener", d);
  for (const d of domains.slice(0, 20)) add("url_domain", d);
  return out.slice(0, 60);
}

const MASK = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const HEX16 = /^[0-9a-f]{16}$/;
const utf8 = new TextEncoder();

/** Lowercase; links become "url", addresses "email", each run of digits "0". */
export function normalizeForFingerprint(text: string | null | undefined): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/\b(?:https?:\/\/|www\.)\S+/g, " url ")
    .replace(/\S+/g, (token) => (token.includes("@") && /^[^@]+@[^@]+\.[^@]+$/.test(token) ? " email " : token))
    .replace(/\p{Nd}+/gu, "0")
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (const byte of utf8.encode(s)) h = ((h ^ BigInt(byte)) * FNV_PRIME) & MASK;
  return h;
}

/** 64-bit SimHash over word 3-shingles, as 16 hex digits. */
export function simhash64(text: string): string {
  const words = normalizeForFingerprint(text).split(" ").filter(Boolean);
  const features = words.length < 3 ? words : words.slice(2).map((w, i) => `${words[i]} ${words[i + 1]} ${w}`);
  const weights = new Array(64).fill(0);
  for (const feature of features) {
    const h = fnv1a64(feature);
    const lo = Number(h & 0xffffffffn);
    const hi = Number(h >> 32n);
    for (let b = 0; b < 32; b++) {
      weights[b] += (lo >>> b) & 1 ? 1 : -1;
      weights[b + 32] += (hi >>> b) & 1 ? 1 : -1;
    }
  }
  let out = 0n;
  for (let b = 63; b >= 0; b--) out = (out << 1n) | (weights[b] > 0 ? 1n : 0n);
  return out.toString(16).padStart(16, "0");
}

function popcount32(x: number): number {
  let n = 0;
  for (let v = x >>> 0; v; v &= v - 1) n++;
  return n;
}

/** Bits two fingerprints differ in. */
export function hamming(a: string, b: string): number {
  if (!HEX16.test(a) || !HEX16.test(b)) throw new TypeError("a fingerprint is 16 lowercase hex digits");
  return popcount32(parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) + popcount32(parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16));
}

/** Nearest known fingerprint within `threshold` bits lends its group. */
export function groupFor(fp: string, known: Map<string, string>, threshold = 3): string {
  if (!HEX16.test(fp)) throw new TypeError("a fingerprint is 16 lowercase hex digits");
  if (known.has(fp)) return known.get(fp) as string;
  let group = fp;
  let nearest = threshold + 1;
  for (const [other, otherGroup] of known) {
    const d = hamming(fp, other);
    if (d < nearest) {
      nearest = d;
      group = otherGroup;
    }
  }
  known.set(fp, group);
  return group;
}

export const MIN_FINGERPRINT_WORDS = 8;

/** Fingerprint of subject plus body. Short wording has none. */
export function fingerprintOf(subject: string, text: string): string | null {
  const raw = `${subject}\n${text}`;
  const words = normalizeForFingerprint(raw).split(" ").filter(Boolean);
  return words.length >= MIN_FINGERPRINT_WORDS ? simhash64(raw) : null;
}

export function ropeLineKey(email: Pick<Email, "from" | "subject" | "text">): string {
  return sha256Hex(`${email.from.address}\n${email.subject}\n${email.text}`).slice(0, 32);
}

export function ownDomains(accounts: { address: string }[]): string[] {
  const out: string[] = [];
  for (const a of accounts) {
    const domain = senderDomain(a.address);
    if (domain && !FREE_MAIL.has(domain) && !out.includes(domain)) out.push(domain);
  }
  return out;
}

export function flagFor(email: Pick<Email, "from" | "subject" | "text">, domains: string[], key = ropeLineKey(email)): RopeLineFlag {
  const signals = mailboxSignals({
    text: `${email.subject}\n${email.text}`,
    name: email.from.name,
    email: email.from.address,
    ownDomains: domains,
  });
  return { flagged: signals.length > 0, signals, fingerprint: fingerprintOf(email.subject, email.text), key };
}

/** Flags for every inbox email, reusing a stored flag when the text has not changed. Mail is not in the return. */
export function nextRopeLineFlags(
  emails: Pick<Email, "id" | "folderId" | "from" | "subject" | "text">[],
  inboxIds: Set<string>,
  domains: string[],
  prev: Record<string, RopeLineFlag>,
  skip: Set<string> = new Set(),
): Record<string, RopeLineFlag> | null {
  let next = prev;
  let changed = false;
  for (const e of emails) {
    if (!inboxIds.has(e.folderId) || skip.has(e.id)) continue;
    const key = ropeLineKey(e);
    if (next[e.id]?.key === key) continue;
    if (!changed) {
      next = { ...prev };
      changed = true;
    }
    next[e.id] = flagFor(e, domains, key);
  }
  return changed ? next : null;
}

function isSignal(v: unknown): v is RopeLineSignal {
  if (!v || typeof v !== "object") return false;
  const s = v as { kind?: unknown; value?: unknown };
  return typeof s.kind === "string" && SIGNAL_KINDS.has(s.kind) && (s.value === null || typeof s.value === "string");
}

/** A saved map, dropped where it is not a flag. Values are cut to the same bounds the check writes. */
export function validRopeLineFlags(raw: unknown): Record<string, RopeLineFlag> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, RopeLineFlag> = {};
  for (const [id, v] of Object.entries(raw).slice(0, 20000)) {
    if (!v || typeof v !== "object") continue;
    const f = v as { signals?: unknown; fingerprint?: unknown; key?: unknown };
    const key = typeof f.key === "string" ? f.key.slice(0, 64) : "";
    if (!key) continue;
    const signals = (Array.isArray(f.signals) ? f.signals.filter(isSignal) : [])
      .slice(0, 60)
      .map((s) => ({ kind: s.kind, value: s.value === null ? null : s.value.slice(0, VALUE_MAX) }));
    const fingerprint = typeof f.fingerprint === "string" && HEX16.test(f.fingerprint) ? f.fingerprint : null;
    const advice = validAdvice((f as { advice?: unknown }).advice);
    out[id] = { flagged: signals.length > 0, signals, fingerprint, key, ...(advice ? { advice } : {}) };
  }
  return out;
}

function validAdvice(raw: unknown): RopeLineAdvice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as { advised?: unknown; alarms?: unknown; family?: unknown };
  if (typeof a.advised !== "boolean" || !Array.isArray(a.alarms)) return undefined;
  const alarms = a.alarms
    .filter((x): x is { id: string; yes: boolean; probability: number } => {
      if (!x || typeof x !== "object") return false;
      const r = x as { id?: unknown; yes?: unknown; probability?: unknown };
      return typeof r.id === "string" && typeof r.yes === "boolean" && typeof r.probability === "number" && r.probability >= 0 && r.probability <= 1;
    })
    .slice(0, 20)
    .map((x) => ({ id: x.id.slice(0, 64), yes: x.yes, probability: x.probability }));
  const family = typeof a.family === "string" && a.family.length <= 64 ? a.family : null;
  return { advised: a.advised, alarms, family };
}
