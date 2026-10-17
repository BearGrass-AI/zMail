// Seeded calendars for the prototype, positioned relative to the current week
// so "today" always has a realistic schedule. Real data comes from Google
// Calendar (Gmail account) and Microsoft Graph (M365) later.

import type { CalEvent, CalSuggestion, CalendarInfo, Contact } from "@/lib/types";

export const CALENDARS: CalendarInfo[] = [
  { id: "cal-work", accountId: "work", name: "Work (Outlook)", source: "outlook", hue: 255 },
  { id: "cal-personal", accountId: "personal", name: "Personal (Google)", source: "google", hue: 75 },
  { id: "cal-family", accountId: "personal", name: "Family", source: "google", hue: 155 },
];

const p = (name: string, address: string): Contact => ({ name, address });
const SARAH = p("Sarah Kim", "sarah.kim@example.org");
const DANA = p("Dana Whitfield", "dana.whitfield@example.org");
const JEN = p("Jen Alvarez", "jen.alvarez@example.org");
const PROVOST = p("Office of the Provost", "provost@example.org");

export function startOfWeek(d = new Date()) {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

function at(day: Date, h: number, min = 0) {
  const d = new Date(day);
  d.setHours(h, min, 0, 0);
  return d.toISOString();
}

let seq = 0;
function ev(day: Date, h: number, m: number, mins: number, e: Omit<CalEvent, "id" | "start" | "end">): CalEvent {
  const start = at(day, h, m);
  return { id: `ev${++seq}`, start, end: new Date(Date.parse(start) + mins * 60000).toISOString(), ...e };
}

export function seedCalendar(now = new Date()) {
  seq = 0;
  const monday = startOfWeek(now);
  const todayIdx = (now.getDay() + 6) % 7;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  /** Day `i` of this week, nudged off today so today's schedule stays curated. */
  const day = (i: number) => {
    const idx = i === todayIdx ? (i + 1) % 7 : i;
    const d = new Date(monday);
    d.setDate(monday.getDate() + idx);
    return d;
  };

  const events: CalEvent[] = [];
  // Daily standup, weekdays, this week and next.
  for (const i of [0, 1, 2, 3, 4, 7, 8, 9, 10, 11]) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    events.push(ev(d, 9, 0, 30, { calendarId: "cal-work", title: "Cabinet standup", attendees: [], hue: 295, video: true }));
  }

  // Today.
  events.push(
    ev(today, 10, 30, 45, {
      calendarId: "cal-work", title: "Banner go/no-go", attendees: [SARAH], hue: 20, video: true,
      related: { from: SARAH.address },
    }),
    ev(today, 12, 0, 60, {
      calendarId: "cal-work", title: "Lunch · Dana", location: "Campus Commons", attendees: [DANA], hue: 155,
      related: { from: DANA.address },
    }),
    ev(today, 14, 0, 60, {
      calendarId: "cal-work", title: "Deans & Directors", location: "Admin Building 210", attendees: [PROVOST],
      related: { from: PROVOST.address, subject: "Deans & Directors" },
    }),
    ev(today, 16, 30, 120, { calendarId: "cal-personal", title: "Golf · Pine Hollow", location: "Pine Hollow GC", attendees: [] }),
  );

  // Rest of the week.
  events.push(
    ev(day(0), 11, 0, 90, {
      calendarId: "cal-work", title: "Budget review", location: "Budget Office", attendees: [],
      related: { from: "budget@example.org" },
    }),
    ev(day(1), 13, 0, 60, {
      calendarId: "cal-work", title: "Vendor call · Dell", attendees: [], video: true,
      related: { from: "mark.ellis@dell.com" },
    }),
    ev(day(2), 10, 0, 120, {
      calendarId: "cal-work", title: "IT Security briefing", attendees: [], hue: 210,
      related: { from: "infosec@example.org" },
    }),
    ev(day(2), 16, 30, 60, { calendarId: "cal-family", title: "Kids · soccer", attendees: [] }),
    ev(day(3), 12, 0, 60, {
      calendarId: "cal-work", title: "Trustees prep", attendees: [JEN],
      related: { from: JEN.address },
    }),
  );

  const nextMon = new Date(monday);
  nextMon.setDate(monday.getDate() + 7);
  events.push(
    ev(nextMon, 10, 0, 120, {
      calendarId: "cal-work", title: "Board of Trustees", location: "Library Conference Room", attendees: [JEN], hue: 18,
      related: { from: JEN.address },
    }),
    ev(nextMon, 13, 30, 60, { calendarId: "cal-work", title: "1:1 · Provost", attendees: [PROVOST] }),
  );

  const nextTue = new Date(monday);
  nextTue.setDate(monday.getDate() + 8);
  const flight = new Date(monday);
  flight.setDate(monday.getDate() + 9);
  // Next open afternoon slot: today if it's before 3 PM, otherwise tomorrow.
  const prep = new Date(today);
  if (now.getHours() >= 15) prep.setDate(prep.getDate() + 1);

  const suggestions: CalSuggestion[] = [
    {
      id: "sug-invite", kind: "invite", title: "AI Governance working group",
      detail: "Invite from the Provost · you're free then",
      start: at(nextTue, 15), end: at(nextTue, 16), calendarId: "cal-work",
      emailSubject: "Invitation: AI Governance working group",
    },
    {
      id: "sug-flight", kind: "extracted", title: "DEN → SFO · Delta",
      detail: "Found in email · confirmation GX7TQ2",
      start: at(flight, 6, 5), end: at(flight, 8, 40), calendarId: "cal-personal",
      emailSubject: "Your trip confirmation: DEN → SFO",
    },
    {
      id: "sug-block", kind: "block", title: "Prep: Trustees slides",
      detail: "Due Monday and Monday is packed. Block an hour to prep?",
      start: at(prep, 15), end: at(prep, 16), calendarId: "cal-work",
      emailSubject: "Board of Trustees slides — your section",
    },
  ];

  return { events, suggestions };
}
