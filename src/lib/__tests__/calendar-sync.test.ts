// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailForEvent, ensureEventRange, eventMailIndex, resetCalendarSync, syncCalendars, useMail } from "@/lib/store";
import { calProviders } from "@/lib/store/providers";
import type { CalendarProvider } from "@/lib/calendar/provider";
import type { CalEvent, CalendarInfo, Email } from "@/lib/types";

const mail = (id: string, from: string, subject: string) =>
  ({ id, folderId: "f", accountId: "a", from: { name: from, address: from }, subject }) as Email;
const ev = (over: Partial<CalEvent> = {}) =>
  ({ id: "a:e1", calendarId: "a:c1", title: "Standup", start: "2026-10-12T09:00:00Z", end: "2026-10-12T09:30:00Z", attendees: [], ...over }) as CalEvent;

/** The implementation before the index existed. */
const oldEmailForEvent = (emails: Email[], e: CalEvent) =>
  e.related
    ? emails.find(
        (m) =>
          (!e.related!.from || m.from.address.toLowerCase() === e.related!.from) &&
          (!e.related!.subject || m.subject.includes(e.related!.subject)),
      )
    : undefined;

describe("emailForEvent", () => {
  const emails = [
    mail("1", "Dana@x.com", "Lunch plans"),
    mail("2", "bob@x.com", "Budget review"),
    mail("3", "dana@x.com", "Budget review notes"),
    mail("4", "carol@x.com", "Lunch plans"),
  ];

  it("matches sender plus subject like before", () => {
    const e = ev({ related: { from: "dana@x.com", subject: "Budget" } });
    expect(emailForEvent({ emails }, e)?.id).toBe("3");
    expect(emailForEvent({ emails }, e)).toBe(oldEmailForEvent(emails, e));
  });

  it("matches sender alone (first in mailbox order)", () => {
    const e = ev({ related: { from: "dana@x.com" } });
    expect(emailForEvent({ emails }, e)?.id).toBe("1");
    expect(emailForEvent({ emails }, e)).toBe(oldEmailForEvent(emails, e));
  });

  it("matches subject only", () => {
    const e = ev({ related: { subject: "Lunch" } });
    expect(emailForEvent({ emails }, e)?.id).toBe("1");
    expect(emailForEvent({ emails }, e)).toBe(oldEmailForEvent(emails, e));
  });

  it("returns undefined when nothing matches or there is no relation", () => {
    for (const related of [{ from: "nobody@x.com" }, { from: "dana@x.com", subject: "zzz" }, { subject: "zzz" }, undefined]) {
      const e = ev({ related });
      expect(emailForEvent({ emails }, e)).toBeUndefined();
      expect(oldEmailForEvent(emails, e)).toBeUndefined();
    }
  });

  it("caches the index per emails array", () => {
    const idx = eventMailIndex(emails);
    expect(eventMailIndex(emails)).toBe(idx);
    expect(eventMailIndex([...emails])).not.toBe(idx);
  });
});

describe("syncCalendars", () => {
  const cals: CalendarInfo[] = [{ id: "a:c1", accountId: "a", name: "Work", source: "google", hue: 200 }];
  let events: CalEvent[];
  let listEvents: ReturnType<typeof vi.fn>;
  let provider: CalendarProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    resetCalendarSync();
    useMail.setState({ calendars: [], events: [], calChanges: { added: [], deleted: [], resolved: [] } });
    events = [ev()];
    listEvents = vi.fn(async () => events.map((e) => ({ ...e })));
    provider = {
      accountId: "a",
      nativeVideo: [],
      listCalendars: async () => cals.map((c) => ({ ...c })),
      listEvents,
    } as unknown as CalendarProvider;
    calProviders.clear();
    calProviders.set("a", provider);
  });
  afterEach(() => vi.useRealTimers());

  it("leaves out what a sync brings back after its account was removed", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    listEvents.mockImplementationOnce(async () => {
      await held;
      return events.map((e) => ({ ...e }));
    });
    const syncing = syncCalendars([provider], { force: true });
    await vi.advanceTimersByTimeAsync(0);
    calProviders.delete("a");
    release();
    await syncing;
    expect(useMail.getState().calendars).toEqual([]);
    expect(useMail.getState().events).toEqual([]);
  });

  it("skips unforced syncs within 5 minutes, runs forced ones, and runs again after the window", async () => {
    await syncCalendars([provider]);
    await syncCalendars([provider]);
    expect(listEvents).toHaveBeenCalledTimes(1);
    await syncCalendars([provider], { force: true });
    expect(listEvents).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5 * 6e4 + 1);
    await syncCalendars([provider]);
    expect(listEvents).toHaveBeenCalledTimes(3);
  });

  it("does not write the store when nothing changed", async () => {
    await syncCalendars([provider], { force: true });
    expect(useMail.getState().events).toHaveLength(1);
    const spy = vi.fn();
    const unsub = useMail.subscribe(spy);
    await syncCalendars([provider], { force: true });
    expect(spy).not.toHaveBeenCalled();
    unsub();
  });

  it("writes when a rendered field changes without the title or times changing", async () => {
    await syncCalendars([provider], { force: true });
    const spy = vi.fn();
    const unsub = useMail.subscribe(spy);
    for (const patch of [
      { location: "Room 2" },
      { allDay: true },
      { hue: 10 },
      { joinUrl: "https://meet/x" },
      { attendees: [{ name: "Dana", address: "d@x.com" }] },
    ] as Partial<CalEvent>[]) {
      events = [ev(patch)];
      await syncCalendars([provider], { force: true });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      events = [ev()];
      await syncCalendars([provider], { force: true });
      spy.mockClear();
    }
    unsub();
  });
});

describe("ensureEventRange", () => {
  const cals: CalendarInfo[] = [{ id: "a:c1", accountId: "a", name: "Work", source: "google", hue: 200 }];
  const far = (id: string, start: string, end: string): CalEvent => ({ id, calendarId: "a:c1", title: id, start, end, attendees: [] });
  let listEvents: ReturnType<typeof vi.fn>;
  let provider: CalendarProvider;
  let server: CalEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00"));
    resetCalendarSync();
    useMail.setState({ calendars: cals, events: [], calChanges: { added: [], deleted: [], resolved: [] } });
    server = [far("soon", "2026-10-20T09:00:00", "2026-10-20T10:00:00"), far("nov18", "2026-11-18T09:00:00", "2026-11-18T10:00:00")];
    listEvents = vi.fn(async (_ids: string[], from: Date, to: Date) => server.filter((e) => new Date(e.start) < to && new Date(e.end) > from).map((e) => ({ ...e })));
    provider = { accountId: "a", nativeVideo: [], listCalendars: async () => cals, listEvents } as unknown as CalendarProvider;
    calProviders.clear();
    calProviders.set("a", provider);
  });
  afterEach(() => vi.useRealTimers());

  it("leaves out far weeks fetched for an account removed meanwhile", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    listEvents.mockImplementationOnce(async (_ids: string[], from: Date, to: Date) => {
      await held;
      return server.filter((e) => new Date(e.start) < to && new Date(e.end) > from).map((e) => ({ ...e }));
    });
    const ensuring = ensureEventRange(new Date(2026, 10, 18), new Date(2026, 10, 19), [provider]);
    await vi.advanceTimersByTimeAsync(0);
    calProviders.delete("a");
    release();
    await ensuring;
    expect(useMail.getState().events).toEqual([]);
  });

  it("does nothing for dates the regular sync covers", async () => {
    await syncCalendars([provider], { force: true });
    listEvents.mockClear();
    expect(await ensureEventRange(new Date(2026, 9, 20), new Date(2026, 9, 21), [provider])).toBe(true);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("fetches dates in the sync window itself before the first regular sync has run", async () => {
    expect(await ensureEventRange(new Date(2026, 9, 20), new Date(2026, 9, 21), [provider])).toBe(true);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(useMail.getState().events.map((e) => e.id)).toEqual(["soon"]);
  });

  it("fetches dates in the sync window itself when the regular sync failed, and says so if that fails too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    listEvents.mockRejectedValueOnce(new Error("offline"));
    await syncCalendars([provider], { force: true });
    listEvents.mockRejectedValueOnce(new Error("offline"));
    expect(await ensureEventRange(new Date(2026, 9, 20), new Date(2026, 9, 21), [provider])).toBe(false);
    expect(await ensureEventRange(new Date(2026, 9, 20), new Date(2026, 9, 21), [provider])).toBe(true);
    expect(useMail.getState().events.map((e) => e.id)).toEqual(["soon"]);
  });

  it("fetches far-off weeks once, and the next regular sync keeps them", async () => {
    expect(await ensureEventRange(new Date(2026, 10, 18), new Date(2026, 10, 19), [provider])).toBe(true);
    expect(useMail.getState().events.map((e) => e.id)).toEqual(["nov18"]);
    // Whole weeks, Sunday to Sunday.
    expect(listEvents.mock.calls[0][1]).toEqual(new Date(2026, 10, 15));
    expect(listEvents.mock.calls[0][2]).toEqual(new Date(2026, 10, 22));
    await ensureEventRange(new Date(2026, 10, 19), new Date(2026, 10, 20), [provider]);
    expect(listEvents).toHaveBeenCalledTimes(1);
    await syncCalendars([provider], { force: true });
    expect(useMail.getState().events.map((e) => e.id).sort()).toEqual(["nov18", "soon"]);
  });

  it("reports false when a calendar can't be read", async () => {
    listEvents.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await ensureEventRange(new Date(2026, 11, 1), new Date(2026, 11, 2), [provider])).toBe(false);
  });

  it("fetches only the weeks of the current month grid outside the sync window, in one request", async () => {
    // Window: Oct 6 to Nov 10. October's grid runs Sunday Sep 27 to Nov 8.
    await syncCalendars([provider], { force: true });
    listEvents.mockClear();
    expect(await ensureEventRange(new Date(2026, 8, 27), new Date(2026, 10, 8), [provider])).toBe(true);
    expect(listEvents).toHaveBeenCalledTimes(1);
    // Sep 27 and Oct 4 (only partly in the window); Oct 11 to Nov 8 are synced already.
    expect(listEvents.mock.calls[0][1]).toEqual(new Date(2026, 8, 27));
    expect(listEvents.mock.calls[0][2]).toEqual(new Date(2026, 9, 11));
    await ensureEventRange(new Date(2026, 8, 27), new Date(2026, 10, 8), [provider]);
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it("fetches only the missing weeks, one request per run of adjacent weeks", async () => {
    await ensureEventRange(new Date(2026, 11, 13), new Date(2026, 11, 20), [provider]);
    listEvents.mockClear();
    await ensureEventRange(new Date(2026, 11, 6), new Date(2026, 11, 27), [provider]);
    expect(listEvents.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [new Date(2026, 11, 6), new Date(2026, 11, 13)],
      [new Date(2026, 11, 20), new Date(2026, 11, 27)],
    ]);
  });

  it("shares one request between concurrent calls for the same far week", async () => {
    const [a, b] = await Promise.all([
      ensureEventRange(new Date(2026, 10, 18), new Date(2026, 10, 19), [provider]),
      ensureEventRange(new Date(2026, 10, 17), new Date(2026, 10, 20), [provider]),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(useMail.getState().events.map((e) => e.id)).toEqual(["nov18"]);
  });

  it("does not write the store when a refetch brings the same events", async () => {
    await ensureEventRange(new Date(2026, 10, 18), new Date(2026, 10, 19), [provider]);
    vi.advanceTimersByTime(10 * 6e4 + 1);
    const spy = vi.fn();
    const unsub = useMail.subscribe(spy);
    await ensureEventRange(new Date(2026, 10, 18), new Date(2026, 10, 19), [provider]);
    expect(listEvents).toHaveBeenCalledTimes(2);
    expect(spy).not.toHaveBeenCalled();
    // A changed event still lands.
    vi.advanceTimersByTime(10 * 6e4 + 1);
    server = [far("nov18", "2026-11-18T11:00:00", "2026-11-18T12:00:00")];
    await ensureEventRange(new Date(2026, 10, 18), new Date(2026, 10, 19), [provider]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useMail.getState().events[0].start).toBe("2026-11-18T11:00:00");
    unsub();
  });

  it("the next regular sync drops events 120 days out and keeps ones 40 days out", async () => {
    // Fetched earlier, while something else is on screen now.
    const e120 = far("feb10", "2027-02-10T09:00:00", "2027-02-10T10:00:00");
    const e40 = far("nov22", "2026-11-22T09:00:00", "2026-11-22T10:00:00");
    useMail.setState({ events: [e120, e40] });
    await syncCalendars([provider], { force: true });
    expect(useMail.getState().events.map((e) => e.id).sort()).toEqual(["nov22", "soon"]);
  });

  it("keeps far events on screen through a sync, drops them once you page away, and refetches them when you come back", async () => {
    server.push(far("feb10", "2027-02-10T09:00:00", "2027-02-10T10:00:00"));
    await ensureEventRange(new Date(2027, 1, 7), new Date(2027, 1, 14), [provider]);
    await syncCalendars([provider], { force: true });
    expect(useMail.getState().events.map((e) => e.id).sort()).toEqual(["feb10", "soon"]);
    await ensureEventRange(new Date(2026, 10, 18), new Date(2026, 10, 19), [provider]);
    expect(useMail.getState().events.map((e) => e.id).sort()).toEqual(["nov18", "soon"]);
    listEvents.mockClear();
    await ensureEventRange(new Date(2027, 1, 7), new Date(2027, 1, 14), [provider]);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(useMail.getState().events.map((e) => e.id).sort()).toEqual(["feb10", "nov18", "soon"]);
  });
});
