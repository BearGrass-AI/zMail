// Outlook calendar via Microsoft Graph (calendarView in UTC, Teams meetings).

import type { CalEvent, CalendarInfo } from "@/lib/types";
import type { CalendarProvider, NewEvent, Rsvp } from "@/lib/calendar/provider";
import { pool } from "@/lib/google/gmail";
import { graph } from "./graph";
import { calendarToInfo, eventToCal, type GCalEvent, type GCalendarInfo } from "./graph-map";
import { localDate } from "@/lib/ai/dates";

const UTC = { Prefer: 'outlook.timezone="UTC"' };

export class OutlookCalendarProvider implements CalendarProvider {
  readonly nativeVideo = ["teams" as const];
  private raw = new Map<string, string>(); // zMail event id → Graph event id

  constructor(readonly accountId: string) {}

  private gid(calendarId: string) {
    return calendarId.slice(this.accountId.length + 1);
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const res = await graph<{ value: GCalendarInfo[] }>(this.accountId, "GET", "/me/calendars?$select=id,name,hexColor,isDefaultCalendar");
    return res.value.map((c) => calendarToInfo(this.accountId, c));
  }

  async listEvents(calendarIds: string[], from: Date, to: Date): Promise<CalEvent[]> {
    const select = "$select=id,subject,isCancelled,isAllDay,start,end,location,attendees,organizer,isOrganizer,isOnlineMeeting,onlineMeeting&$top=250";
    const lists = await pool(calendarIds, 4, async (cid) => {
      const q = `startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&${select}`;
      const items: GCalEvent[] = [];
      let next: string | undefined = `/me/calendars/${this.gid(cid)}/calendarView?${q}`;
      while (next && items.length < 2500) {
        const page: { value: GCalEvent[]; "@odata.nextLink"?: string } = await graph(this.accountId, "GET", next, undefined, UTC);
        items.push(...page.value);
        next = page["@odata.nextLink"];
      }
      return items.map((e) => {
        const ev = eventToCal(cid, e);
        if (ev) this.raw.set(ev.id, e.id);
        return ev;
      });
    });
    return lists.flat().filter((e): e is CalEvent => !!e);
  }

  async createEvent(e: NewEvent): Promise<CalEvent> {
    const created = await graph<GCalEvent>(
      this.accountId,
      "POST",
      `/me/calendars/${this.gid(e.calendarId)}/events`,
      {
        subject: e.title,
        body: e.description ? { contentType: "Text", content: e.description } : undefined,
        ...(e.allDay
          ? {
              // Outlook wants all-day events at midnight in a named time zone.
              isAllDay: true,
              start: { dateTime: `${localDate(new Date(e.start))}T00:00:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
              end: { dateTime: `${localDate(new Date(e.end))}T00:00:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            }
          : {
              start: { dateTime: e.start.replace(/Z$/, ""), timeZone: "UTC" },
              end: { dateTime: e.end.replace(/Z$/, ""), timeZone: "UTC" },
            }),
        location: e.location ? { displayName: e.location } : undefined,
        attendees: (e.attendees ?? []).map((address) => ({ emailAddress: { address }, type: "required" })),
        ...(e.video === "teams" ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
      },
      UTC,
    );
    const ev = eventToCal(e.calendarId, created)!;
    this.raw.set(ev.id, created.id);
    return ev;
  }

  async respond(event: CalEvent, response: Rsvp) {
    const id = this.raw.get(event.id);
    if (!id) throw new Error("Refresh the calendar and try again.");
    const action = response === "accepted" ? "accept" : response === "tentative" ? "tentativelyAccept" : "decline";
    await graph(this.accountId, "POST", `/me/events/${id}/${action}`, { sendResponse: true });
  }

  async deleteEvent(event: CalEvent) {
    const id = this.raw.get(event.id);
    if (id) await graph(this.accountId, "DELETE", `/me/events/${id}`);
  }
}
