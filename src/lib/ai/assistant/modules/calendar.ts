// Calendar: reading events, RSVPs, deleting, and invites with attendees.
import { useMail, calendarProvider, defaultCalendarFor, ensureEventRange } from "@/lib/store";
import type { Rsvp, VideoOption } from "@/lib/calendar/provider";
import type { CalEvent, CalendarInfo } from "@/lib/types";
import { useAssistant } from "../state";
import { pushConfirmCard } from "./confirm";
import { extOf, type ToolModule } from "./types";
import { localDate, localIso } from "@/lib/dates/local";

type Video = "meet" | "teams" | "zoom" | null;

interface NewEventInput {
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  video?: Video;
}

export interface CalendarDeps {
  events: () => CalEvent[];
  /** Load events for [from, to) when they're outside the synced weeks; false when a calendar couldn't be read. */
  ensureRange: (from: Date, to: Date) => Promise<boolean>;
  calendars: () => CalendarInfo[];
  hiddenCalendars: () => Set<string>;
  /** Id of the first account's default calendar ("" when none). */
  defaultCalendarId: () => string;
  respondEvent: (e: CalEvent, response: Rsvp) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  createEvent: (e: NewEventInput) => Promise<unknown>;
  /** Video links the account's calendar adds itself (Google: Meet, Outlook: Teams). Zoom is separate. */
  nativeVideo: (accountId: string) => VideoOption[];
}

const ID = "calendar";
const MAX_EVENTS = 50;
const RESPONSES: Rsvp[] = ["accepted", "tentative", "declined"];
const VIDEOS = ["teams", "meet", "zoom", "none"];
const VIDEO_NAME: Record<VideoOption, string> = { meet: "Google Meet", teams: "Microsoft Teams", zoom: "Zoom" };

/** A Meet or Teams link the calendar can't add itself would leave the invite without one. Zoom is created by zMail. */
function videoProblem(video: Video, cal: CalendarInfo, d: CalendarDeps): string | null {
  if (!video || video === "zoom" || d.nativeVideo(cal.accountId).includes(video)) return null;
  return `${cal.name} can't add ${VIDEO_NAME[video]}`;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const timeLabel = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function whenLabel(startIso: string, endIso: string, allDay?: boolean): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (allDay) return `${dayLabel(s)} (all day)`;
  const sameDay = localDate(s) === localDate(e);
  return sameDay ? `${dayLabel(s)}, ${timeLabel(s)} – ${timeLabel(e)}` : `${dayLabel(s)} ${timeLabel(s)} – ${dayLabel(e)} ${timeLabel(e)}`;
}

function parseDay(v: unknown, name: string): Date {
  if (typeof v !== "string" || !DAY.test(v)) throw new Error(`bad_query: ${name} must be a date like 2026-10-14`);
  const d = new Date(`${v}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw new Error(`bad_query: ${name} is not a valid date`);
  return d;
}

function parseDateTime(v: unknown, name: string, allDay: boolean): Date {
  const s = typeof v === "string" ? v.trim() : "";
  const d = new Date(allDay && DAY.test(s) ? `${s}T00:00:00` : s);
  if (!s || Number.isNaN(d.getTime())) throw new Error(`bad_query: ${name} must be a valid local time like 2026-10-14T14:00:00`);
  return d;
}

function knownEvent(args: Record<string, unknown>, d: CalendarDeps): CalEvent {
  const id = args.event_id;
  // Existence in the store is what stops the model inventing ids; no hidden state.
  const ev = typeof id === "string" ? d.events().find((e) => e.id === id) : undefined;
  if (!ev) throw new Error(`unknown id "${String(id)}": use ids from list_events`);
  return ev;
}

const eventDetail = (ev: CalEvent) => whenLabel(ev.start, ev.end, ev.allDay);

const VERB: Record<Rsvp, { word: string; label: string; done: string }> = {
  accepted: { word: "Accept", label: "Accept", done: "Accepted" },
  tentative: { word: "Maybe", label: "Maybe", done: "Replied maybe" },
  declined: { word: "Decline", label: "Decline", done: "Declined" },
};

const AWAITING = { status: "awaiting_confirmation", note: "A card is waiting for the user's OK. Nothing has happened yet." };

export const calendarModule: ToolModule = {
  id: ID,
  prompt: [
    "- Use list_events for questions about the calendar; never guess what's on it.",
    "- rsvp, delete_event and invite only show a card; say the user needs to confirm on the card. Use invite when there are attendees or a video call; create_event for a simple event on the user's own calendar.",
  ],
  tools: [
    {
      name: "list_events",
      description: "Read the user's calendar for any date range (visible calendars; far-off dates are fetched as needed). Returns events overlapping the range, sorted by start.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "First day, YYYY-MM-DD" },
          to: { type: "string", description: "Last day inclusive, YYYY-MM-DD; defaults to from" },
          query: { type: "string", description: "Optional text to match in title, location or attendee names" },
        },
        required: ["from"],
      },
    },
    {
      name: "rsvp",
      description: "Propose accepting, tentatively accepting or declining an event. The user confirms on a card. Use an id from list_events.",
      parameters: {
        type: "object",
        properties: { event_id: { type: "string" }, response: { type: "string", enum: RESPONSES } },
        required: ["event_id", "response"],
      },
    },
    {
      name: "delete_event",
      description: "Propose deleting an event. The user confirms on a card. Use an id from list_events.",
      parameters: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
    },
    {
      name: "invite",
      description: "Propose a calendar event with attendees and optional video call; invitations go out when the user confirms on a card. Times are local ISO (2026-10-14T14:00:00).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          attendees: { type: "array", items: { type: "string" }, description: "Email addresses" },
          calendar: { type: "string", description: "Calendar id or name; defaults to the main calendar" },
          video: { type: "string", enum: VIDEOS, description: "meet on Google calendars, teams on Outlook calendars, zoom on any." },
          location: { type: "string" },
          notes: { type: "string" },
          all_day: { type: "boolean" },
        },
        required: ["title", "start", "end", "attendees"],
      },
    },
  ],
  handlers: {
    list_events: async (args, deps) => {
      const d = extOf<CalendarDeps>(deps, ID);
      const from = parseDay(args.from, "from");
      const to = args.to === undefined || args.to === "" ? from : parseDay(args.to, "to");
      if (to < from) throw new Error("bad_query: to must not be before from");
      const rangeEnd = new Date(to);
      rangeEnd.setDate(rangeEnd.getDate() + 1);
      const hidden = d.hiddenCalendars();
      const names = new Map(d.calendars().map((c) => [c.id, c.name]));
      const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const complete = await d.ensureRange(from, rangeEnd);
      const all = d.events();
      const label = localDate(from) === localDate(to) ? dayLabel(from) : `${dayLabel(from)} to ${dayLabel(to)}`;
      useAssistant.getState().push({ kind: "step", text: `Read the calendar for ${label}` });

      const hits = all
        .filter((e) => !hidden.has(e.calendarId))
        .filter((e) => {
          const s = new Date(e.start);
          const en = new Date(e.end);
          if (Number.isNaN(s.getTime())) return false;
          return s < rangeEnd && (en > from || (s >= from && en.getTime() <= s.getTime()));
        })
        .filter((e) => !q || [e.title, e.location ?? "", ...e.attendees.map((a) => a.name || a.address)].some((t) => t.toLowerCase().includes(q)))
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      const shown = hits.slice(0, MAX_EVENTS);


      return {
        events: shown.map((e) => {
          const who = e.attendees.slice(0, 8).map((a) => a.name || a.address);
          if (e.attendees.length > 8) who.push(`+${e.attendees.length - 8} more`);
          return {
            id: e.id,
            title: e.title,
            start: e.start,
            end: e.end,
            all_day: !!e.allDay,
            calendar: names.get(e.calendarId) ?? e.calendarId,
            ...(e.location ? { location: e.location } : {}),
            ...(e.joinUrl || e.video ? { join: true } : {}),
            attendees: who,
          };
        }),
        ...(hits.length > shown.length ? { truncated: `Showing ${shown.length} of ${hits.length}` } : {}),
        ...(complete ? {} : { note: "A calendar couldn't be read for this range, so events may be missing." }),
      };
    },

    rsvp: async (args, deps) => {
      const d = extOf<CalendarDeps>(deps, ID);
      const response = args.response as Rsvp;
      if (!RESPONSES.includes(response)) throw new Error("bad_query: response must be accepted, tentative or declined");
      const ev = knownEvent(args, d);
      const v = VERB[response];
      pushConfirmCard({
        module: ID,
        action: "rsvp",
        title: `${v.word} “${ev.title}”`,
        detail: eventDetail(ev),
        preview: { fields: [{ label: "Reply", value: v.label }] },
        payload: { eventId: ev.id, response },
        confirmLabel: v.label,
      });
      return AWAITING;
    },

    delete_event: async (args, deps) => {
      const d = extOf<CalendarDeps>(deps, ID);
      const ev = knownEvent(args, d);
      pushConfirmCard({
        module: ID,
        action: "delete",
        title: `Delete “${ev.title}”`,
        detail: eventDetail(ev),
        payload: { eventId: ev.id },
        confirmLabel: "Delete event",
      });
      return AWAITING;
    },

    invite: async (args, deps) => {
      const d = extOf<CalendarDeps>(deps, ID);
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) throw new Error("bad_query: invite needs a title");
      const allDay = args.all_day === true;
      const start = parseDateTime(args.start, "start", allDay);
      const end = parseDateTime(args.end, "end", allDay);
      if (end <= start) throw new Error("bad_query: end must be after start");
      if (!Array.isArray(args.attendees) || args.attendees.length === 0) throw new Error("bad_query: attendees must be a non-empty list of email addresses");
      const attendees = args.attendees.map((a) => (typeof a === "string" ? a.trim() : ""));
      const bad = attendees.find((a) => !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(a));
      if (bad !== undefined) throw new Error(`bad_query: "${bad}" is not an email address`);
      const videoArg = args.video === undefined || args.video === "" ? "none" : String(args.video);
      if (!VIDEOS.includes(videoArg)) throw new Error("bad_query: video must be teams, meet, zoom or none");

      const cals = d.calendars();
      let cal: CalendarInfo | undefined;
      if (typeof args.calendar === "string" && args.calendar.trim()) {
        const want = args.calendar.trim().toLowerCase();
        cal = cals.find((c) => c.id === args.calendar) ?? cals.find((c) => c.name.toLowerCase() === want);
        if (!cal) throw new Error(`bad_query: no calendar "${args.calendar}"`);
      } else {
        const id = d.defaultCalendarId();
        cal = cals.find((c) => c.id === id);
        if (!cal) throw new Error("bad_query: no calendar is available to add the event to");
      }
      const video = videoArg === "none" ? null : (videoArg as Video);
      const problem = videoProblem(video, cal, d);
      if (problem) throw new Error(`bad_query: ${problem}; video can be ${[...d.nativeVideo(cal.accountId), "zoom", "none"].join(", ").replace(/, (\w+)$/, " or $1")}`);

      const location = typeof args.location === "string" && args.location.trim() ? args.location.trim() : undefined;
      const notes = typeof args.notes === "string" && args.notes.trim() ? args.notes.trim() : undefined;
      const startIso = localIso(start);
      const endIso = localIso(end);
      const fields = [
        { label: "When", value: whenLabel(startIso, endIso, allDay) },
        { label: "Calendar", value: cal.name },
        { label: "Attendees", value: attendees.join(", ") },
        { label: "Video", value: video ? VIDEO_NAME[video] : "None" },
        ...(location ? [{ label: "Location", value: location }] : []),
      ];
      const input: NewEventInput = {
        calendarId: cal.id,
        title,
        start: startIso,
        end: endIso,
        allDay,
        location,
        description: notes,
        attendees,
        video,
      };
      pushConfirmCard({
        module: ID,
        action: "invite",
        title: `Invite: ${title}`,
        detail: fields[0].value,
        preview: { fields, body: notes },
        payload: input,
        confirmLabel: "Send invite",
      });
      return AWAITING;
    },
  },
  confirm: {
    rsvp: async (payload, deps) => {
      const d = extOf<CalendarDeps>(deps, ID);
      const { eventId, response } = payload as { eventId: string; response: Rsvp };
      const ev = d.events().find((e) => e.id === eventId);
      if (!ev) throw new Error("That event is no longer on the calendar.");
      await d.respondEvent(ev, response);
      return VERB[response].done;
    },
    delete: async (payload, deps) => {
      const d = extOf<CalendarDeps>(deps, ID);
      await d.deleteEvent((payload as { eventId: string }).eventId);
      return "Deleted";
    },
    invite: async (payload, deps) => {
      const d = extOf<CalendarDeps>(deps, ID);
      const input = payload as NewEventInput;
      // The calendar's account may have been reconnected since the card was made.
      const cal = d.calendars().find((c) => c.id === input.calendarId);
      const problem = cal && videoProblem(input.video ?? null, cal, d);
      if (problem) throw new Error(`${problem}. Ask again to pick another option.`);
      // Providers expect UTC; the card payload holds local wall-clock strings (or UTC from older cards).
      await d.createEvent({ ...input, start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString() });
      const n = input.attendees?.length ?? 0;
      return `Invite sent to ${n} ${n === 1 ? "person" : "people"}`;
    },
  },
  realDeps: (): CalendarDeps => ({
    events: () => useMail.getState().events,
    ensureRange: (from, to) => ensureEventRange(from, to),
    calendars: () => useMail.getState().calendars,
    hiddenCalendars: () => useMail.getState().hiddenCalendars,
    defaultCalendarId: () => {
      const s = useMail.getState();
      const first = s.accounts[0];
      return first ? defaultCalendarFor(s, first.id) : "";
    },
    respondEvent: (e, r) => useMail.getState().respondEvent(e, r),
    deleteEvent: (id) => useMail.getState().deleteEvent(id),
    createEvent: (e) => useMail.getState().createEvent(e),
    // Demo calendars (no provider) can preview either, as in the new-event dialog.
    nativeVideo: (accountId) => calendarProvider(accountId)?.nativeVideo ?? ["meet", "teams"],
  }),
};
