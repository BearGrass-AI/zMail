// The store's calendar actions: create, answer and delete events, show or hide calendars,
// and take or dismiss date suggestions.

import type { StoreApi } from "zustand";
import { toast } from "sonner";
import type { CalEvent } from "@/lib/types";
import { createZoomMeeting } from "@/lib/zoom/zoom";
import { calProviders } from "./providers";
import { inboxSuggestions } from "./selectors";
import type { MailState } from "./types";

/** Events with an RSVP on its way; each RSVP emails the organizer, so a second is ignored. */
const responding = new Set<string>();

/** How long a deleted event waits for Undo before the server deletes it (and emails any guests). */
export const EVENT_DELETE_HOLD_MS = 5000;
/** Events deleted on screen whose server delete is still held for Undo: a sync in the meantime leaves them out. */
export const heldEventDeletes = new Set<string>();

/** The store's calendar actions. */
export function calendarActions(
  set: StoreApi<MailState>["setState"],
  get: StoreApi<MailState>["getState"],
): Pick<
  MailState,
  "openNewEvent" | "createEvent" | "respondEvent" | "toggleCalendar" | "acceptCalSuggestion" | "dismissCalSuggestion" | "removeNoDateSender" | "deleteEvent" | "holdDeleteEvent"
> {
  /** Off the calendar now; the server delete runs, and a refusal puts the event back (and rejects). */
  const commitDelete = async (ev: CalEvent) => {
    const id = ev.id;
    const cal = get().calendars.find((c) => c.id === ev.calendarId);
    const provider = cal ? calProviders.get(cal.accountId) : undefined;
    const before = get().calChanges;
    set((s) => ({
      events: s.events.filter((e) => e.id !== id),
      calChanges: {
        ...s.calChanges,
        added: s.calChanges.added.filter((e) => e.id !== id),
        deleted: s.calChanges.added.some((e) => e.id === id) ? s.calChanges.deleted : [...s.calChanges.deleted, id],
      },
    }));
    if (!provider) return;
    try {
      await provider.deleteEvent(ev);
    } catch (err) {
      set((s) => ({ events: s.events.some((e) => e.id === id) ? s.events : [...s.events, ev], calChanges: before }));
      throw err;
    }
  };

  return {
    openNewEvent: (newEvent) => set({ newEvent }),

    async createEvent(input) {
      let e = { ...input };
      let zoomUrl: string | undefined;
      if (e.video === "zoom") {
        const m = await createZoomMeeting({ topic: e.title, start: e.start, end: e.end, agenda: e.description });
        zoomUrl = m.join_url;
        e = {
          ...e,
          video: null,
          location: e.location || "Zoom",
          description: [e.description, `Join Zoom meeting: ${m.join_url}${m.password ? `\nPasscode: ${m.password}` : ""}`].filter(Boolean).join("\n\n"),
        };
      }
      const cal = get().calendars.find((c) => c.id === e.calendarId);
      const provider = cal ? calProviders.get(cal.accountId) : undefined;
      let event: CalEvent;
      if (provider) {
        event = await provider.createEvent(e);
      } else {
        // Demo calendar: keep it local.
        event = {
          id: `local-${crypto.randomUUID().slice(0, 8)}`,
          calendarId: e.calendarId,
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          location: e.location,
          video: !!input.video,
          joinUrl: input.video && input.video !== "zoom" ? "https://example.com/demo-meeting" : undefined,
          attendees: (e.attendees ?? []).map((address) => ({ name: address, address })),
        };
        set((s) => ({ calChanges: { ...s.calChanges, added: [...s.calChanges.added, event] } }));
      }
      if (zoomUrl) event = { ...event, video: true, joinUrl: zoomUrl };
      set((s) => ({ events: [...s.events.filter((x) => x.id !== event.id), event] }));
      return event;
    },

    async respondEvent(event, response) {
      const cal = get().calendars.find((c) => c.id === event.calendarId);
      const provider = cal ? calProviders.get(cal.accountId) : undefined;
      // One reply at a time per event: each one emails the organizer.
      if (!provider || responding.has(event.id)) return;
      responding.add(event.id);
      try {
        await provider.respond(event, response);
      } finally {
        responding.delete(event.id);
      }
      if (response === "declined") set((s) => ({ events: s.events.filter((x) => x.id !== event.id) }));
    },

    toggleCalendar(id) {
      set((s) => {
        const hidden = new Set(s.hiddenCalendars);
        if (hidden.has(id)) hidden.delete(id);
        else hidden.add(id);
        return { hiddenCalendars: hidden };
      });
    },

    async acceptCalSuggestion(id, response = "yes", calendarId) {
      const found = inboxSuggestions(get()).find((x) => x.id === id);
      if (!found) return;
      const sug = { ...found, calendarId: calendarId ?? found.calendarId };
      const cal = get().calendars.find((c) => c.id === sug.calendarId);
      if (cal && calProviders.has(cal.accountId)) {
        // A real calendar: create the event there.
        const email = sug.emailId ? get().emails.find((e) => e.id === sug.emailId) : undefined;
        await get().createEvent({
          calendarId: sug.calendarId,
          title: sug.title,
          start: sug.start,
          end: sug.end,
          allDay: sug.allDay,
          description: email ? `From email: ${email.subject} (${email.from.name})${sug.quote ? `\n“${sug.quote}”` : ""}` : undefined,
        });
        set((s) => ({
          calSuggestions: s.calSuggestions.filter((x) => x.id !== id),
          calChanges: { ...s.calChanges, resolved: [...s.calChanges.resolved, id] },
        }));
        return;
      }
      const event: CalEvent = {
        id: `ev-${id}`,
        calendarId: sug.calendarId,
        title: response === "maybe" ? `${sug.title} (tentative)` : sug.title,
        start: sug.start,
        end: sug.end,
        allDay: sug.allDay,
        attendees: [],
        hue: sug.kind === "block" ? 75 : undefined,
        related: sug.emailSubject ? { subject: sug.emailSubject } : undefined,
      };
      set((s) => ({
        events: [...s.events, event],
        calSuggestions: s.calSuggestions.filter((x) => x.id !== id),
        calChanges: { ...s.calChanges, added: [...s.calChanges.added, event], resolved: [...s.calChanges.resolved, id] },
      }));
    },

    dismissCalSuggestion(id) {
      const from = inboxSuggestions(get()).find((x) => x.id === id)?.emailId;
      const sender = from ? get().emails.find((e) => e.id === from)?.from.address.toLowerCase() : undefined;
      set((s) => ({
        calSuggestions: s.calSuggestions.filter((x) => x.id !== id),
        calChanges: { ...s.calChanges, resolved: [...s.calChanges.resolved, id] },
      }));
      if (!sender) return;
      const prev = Object.hasOwn(get().dateDismissals, sender) ? get().dateDismissals[sender] : [];
      const seen = prev.includes(from!) ? prev : [...prev, from!];
      const count = seen.length;
      set((s) => ({
        dateDismissals: { ...s.dateDismissals, [sender]: seen },
        ...(count >= 2 ? { noDateSenders: { ...s.noDateSenders, [sender]: true as const } } : {}),
      }));
      if (count === 2 && prev.length < 2)
        toast(`Won't suggest dates from ${sender} anymore`, {
          action: { label: "Undo", onClick: () => get().removeNoDateSender(sender) },
        });
    },

    removeNoDateSender(address) {
      set((s) => {
        const noDateSenders = { ...s.noDateSenders };
        delete noDateSenders[address];
        return { noDateSenders, dateDismissals: { ...s.dateDismissals, [address]: [] } };
      });
    },

    async deleteEvent(id) {
      const ev = get().events.find((e) => e.id === id);
      if (ev) await commitDelete(ev);
    },

    holdDeleteEvent(id, ms = EVENT_DELETE_HOLD_MS) {
      const ev = get().events.find((e) => e.id === id);
      if (!ev || heldEventDeletes.has(id)) return null;
      // Only hidden for now: nothing is saved or sent until the hold ends, so quitting meanwhile keeps the event.
      heldEventDeletes.add(id);
      set((s) => ({ events: s.events.filter((e) => e.id !== id) }));
      let settle!: (deleted: boolean) => void;
      let fail!: (err: unknown) => void;
      const done = new Promise<boolean>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      const timer = setTimeout(() => {
        heldEventDeletes.delete(id);
        commitDelete(ev).then(() => settle(true), fail);
      }, ms);
      const undo = () => {
        if (!heldEventDeletes.delete(id)) return;
        clearTimeout(timer);
        set((s) => ({ events: s.events.some((e) => e.id === id) ? s.events : [...s.events, ev] }));
        settle(false);
      };
      return { undo, done };
    },
  };
}
