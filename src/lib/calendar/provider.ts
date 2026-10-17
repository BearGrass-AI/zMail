// The seam between zMail and a calendar backend (Google Calendar, Outlook).

import type { CalEvent, CalendarInfo } from "@/lib/types";

export type VideoOption = "meet" | "teams" | "zoom";

export interface NewEvent {
  calendarId: string;
  title: string;
  start: string; // ISO
  end: string; // ISO
  /** Whole day(s): start is local midnight, end is the next day's midnight. */
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  /** Native video for this provider (Meet on Google, Teams on Outlook). Zoom links are added by the caller. */
  video?: VideoOption | null;
}

export type Rsvp = "accepted" | "tentative" | "declined";

export interface CalendarProvider {
  readonly accountId: string;
  /** Video options this backend can create natively. */
  readonly nativeVideo: VideoOption[];
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(calendarIds: string[], from: Date, to: Date): Promise<CalEvent[]>;
  createEvent(e: NewEvent): Promise<CalEvent>;
  respond(event: CalEvent, response: Rsvp): Promise<void>;
  deleteEvent(event: CalEvent): Promise<void>;
}
