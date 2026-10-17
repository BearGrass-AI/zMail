// src/lib/ai/assistant/query.ts
// The assistant's structured mail query and its translations: a Gmail search
// string, a Graph $search (KQL) or $filter, and a local matcher for the mock
// provider and for zMail-only fields (category, section).

import type { Category, Email, Folder } from "@/lib/types";
import { CATEGORIES } from "@/lib/types";

export interface MailQuery {
  /** Address, domain or name. */
  from?: string;
  to?: string;
  /** Words that must all appear in the subject. */
  subject?: string;
  /** Words anywhere in the email. */
  words?: string;
  /** YYYY-MM-DD, inclusive. */
  after?: string;
  /** YYYY-MM-DD, exclusive. */
  before?: string;
  /** System kind (inbox, archive, sent, spam, trash, drafts) or a folder id. */
  folder?: string;
  unread?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  /** zMail's category; only mail zMail has sorted has one. */
  category?: Category;
  /** One of the user's section ids. */
  section?: string;
  /** Limit to one account id. */
  account?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** YYYY-MM-DD that exists on the calendar (rejects 2025-02-30 and 2025-13-01). */
const isDate = (d: string) => {
  if (!DATE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const STRINGS = ["from", "to", "subject", "words", "folder", "section", "account"] as const;
const BOOLS = ["unread", "starred", "hasAttachment"] as const;
const SYSTEM_KINDS = ["inbox", "archive", "sent", "spam", "trash", "drafts"];

export function cleanQuery(raw: unknown): MailQuery {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("bad_query: query must be an object");
  const r = raw as Record<string, unknown>;
  const q: MailQuery = {};
  for (const k of STRINGS) {
    if (r[k] === undefined || r[k] === null || r[k] === "") continue;
    if (typeof r[k] !== "string") throw new Error(`bad_query: ${k} must be a string`);
    const v = (r[k] as string).trim();
    if (v) q[k] = v;
  }
  for (const k of BOOLS) {
    if (r[k] === undefined || r[k] === null) continue;
    if (typeof r[k] !== "boolean") throw new Error(`bad_query: ${k} must be true or false`);
    q[k] = r[k] as boolean;
  }
  for (const k of ["after", "before"] as const) {
    if (r[k] === undefined || r[k] === null || r[k] === "") continue;
    if (typeof r[k] !== "string" || !isDate(r[k] as string)) throw new Error(`bad_query: ${k} must be YYYY-MM-DD`);
    q[k] = r[k] as string;
  }
  if (r.category !== undefined && r.category !== null) {
    if (!CATEGORIES.includes(r.category as Category)) throw new Error(`bad_query: category must be one of ${CATEGORIES.join(", ")}`);
    q.category = r.category as Category;
  }
  assertSearchable(q);
  return q;
}

const TEXT_FIELDS = ["from", "to", "subject", "words"] as const;

/** A text field that sanitizes to nothing would silently widen the search, so it's an error instead. */
export function assertSearchable(q: MailQuery) {
  for (const k of TEXT_FIELDS) if (q[k] !== undefined && !tokens(q[k]!).length) throw new Error(`bad_query: ${k} has no searchable words`);
}

export function resolveFolder(q: MailQuery, accountId: string, folders: Folder[]): Folder | undefined {
  if (!q.folder) return undefined;
  if (SYSTEM_KINDS.includes(q.folder)) return folders.find((f) => f.accountId === accountId && f.system === q.folder);
  return folders.find((f) => f.accountId === accountId && f.id === q.folder);
}

/**
 * Free text to safe search tokens, shared by every provider and the local matcher.
 * Drops operator and grouping characters (quotes, parens, braces, colon, backslash),
 * strips leading minus signs, and lowercases bare OR/AND/NOT/NEAR so they aren't read as operators.
 * Empty tokens are dropped; a field left with no tokens is rejected (assertSearchable).
 */
const OPERATORS = new Set(["OR", "AND", "NOT", "NEAR"]);

function tokens(s: string): string[] {
  return s
    .replace(/["(){}:\\]/g, "")
    .split(/\s+/)
    .map((t) => t.replace(/^-+/, ""))
    .filter(Boolean)
    .map((t) => (OPERATORS.has(t) ? t.toLowerCase() : t));
}

export function gmailQuery(q: MailQuery, folder: Folder | undefined, folders: Folder[]): string {
  assertSearchable(q);
  const quote = (v: string) => (v.includes(" ") ? `"${v}"` : v);
  const parts: string[] = [];
  const from = tokens(q.from ?? "").join(" ");
  const to = tokens(q.to ?? "").join(" ");
  const subject = tokens(q.subject ?? "").join(" ");
  const words = tokens(q.words ?? "").join(" ");
  if (from) parts.push(`from:${quote(from)}`);
  if (to) parts.push(`to:${quote(to)}`);
  if (subject) parts.push(`subject:(${subject})`);
  if (words) parts.push(words);
  if (q.after) parts.push(`after:${q.after.replace(/-/g, "/")}`);
  if (q.before) parts.push(`before:${q.before.replace(/-/g, "/")}`);
  if (q.unread !== undefined) parts.push(q.unread ? "is:unread" : "-is:unread");
  if (q.starred !== undefined) parts.push(q.starred ? "is:starred" : "-is:starred");
  if (q.hasAttachment !== undefined) parts.push(q.hasAttachment ? "has:attachment" : "-has:attachment");
  if (folder) parts.push(gmailFolderTerm(folder, folders));
  return parts.join(" ");
}

function gmailFolderTerm(f: Folder, folders: Folder[]) {
  switch (f.system) {
    case "inbox":
      return "in:inbox";
    case "sent":
      return "in:sent";
    case "spam":
      return "in:spam";
    case "trash":
      return "in:trash";
    case "drafts":
      return "in:drafts";
    case "archive":
      return "-in:inbox -in:spam -in:trash -in:sent -in:drafts";
  }
  // Gmail searches nested labels by their full name, with spaces and slashes as hyphens.
  const names: string[] = [];
  for (let cur: Folder | undefined = f; cur; cur = folders.find((x) => x.id === cur!.parentId)) names.unshift(cur.name);
  return `label:${names.join("-").toLowerCase().replace(/[\s/&]+/g, "-")}`;
}

export function graphQuery(q: MailQuery): { search?: string; filter?: string; local: (e: Email) => boolean } {
  assertSearchable(q);
  const terms: string[] = [];
  // Multi-word names become one term per word, since KQL from: matches a single token.
  if (q.from) terms.push(...tokens(q.from).map((w) => `from:${w}`));
  if (q.to) terms.push(...tokens(q.to).map((w) => `to:${w}`));
  if (q.subject) terms.push(...tokens(q.subject).map((w) => `subject:${w}`));
  if (q.words && tokens(q.words).length) terms.push(tokens(q.words).join(" "));
  if (terms.length) {
    // $search can't be combined with $filter, so dates go into KQL and flags are checked locally.
    if (q.after) terms.push(`received>=${q.after}`);
    if (q.before) terms.push(`received<${q.before}`);
    if (q.hasAttachment !== undefined) terms.push(`hasattachments:${q.hasAttachment}`);
    return {
      search: terms.join(" "),
      local: (e) => (q.unread === undefined || e.unread === q.unread) && (q.starred === undefined || e.starred === q.starred),
    };
  }
  // Graph rejects $orderby on a property that doesn't lead the $filter.
  const f = [`receivedDateTime ge ${q.after ?? "1900-01-01"}T00:00:00Z`];
  if (q.before) f.push(`receivedDateTime lt ${q.before}T00:00:00Z`);
  if (q.unread !== undefined) f.push(`isRead eq ${!q.unread}`);
  if (q.starred !== undefined) f.push(q.starred ? "flag/flagStatus eq 'flagged'" : "flag/flagStatus ne 'flagged'");
  if (q.hasAttachment !== undefined) f.push(`hasAttachments eq ${q.hasAttachment}`);
  return { filter: f.join(" and "), local: () => true };
}

export interface LocalCtx {
  /** Resolved folder id when the query names a folder. */
  folderId?: string;
  categoryOf: (id: string) => Category | undefined;
  sectionOf: (e: Email) => string | undefined;
}

const words = (s: string) => tokens(s).map((w) => w.toLowerCase());
const day = (iso: string) => iso.slice(0, 10);

export function matchesLocal(e: Email, q: MailQuery, ctx: LocalCtx): boolean {
  const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
  if (q.from && !has(`${e.from.name} ${e.from.address}`, q.from)) return false;
  if (q.to && !e.to.some((c) => has(`${c.name} ${c.address}`, q.to!))) return false;
  if (q.subject && !words(q.subject).every((w) => has(e.subject, w))) return false;
  if (q.words && !words(q.words).every((w) => has(`${e.from.name} ${e.subject} ${e.text}`, w))) return false;
  if (q.after && day(e.date) < q.after) return false;
  if (q.before && day(e.date) >= q.before) return false;
  if (ctx.folderId && e.folderId !== ctx.folderId) return false;
  if (q.unread !== undefined && e.unread !== q.unread) return false;
  if (q.starred !== undefined && e.starred !== q.starred) return false;
  if (q.hasAttachment !== undefined && !!e.attachments?.length !== q.hasAttachment) return false;
  if (q.category && ctx.categoryOf(e.id) !== q.category) return false;
  if (q.section && ctx.sectionOf(e) !== q.section) return false;
  if (q.account && e.accountId !== q.account) return false;
  return true;
}

const human = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function describeQuery(q: MailQuery, names: { folder?: string; section?: string } = {}): string {
  const parts: string[] = [];
  if (q.from) parts.push(`From ${q.from}`);
  if (q.to) parts.push(`to ${q.to}`);
  if (q.subject) parts.push(`subject "${q.subject}"`);
  if (q.words) parts.push(`"${q.words}"`);
  if (q.folder) parts.push(`in ${names.folder ?? q.folder}`);
  if (q.section) parts.push(`in ${names.section ?? "section"}`);
  if (q.category) parts.push(q.category);
  if (q.unread !== undefined) parts.push(q.unread ? "unread" : "read");
  if (q.starred !== undefined) parts.push(q.starred ? "starred" : "not starred");
  if (q.hasAttachment !== undefined) parts.push(q.hasAttachment ? "with attachments" : "without attachments");
  if (q.after) parts.push(`since ${human(q.after)}`);
  if (q.before) parts.push(`before ${human(q.before)}`);
  if (!parts.length) return "All mail";
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
