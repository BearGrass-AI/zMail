// Banners for new mail zMail sorts into Needs you, and the dock badge. The top half is pure
// rules (unit-tested); the bottom half watches the store and talks to macOS.

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import type { Account, Email } from "@/lib/types";
import { bucketOf, inNeedsYou, isInbox, useMail } from "@/lib/store";
import { isAutoReply } from "@/lib/mail/auto-reply";
import { useSettings, type NotificationPrefs } from "@/lib/settings";
import { kvGet, kvSet } from "@/lib/db";
import {
  notifyDelivered,
  notifyRemove,
  notifyShow,
  notifyStatus,
  notifyTakePending,
  onNotificationOpen,
  type Note,
  type NotifyStatus,
} from "@/lib/notify-native";

/** The store slices the rules read. */
export type NotifySlice = Parameters<typeof isInbox>[0] & Parameters<typeof inNeedsYou>[0] & { emails: Email[] };

export interface QualifyCtx {
  s: NotifySlice;
  prefs: NotificationPrefs;
  /** Your own addresses, lowercased. */
  own: Set<string>;
  /** Mail dated before this (ms) never makes a banner. */
  since: number;
}

// ---- rules ---------------------------------------------------------------------

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Quiet hours suppress banners (they don't defer them). A `from` after `to` wraps midnight. */
export function inQuietHours(q: NotificationPrefs["quiet"], now: Date): boolean {
  if (!q.on) return false;
  const day = now.getDay();
  if ((day === 0 || day === 6) && q.weekends === "all") return true;
  const from = minutes(q.from);
  const to = minutes(q.to);
  if (from === to) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return from > to ? m >= from || m < to : m >= from && m < to;
}

export const ownAddresses = (accounts: Pick<Account, "address">[]) => new Set(accounts.map((a) => a.address.toLowerCase()));

/** Whether this email earns a banner: new, unread, in the inbox, and showing in Needs you (or sorted into Worth a skim when widened). */
export function qualifies(e: Email, { s, prefs, own, since }: QualifyCtx): boolean {
  if (prefs.level === "off" || !e.unread || !isInbox(s, e)) return false;
  if (!inNeedsYou(s, e) && !(bucketOf(s, e.id) === "worth_skim" && prefs.level === "needs_skim")) return false;
  if (prefs.mutedAccounts.includes(e.accountId)) return false;
  if (own.has(e.from.address.toLowerCase())) return false;
  // NaN (an unparseable date) fails too.
  if (!(Date.parse(e.date) >= since)) return false;
  return !isAutoReply(e);
}

const senderName = (e: Email) => e.from.name || e.from.address;

/**
 * One banner per email, or one summary when 4 or more arrive together. `skim` holds the ids
 * sorted into Worth a skim, which get a prefix when the level includes them.
 */
export function planBanners(emails: Email[], prefs: NotificationPrefs, skim: ReadonlySet<string> = new Set()): Note[] {
  if (!emails.length) return [];
  if (emails.length <= 3)
    return emails.map((e) => {
      const subject = e.subject || "(no subject)";
      return {
        id: e.id,
        title: senderName(e),
        subtitle: prefs.level === "needs_skim" && skim.has(e.id) ? `Worth a skim · ${subject}` : subject,
        body: prefs.preview ? e.snippet : undefined,
        thread: e.accountId,
        sound: prefs.sound,
        emailId: e.id,
        accountId: e.accountId,
      };
    });
  const n = emails.length;
  const names = [...new Set(emails.map(senderName))];
  const rest = names.length - 3;
  const subtitle = rest > 0 ? `${names.slice(0, 3).join(", ")} and ${rest} more` : names.join(", ");
  return [
    {
      id: `summary-${Date.now()}`,
      title: prefs.level === "needs_skim" ? `${n} new emails` : `${n} emails need you`,
      subtitle,
      body: prefs.preview ? "Click to see them in zMail" : undefined,
      sound: prefs.sound,
    },
  ];
}

/** The dock number: unread inbox mail showing in Needs you (or all unread) across every account. Undefined clears it. */
export function badgeCount(s: NotifySlice, mode: NotificationPrefs["badge"]): number | undefined {
  if (mode === "none") return undefined;
  let n = 0;
  for (const e of s.emails) if (badged(e, s, mode)) n++;
  return n || undefined;
}

/** Whether `e` counts toward the dock number (with `mode` other than "none"). */
const badged = (e: Email, s: NotifySlice, mode: NotificationPrefs["badge"]) =>
  e.unread && isInbox(s, e) && (mode === "unread" || inNeedsYou(s, e));

const idIndexCache = new WeakMap<Email[], Map<string, Email>>();
/** Emails by id, built once per emails array. */
function idIndex(emails: Email[]): Map<string, Email> {
  let m = idIndexCache.get(emails);
  if (!m) idIndexCache.set(emails, (m = new Map(emails.map((e) => [e.id, e]))));
  return m;
}

// ---- wiring --------------------------------------------------------------------

const NOTIFIED_KEY = "notified.v1";
const NOTIFIED_MAX = 2000;
const FLUSH_MS = 2000;

let started = false;
/** Undoes what startNotifications hooked up (tests only). */
let teardown: (() => void)[] = [];
let permission: NotifyStatus = "unavailable";

/** Test hook: let startNotifications run again, dropping the previous run's listeners. */
export function resetNotifications() {
  for (const off of teardown) off();
  teardown = [];
  started = false;
}

const allowed = (st: NotifyStatus) => st === "authorized" || st === "provisional";

/** Ask macOS again (after the first-run card or Settings changed it, and on window focus). */
export async function refreshNotifyStatus(): Promise<NotifyStatus> {
  permission = await notifyStatus();
  return permission;
}

/** Open a clicked banner: the email itself, or Today for a summary. */
async function openFromBanner(emailId?: string | null, accountId?: string | null) {
  const m = useMail.getState();
  if (!emailId) return m.closeCompose(() => useMail.getState().setView({ kind: "brief" }));
  try {
    if (!m.emails.some((e) => e.id === emailId)) {
      if (!accountId) throw new Error("no account");
      await m.ensureEmail({ id: emailId, accountId });
    }
    useMail.getState().closeCompose(() => {
      useMail.getState().setView({ kind: "inbox" });
      useMail.getState().select(emailId);
    });
  } catch {
    toast("That email is no longer available");
  }
}

/** Starts watching for new mail that needs you. Call once, after the store has loaded. */
export async function startNotifications() {
  if (started) return;
  started = true;
  const sessionStart = Date.now();
  const since = sessionStart - 15 * 60_000;
  const notified = new Set((await kvGet<string[]>(NOTIFIED_KEY).catch(() => null)) ?? []);
  /** Ids that got a banner of their own, so it can be taken back once handled. */
  const shown = new Set<string>();
  let pending: Email[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastBadge: number | undefined | null = null;

  void refreshNotifyStatus();
  const onFocus = () => void refreshNotifyStatus();
  window.addEventListener("focus", onFocus);
  teardown.push(() => window.removeEventListener("focus", onFocus));

  let ownFor: { accounts: Account[]; own: Set<string> } | undefined;
  const ctx = (): QualifyCtx => {
    const s = useMail.getState();
    // Your addresses only change with the accounts list.
    if (ownFor?.accounts !== s.accounts) ownFor = { accounts: s.accounts, own: ownAddresses(s.accounts) };
    return { s, prefs: useSettings.getState().notifications, own: ownFor.own, since };
  };
  /** A banner already shown stays while its email still qualifies; `since` only decides what's new. */
  const stillWanted = (e: Email | undefined, c: QualifyCtx) => !!e && qualifies(e, { ...c, since: 0 });

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // Sets keep insertion order: drop the oldest.
      for (const id of notified) {
        if (notified.size <= NOTIFIED_MAX) break;
        notified.delete(id);
      }
      kvSet(NOTIFIED_KEY, [...notified]).catch((err) => console.error("[notify] save failed", err));
    }, FLUSH_MS);
  };

  /** Everything that qualifies now counts as already told, with no banner (launch, a wider setting). */
  const baseline = () => {
    const c = ctx();
    let added = false;
    for (const e of c.s.emails)
      if (!notified.has(e.id) && qualifies(e, c)) {
        notified.add(e.id);
        added = true;
      }
    if (added) save();
  };

  const applyBadge = () => setBadge(badgeCount(useMail.getState(), useSettings.getState().notifications.badge));

  const setBadge = (n: number | undefined) => {
    if (n === lastBadge) return;
    lastBadge = n;
    if (isTauri()) getCurrentWindow().setBadgeCount(n).catch((err) => console.error("[notify] badge failed", err));
  };

  const flush = async () => {
    const batch = pending;
    pending = [];
    const c = ctx();
    const byId = idIndex(c.s.emails);
    // Read or moved while waiting: no banner.
    const live = batch.map((e) => byId.get(e.id)).filter((e): e is Email => !!e && qualifies(e, c));
    if (!live.length) return;
    if (inQuietHours(c.prefs.quiet, new Date())) return;
    if (c.prefs.skipWhenFocused && document.hasFocus()) return;
    if (!allowed(permission)) return;
    const skim = new Set(live.filter((e) => bucketOf(c.s, e.id) === "worth_skim").map((e) => e.id));
    for (const note of planBanners(live, c.prefs, skim)) {
      if (note.emailId) shown.add(note.emailId);
      await notifyShow(note);
    }
  };

  const check = () => {
    const c = ctx();
    // One pass finds new banners and counts the dock number (badgeCount's rule).
    const mode = c.prefs.badge;
    let badge = 0;
    for (const e of c.s.emails) {
      if (!notified.has(e.id) && qualifies(e, c)) {
        notified.add(e.id);
        pending.push(e);
      }
      if (mode !== "none" && badged(e, c.s, mode)) badge++;
    }
    if (pending.length) {
      save();
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => void flush(), FLUSH_MS);
    }
    if (shown.size) {
      const byId = idIndex(c.s.emails);
      const gone = [...shown].filter((id) => !stillWanted(byId.get(id), c));
      for (const id of gone) shown.delete(id);
      if (gone.length) void notifyRemove(gone);
    }
    setBadge(mode === "none" ? undefined : badge || undefined);
  };

  /**
   * Banners from earlier sessions are still in Notification Center. Take back the ones whose
   * email is read, gone or no longer qualifies, and old summaries; watch the rest like our own.
   */
  const tidyDelivered = async () => {
    const ids = await notifyDelivered();
    if (!ids.length) return;
    const c = ctx();
    const byId = idIndex(c.s.emails);
    const stale: string[] = [];
    for (const id of ids) {
      if (id.startsWith("summary-")) {
        if (!(Number(id.slice("summary-".length)) >= sessionStart)) stale.push(id);
      } else if (id.startsWith("test-")) {
        continue;
      } else if (stillWanted(byId.get(id), c)) {
        shown.add(id);
      } else {
        stale.push(id);
      }
    }
    if (stale.length) await notifyRemove(stale);
  };

  baseline();
  applyBadge();

  let prev = useMail.getState();
  teardown.push(
    useMail.subscribe((s) => {
      if (
        s.triage === prev.triage &&
        s.overrides === prev.overrides &&
        s.emails === prev.emails &&
        s.folders === prev.folders &&
        s.snoozed === prev.snoozed &&
        s.resolved === prev.resolved &&
        s.sections === prev.sections &&
        s.sectionOverrides === prev.sectionOverrides
      )
        return;
      prev = s;
      check();
    }),
  );

  teardown.push(
    useSettings.subscribe((st, old) => {
      if (st.notifications === old.notifications) return;
      // A wider level or an unmuted account doesn't flood: what qualifies now is old news.
      baseline();
      check();
    }),
  );

  const unlisten = await onNotificationOpen(({ emailId, accountId }) => {
    // Rust also keeps the click for a launch; take it so it isn't opened a second time below.
    void notifyTakePending();
    void openFromBanner(emailId, accountId);
  });
  teardown.push(unlisten);
  // A click that launched zMail was emitted before anyone listened.
  const launch = await notifyTakePending();
  if (launch) void openFromBanner(launch.emailId, launch.accountId);

  await tidyDelivered();
}

/** Settings → Notifications → "Send a test notification". Ignores focus and quiet hours. */
export async function sendTest() {
  await notifyShow({
    id: `test-${Date.now()}`,
    title: "zMail notifications are on",
    body: "You'll see banners like this for mail that needs you.",
    sound: useSettings.getState().notifications.sound,
  });
}
