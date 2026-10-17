// Pure Google Calendar API ↔ zMail mapping.

import type { CalEvent, CalendarInfo, Contact } from "@/lib/types";

export interface GCalendar {
  id: string;
  summary: string;
  backgroundColor?: string;
  primary?: boolean;
  accessRole?: string;
}

export interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { email: string; displayName?: string; self?: boolean; responseStatus?: string; organizer?: boolean }[];
  organizer?: { email: string; displayName?: string; self?: boolean };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] };
}

/** Hue (0–360) from a #rrggbb color. */
export function hexToHue(hex: string | undefined, fallback = 255): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  if (!m) return fallback;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return fallback;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

export function calendarToInfo(accountId: string, c: GCalendar): CalendarInfo {
  return { id: `${accountId}:${c.id}`, accountId, name: c.summary, source: "google", hue: hexToHue(c.backgroundColor), ...(c.primary ? { primary: true } : {}) };
}

export function joinUrl(e: GEvent): string | undefined {
  return e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
}

export function eventToCal(calendarId: string, e: GEvent): CalEvent | null {
  if (e.status === "cancelled") return null;
  const start = e.start.dateTime ?? (e.start.date ? `${e.start.date}T00:00:00` : undefined);
  const end = e.end.dateTime ?? (e.end.date ? `${e.end.date}T00:00:00` : undefined);
  if (!start || !end) return null;
  const others = (e.attendees ?? []).filter((a) => !a.self);
  const attendees: Contact[] = others.map((a) => ({ name: a.displayName ?? a.email, address: a.email.toLowerCase() }));
  const organizer = e.organizer && !e.organizer.self ? e.organizer.email.toLowerCase() : undefined;
  return {
    id: `${calendarId}:${e.id}`,
    calendarId,
    title: e.summary ?? "(no title)",
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    location: e.location,
    video: !!joinUrl(e),
    joinUrl: joinUrl(e),
    attendees,
    allDay: !e.start.dateTime,
    // Tie the meeting to mail from its organizer.
    related: organizer ? { from: organizer } : undefined,
  };
}

/** Attendee list with the current user's response changed (for RSVP). */
export function withResponse(e: GEvent, response: "accepted" | "tentative" | "declined") {
  return (e.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: response } : a));
}
