// Which emails are worth sending to the writing model for a date check.
// Cheap local rules first, so marketing and old mail never reach the model.

import { mentionsDate } from "@/lib/ai/dates";
import type { Category, Email } from "@/lib/types";

const MAX_AGE = 30 * 864e5;
const SECTION_MAX_AGE = 90 * 864e5;

export interface DateCandidateCtx {
  inbox: boolean;
  category?: Category;
  section?: { dates?: boolean } | null;
  noDateSenders: Record<string, true>;
  everywhere: boolean;
  now: number;
}

export function isDateCandidate(e: Email, ctx: DateCandidateCtx): boolean {
  if (!ctx.inbox || e.partial) return false;
  const offSender = Object.hasOwn(ctx.noDateSenders, e.from.address.toLowerCase());
  // NaN (unparsable date) fails both age checks.
  const age = ctx.now - Date.parse(e.date);
  if (ctx.section) return !!ctx.section.dates && !offSender && age <= SECTION_MAX_AGE;
  if (!ctx.everywhere) return false;
  if (!ctx.category) return false; // not sorted yet: wait, so promos never reach the model
  if (ctx.category === "promotions" || ctx.category === "newsletters") return false;
  if (offSender) return false;
  if (!(age <= MAX_AGE)) return false;
  return mentionsDate(`${e.subject} ${e.text.slice(0, 5000)}`);
}
