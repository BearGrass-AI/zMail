// Your own sections (Bills, Kids' school…): extra groups on Today and Triage
// that the decision model sorts mail into, alongside the three buckets.

import type { Question } from "@/lib/ai/decision";
import type { SenderHabit } from "@/lib/types";

export const SECTION_ICONS = [
  "credit-card",
  "school",
  "home",
  "plane",
  "heart",
  "briefcase",
  "users",
  "trophy",
  "stethoscope",
  "shopping",
] as const;
export type SectionIcon = (typeof SECTION_ICONS)[number];

export interface MailSection {
  id: string;
  name: string;
  /** Plain English; this is the criteria text the decision model reads. */
  description: string;
  icon: SectionIcon;
  hue: number;
  /** Linked label/folder: its mail teaches the model, and archiving files there. */
  folderId?: string;
  /** Accounts this section sorts; empty = all. */
  accountIds: string[];
  /** Pull due dates and events out of its mail and suggest calendar events. */
  dates: boolean;
  /** Its urgent mail also shows in Needs you. Off (absent): it stays in the section, flagged at the top. */
  urgentInNeedsYou?: boolean;
}

export const SECTION_PRESETS: Omit<MailSection, "id" | "accountIds" | "folderId">[] = [
  {
    name: "Bills",
    description:
      "Credit card statements, utility and phone bills, loan, rent and insurance payments, anything saying a payment is due or was received.",
    icon: "credit-card",
    hue: 150,
    dates: true,
  },
  {
    name: "School",
    description: "Email from my kids' teachers, school or district: classroom updates, field trips, permission slips, events and closures.",
    icon: "school",
    hue: 70,
    dates: true,
  },
  {
    name: "Travel",
    description: "Flight, hotel, rental car and train bookings, itineraries, check-in reminders and trip changes.",
    icon: "plane",
    hue: 210,
    dates: true,
  },
];

export const NO_SECTION = "none";

/** Sections that sort this account's mail. */
export function sectionsFor(sections: MailSection[], accountId: string) {
  return sections.filter((x) => !x.accountIds.length || x.accountIds.includes(accountId));
}

/**
 * Fingerprint of the sections an email was sorted against. When it changes
 * (a section is added or reworded) the email can be re-sorted into it.
 */
export function sectionsKey(sections: MailSection[], accountId: string) {
  const list = sectionsFor(sections, accountId);
  if (!list.length) return "";
  let h = 0;
  for (const c of list.map((x) => `${x.id}:${x.name}:${x.description}`).join("|")) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h).toString(36);
}

/** The extra choice question; undefined when no section applies. */
export function sectionQuestion(sections: MailSection[], maxOptions: number): Question | undefined {
  if (!sections.length) return undefined;
  return {
    type: "choice",
    instructions:
      "The user has their own sections for certain kinds of mail. Which one does this email belong in? Choose none unless it clearly fits a section's description. section_history shows this sender's emails the user already keeps in a section; treat them as examples of what belongs there, not as a rule for everything this sender sends.",
    criteria: {
      [NO_SECTION]: "None of these sections.",
      ...Object.fromEntries(sections.slice(0, maxOptions - 1).map((x) => [x.id, `"${x.name}": ${x.description}`])),
    },
  };
}

/**
 * What zMail knows about this sender per section: how much of their mail is in
 * its label, and example subjects from the label and from your corrections
 * (so one sender can be both a bill and a promo). Emails you took out of a
 * section show up under "none".
 */
export function sectionHistory(sections: MailSection[], habit: SenderHabit | undefined, examples: Record<string, string[]> = {}) {
  const out: { section: string; section_id: string; sender_emails_in_it?: number; example_subjects?: string[] }[] = [];
  for (const x of sections) {
    const count = x.folderId ? habit?.byFolder[x.folderId] ?? 0 : 0;
    const ex = examples[x.id] ?? [];
    if (!count && !ex.length) continue;
    out.push({ section: x.name, section_id: x.id, ...(count ? { sender_emails_in_it: count } : {}), ...(ex.length ? { example_subjects: ex } : {}) });
  }
  if (examples[NO_SECTION]?.length) out.push({ section: "none of these", section_id: NO_SECTION, example_subjects: examples[NO_SECTION] });
  return out;
}
