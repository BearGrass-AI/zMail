// Scheduled send: what's waiting, the Send later presets, and which are due.

/** Outlook can hold a scheduled email on the server (PidTagDeferredSendTime). Off until cancelling it is verified on a real mailbox. */
export const OUTLOOK_SERVER_HOLD = false;

export interface ScheduledSend {
  /** Same as draftId. */
  id: string;
  accountId: string;
  draftId: string;
  /** The draft's message id (Gmail's differs from the draft id; Outlook's is the same). */
  messageId: string;
  sendAt: number;
  subject: string;
  /** Display names or addresses. */
  to: string[];
  snippet: string;
  /** True: the server sends it (Outlook hold). False: zMail sends the draft at sendAt. */
  server: boolean;
  createdAt: number;
  /** Last failed attempt (local sends only). */
  error?: string;
  lastTry?: number;
  /** Open in the composer: the scheduler waits until the composer schedules, sends or closes it. */
  editing?: boolean;
  /** A copy of zMail is sending it: `by` is that copy's INSTANCE_ID (several copies share the saved list). */
  claim?: { by: string; at: number };
}

export const RETRY_MS = 5 * 60_000;
export const LATE_MS = 2 * 60_000;
/** A claim older than this is from a copy that quit or crashed mid-send: it can be taken over. */
export const CLAIM_MS = 3 * 60_000;
/** This process, in send claims. */
export const INSTANCE_ID = crypto.randomUUID();

/** Another copy of zMail claimed it less than CLAIM_MS ago. */
export function claimedElsewhere(r: ScheduledSend, now: number) {
  return !!r.claim && r.claim.by !== INSTANCE_ID && now - r.claim.at < CLAIM_MS;
}

const DAY_MS = 24 * 3600 * 1000;
const YEAR_MS = 366 * DAY_MS;

const timeText = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const weekday = (d: Date) => d.toLocaleDateString([], { weekday: "short" });
const monthDay = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });

/** Calendar days from `now` to `at` (0 = same day), by local midnight. */
function daysAhead(at: Date, now: Date) {
  const a = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

/** `days` after `now`'s date, at h:00 local. */
function dayAt(now: Date, days: number, h: number) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, 0, 0, 0);
}

/** The Send later presets for `now`, each with a short hint of when it lands. */
export function sendLaterTimes(now = new Date()): { label: string; hint: string; at: Date }[] {
  const hint = (at: Date) => {
    const days = daysAhead(at, now);
    if (days === 0) return timeText(at);
    if (days > 0 && days <= 6) return `${weekday(at)} ${timeText(at)}`;
    return `${monthDay(at)}, ${timeText(at)}`;
  };
  const out: { label: string; at: Date }[] = [];
  // Three hours out, rounded up to the next :00 or :30.
  const later = new Date(now.getTime() + 3 * 3600 * 1000);
  const extra = later.getMinutes() % 30 || later.getSeconds() || later.getMilliseconds() ? 30 - (later.getMinutes() % 30) : 0;
  later.setMinutes(later.getMinutes() + extra, 0, 0);
  if (daysAhead(later, now) === 0 && later < dayAt(now, 0, 21)) out.push({ label: "Later today", at: later });
  out.push({ label: "Tomorrow morning", at: dayAt(now, 1, 8) });
  out.push({ label: "Tomorrow afternoon", at: dayAt(now, 1, 13) });
  // Next Monday (a week out on a Monday); tomorrow's Monday is already "Tomorrow morning".
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday !== 1) out.push({ label: "Monday morning", at: dayAt(now, toMonday, 8) });
  return out.map((t) => ({ ...t, hint: hint(t.at) }));
}

/** "Today 4:30 PM", "Tomorrow 8:00 AM", "Wed 8:00 AM" (within 6 days), else "Oct 19, 8:00 AM". */
export function whenLabel(at: number, now = Date.now()) {
  const d = new Date(at);
  const days = daysAhead(d, new Date(now));
  if (days === 0) return `Today ${timeText(d)}`;
  if (days === 1) return `Tomorrow ${timeText(d)}`;
  if (days > 1 && days <= 6) return `${weekday(d)} ${timeText(d)}`;
  return `${monthDay(d)}, ${timeText(d)}`;
}

/** "Wed, Oct 14 at 8:00 AM". */
export function longWhen(at: number) {
  const d = new Date(at);
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${timeText(d)}`;
}

/** Local sends that are due now, oldest first; a failed one waits RETRY_MS before the next try, and one being edited waits. */
export function dueNow(list: ScheduledSend[], now: number): ScheduledSend[] {
  return list.filter((s) => !s.server && !s.editing && s.sendAt <= now && (!s.lastTry || now - s.lastTry >= RETRY_MS)).sort((a, b) => a.sendAt - b.sendAt);
}

/** At least a minute out and under a year away. */
export function validSendAt(at: number, now: number) {
  return at > now + 60_000 && at < now + YEAR_MS;
}
