// @vitest-environment jsdom
// Deleting an event by hand: asks first when guests would be emailed, and waits out an Undo before the server delete.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCalendarSync, syncCalendars, useMail } from "@/lib/store";
import { calProviders } from "@/lib/store/providers";
import { EVENT_DELETE_HOLD_MS, heldEventDeletes } from "@/lib/store/calendar-actions";
import { confirmDeleteText, deleteEventWithUndo, otherGuests } from "@/lib/calendar/delete-event";
import type { CalendarProvider } from "@/lib/calendar/provider";
import type { CalEvent, CalendarInfo } from "@/lib/types";

const toasts: { text: string; opts?: { id?: unknown; action?: { label: string; onClick: () => void } } }[] = [];
vi.mock("sonner", () => {
  const t = (text: string, opts?: never) => (toasts.push({ text, opts }), 1);
  t.error = (text: string, opts?: never) => (toasts.push({ text: `error: ${text}`, opts }), 1);
  t.success = t;
  t.dismiss = () => {};
  return { toast: t };
});

const ev = (over: Partial<CalEvent> = {}) =>
  ({ id: "a:e1", calendarId: "a:c1", title: "Standup", start: "2026-10-12T09:00:00Z", end: "2026-10-12T09:30:00Z", attendees: [], ...over }) as CalEvent;
const cals: CalendarInfo[] = [{ id: "a:c1", accountId: "a", name: "Work", source: "google", hue: 200 }];

let deleteEvent: ReturnType<typeof vi.fn>;
let provider: CalendarProvider;
const ids = () => useMail.getState().events.map((e) => e.id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  toasts.length = 0;
  heldEventDeletes.clear();
  resetCalendarSync();
  deleteEvent = vi.fn(async () => {});
  provider = {
    accountId: "a",
    nativeVideo: [],
    listCalendars: async () => cals.map((c) => ({ ...c })),
    listEvents: async () => [ev()],
    deleteEvent,
  } as unknown as CalendarProvider;
  calProviders.clear();
  calProviders.set("a", provider);
  useMail.setState({ calendars: cals, events: [ev()], calChanges: { added: [], deleted: [], resolved: [] } });
});
afterEach(() => vi.useRealTimers());

describe("who a delete would email", () => {
  it("counts attendees other than the user, once each", () => {
    const e = ev({ attendees: [{ name: "Me", address: "Z@gmail.com" }, { name: "Ann", address: "ann@x.com" }, { name: "Ann", address: "ANN@x.com" }, { name: "Bo", address: "bo@x.com" }] });
    expect(otherGuests(e, ["z@gmail.com"])).toBe(2);
    expect(otherGuests(ev({ attendees: [{ name: "Me", address: "z@gmail.com" }] }), ["z@gmail.com"])).toBe(0);
    expect(confirmDeleteText(6)).toBe("Delete and notify 6 guests?");
    expect(confirmDeleteText(1)).toBe("Delete and notify 1 guest?");
  });
});

describe("holdDeleteEvent", () => {
  it("hides the event at once and deletes it on the server only after the hold", async () => {
    const held = useMail.getState().holdDeleteEvent("a:e1")!;
    expect(ids()).toEqual([]);
    expect(deleteEvent).not.toHaveBeenCalled();
    // Nothing saved yet: quitting now would keep the event.
    expect(useMail.getState().calChanges.deleted).toEqual([]);
    await vi.advanceTimersByTimeAsync(EVENT_DELETE_HOLD_MS);
    expect(deleteEvent).toHaveBeenCalledTimes(1);
    expect(await held.done).toBe(true);
    expect(useMail.getState().calChanges.deleted).toEqual(["a:e1"]);
  });

  it("Undo puts it back and nothing reaches the server", async () => {
    const held = useMail.getState().holdDeleteEvent("a:e1")!;
    held.undo();
    expect(ids()).toEqual(["a:e1"]);
    await vi.advanceTimersByTimeAsync(EVENT_DELETE_HOLD_MS * 2);
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(await held.done).toBe(false);
  });

  it("a sync during the hold doesn't bring it back", async () => {
    useMail.getState().holdDeleteEvent("a:e1");
    await syncCalendars([provider], { force: true });
    expect(ids()).toEqual([]);
  });

  it("a server refusal puts the event back and says so", async () => {
    deleteEvent.mockRejectedValueOnce(new Error("Forbidden."));
    deleteEventWithUndo(ev());
    expect(toasts[0].text).toBe('Deleted "Standup"');
    expect(toasts[0].opts?.action?.label).toBe("Undo");
    await vi.advanceTimersByTimeAsync(EVENT_DELETE_HOLD_MS);
    expect(ids()).toEqual(["a:e1"]);
    expect(toasts.at(-1)?.text).toBe('error: Couldn\'t delete "Standup"');
  });

  it("the toast's Undo cancels the delete", async () => {
    deleteEventWithUndo(ev());
    toasts[0].opts!.action!.onClick();
    await vi.advanceTimersByTimeAsync(EVENT_DELETE_HOLD_MS);
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(ids()).toEqual(["a:e1"]);
  });
});
