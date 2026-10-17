// @vitest-environment jsdom
// Calendar module: list_events filtering, and rsvp / delete / invite cards and their confirm actions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import { runConfirm } from "@/lib/ai/assistant/modules/confirm";
import { useAssistant } from "@/lib/ai/assistant/state";
import type { CalendarDeps } from "@/lib/ai/assistant/modules/calendar";
import type { CalEvent } from "@/lib/types";
import type { VideoOption } from "@/lib/calendar/provider";
import { localDate } from "@/lib/ai/dates";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const ev = (id: string, title: string, start: string, end: string, extra: Partial<CalEvent> = {}): CalEvent => ({ id, calendarId: "c1", title, start, end, attendees: [], ...extra });
const EVENTS: CalEvent[] = [
  ev("e1", "Board meeting", "2026-10-14T14:00:00", "2026-10-14T15:00:00", { location: "Room 4", attendees: [{ name: "Dana Lee", address: "dana@x.com" }] }),
  ev("e2", "Overnight run", "2026-10-13T23:00:00", "2026-10-14T01:00:00"),
  ev("e3", "Secret", "2026-10-14T09:00:00", "2026-10-14T10:00:00", { calendarId: "hid" }),
  ev("e4", "Next week", "2026-10-21T09:00:00", "2026-10-21T10:00:00"),
];

function make(events = EVENTS, ensureRange: CalendarDeps["ensureRange"] = async () => true) {
  const fake = {
    events: () => events,
    ensureRange: vi.fn(ensureRange),
    calendars: () => [
      { id: "c1", accountId: "a1", name: "Work", source: "mock" as const, hue: 1 },
      { id: "hid", accountId: "a1", name: "Hidden", source: "mock" as const, hue: 2 },
      { id: "gcal", accountId: "g1", name: "Personal", source: "google" as const, hue: 3 },
      { id: "ocal", accountId: "o1", name: "Outlook", source: "outlook" as const, hue: 4 },
    ],
    nativeVideo: (accountId: string): VideoOption[] => (accountId === "g1" ? ["meet"] : accountId === "o1" ? ["teams"] : ["meet", "teams"]),
    hiddenCalendars: () => new Set(["hid"]),
    defaultCalendarId: () => "c1",
    respondEvent: vi.fn(async () => {}),
    deleteEvent: vi.fn(async () => {}),
    createEvent: vi.fn(async (_e: Parameters<CalendarDeps["createEvent"]>[0]) => ({})),
  } satisfies CalendarDeps;
  return { fake, deps: { ext: { calendar: fake } } as unknown as ToolDeps };
}
const run = (name: string, args: Record<string, unknown>, deps: ToolDeps) => executeTool({ id: "c1", name, args }, deps);
const cards = () => useAssistant.getState().items.filter((i) => i.kind === "card");
const lastCard = () => {
  const c = cards().at(-1);
  if (!c || c.kind !== "card" || c.card.type !== "confirm") throw new Error("no confirm card");
  return { id: c.id, card: c.card };
};

beforeEach(() => useAssistant.getState().newChat());

describe("list_events", () => {
  it("returns overlapping events on visible calendars, sorted", async () => {
    const { deps } = make();
    const r = (await run("list_events", { from: "2026-10-14" }, deps)) as { content: { events: { id: string; attendees: string[] }[]; note?: string } };
    expect(r.content.events.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(r.content.events[1].attendees).toEqual(["Dana Lee"]);
    expect(r.content.note).toBeUndefined();
  });

  it("covers a range with an inclusive end", async () => {
    const { deps } = make();
    const r = (await run("list_events", { from: "2026-10-14", to: "2026-10-21" }, deps)) as { content: { events: { id: string }[] } };
    expect(r.content.events.map((e) => e.id)).toEqual(["e2", "e1", "e4"]);
  });

  it("loads far-off dates first, and warns only when a calendar couldn't be read", async () => {
    const far = ev("e9", "Board retreat", "2026-11-18T09:00:00", "2026-11-18T12:00:00");
    const loaded: CalEvent[] = [...EVENTS];
    const { fake, deps } = make(loaded, async () => {
      loaded.push(far);
      return true;
    });
    const r = (await run("list_events", { from: "2026-11-18" }, deps)) as { content: { events: { id: string }[]; note?: string } };
    expect(fake.ensureRange).toHaveBeenCalledWith(new Date(2026, 10, 18), new Date(2026, 10, 19));
    expect(r.content.events.map((e) => e.id)).toEqual(["e9"]);
    expect(r.content.note).toBeUndefined();
    const failed = make(EVENTS, async () => false);
    const f = (await run("list_events", { from: "2026-12-01" }, failed.deps)) as { content: { note?: string } };
    expect(f.content.note).toMatch(/couldn't be read/);
  });

  it("filters by query", async () => {
    const { deps } = make();
    const r = (await run("list_events", { from: "2026-12-01", query: "board" }, deps)) as { content: { events: unknown[] } };
    expect(r.content.events).toEqual([]);
    const q = (await run("list_events", { from: "2026-10-14", query: "dana" }, deps)) as { content: { events: { id: string }[] } };
    expect(q.content.events.map((e) => e.id)).toEqual(["e1"]);
  });

  it("caps at 50", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ev(`m${i}`, `Ev ${i}`, "2026-10-14T08:00:00", "2026-10-14T09:00:00"));
    const { deps } = make(many);
    const r = (await run("list_events", { from: "2026-10-14" }, deps)) as { content: { events: unknown[]; truncated?: string } };
    expect(r.content.events).toHaveLength(50);
    expect(r.content.truncated).toBeDefined();
  });

  it("rejects a bad date", async () => {
    const { deps } = make();
    expect(JSON.stringify(await run("list_events", { from: "tomorrow" }, deps))).toMatch(/date/i);
  });
});

describe("rsvp / delete / invite", () => {
  it("rejects made-up event ids", async () => {
    const { deps } = make();
    const r = await run("rsvp", { event_id: "zzz", response: "accepted" }, deps);
    expect(JSON.stringify(r)).toMatch(/unknown id/);
    expect(cards()).toHaveLength(0);
  });

  it("accepts ids that exist in the store even if never listed", async () => {
    const { deps } = make();
    expect(JSON.stringify(await run("rsvp", { event_id: "e1", response: "accepted" }, deps))).toMatch(/awaiting_confirmation/);
    expect(JSON.stringify(await run("delete_event", { event_id: "e4" }, deps))).toMatch(/awaiting_confirmation/);
    expect(cards()).toHaveLength(2);
  });

  it("invite confirm sends UTC ISO strings for a local time", async () => {
    const { fake, deps } = make();
    await run("invite", { title: "Sync", start: "2026-10-14T14:00:00", end: "2026-10-14T15:00:00", attendees: ["a@x.com"] }, deps);
    await runConfirm(lastCard().id, deps);
    const sent = fake.createEvent.mock.calls[0][0];
    expect(sent.start).toMatch(/Z$/);
    expect(sent.start).toBe(new Date("2026-10-14T14:00:00").toISOString());
    expect(sent.end).toBe(new Date("2026-10-14T15:00:00").toISOString());
  });

  it("all-day invite keeps the same calendar day", async () => {
    const { fake, deps } = make();
    await run("invite", { title: "Offsite", start: "2026-10-14", end: "2026-10-15", all_day: true, attendees: ["a@x.com"] }, deps);
    await runConfirm(lastCard().id, deps);
    const sent = fake.createEvent.mock.calls[0][0];
    expect(sent.allDay).toBe(true);
    expect(localDate(new Date(sent.start))).toBe("2026-10-14");
  });

  it("rsvp pushes a card; confirm calls respondEvent", async () => {
    const { fake, deps } = make();
    await run("list_events", { from: "2026-10-14" }, deps);
    const r = await run("rsvp", { event_id: "e1", response: "tentative" }, deps);
    expect(JSON.stringify(r)).toMatch(/awaiting_confirmation/);
    const c = lastCard();
    expect(c.card).toMatchObject({ module: "calendar", action: "rsvp", title: "Maybe “Board meeting”", confirmLabel: "Maybe" });
    expect(fake.respondEvent).not.toHaveBeenCalled();
    await runConfirm(c.id, deps);
    expect(fake.respondEvent).toHaveBeenCalledWith(EVENTS[0], "tentative");
    expect(lastCard().card).toMatchObject({ status: "done", result: "Replied maybe" });
  });

  it("delete_event pushes a card; confirm calls deleteEvent", async () => {
    const { fake, deps } = make();
    await run("list_events", { from: "2026-10-14" }, deps);
    await run("delete_event", { event_id: "e1" }, deps);
    const c = lastCard();
    expect(c.card).toMatchObject({ action: "delete", confirmLabel: "Delete event" });
    await runConfirm(c.id, deps);
    expect(fake.deleteEvent).toHaveBeenCalledWith("e1");
  });

  it("invite builds a card; confirm calls createEvent", async () => {
    const { fake, deps } = make();
    await run("invite", { title: "Sync", start: "2026-10-15T10:00:00", end: "2026-10-15T10:30:00", attendees: ["a@x.com", "b@y.org"], calendar: "work", video: "teams", notes: "Agenda" }, deps);
    const c = lastCard();
    expect(c.card.confirmLabel).toBe("Send invite");
    expect(c.card.preview?.body).toBe("Agenda");
    expect(c.card.preview?.fields?.map((f) => f.label)).toEqual(["When", "Calendar", "Attendees", "Video"]);
    await runConfirm(c.id, deps);
    expect(fake.createEvent).toHaveBeenCalledWith(expect.objectContaining({ calendarId: "c1", title: "Sync", attendees: ["a@x.com", "b@y.org"], video: "teams", description: "Agenda" }));
    expect(lastCard().card).toMatchObject({ status: "done", result: "Invite sent to 2 people" });
  });

  it("invite maps video none to null and uses the default calendar", async () => {
    const { fake, deps } = make();
    await run("invite", { title: "Sync", start: "2026-10-15T10:00:00", end: "2026-10-15T11:00:00", attendees: ["a@x.com"], video: "none" }, deps);
    await runConfirm(lastCard().id, deps);
    expect(fake.createEvent).toHaveBeenCalledWith(expect.objectContaining({ calendarId: "c1", video: null }));
  });

  it("invite validates end, emails and calendar", async () => {
    const { deps } = make();
    const base = { title: "T", start: "2026-10-15T10:00:00", end: "2026-10-15T11:00:00", attendees: ["a@x.com"] };
    expect(JSON.stringify(await run("invite", { ...base, end: "2026-10-15T09:00:00" }, deps))).toMatch(/end must be after start/);
    expect(JSON.stringify(await run("invite", { ...base, attendees: ["nope"] }, deps))).toMatch(/not an email/);
    expect(JSON.stringify(await run("invite", { ...base, calendar: "Nowhere" }, deps))).toMatch(/no calendar/);
    expect(cards()).toHaveLength(0);
  });

  // Google only adds Meet links and Outlook only Teams; Zoom is zMail's own and works on any calendar.
  it("invite refuses a video service the calendar can't add, naming the ones it can", async () => {
    const { fake, deps } = make();
    const base = { title: "T", start: "2026-10-15T10:00:00", end: "2026-10-15T11:00:00", attendees: ["a@x.com"] };
    expect(JSON.stringify(await run("invite", { ...base, calendar: "Personal", video: "teams" }, deps))).toMatch(/bad_query: Personal can't add Microsoft Teams; video can be meet, zoom or none/);
    expect(JSON.stringify(await run("invite", { ...base, calendar: "Outlook", video: "meet" }, deps))).toMatch(/bad_query: Outlook can't add Google Meet; video can be teams, zoom or none/);
    expect(cards()).toHaveLength(0);
    for (const [calendar, video] of [["Personal", "meet"], ["Outlook", "teams"], ["Personal", "zoom"], ["Outlook", "zoom"]]) {
      await run("invite", { ...base, calendar, video }, deps);
      await runConfirm(lastCard().id, deps);
      expect(lastCard().card.status).toBe("done");
    }
    expect(fake.createEvent.mock.calls.map(([e]) => [e.calendarId, e.video])).toEqual([["gcal", "meet"], ["ocal", "teams"], ["gcal", "zoom"], ["ocal", "zoom"]]);
  });

  it("invite re-checks the video service when confirmed", async () => {
    const { fake, deps } = make();
    await run("invite", { title: "T", start: "2026-10-15T10:00:00", end: "2026-10-15T11:00:00", attendees: ["a@x.com"], calendar: "Outlook", video: "teams" }, deps);
    // The calendar's account was reconnected with a provider that can't add Teams.
    fake.nativeVideo = () => [];
    await runConfirm(lastCard().id, deps);
    expect(lastCard().card).toMatchObject({ status: "failed", error: "Outlook can't add Microsoft Teams. Ask again to pick another option." });
    expect(fake.createEvent).not.toHaveBeenCalled();
  });
});
