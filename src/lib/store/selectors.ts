// Pure reads of the store's state: what each view shows, in what order, and the counts beside it.

import type { Bucket, CalEvent, CalSuggestion, Category, Email, Folder } from "@/lib/types";
import { useSettings } from "@/lib/settings";
import { findToSuggestion, localDate, usableFind } from "@/lib/ai/dates";
import { sectionsFor, type MailSection } from "@/lib/sections";
import { todayList, sortNeeds } from "@/lib/mail/unread";
import { filingRuleFor } from "@/lib/rules";
import type { BackfillState, MailState, SearchScope } from "./types";
import { held } from "./held";

/** What homeGroups reads. `Sel` and `selectHome` both come from this list, so they can't drift apart. */
const SEL_KEYS = [
  "folders",
  "triage",
  "overrides",
  "rules",
  "dismissed",
  "snoozed",
  "emails",
  "query",
  "view",
  "accountFilter",
  "sections",
  "sectionOverrides",
  "resolved",
] as const satisfies readonly (keyof MailState)[];

export type Sel = Pick<MailState, (typeof SEL_KEYS)[number]>;

/** `keys` of the state, by reference. */
function pick<K extends keyof MailState>(s: MailState, keys: readonly K[]): Pick<MailState, K> {
  const out = {} as Pick<MailState, K>;
  for (const k of keys) out[k] = s[k];
  return out;
}

/** The slices homeGroups reads, for `useMail(useShallow(selectHome))`. Copies references only. */
export function selectHome(s: MailState): Sel {
  return pick(s, SEL_KEYS);
}

/** What inboxSuggestions reads. `SuggestionSel` (its parameter type) and `selectSuggestions` both come from this list. */
const SUGGESTION_KEYS = [
  "calSuggestions",
  "dateFinds",
  "noDateSenders",
  "emails",
  "folders",
  "triage",
  "categoryOverrides",
  "sections",
  "sectionOverrides",
  "calChanges",
  "calendars",
  "hiddenCalendars",
  "events",
  "accounts",
] as const satisfies readonly (keyof MailState)[];

export type SuggestionSel = Pick<MailState, (typeof SUGGESTION_KEYS)[number]>;

/** The slices inboxSuggestions reads, for `useMail(useShallow(selectSuggestions))`. Copies references only. */
export function selectSuggestions(s: MailState): SuggestionSel {
  return pick(s, SUGGESTION_KEYS);
}

/** The progress line while an Inbox backfill runs ("Loading older Inbox mail · 400 of ~1,200"); null when idle. */
export function backfillLine(backfill: Record<string, BackfillState>): string | null {
  const b = Object.values(backfill).find((x) => x.running);
  if (!b) return null;
  const n = (x: number) => x.toLocaleString("en-US");
  return `Loading older Inbox mail · ${n(b.loaded)}${b.total ? ` of ~${n(Math.max(b.total, b.loaded))}` : ""}`;
}

const inboxIdsCache = new WeakMap<Folder[], Set<string>>();
export function inboxFolderIds(folders: Folder[]): Set<string> {
  let ids = inboxIdsCache.get(folders);
  if (!ids) inboxIdsCache.set(folders, (ids = new Set(folders.filter((f) => f.system === "inbox").map((f) => f.id))));
  return ids;
}

export function isInbox(s: Pick<MailState, "folders" | "snoozed">, e: Email) {
  // A search result held in the store isn't inbox mail to anything that walks the inbox (see held.ts).
  if (held.has(e.id)) return false;
  if (s.snoozed[e.id] && s.snoozed[e.id] > Date.now()) return false;
  return inboxFolderIds(s.folders).has(e.folderId);
}

export function bucketOf(s: Pick<MailState, "triage" | "overrides">, id: string): Bucket | undefined {
  return s.overrides[id] ?? s.triage[id]?.bucket;
}

/** What kind of email it is: your correction first, then the model's answer. */
export function categoryOf(s: Pick<MailState, "triage" | "categoryOverrides">, id: string): Category | undefined {
  return s.categoryOverrides[id] ?? s.triage[id]?.category;
}

/** The section an email is in (your correction first, then the model's), if it still exists. */
export function sectionOf(s: Pick<MailState, "triage" | "sections" | "sectionOverrides">, e: Email): MailSection | undefined {
  const id = sectionIdOf(s, e);
  if (!id) return undefined;
  return sectionsFor(s.sections, e.accountId).find((x) => x.id === id);
}

function sectionIdOf(s: Pick<MailState, "triage" | "sectionOverrides">, e: Email): string | null | undefined {
  const override = s.sectionOverrides[e.id];
  return override === undefined ? s.triage[e.id]?.section : override;
}

/** Whether this inbox email shows in Needs you: model or your lane says so, not resolved, and its section (if any) lets urgent mail through. */
export function inNeedsYou(
  s: Pick<MailState, "triage" | "overrides" | "resolved" | "sections" | "sectionOverrides">,
  e: Email,
): boolean {
  if (bucketOf(s, e.id) !== "needs_you" || s.resolved[e.id]) return false;
  const section = sectionOf(s, e);
  return !section || !!section.urgentInNeedsYou;
}

type NeedsSel = Pick<MailState, "folders" | "snoozed" | "triage" | "overrides" | "resolved" | "sections" | "sectionOverrides">;

/** Needs-you mail older than this, with no due date found, ages out. */
const AGE_OUT_MS = 14 * 864e5;

/**
 * Inbox mail still in Needs you that has run its course: the day after its latest due date or
 * deadline, or 14 days after it arrived when no such date was found.
 */
export function ageOutIds(s: NeedsSel & Pick<MailState, "emails" | "dateFinds">, now: number): string[] {
  const today = localDate(new Date(now));
  const out: string[] = [];
  for (const e of s.emails) {
    if (!isInbox(s, e) || !inNeedsYou(s, e)) continue;
    let due = "";
    for (const f of s.dateFinds[e.id] ?? []) if ((f.kind === "due" || f.kind === "deadline") && f.date > due) due = f.date;
    if (due ? today > due : now - Date.parse(e.date) > AGE_OUT_MS) out.push(e.id);
  }
  return out;
}

/**
 * Needs-you mail you have since replied to from anywhere: its thread's newest message (in any
 * folder the store holds but Drafts) is from one of your own addresses and came after it.
 */
export function repliedIds(s: NeedsSel & Pick<MailState, "emails" | "accounts">): string[] {
  // Your addresses, as ownAddresses (notifications) has them.
  const own = new Set(s.accounts.map((a) => a.address.toLowerCase()));
  const drafts = new Set(s.folders.filter((f) => f.system === "drafts").map((f) => f.id));
  const thread = (e: Email) => `${e.accountId}\u0000${e.threadId}`;
  const newest = new Map<string, { e: Email; at: number }>();
  for (const e of s.emails) {
    if (drafts.has(e.folderId) || held.has(e.id)) continue;
    const at = Date.parse(e.date);
    const n = newest.get(thread(e));
    if (!n || at > n.at) newest.set(thread(e), { e, at });
  }
  const out: string[] = [];
  for (const e of s.emails) {
    const n = newest.get(thread(e));
    if (!n || n.e.id === e.id || !own.has(n.e.from.address.toLowerCase()) || !(n.at > Date.parse(e.date))) continue;
    if (isInbox(s, e) && inNeedsYou(s, e)) out.push(e.id);
  }
  return out;
}

/** Sections shown for the account switcher's current choice. */
export function visibleSections(s: Pick<MailState, "sections" | "accountFilter">) {
  return s.accountFilter ? sectionsFor(s.sections, s.accountFilter) : s.sections;
}

type HomeGroups = ReturnType<typeof computeHomeGroups>;
let homeCache: { sel: Partial<Sel>; until: number; out: HomeGroups } | undefined;

/**
 * Today and Triage groups. Mail in a section leaves "Worth a skim" and "Can go"
 * for the section's block; "Needs you" keeps it (tagged with the section) only when the section
 * lets urgent mail through. Otherwise urgent mail heads its section's block, flagged. Resolved
 * urgent mail goes to its section, else Worth a skim.
 * Cached on the last inputs (each `Sel` field by reference): J/K, prefetch and the views
 * all ask for the same groups. Callers must not mutate the result.
 */
export function homeGroups(s: Sel): HomeGroups {
  const now = Date.now();
  const c = homeCache;
  if (c && now < c.until && SEL_KEYS.every((k) => c.sel[k] === s[k])) return c.out;
  const out = computeHomeGroups(s);
  const sel: Partial<Sel> = {};
  for (const k of SEL_KEYS) (sel as Record<string, unknown>)[k] = s[k];
  // A snooze running out puts mail back in the inbox with no state change: recompute then.
  let until = Infinity;
  for (const t of Object.values(s.snoozed)) if (t > now && t < until) until = t;
  homeCache = { sel, until, out };
  return out;
}

function computeHomeGroups(s: Sel) {
  const inbox = homeInbox(s);
  const needs = inbox
    .filter((e) => inNeedsYou(s, e))
    .sort((x, y) => (s.triage[y.id]?.urgency ?? 0) - (s.triage[x.id]?.urgency ?? 0));
  const inNeeds = new Set(needs.map((e) => e.id));
  // Per section: urgent mail it holds out of Needs you (first, flagged), then the rest.
  const bySection = new Map<string, { flagged: Email[]; rest: Email[] }>(visibleSections(s).map((x) => [x.id, { flagged: [], rest: [] }]));
  const skim: Email[] = [];
  const canGo: Email[] = [];
  let unsorted = 0;
  // sectionOf, with each account's section list built once per call instead of once per email.
  const byAccount = new Map<string, MailSection[]>();
  const sectionsOf = (accountId: string) => {
    let list = byAccount.get(accountId);
    if (!list) byAccount.set(accountId, (list = sectionsFor(s.sections, accountId)));
    return list;
  };
  for (const e of inbox) {
    const b = bucketOf(s, e.id);
    if (!b) unsorted++;
    if (!b || inNeeds.has(e.id)) continue;
    const id = sectionIdOf(s, e);
    const sec = id ? sectionsOf(e.accountId).find((x) => x.id === id) : undefined;
    const block = sec && bySection.get(sec.id);
    if (block) (b === "needs_you" && !s.resolved[e.id] ? block.flagged : block.rest).push(e);
    // Urgent mail out of Needs you with no section to go to is worth a skim.
    else (b === "ready_archive" ? canGo : skim).push(e);
  }
  const sections = visibleSections(s).map((section) => {
    const { flagged, rest } = bySection.get(section.id)!;
    return { section, emails: [...flagged, ...rest], flagged: new Set(flagged.map((e) => e.id)) };
  });
  return { needs, sections, skim, canGo, unsorted };
}

/** The calendar an email's dates go to by default: its account's main calendar. */
export function defaultCalendarFor(s: Pick<MailState, "calendars" | "hiddenCalendars" | "accounts">, accountId: string) {
  const address = s.accounts.find((a) => a.id === accountId)?.address.toLowerCase();
  const mine = s.calendars.filter((c) => c.accountId === accountId);
  const visible = (c: { id: string }) => !s.hiddenCalendars.has(c.id);
  // The one you picked last for this account, then the account's main calendar (Google's primary,
  // Outlook's default), then one named after the address, then the first visible one.
  const remembered = useSettings.getState().defaultCalendars?.[accountId];
  return (
    s.calendars.find((c) => c.id === remembered && visible(c)) ??
    mine.find((c) => c.primary && visible(c)) ??
    mine.find((c) => c.name.toLowerCase() === address) ??
    mine.find((c) => !s.hiddenCalendars.has(c.id)) ??
    s.calendars.find((c) => !s.hiddenCalendars.has(c.id)) ??
    s.calendars[0]
  )?.id ?? "";
}

/**
 * Whether dates found in this email should show. Section mail follows its section's
 * dates switch; other mail needs "Find dates in your mail" on and a category (after
 * your correction) that isn't promotions or newsletters. Senders you turned off never show.
 */
export function datesShownFor(
  s: Pick<MailState, "triage" | "categoryOverrides" | "sections" | "sectionOverrides" | "noDateSenders">,
  e: Email,
  everywhere: boolean,
): boolean {
  if (Object.hasOwn(s.noDateSenders, e.from.address.toLowerCase())) return false;
  const section = sectionOf(s, e);
  if (section) return !!section.dates;
  if (!everywhere) return false;
  const category = categoryOf(s, e.id);
  return category !== "promotions" && category !== "newsletters";
}

/** Calendar suggestions: invites and bookings, plus dates found in your mail. */
/** "x-<emailId>-<YYYY-MM-DD>-<slug>" → its email id and date (email ids can contain "-"). */
function parseFindId(id: string): { emailId: string; date: string } | undefined {
  const m = /^x-(.+)-(\d{4}-\d{2}-\d{2})-[a-z0-9-]*$/.exec(id);
  return m ? { emailId: m[1], date: m[2] } : undefined;
}

const STOP = new Set(["meeting", "call", "with", "about", "review", "discuss", "chat", "sync", "check", "the", "and", "for", "from", "your", "this", "that", "room"]);
const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));

export function inboxSuggestions(
  s: SuggestionSel,
  everywhere: boolean = useSettings.getState().findDatesEverywhere,
  now: Date = new Date(),
): CalSuggestion[] {
  const resolved = new Set(s.calChanges.resolved);
  const today = localDate(now);
  const byId = new Map(s.emails.map((e) => [e.id, e]));
  // What you already added or dismissed, by thread: a meeting usually shows up in several emails of
  // one thread, and answering it once covers every copy. Newest handled email per thread too, so older
  // proposals in that thread ("tomorrow at 9?" before "11 works") stop coming back.
  const handledThreadDates = new Set<string>();
  const handledThreadUpTo = new Map<string, number>();
  for (const id of resolved) {
    const p = parseFindId(id);
    const e = p && byId.get(p.emailId);
    if (!p || !e) continue;
    handledThreadDates.add(`${e.threadId}|${p.date}`);
    const t = Date.parse(e.date);
    if (t > (handledThreadUpTo.get(e.threadId) ?? -Infinity)) handledThreadUpTo.set(e.threadId, t);
  }
  const timed = s.events.filter((ev) => !ev.allDay);
  /** Something already on the calendar at that time (±15 min) with a word in common: it was added already. */
  const onCalendar = (sug: CalSuggestion) => {
    const at = Date.parse(sug.start);
    const w = words(sug.title);
    return timed.some((ev) => Math.abs(Date.parse(ev.start) - at) <= 15 * 6e4 && [...words(ev.title)].some((x) => w.has(x)));
  };
  const out: CalSuggestion[] = [...s.calSuggestions];
  for (const [emailId, finds] of Object.entries(s.dateFinds)) {
    const e = byId.get(emailId);
    if (!e || !finds.length) continue;
    const kind = s.folders.find((f) => f.id === e.folderId)?.system;
    if (kind === "trash" || kind === "spam") continue;
    if (!datesShownFor(s, e, everywhere)) continue;
    const upTo = handledThreadUpTo.get(e.threadId);
    if (upTo !== undefined && Date.parse(e.date) <= upTo) continue;
    const section = sectionOf(s, e);
    for (const f of finds) {
      // A saved find with an impossible date or time can't be placed (and would throw building it).
      if (f.date < today || !usableFind(f)) continue;
      const sug = findToSuggestion(f, e, section?.id, defaultCalendarFor(s, e.accountId));
      if (resolved.has(sug.id) || handledThreadDates.has(`${e.threadId}|${f.date}`)) continue;
      // A time that has already passed today isn't worth adding.
      if (!sug.allDay && Date.parse(sug.start) < now.getTime()) continue;
      if (!sug.allDay && onCalendar(sug)) continue;
      out.push(sug);
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export function suggestionFor(s: Sel, e: Email, threshold: number) {
  if (!isInbox(s, e) || s.dismissed.has(e.id)) return undefined;
  const ruled = filingRuleFor(s.rules, e.from.address);
  if (ruled) {
    const folder = s.folders.find((f) => f.id === ruled);
    if (folder) return { folderId: ruled, probability: 1, rule: true, evidence: undefined, folder };
  }
  const sug = s.triage[e.id]?.folder;
  if (!sug || sug.probability < threshold) return undefined;
  const folder = s.folders.find((f) => f.id === sug.folderId);
  return folder ? { ...sug, rule: false, folder } : undefined;
}

/** Lowercased search text per email. Emails are replaced, never mutated, so an entry can't go stale. */
const haystacks = new WeakMap<Email, string>();

function matches(e: Email, q: string) {
  if (!q) return true;
  let h = haystacks.get(e);
  if (h === undefined) haystacks.set(e, (h = `${e.from.name} ${e.from.address} ${e.subject} ${e.text}`.toLowerCase()));
  return h.includes(q);
}

/** Inbox emails (search-filtered), newest first. */
export function inboxEmails(s: Sel) {
  const q = s.query.trim().toLowerCase();
  return s.emails.filter((e) => isInbox(s, e) && matches(e, q));
}

/** Inbox for Today and Triage: honors the account switcher. */
export function homeInbox(s: Sel) {
  return inboxEmails(s).filter((e) => !s.accountFilter || e.accountId === s.accountFilter);
}

/** Emails for the plain list views (inbox, starred, snoozed, folder). */
export function listEmails(s: Sel): Email[] {
  const q = s.query.trim().toLowerCase();
  const v = s.view;
  // The Scheduled view renders its records, not emails.
  if (v.kind === "scheduled") return [];
  return s.emails.filter((e) => {
    if (held.has(e.id) || !matches(e, q)) return false;
    switch (v.kind) {
      case "folder":
        return e.folderId === v.folderId;
      case "starred":
        return e.starred;
      case "snoozed":
        return (s.snoozed[e.id] ?? 0) > Date.now();
      default:
        return isInbox(s, e);
    }
  });
}

// ---- search across all mail ---------------------------------------------------

/** Most rows search shows. */
export const SEARCH_MAX = 500;

/** Whether this query in this view is search mode: text in the box, in any mail view (Calendar and Scheduled filter as before). */
export function resultsMode(s: Pick<MailState, "query" | "view">): boolean {
  return s.query.trim() !== "" && s.view.kind !== "calendar" && s.view.kind !== "scheduled";
}

/** What "here" means for a view: its folder, Starred, Snoozed, or the inbox (All Inboxes, Today, Triage). */
export type SearchHere = { kind: "folder"; folderId: string } | { kind: "starred" } | { kind: "snoozed" } | { kind: "inbox" };

export function searchHere(view: MailState["view"]): SearchHere {
  if (view.kind === "folder") return { kind: "folder", folderId: view.folderId };
  if (view.kind === "starred" || view.kind === "snoozed") return { kind: view.kind };
  return { kind: "inbox" };
}

/** What a search answer is for: the query, the scope (and for "here", the view) and the account. */
export function searchKey(s: Pick<MailState, "query" | "view" | "accountFilter"> & { search: { scope: SearchScope } | null }): string {
  const scope = s.search?.scope ?? "all";
  return JSON.stringify([s.query.trim(), scope, scope === "here" ? searchHere(s.view) : null, s.accountFilter]);
}

/** Lowercase words of a query, each matched on its own (as the keyword index does). */
export function searchWords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 16);
}

const systemCache = new WeakMap<Folder[], Map<string, Folder["system"]>>();
function systemOf(folders: Folder[], id: string): Folder["system"] {
  let m = systemCache.get(folders);
  if (!m) systemCache.set(folders, (m = new Map(folders.map((f) => [f.id, f.system]))));
  return m.get(id);
}

/** Whether an email belongs in this search scope now. "all" leaves out Spam and Trash; a folder includes them when it is one. */
export function inSearchScope(s: Pick<MailState, "folders" | "snoozed" | "view">, e: Email, scope: SearchScope): boolean {
  if (scope === "all") {
    const sys = systemOf(s.folders, e.folderId);
    return sys !== "spam" && sys !== "trash";
  }
  const here = searchHere(s.view);
  switch (here.kind) {
    case "folder":
      return e.folderId === here.folderId;
    case "starred":
      return e.starred;
    case "snoozed":
      return (s.snoozed[e.id] ?? 0) > Date.now();
    default:
      // The inbox as the Inbox view shows it (held rows included: they're results too).
      return inboxFolderIds(s.folders).has(e.folderId) && !((s.snoozed[e.id] ?? 0) > Date.now());
  }
}

type ResultSel = Pick<MailState, "emails" | "folders" | "snoozed" | "view" | "accountFilter"> &
  Partial<Pick<MailState, "accounts">> & { search: NonNullable<MailState["search"]> };

const idIndexCache = new WeakMap<Email[], Map<string, Email>>();
function byId(emails: Email[]) {
  let m = idIndexCache.get(emails);
  if (!m) idIndexCache.set(emails, (m = new Map(emails.map((e) => [e.id, e]))));
  return m;
}

/** Most rows in Best matches. */
export const BEST_MAX = 3;

export type ResultGroups = { best: Email[]; rest: Email[]; all: Email[] };
const NO_GROUPS: ResultGroups = { best: [], rest: [], all: [] };
let resultCache: { in: unknown[]; out: ResultGroups } | undefined;

/**
 * Search results as the list shows them, at most SEARCH_MAX: Best matches first (up to BEST_MAX, in
 * the order meaning-based search ranked them; none without it), then the rest newest first. The rest
 * are the index hits (the loaded email when there is one, else the cached row) plus loaded mail matching
 * every word of the answered query (mail newer than the cache, or the browser preview with no index),
 * without the best ones. Filtered now by the scope and the account switcher, so an action shows at once.
 * Cached on the last inputs; don't mutate it.
 */
export function resultGroups(s: ResultSel): ResultGroups {
  const r = s.search.results;
  if (!r) return NO_GROUPS;
  const inputs = [s.emails, s.folders, s.snoozed, s.view, s.accountFilter, s.search, s.accounts];
  if (resultCache && resultCache.in.every((x, i) => x === inputs[i])) return resultCache.out;
  const scope = s.search.scope;
  const accounts = s.accounts && new Set(s.accounts.map((a) => a.id));
  const seen = new Set<string>();
  const out: Email[] = [];
  const take = (e: Email | undefined) => {
    if (!e || e.partial || seen.has(e.id)) return;
    if (s.accountFilter ? e.accountId !== s.accountFilter : accounts && !accounts.has(e.accountId)) return;
    if (!inSearchScope(s, e, scope)) return;
    seen.add(e.id);
    out.push(e);
  };
  const loaded = byId(s.emails);
  for (const id of r.best) if (out.length < BEST_MAX) take(loaded.get(id) ?? r.rows[id]);
  const best = out.splice(0);
  for (const id of r.ids) take(loaded.get(id) ?? r.rows[id]);
  const words = searchWords(r.query);
  if (words.length) for (const e of s.emails) if (!seen.has(e.id) && words.every((w) => matches(e, w))) take(e);
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (best.length + out.length > SEARCH_MAX) out.length = SEARCH_MAX - best.length;
  const groups = { best, rest: out, all: best.length ? [...best, ...out] : out };
  resultCache = { in: inputs, out: groups };
  return groups;
}

/** Search results in on-screen order (Best matches, then the rest): see resultGroups. Don't mutate it. */
export function resultEmails(s: ResultSel): Email[] {
  return resultGroups(s).all;
}

// ---- calendar selectors ------------------------------------------------------

type CalSel = Pick<MailState, "events" | "hiddenCalendars" | "calendars"> & Partial<Pick<MailState, "accountFilter">>;

export function visibleEvents(s: CalSel) {
  const shown = (calendarId: string) =>
    !s.accountFilter || s.calendars.find((c) => c.id === calendarId)?.accountId === s.accountFilter;
  return s.events.filter((e) => !s.hiddenCalendars.has(e.calendarId) && shown(e.calendarId));
}

export function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export interface DayEvents {
  /** All-day events covering the day, in visibleEvents order. */
  allDay: CalEvent[];
  /** Timed events starting that day, by start. */
  timed: CalEvent[];
}

export interface EventIndex {
  /** Keyed by local "YYYY-MM-DD". */
  days: Map<string, DayEvents>;
  /** Every visible all-day event, in order (scanned per day when `long`). */
  allDay: CalEvent[];
  /** An all-day event spans too many days to spread over `days`, so all-day lookups scan `allDay`. */
  long: boolean;
}

/** All-day events longer than this aren't spread day by day (a bad end date could mean millions of days). */
const INDEX_MAX_DAYS = 800;
const NO_EVENTS: CalEvent[] = [];
const indexCache = new WeakMap<CalEvent[], { hidden: Set<string>; calendars: MailState["calendars"]; account: string | null | undefined; idx: EventIndex }[]>();

/** Whether all-day `e` covers the day from `start` to `end` (ms). */
const covers = (e: CalEvent, start: number, end: number) => Date.parse(e.start) < end && Date.parse(e.end) > start;

/** Local midnight of `d`'s day and of the next day (DST-safe). */
function dayBounds(d: Date): [Date, Date] {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

/**
 * Visible events grouped by local day, built once per (events, calendars, hiddenCalendars,
 * accountFilter): a month grid is 42 lookups instead of 84 scans of every event.
 */
export function eventIndex(s: CalSel): EventIndex {
  let entries = indexCache.get(s.events);
  const hit = entries?.find((x) => x.hidden === s.hiddenCalendars && x.calendars === s.calendars && x.account === s.accountFilter);
  if (hit) return hit.idx;
  const days = new Map<string, DayEvents>();
  const at = (key: string) => {
    let d = days.get(key);
    if (!d) days.set(key, (d = { allDay: [], timed: [] }));
    return d;
  };
  const allDay: CalEvent[] = [];
  let long = false;
  for (const e of visibleEvents(s)) {
    if (!e.allDay) {
      at(localDate(new Date(e.start))).timed.push(e);
      continue;
    }
    allDay.push(e);
    // The same overlap rule as checking each day, walked from the day the event starts on.
    const end = Date.parse(e.end);
    let [d, next] = dayBounds(new Date(Date.parse(e.start)));
    for (let n = 0; d.getTime() < end; n++) {
      if (n > INDEX_MAX_DAYS) {
        long = true;
        break;
      }
      if (covers(e, d.getTime(), next.getTime())) at(localDate(d)).allDay.push(e);
      [d, next] = dayBounds(next);
    }
  }
  for (const d of days.values()) d.timed.sort((a, b) => a.start.localeCompare(b.start));
  const idx = { days, allDay, long };
  if (!entries) indexCache.set(s.events, (entries = []));
  // Keep a few calendar / account combinations per events array (the sidebar and calendar can differ).
  entries.unshift({ hidden: s.hiddenCalendars, calendars: s.calendars, account: s.accountFilter, idx });
  entries.length = Math.min(entries.length, 4);
  return idx;
}

/** A day's all-day and timed events, from the index. Shared lists: don't mutate them. */
export function dayEvents(s: CalSel, day: Date): DayEvents {
  const idx = eventIndex(s);
  const found = idx.days.get(localDate(day));
  if (!idx.long) return found ?? { allDay: NO_EVENTS, timed: NO_EVENTS };
  const [start, end] = dayBounds(day);
  return { allDay: idx.allDay.filter((e) => covers(e, start.getTime(), end.getTime())), timed: found?.timed ?? NO_EVENTS };
}

/** Timed events starting on `day`. */
export function eventsOn(s: CalSel, day: Date) {
  return [...dayEvents(s, day).timed];
}

/** All-day events covering `day` (multi-day events included). */
export function allDayOn(s: CalSel, day: Date) {
  return [...dayEvents(s, day).allDay];
}

/** The next timed event that hasn't ended yet today (or null). */
export function nextEvent(s: CalSel, now = new Date()) {
  return eventsOn(s, now).find((e) => Date.parse(e.end) > now.getTime()) ?? null;
}

export function eventHue(s: CalSel, e: CalEvent) {
  return e.hue ?? s.calendars.find((c) => c.id === e.calendarId)?.hue ?? 255;
}

let upcomingCache: { events: CalEvent[]; hidden: Set<string>; calendars: MailState["calendars"]; account: string | null | undefined; at: number; out: CalEvent[] } | undefined;

/** Visible events that haven't ended (12h grace), soonest first. Cached per input references, refreshed every 5 minutes. */
export function upcomingEvents(s: CalSel): CalEvent[] {
  const now = Date.now();
  const c = upcomingCache;
  if (c && c.events === s.events && c.hidden === s.hiddenCalendars && c.calendars === s.calendars && c.account === s.accountFilter && now - c.at < 5 * 6e4) return c.out;
  const cutoff = now - 36e5 * 12;
  const out = visibleEvents(s)
    .filter((e) => Date.parse(e.end) > cutoff)
    .sort((a, b) => a.start.localeCompare(b.start));
  upcomingCache = { events: s.events, hidden: s.hiddenCalendars, calendars: s.calendars, account: s.accountFilter, at: now, out };
  return out;
}

/** The upcoming (or today's) meeting an email relates to, if any. */
export function eventForEmail(s: CalSel, email: Email) {
  return upcomingEvents(s).find(
    (e) =>
      (e.related?.from && e.related.from === email.from.address.toLowerCase() &&
        (!e.related.subject || email.subject.includes(e.related.subject))) ||
      (!e.related?.from && e.related?.subject && email.subject.includes(e.related.subject)),
  );
}

const eventMailCache = new WeakMap<Email[], Map<string, Email[]>>();
const eventSubjectCache = new WeakMap<Email[], Map<string, Email | null>>();

/** Emails grouped by lowercase sender address (in mailbox order), cached per array. */
export function eventMailIndex(emails: Email[]): Map<string, Email[]> {
  let idx = eventMailCache.get(emails);
  if (!idx) {
    idx = new Map();
    for (const m of emails) {
      const k = m.from.address.toLowerCase();
      const l = idx.get(k);
      if (l) l.push(m);
      else idx.set(k, [m]);
    }
    eventMailCache.set(emails, idx);
  }
  return idx;
}

/** The email an event relates to, if it is in the mailbox. */
export function emailForEvent(s: Pick<MailState, "emails">, e: CalEvent) {
  const r = e.related;
  if (!r) return undefined;
  if (r.from) return eventMailIndex(s.emails).get(r.from)?.find((m) => !r.subject || m.subject.includes(r.subject));
  // No sender and no subject names nothing; don't match the first email.
  if (!r.subject) return undefined;
  // Subject-only lookups scan the mailbox; cache per emails array since selectors call this per event.
  const subject = r.subject;
  let bySubject = eventSubjectCache.get(s.emails);
  if (!bySubject) {
    bySubject = new Map();
    eventSubjectCache.set(s.emails, bySubject);
  }
  if (!bySubject.has(subject)) bySubject.set(subject, s.emails.find((m) => m.subject.includes(subject)) ?? null);
  return bySubject.get(subject) ?? undefined;
}

/** The emails worth loading ahead of `id`: the next two in on-screen order, then the previous one. */
export function neighborsOf(order: string[], id: string): string[] {
  const i = order.indexOf(id);
  if (i < 0) return [];
  return [order[i + 1], order[i + 2], order[i - 1]].filter((x): x is string => x !== undefined);
}

/** Ids Today holds in place: those opened this visit plus the open email. */
export function todayKeep(kept: ReadonlySet<string> | undefined, openId: string | null | undefined): ReadonlySet<string> {
  const keep = new Set(kept);
  if (openId) keep.add(openId);
  return keep;
}

/** Emails in on-screen order for the current view (drives J/K navigation). */
export function orderedEmails(s: Sel & Partial<Pick<MailState, "selectedId" | "todayKept" | "search" | "accounts">>): Email[] {
  // Search mode shows its results in place of the view's list.
  if (s.search) return resultEmails({ ...s, search: s.search });
  if (s.view.kind !== "brief" && s.view.kind !== "triage") return listEmails(s);
  const g = homeGroups(s);
  if (s.view.kind === "brief") {
    // J/K follows Today's order: unread first in each section, read after (or hidden).
    const { todayShow: show, needsSort } = useSettings.getState();
    const t = (list: Email[]) => todayList(list, show, todayKeep(s.todayKept, s.selectedId)).list;
    return [...t(sortNeeds(g.needs, needsSort)), ...g.sections.flatMap((x) => t(x.emails)), ...t(g.skim)];
  }
  const sectioned = g.sections.flatMap((x) => x.emails);
  return [...g.needs, ...sectioned, ...g.skim, ...g.canGo];
}

// ---- folder tree -------------------------------------------------------------

export function childFolders(folders: Folder[], accountId: string, parentId: string | undefined) {
  return folders.filter((f) => f.accountId === accountId && f.parentId === parentId);
}

const childIndexCache = new WeakMap<Folder[], Map<string, Folder[]>>();
const NO_FOLDERS: Folder[] = [];

/** `childFolders` through a per-array index, so each tree row is a lookup instead of a filter over every folder. */
export function childFoldersIndexed(folders: Folder[], accountId: string, parentId: string | undefined) {
  let idx = childIndexCache.get(folders);
  if (!idx) {
    idx = new Map();
    for (const f of folders) {
      const k = `${f.accountId}\u0000${f.parentId ?? ""}`;
      const a = idx.get(k);
      if (a) a.push(f);
      else idx.set(k, [f]);
    }
    childIndexCache.set(folders, idx);
  }
  return idx.get(`${accountId}\u0000${parentId ?? ""}`) ?? NO_FOLDERS;
}

const pathIndexCache = new WeakMap<Folder[], Map<string, string>>();

/** `folderPath` memoized per folders array (filled on demand). */
export function folderPathCached(folders: Folder[], id: string) {
  let m = pathIndexCache.get(folders);
  if (!m) {
    m = new Map();
    pathIndexCache.set(folders, m);
  }
  let p = m.get(id);
  if (p === undefined) {
    p = folderPath(folders, id);
    m.set(id, p);
  }
  return p;
}

/** "Campus Departments › HR" (Inbox is implied and omitted). */
export function folderPath(folders: Folder[], id: string) {
  const parts: string[] = [];
  let f = folders.find((x) => x.id === id);
  while (f) {
    if (f.system !== "inbox") parts.unshift(f.name);
    f = f.parentId ? folders.find((x) => x.id === f!.parentId) : undefined;
  }
  return parts.join(" › ");
}

/**
 * Unread count. The server count covers mail zMail hasn't synced; synced mail
 * is counted live. Taking the larger avoids double-counting synced messages.
 */
export function folderUnread(s: Pick<MailState, "emails">, f: Folder) {
  const live = unreadByFolder(s.emails).get(f.id) ?? 0;
  return Math.max(f.unread ?? 0, live);
}

const unreadByFolderCache = new WeakMap<Email[], Map<string, number>>();
/** Unread email count per folderId, one pass, cached per emails array. */
export function unreadByFolder(emails: Email[]): Map<string, number> {
  let m = unreadByFolderCache.get(emails);
  if (!m) {
    m = new Map();
    for (const e of emails) if (e.unread && !held.has(e.id)) m.set(e.folderId, (m.get(e.folderId) ?? 0) + 1);
    unreadByFolderCache.set(emails, m);
  }
  return m;
}

const idsByFolderCache = new WeakMap<Email[], Map<string, string[]>>();
/** Email ids per folderId, cached per emails array. */
export function idsByFolder(emails: Email[]): Map<string, string[]> {
  let m = idsByFolderCache.get(emails);
  if (!m) {
    m = new Map();
    for (const e of emails) {
      if (held.has(e.id)) continue;
      const a = m.get(e.folderId);
      if (a) a.push(e.id);
      else m.set(e.folderId, [e.id]);
    }
    idsByFolderCache.set(emails, m);
  }
  return m;
}

const starredCache = new WeakMap<Email[], number>();
/** Starred email count, cached per emails array. */
export function starredCount(emails: Email[]): number {
  let n = starredCache.get(emails);
  if (n === undefined) {
    n = emails.filter((e) => e.starred && !held.has(e.id)).length;
    starredCache.set(emails, n);
  }
  return n;
}

/**
 * "All Inboxes" count: the sum of each account's Inbox number as its row shows it
 * (server count vs. live cache). An account with no inbox folder yet falls back
 * to its live unread inbox mail.
 */
export function allInboxesUnread(s: Pick<MailState, "emails" | "folders" | "accounts" | "snoozed">) {
  let total = 0;
  for (const a of s.accounts) {
    const inbox = s.folders.find((f) => f.accountId === a.id && f.system === "inbox");
    total += inbox ? folderUnread(s, inbox) : s.emails.filter((e) => e.accountId === a.id && e.unread && isInbox(s, e)).length;
  }
  return total;
}

/** Stable color for a user folder, derived from its name. */
export function folderHue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}

/**
 * After the open email leaves the view, the email to show instead: the first one after it in
 * the old on-screen order that is still showing, else the nearest one before it, else null.
 */
export function nextAfterRemoval(before: string[], still: Set<string>, removed: string): string | null {
  const i = before.indexOf(removed);
  if (i < 0) return null;
  for (let j = i + 1; j < before.length; j++) if (still.has(before[j])) return before[j];
  for (let j = i - 1; j >= 0; j--) if (still.has(before[j])) return before[j];
  return null;
}
