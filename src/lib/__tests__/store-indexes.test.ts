// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  allDayOn,
  childFolders,
  childFoldersIndexed,
  dayEvents,
  emailForEvent,
  eventForEmail,
  eventIndex,
  eventsOn,
  folderUnread,
  homeGroups,
  idsByFolder,
  listEmails,
  sameDay,
  selectHome,
  selectSuggestions,
  starredCount,
  unreadByFolder,
  upcomingEvents,
  useMail,
} from "@/lib/store";
import type { CalEvent, Email, Folder } from "@/lib/types";

const mail = (id: string, folderId: string, over: Partial<Email> = {}) =>
  ({ id, folderId, accountId: "a", unread: false, starred: false, subject: "Lunch plans", from: { name: "Dana", address: "Dana@x.com" }, ...over }) as Email;
const folder = (id: string, unread?: number) => ({ id, accountId: "a", name: id, unread }) as Folder;
const hours = (h: number) => new Date(Date.now() + h * 36e5).toISOString();
const event = (id: string, startH: number, endH: number, over: Partial<CalEvent> = {}) =>
  ({ id, calendarId: "c", title: id, start: hours(startH), end: hours(endH), attendees: [], ...over }) as CalEvent;
const cal = (events: CalEvent[], hidden: string[] = []) => ({ events, hiddenCalendars: new Set(hidden), calendars: [] });

describe("unreadByFolder / idsByFolder / starredCount", () => {
  const emails = [mail("1", "f1", { unread: true, starred: true }), mail("2", "f1"), mail("3", "f2", { unread: true })];

  it("counts unread per folder and caches per array", () => {
    const m = unreadByFolder(emails);
    expect(m.get("f1")).toBe(1);
    expect(m.get("f2")).toBe(1);
    expect(m.get("none")).toBeUndefined();
    expect(unreadByFolder(emails)).toBe(m);
    expect(unreadByFolder([...emails])).not.toBe(m);
  });

  it("groups ids per folder and caches per array", () => {
    const m = idsByFolder(emails);
    expect(m.get("f1")).toEqual(["1", "2"]);
    expect(m.get("f2")).toEqual(["3"]);
    expect(idsByFolder(emails)).toBe(m);
    expect(idsByFolder([...emails])).not.toBe(m);
  });

  it("counts starred", () => {
    expect(starredCount(emails)).toBe(1);
    expect(starredCount([...emails, mail("4", "f2", { starred: true })])).toBe(2);
  });
});

describe("folderUnread", () => {
  it("returns the larger of server and live counts", () => {
    const emails = [mail("1", "f1", { unread: true }), mail("2", "f1", { unread: true })];
    expect(folderUnread({ emails }, folder("f1", 10))).toBe(10);
    expect(folderUnread({ emails }, folder("f1", 1))).toBe(2);
    expect(folderUnread({ emails }, folder("f1"))).toBe(2);
    expect(folderUnread({ emails }, folder("f3"))).toBe(0);
  });
});

describe("eventForEmail", () => {
  const email = mail("1", "f1");

  it("finds the event related by sender and subject, soonest first", () => {
    const later = event("later", 5, 6, { related: { from: "dana@x.com", subject: "Lunch" } });
    const sooner = event("sooner", 1, 2, { related: { from: "dana@x.com" } });
    const s = cal([later, sooner]);
    expect(eventForEmail(s, email)).toBe(sooner);
    expect(upcomingEvents(s).map((e) => e.id)).toEqual(["sooner", "later"]);
  });

  it("matches on subject alone when the event names no sender", () => {
    const e = event("e", 1, 2, { related: { subject: "Lunch" } });
    expect(eventForEmail(cal([e]), email)).toBe(e);
  });

  it("returns undefined for unrelated, long-ended or hidden events", () => {
    expect(eventForEmail(cal([event("x", 1, 2, { related: { from: "other@x.com" } })]), email)).toBeUndefined();
    expect(eventForEmail(cal([event("old", -30, -20, { related: { from: "dana@x.com" } })]), email)).toBeUndefined();
    expect(eventForEmail(cal([event("h", 1, 2, { related: { from: "dana@x.com" } })], ["c"]), email)).toBeUndefined();
  });

  it("reuses the sorted list for the same inputs", () => {
    const s = cal([event("e", 1, 2)]);
    expect(upcomingEvents(s)).toBe(upcomingEvents(s));
    expect(upcomingEvents({ ...s, events: [...s.events] })).not.toBe(upcomingEvents(s));
  });
});

// Hand-written lists: if Sel or inboxSuggestions' parameter type gains a field, update these and the selectors.
const HOME_KEYS = ["folders", "triage", "overrides", "rules", "dismissed", "snoozed", "emails", "query", "view", "accountFilter", "sections", "sectionOverrides", "resolved"];
const SUGGESTION_KEYS = [
  "calSuggestions", "dateFinds", "noDateSenders", "emails", "folders", "triage", "categoryOverrides",
  "sections", "sectionOverrides", "calChanges", "calendars", "hiddenCalendars", "accounts", "events",
];

describe("home-view selectors", () => {
  const state = useMail.getState();
  it("selectHome returns exactly the Sel keys, by reference", () => {
    const h = selectHome(state);
    expect(Object.keys(h).sort()).toEqual([...HOME_KEYS].sort());
    for (const k of HOME_KEYS) expect((h as Record<string, unknown>)[k]).toBe((state as unknown as Record<string, unknown>)[k]);
  });
  it("selectSuggestions covers every key inboxSuggestions reads, by reference", () => {
    const g = selectSuggestions(state);
    expect(Object.keys(g).sort()).toEqual([...SUGGESTION_KEYS].sort());
    for (const k of SUGGESTION_KEYS) expect((g as Record<string, unknown>)[k]).toBe((state as unknown as Record<string, unknown>)[k]);
  });
});

describe("emailForEvent subject fallback", () => {
  const emails = [mail("1", "f1", { subject: "Budget review" }), mail("2", "f1", { subject: "Lunch plans" })];
  const ev = (related: CalEvent["related"]) => event("e", 1, 2, { related });

  it("finds by subject, repeatably, and caches per emails array", () => {
    const find = vi.spyOn(Array.prototype, "find");
    const first = emailForEvent({ emails }, ev({ subject: "Lunch" }));
    const after1 = find.mock.calls.length;
    const second = emailForEvent({ emails }, ev({ subject: "Lunch" }));
    expect(first?.id).toBe("2");
    expect(second).toBe(first);
    expect(find.mock.calls.length).toBe(after1);
    find.mockRestore();
    expect(emailForEvent({ emails }, ev({ subject: "nothing like it" }))).toBeUndefined();
  });

  it("returns undefined for an empty subject with no sender", () => {
    expect(emailForEvent({ emails }, ev({ subject: "" }))).toBeUndefined();
    expect(emailForEvent({ emails }, ev({}))).toBeUndefined();
  });
});

describe("childFoldersIndexed", () => {
  const f = (id: string, accountId: string, parentId?: string) => ({ id, accountId, name: id, parentId }) as Folder;
  const folders = [f("a", "x"), f("b", "x", "a"), f("c", "x", "a"), f("d", "y"), f("e", "y", "d"), f("g", "x", "b")];

  it("matches childFolders for every parent", () => {
    for (const [acct, parent] of [["x", undefined], ["x", "a"], ["x", "b"], ["y", "d"], ["y", undefined], ["x", "zz"]] as const)
      expect(childFoldersIndexed(folders, acct, parent)).toEqual(childFolders(folders, acct, parent));
  });
});

describe("homeGroups cache", () => {
  const inbox = { id: "in", accountId: "a", name: "Inbox", system: "inbox" } as Folder;
  const sel = () => ({ ...selectHome(useMail.getState()), folders: [inbox], emails: [mail("1", "in"), mail("2", "in")], triage: {}, snoozed: {} });

  it("returns the same object for the same inputs", () => {
    const s = sel();
    const g = homeGroups(s);
    expect(homeGroups({ ...s })).toBe(g);
  });

  it("recomputes when any Sel field changes", () => {
    for (const k of HOME_KEYS) {
      const s = sel();
      const g = homeGroups(s);
      const v = (s as Record<string, unknown>)[k];
      const changed = typeof v === "string" ? `${v} ` : v === null ? "other" : v instanceof Set ? new Set(v) : Array.isArray(v) ? [...v] : { ...(v as object) };
      expect(homeGroups({ ...s, [k]: changed }), k).not.toBe(g);
    }
  });

  it("recomputes once a snooze runs out", () => {
    vi.useFakeTimers();
    try {
      const s = { ...sel(), triage: { "1": { bucket: "worth_skim" } } as never, snoozed: { "1": Date.now() + 1000 } };
      expect(homeGroups(s).skim).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(homeGroups(s).skim.map((e) => e.id)).toEqual(["1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("search matching", () => {
  const inbox = { id: "in", accountId: "a", name: "Inbox", system: "inbox" } as Folder;
  const emails = [
    mail("1", "in", { subject: "Quarterly BUDGET", text: "numbers attached" }),
    mail("2", "in", { from: { name: "Pat Lee", address: "Pat@Example.com" }, text: "See you at the Game" }),
    mail("3", "in", { subject: "Lunch", text: "nothing here" }),
  ];
  const ids = (query: string) =>
    listEmails({ ...selectHome(useMail.getState()), folders: [inbox], emails, snoozed: {}, query, view: { kind: "inbox" } }).map((e) => e.id);

  it("matches sender, address, subject and body, ignoring case, the same way twice", () => {
    for (let i = 0; i < 2; i++) {
      expect(ids("budget")).toEqual(["1"]);
      expect(ids("  PAT@example ")).toEqual(["2"]);
      expect(ids("pat lee")).toEqual(["2"]);
      expect(ids("the game")).toEqual(["2"]);
      expect(ids("dana")).toEqual(["1", "3"]);
      expect(ids("lunch plans")).toEqual(["2"]);
      expect(ids("LUNCH nothing")).toEqual(["3"]);
      expect(ids("no such words")).toEqual([]);
      expect(ids("")).toEqual(["1", "2", "3"]);
    }
  });
});

describe("eventIndex", () => {
  const local = (y: number, m: number, d: number, h = 0) => new Date(y, m, d, h).toISOString();
  const ev = (id: string, start: string, end: string, over: Partial<CalEvent> = {}) =>
    ({ id, calendarId: "c", title: id, start, end, attendees: [], ...over }) as CalEvent;
  const events = [
    ev("trip", local(2026, 9, 12), local(2026, 9, 15), { allDay: true }),
    ev("late", local(2026, 9, 13, 15), local(2026, 9, 13, 16)),
    ev("early", local(2026, 9, 13, 9), local(2026, 9, 13, 10)),
    ev("utc", "2026-10-14", "2026-10-15", { allDay: true }),
    ev("hidden", local(2026, 9, 13, 11), local(2026, 9, 13, 12), { calendarId: "h" }),
    ev("other", local(2026, 9, 16, 8), local(2026, 9, 16, 9)),
    ev("fall", local(2026, 9, 30), local(2026, 10, 3), { allDay: true }),
    ev("sun", local(2026, 10, 1, 9), local(2026, 10, 1, 10)),
  ];
  const s = { events, hiddenCalendars: new Set(["h"]), calendars: [] };
  const ids = (l: CalEvent[]) => l.map((e) => e.id);

  it("puts a multi-day all-day event on each covered day, not the day after its end", () => {
    expect(ids(dayEvents(s, new Date(2026, 9, 11)).allDay)).toEqual([]);
    for (const d of [12, 13, 14]) expect(ids(dayEvents(s, new Date(2026, 9, d)).allDay)).toContain("trip");
    expect(ids(dayEvents(s, new Date(2026, 9, 15)).allDay)).not.toContain("trip");
  });

  it("sorts timed events by start and skips hidden calendars", () => {
    expect(ids(dayEvents(s, new Date(2026, 9, 13, 18)).timed)).toEqual(["early", "late"]);
  });

  it("is built once per input and matches the old eventsOn / allDayOn rules for a sample week", () => {
    expect(eventIndex(s)).toBe(eventIndex({ ...s }));
    const visible = events.filter((e) => e.calendarId !== "h");
    // Through the end of October too, where US clocks change (Nov 1).
    for (let d = 10; d <= 34; d++) {
      const day = new Date(2026, 9, d, 12);
      const start = new Date(2026, 9, d).getTime();
      const end = new Date(2026, 9, d + 1).getTime();
      const allDay = visible.filter((e) => e.allDay && Date.parse(e.start) < end && Date.parse(e.end) > start);
      const timed = visible.filter((e) => !e.allDay && sameDay(new Date(e.start), day)).sort((a, b) => a.start.localeCompare(b.start));
      expect(ids(allDayOn(s, day))).toEqual(ids(allDay));
      expect(ids(eventsOn(s, day))).toEqual(ids(timed));
      expect(dayEvents(s, day).allDay).toEqual(allDayOn(s, day));
      expect(dayEvents(s, day).timed).toEqual(eventsOn(s, day));
    }
  });

  it("scans for an all-day event with a far-off end", () => {
    const forever = { ...s, events: [...events, ev("forever", local(2026, 0, 1), "9999-01-01T00:00:00Z", { allDay: true })] };
    expect(eventIndex(forever).long).toBe(true);
    expect(ids(allDayOn(forever, new Date(2030, 5, 1)))).toEqual(["forever"]);
    expect(ids(allDayOn(forever, new Date(2026, 9, 12)))).toEqual(["trip", "forever"]);
    expect(ids(allDayOn(forever, new Date(2025, 11, 31)))).toEqual([]);
  });
});
