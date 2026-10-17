// Calendar sync: the regular window every few minutes, plus whole weeks fetched on demand
// (and dropped again once they're far from today and off screen).

import type { CalEvent, CalendarInfo } from "@/lib/types";
import type { CalendarProvider } from "@/lib/calendar/provider";
import { useMail } from "@/lib/store";
import { calProviders } from "./providers";
import { heldEventDeletes } from "./calendar-actions";

/** Calendar window zMail keeps loaded: last week through four weeks out. */
function calendarWindow() {
  const from = new Date();
  from.setDate(from.getDate() - 7);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 35);
  return { from, to };
}

let lastCalendarSync = 0;
const CALENDAR_SYNC_MS = 5 * 6e4;

/** Everything the calendar UI renders for an event, so a change on the server (a moved room, a new link) still lands. */
function eventSig(e: CalEvent) {
  return [
    e.id, e.calendarId, e.title, e.start, e.end, e.location ?? "", e.allDay ? 1 : 0, e.video ? 1 : 0, e.joinUrl ?? "", e.hue ?? "",
    e.attendees.map((a) => `${a.name}<${a.address}>`).join(","), e.related?.from ?? "", e.related?.subject ?? "",
  ].join("\u001f");
}
const calendarSig = (c: CalendarInfo) => [c.id, c.accountId, c.name, c.source, c.hue, c.primary ? 1 : 0].join("\u001f");

/** Sync calendars and events. Unforced calls run at most every 5 minutes; user-initiated ones pass `force`. */
export async function syncCalendars(list: CalendarProvider[], opts?: { force?: boolean }) {
  if (!opts?.force && Date.now() - lastCalendarSync < CALENDAR_SYNC_MS) return;
  const { from, to } = calendarWindow();
  for (const p of list) {
    try {
      const calendars = await p.listCalendars();
      const events = await p.listEvents(calendars.map((c) => c.id), from, to);
      if (calProviders.get(p.accountId) !== p) continue; // account removed meanwhile
      const prefix = `${p.accountId}:`;
      useMail.setState((s) => {
        const nextEvents = events.filter((e) => !s.calChanges.deleted.includes(e.id) && !heldEventDeletes.has(e.id));
        // Events fetched for dates outside the window (ensureEventRange) stay, unless far off (pruneFarEvents); only the window is replaced.
        const inWindow = (e: CalEvent) => e.calendarId.startsWith(prefix) && overlaps(e, from, to);
        const oldCals = s.calendars.filter((c) => c.accountId === p.accountId).map(calendarSig).join("\n");
        const oldEvents = s.events.filter(inWindow).map(eventSig).join("\n");
        if (oldCals === calendars.map(calendarSig).join("\n") && oldEvents === nextEvents.map(eventSig).join("\n")) return s;
        const kept = s.events.filter((e) => !inWindow(e));
        const fresh = new Set(nextEvents.map((e) => e.id));
        return {
          calendars: [...s.calendars.filter((c) => c.accountId !== p.accountId), ...calendars],
          events: [...kept.filter((e) => !fresh.has(e.id)), ...nextEvents],
        };
      });
      windowLoaded.add(p.accountId);
    } catch (err) {
      console.error("[calendar]", p.accountId, err);
    }
  }
  pruneFarEvents(list);
  lastCalendarSync = Date.now();
}

/** Accounts whose regular window has loaded; until then ensureEventRange fetches window weeks itself. */
const windowLoaded = new Set<string>();
/** Bumped when an account is added or removed, so a week fetch begun before isn't recorded as loaded for every account. */
let rangeEpoch = 0;

/** An account was added or removed: weeks loaded on demand no longer cover every account. */
export function calendarAccountsChanged(accountId: string) {
  windowLoaded.delete(accountId);
  extraRanges.clear();
  inFlight.clear();
  rangeEpoch++;
}

/** Test hook: forget when calendars last synced (and which extra ranges were loaded). */
export function resetCalendarSync() {
  lastCalendarSync = 0;
  windowLoaded.clear();
  extraRanges.clear();
  inFlight.clear();
  viewing = null;
}

/** Does the event overlap [from, to)? */
function overlaps(e: CalEvent, from: Date, to: Date) {
  const s = new Date(e.start).getTime();
  const en = new Date(e.end).getTime();
  if (Number.isNaN(s)) return false;
  return s < to.getTime() && (Number.isNaN(en) ? s : Math.max(en, s + 1)) > from.getTime();
}

/** Midnight of the Sunday on or before `d` (local time). */
function weekStart(d: Date) {
  const w = new Date(d);
  w.setHours(0, 0, 0, 0);
  w.setDate(w.getDate() - w.getDay());
  return w.getTime();
}
/** The Sunday a week after `wk` (setDate, so weeks across a DST change stay aligned). */
function nextWeek(wk: number) {
  const n = new Date(wk);
  n.setDate(n.getDate() + 7);
  return n.getTime();
}

/** Weeks outside the sync window already fetched (week start → when); refetched after EXTRA_RANGE_MS. */
const extraRanges = new Map<number, number>();
const EXTRA_RANGE_MS = 10 * 6e4;
/** Week fetches under way, so overlapping requests share them. */
const inFlight = new Map<number, Promise<boolean>>();
/** Weeks the latest ensureEventRange asked for (likely what's on screen); never pruned. */
let viewing: { from: number; to: number } | null = null;
/** Events further than this from today (and outside the sync window) are dropped, and refetched if viewed again. */
const HORIZON_DAYS = 90;

const sameEvents = (a: CalEvent[], b: CalEvent[]) =>
  a.length === b.length && a.map(eventSig).sort().join("\n") === b.map(eventSig).sort().join("\n");

/** Drop these accounts' far-off events: outside the sync window, the ±HORIZON_DAYS weeks and what's on screen. */
function pruneFarEvents(list: CalendarProvider[]) {
  if (!list.length) return;
  // Whole weeks, so a week whose events were dropped is always refetched.
  const d = new Date();
  d.setDate(d.getDate() - HORIZON_DAYS);
  const lo = weekStart(d);
  d.setDate(d.getDate() + 2 * HORIZON_DAYS);
  const hi = nextWeek(weekStart(d));
  const keepWeek = (wk: number) => (wk < hi && nextWeek(wk) > lo) || (!!viewing && wk < viewing.to && nextWeek(wk) > viewing.from);
  for (const wk of extraRanges.keys()) if (!keepWeek(wk)) extraRanges.delete(wk);
  const win = calendarWindow();
  const spans = [[win.from, win.to], [new Date(lo), new Date(hi)], ...(viewing ? [[new Date(viewing.from), new Date(viewing.to)]] : [])];
  const near = (e: CalEvent) => Number.isNaN(new Date(e.start).getTime()) || spans.some(([a, b]) => overlaps(e, a, b));
  const prefixes = list.map((p) => `${p.accountId}:`);
  useMail.setState((s) => {
    // Only events a provider can refetch; local additions always stay.
    const local = new Set(s.calChanges.added.map((e) => e.id));
    const events = s.events.filter((e) => near(e) || local.has(e.id) || !prefixes.some((p) => e.calendarId.startsWith(p)));
    return events.length === s.events.length ? s : { events };
  });
}

/** Fetch [start, end) from each provider and merge it in; false when one couldn't be read. */
async function fetchEventRange(start: Date, end: Date, list: CalendarProvider[]) {
  const win = calendarWindow();
  let ok = true;
  for (const p of list) {
    try {
      const ids = useMail.getState().calendars.filter((c) => c.accountId === p.accountId).map((c) => c.id);
      const calendars = ids.length ? ids : (await p.listCalendars()).map((c) => c.id);
      const events = await p.listEvents(calendars, start, end);
      if (calProviders.get(p.accountId) !== p) continue; // account removed meanwhile
      const prefix = `${p.accountId}:`;
      useMail.setState((s) => {
        const fresh = events.filter((e) => !s.calChanges.deleted.includes(e.id) && !heldEventDeletes.has(e.id));
        const got = new Set(fresh.map((e) => e.id));
        // Replace this account's events in the fetched weeks (not the ones the regular sync owns).
        const replaced = (e: CalEvent) =>
          got.has(e.id) || (e.calendarId.startsWith(prefix) && overlaps(e, start, end) && !overlaps(e, win.from, win.to));
        // Same events as before: skip the write so calendar views don't re-render.
        if (sameEvents(s.events.filter(replaced), fresh)) return s;
        return { events: [...s.events.filter((e) => !replaced(e)), ...fresh] };
      });
    } catch (err) {
      ok = false;
      console.error("[calendar] range", p.accountId, err);
    }
  }
  return ok;
}

/**
 * Make sure events for [from, to) are in the store. The regular sync covers a week back to four
 * weeks ahead; anything else (the Calendar view paging ahead, the assistant asking about a date)
 * is fetched on demand, in whole weeks, and only the weeks not already loaded or loading.
 * Resolves false when a calendar couldn't be read.
 */
export async function ensureEventRange(from: Date, to: Date, list: CalendarProvider[] = [...calProviders.values()]): Promise<boolean> {
  const win = calendarWindow();
  const now = Date.now();
  for (const [wk, at] of extraRanges) if (now - at >= EXTRA_RANGE_MS) extraRanges.delete(wk);
  // Whole weeks (Sunday to Sunday), so paging week by week reuses fetches.
  const weeks: number[] = [];
  for (let wk = weekStart(from); wk < to.getTime(); wk = nextWeek(wk)) weeks.push(wk);
  if (!weeks.length) return true;
  viewing = { from: weeks[0], to: nextWeek(weeks[weeks.length - 1]) };
  const waits = new Set<Promise<boolean>>();
  const need: number[] = [];
  // The regular sync's weeks count as loaded only once it has loaded them for every account asked about.
  const windowReady = list.every((p) => windowLoaded.has(p.accountId));
  const epoch = rangeEpoch;
  for (const wk of weeks) {
    if ((windowReady && wk >= win.from.getTime() && nextWeek(wk) <= win.to.getTime()) || extraRanges.has(wk)) continue;
    const job = inFlight.get(wk);
    if (job) waits.add(job);
    else need.push(wk);
  }
  // One request per run of adjacent weeks.
  for (let i = 0; i < need.length; ) {
    let j = i + 1;
    while (j < need.length && need[j] === nextWeek(need[j - 1])) j++;
    const run = need.slice(i, j);
    const job: Promise<boolean> = fetchEventRange(new Date(run[0]), new Date(nextWeek(run[run.length - 1])), list).then((ok) => {
      for (const wk of run) {
        if (inFlight.get(wk) === job) inFlight.delete(wk);
        if (ok && epoch === rangeEpoch) extraRanges.set(wk, now);
      }
      return ok;
    });
    for (const wk of run) inFlight.set(wk, job);
    waits.add(job);
    i = j;
  }
  pruneFarEvents(list);
  return (await Promise.all(waits)).every(Boolean);
}
