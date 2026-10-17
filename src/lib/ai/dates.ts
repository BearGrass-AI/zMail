// Pulls due dates and events out of an email with the writing model, for
// sections that have "catch dates" on. The decision model can't do this: it
// only answers choice, yes/no and score questions.

import type { CalSuggestion, Email } from "@/lib/types";
import type { GenerativeProvider } from "./generative";
import { localDate } from "@/lib/dates/local";

export interface DateFind {
  title: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** 24-hour HH:MM, when the email gives a time. */
  time?: string;
  kind: "due" | "deadline" | "event";
  /** The phrase in the email the date came from. */
  quote: string;
}

export { localDate };

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_MENTIONS: RegExp[] = [
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "i"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "i"),
  /(?<![\d.])\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?(?![\d.])/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b/i,
  /\b(?:today|tonight|tomorrow)\b/i,
  /\b(?:this|next) (?:week|month)\b/i,
  /\b\d{1,2}(?:st|nd|rd|th)\b/i,
  /\b(?:eod|end of (?:the )?(?:day|week|month))\b/i,
  /\bin (?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few) (?:days?|weeks?)\b/i,
  /\b\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?(?!\d)/i,
  /\b\d{1,2}\s*[ap]\.?m\b/i,
];

/** Cheap local check: does this text mention a date or time at all? */
export function mentionsDate(text: string): boolean {
  return DATE_MENTIONS.some((re) => re.test(text));
}

export function datesPrompt(email: Email, section?: string, today = new Date()) {
  const day = today.toLocaleDateString("en-US", { weekday: "long" });
  const where = section ? ` This email is in the user's "${section}" section.` : "";
  return `Today is ${day}, ${localDate(today)}.${where}

List the dates in it that the user needs to act on or show up for, for their calendar.

Keep: bills and payments due, deadlines (forms, sign-ups, permission slips, renewals the user must act on), appointments, reservations, travel, school, family and community events, RSVPs and closures. Also keep deadlines and asks from people, such as "can you send the slides by Friday?", "need your sign-off by EOD tomorrow" or "please review before the 15th".

Ignore: marketing and sales dates (sale or offer ends, "Prime Day", product launches, webinar or event pitches from companies selling something, "limited time", shipping estimates, newsletter publication dates), dates in the past, the date the email was sent, and vague dates with no specific day.

When unsure whether a date is marketing, leave it out.

Resolve relative dates ("Friday", "tomorrow", "next week", "the 15th") against the email's sent date (shown below), not today's date. Label them clearly, e.g. "Slides to Jen due".

Reply with only a JSON array, no prose. Each item:
{"title": "<short calendar title, e.g. Chase Visa payment due, Slides to Jen due or Field trip: Museum of the Rockies>", "date": "YYYY-MM-DD", "time": "HH:MM" or null, "kind": "due" | "deadline" | "event", "quote": "<the exact short phrase from the email>"}
Reply [] if there are none.

From: ${email.from.name} <${email.from.address}>
Sent: ${email.date}
Subject: ${email.subject}

${email.text.slice(0, 5000)}`;
}

/** A 24-hour "HH:MM". 24:00 or 12:60 isn't a time: Date would roll it into the next hour or day. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar day as "YYYY-MM-DD" (not 2026-02-31). */
const realDay = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && localDate(new Date(`${date}T00:00:00`)) === date;

/** A find that can become a calendar suggestion; saved finds from before times were checked may not be. */
export const usableFind = (f: DateFind) => realDay(f.date) && (f.time === undefined || TIME.test(f.time));

/** Tolerant parse of the model's reply: keeps well-formed, upcoming dates only. */
export function parseDates(raw: string, today = new Date()): DateFind[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let items: unknown;
  try {
    items = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const todayKey = localDate(today);
  const limit = new Date(today);
  limit.setFullYear(limit.getFullYear() + 1);
  const seen = new Set<string>();
  const out: DateFind[] = [];
  for (const it of items as Record<string, unknown>[]) {
    if (!it || typeof it !== "object") continue;
    const date = typeof it.date === "string" ? it.date.trim() : "";
    const title = typeof it.title === "string" ? it.title.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) continue;
    const d = new Date(`${date}T00:00:00`);
    if (Number.isNaN(d.getTime()) || localDate(d) !== date) continue; // e.g. 2026-02-31
    if (date < todayKey || d > limit) continue;
    const time = typeof it.time === "string" && /^\d{1,2}:\d{2}$/.test(it.time.trim()) ? it.time.trim().padStart(5, "0") : undefined;
    // An impossible time means the model misread the email; drop the find rather than guess.
    if (time && !TIME.test(time)) continue;
    const kind = it.kind === "due" || it.kind === "deadline" || it.kind === "event" ? it.kind : time ? "event" : "deadline";
    const key = `${date}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title.slice(0, 120), date, time, kind, quote: typeof it.quote === "string" ? it.quote.trim().slice(0, 200) : "" });
  }
  return out.slice(0, 6);
}

export async function extractDates(p: GenerativeProvider, email: Email, section?: string): Promise<DateFind[]> {
  const raw = await p.complete(
    [
      { role: "system", content: "You extract calendar dates from email. Reply with JSON only. Never invent dates that are not in the email." },
      { role: "user", content: datesPrompt(email, section) },
    ],
    { maxTokens: 500 },
  );
  return parseDates(raw);
}

const LABELS: Record<DateFind["kind"], string> = { due: "payment due", deadline: "deadline", event: "event" };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32);

/** A calendar suggestion for one find; all-day unless the email gave a time. */
export function findToSuggestion(f: DateFind, email: Email, sectionId: string | undefined, calendarId: string): CalSuggestion {
  let start: Date;
  let end: Date;
  if (f.time) {
    start = new Date(`${f.date}T${f.time}:00`);
    end = new Date(start.getTime() + 36e5);
  } else {
    start = new Date(`${f.date}T00:00:00`);
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  }
  return {
    id: `x-${email.id}-${f.date}-${slug(f.title)}`,
    kind: "extracted",
    title: f.title,
    detail: `From ${email.from.name}: ${email.subject}`,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: !f.time,
    calendarId,
    emailId: email.id,
    sectionId,
    label: LABELS[f.kind],
    quote: f.quote,
  };
}
