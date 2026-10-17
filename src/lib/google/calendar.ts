// Google Calendar API provider.

import type { CalEvent, CalendarInfo } from "@/lib/types";
import type { CalendarProvider, NewEvent, Rsvp } from "@/lib/calendar/provider";
import { request, type Method } from "@/lib/transport";
import { accessToken } from "@/lib/oauth";
import { calendarToInfo, eventToCal, withResponse, type GCalendar, type GEvent } from "./calendar-map";
import { pool } from "./gmail";
import { localDate } from "@/lib/ai/dates";

const API = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendarProvider implements CalendarProvider {
  readonly nativeVideo = ["meet" as const];
  private raw = new Map<string, GEvent>(); // zMail event id → Google event

  constructor(readonly accountId: string) {}

  private async api<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const token = await accessToken(this.accountId);
    return request<T>(method, `${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, body });
  }

  /** Google calendar id from a zMail calendar id ("acct:primary" → "primary"). */
  private gid(calendarId: string) {
    return calendarId.slice(this.accountId.length + 1);
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const res = await this.api<{ items: GCalendar[] }>("GET", "/users/me/calendarList?minAccessRole=reader");
    return res.items.map((c) => calendarToInfo(this.accountId, c));
  }

  async listEvents(calendarIds: string[], from: Date, to: Date): Promise<CalEvent[]> {
    const lists = await pool(calendarIds, 4, async (cid) => {
      const q = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      });
      const items: GEvent[] = [];
      let pageToken: string | undefined;
      do {
        if (pageToken) q.set("pageToken", pageToken);
        const res = await this.api<{ items: GEvent[]; nextPageToken?: string }>(
          "GET",
          `/calendars/${encodeURIComponent(this.gid(cid))}/events?${q}`,
        );
        items.push(...res.items);
        pageToken = res.nextPageToken;
      } while (pageToken && items.length < 2500);
      return items.map((e) => {
        const ev = eventToCal(cid, e);
        if (ev) this.raw.set(ev.id, e);
        return ev;
      });
    });
    return lists.flat().filter((e): e is CalEvent => !!e);
  }

  async createEvent(e: NewEvent): Promise<CalEvent> {
    const body = {
      summary: e.title,
      location: e.location,
      description: e.description,
      ...(e.allDay
        ? { start: { date: localDate(new Date(e.start)) }, end: { date: localDate(new Date(e.end)) } }
        : { start: { dateTime: e.start }, end: { dateTime: e.end } }),
      attendees: e.attendees?.map((email) => ({ email })),
      ...(e.video === "meet"
        ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
        : {}),
    };
    const created = await this.api<GEvent>(
      "POST",
      `/calendars/${encodeURIComponent(this.gid(e.calendarId))}/events?conferenceDataVersion=1&sendUpdates=all`,
      body,
    );
    const ev = eventToCal(e.calendarId, created)!;
    this.raw.set(ev.id, created);
    return ev;
  }

  async respond(event: CalEvent, response: Rsvp) {
    const g = this.raw.get(event.id);
    if (!g) throw new Error("Refresh the calendar and try again.");
    if (!g.attendees?.some((a) => a.self))
      throw new Error("You were invited through a group or alias — respond in Google Calendar for this one.");
    await this.api("PATCH", `/calendars/${encodeURIComponent(this.gid(event.calendarId))}/events/${g.id}?sendUpdates=all`, {
      attendees: withResponse(g, response),
    });
  }

  async deleteEvent(event: CalEvent) {
    const g = this.raw.get(event.id);
    if (!g) return;
    await this.api("DELETE", `/calendars/${encodeURIComponent(this.gid(event.calendarId))}/events/${g.id}?sendUpdates=all`);
  }
}
