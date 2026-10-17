// Lessons: your corrections, kept with enough of each email to keep teaching
// the decision model after the email itself is gone.

import type { Bucket, Category, Email } from "@/lib/types";
import type { SenderExamples } from "@/lib/ai/triage";
import { NO_SECTION, type MailSection } from "@/lib/sections";

/** A correction, kept with enough of the email to teach from on its own. */
export interface Lesson {
  emailId: string;
  /** Lowercased sender address. */
  sender: string;
  subject: string;
  /** When you made the correction. */
  at: number;
  category?: Category;
  /** The bucket you moved it to. */
  bucket?: Bucket;
  /** A section id, or null for "not in a section". */
  section?: string | null;
}

/** Newest corrections kept per sender, for each kind (category, bucket, section). */
export const LESSONS_PER_SENDER = 5;
const SECTION_EXAMPLES = 3;

/** Record corrections as lessons: one per email and kind, the newest few per sender. */
export function learn(
  lessons: Lesson[],
  emails: Email[],
  ids: string[],
  patch: { category: Category } | { bucket: Bucket } | { section: string | null },
): Lesson[] {
  const kind = lessonKind(patch);
  const byId = new Map(emails.map((e) => [e.id, e]));
  const fresh: Lesson[] = [];
  const now = Date.now();
  for (const id of ids) {
    const e = byId.get(id);
    if (e) fresh.push({ emailId: id, sender: e.from.address.toLowerCase(), subject: e.subject, at: now, ...patch });
  }
  const replaced = new Set(fresh.map((l) => l.emailId));
  return capLessons([...fresh, ...lessons.filter((l) => !(replaced.has(l.emailId) && lessonKind(l) === kind))]);
}

function lessonKind(l: Partial<Pick<Lesson, "category" | "bucket" | "section">>) {
  return "category" in l ? "category" : "bucket" in l ? "bucket" : "section";
}

export function capLessons(lessons: Lesson[]) {
  const seen = new Map<string, number>();
  return [...lessons]
    .sort((a, b) => b.at - a.at)
    .filter((l) => {
      const key = `${l.sender}|${lessonKind(l)}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return n <= LESSONS_PER_SENDER;
    });
}

/** Lessons for corrections made before lessons existed (they only stored email ids). */
export function lessonsFromOverrides(
  emails: Email[],
  categories: Record<string, Category>,
  sections: Record<string, string | null>,
  buckets: Record<string, Bucket> = {},
) {
  const byId = new Map(emails.map((e) => [e.id, e]));
  const out: Lesson[] = [];
  const add = (id: string, patch: Partial<Lesson>) => {
    const e = byId.get(id);
    if (e) out.push({ emailId: id, sender: e.from.address.toLowerCase(), subject: e.subject, at: Date.parse(e.date) || 0, ...patch });
  };
  for (const [id, category] of Object.entries(categories)) add(id, { category });
  for (const [id, section] of Object.entries(sections)) add(id, { section });
  for (const [id, bucket] of Object.entries(buckets)) add(id, { bucket });
  return capLessons(out);
}

/**
 * Sender address → examples for the decision model: their emails you
 * corrected (from lessons, so deleted mail still counts) and subjects already
 * in each section's label. Examples, not counts, so a sender can be taught
 * "statements are bills, cash back offers are promos".
 */
export function senderExamples(emails: Email[], lessons: Lesson[], sections: MailSection[] = []) {
  const out = new Map<string, SenderExamples>();
  const entry = (sender: string) => out.get(sender) ?? (out.set(sender, {}), out.get(sender)!);
  for (const l of [...lessons].sort((a, b) => b.at - a.at)) {
    const x = entry(l.sender);
    if (l.category) (x.categories ??= []).push({ subject: l.subject, category: l.category });
    else if (l.bucket) (x.buckets ??= []).push({ subject: l.subject, bucket: l.bucket });
    else if (l.section !== undefined) ((x.sections ??= {})[l.section ?? NO_SECTION] ??= []).push(l.subject);
  }
  const labels = new Map(sections.filter((x) => x.folderId).map((x) => [x.folderId!, x.id]));
  const fromLabel = new Map<string, number>();
  const labelled = emails.filter((e) => labels.has(e.folderId));
  for (const e of labelled.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))) {
    const sectionId = labels.get(e.folderId)!;
    const sender = e.from.address.toLowerCase();
    const key = `${sender}|${sectionId}`;
    if ((fromLabel.get(key) ?? 0) >= SECTION_EXAMPLES) continue;
    fromLabel.set(key, (fromLabel.get(key) ?? 0) + 1);
    const list = ((entry(sender).sections ??= {})[sectionId] ??= []);
    if (!list.includes(e.subject)) list.push(e.subject);
  }
  return out;
}
