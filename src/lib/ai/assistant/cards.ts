// src/lib/ai/assistant/cards.ts
// What the buttons on assistant cards do. Outcomes are queued as notes so the
// model hears about them with the user's next message.

import { SET_CAP, useAssistant, type Card, type Item, type Ref, type ResultSet } from "./state";
import { findUnsubscribe, pushRuleCard, type ToolDeps } from "./tools";
import { realDeps } from "./deps";
import { useMail } from "@/lib/store";
import { normalizeFrom, type RuleAction } from "@/lib/rules";

const stopping = new Set<string>();
const adding = new Set<string>();
const undoing = new Set<string>();

function bulkCard(itemId: string) {
  const item = useAssistant.getState().items.find((i) => i.id === itemId);
  return item?.kind === "card" && item.card.type === "bulk" ? item.card : undefined;
}

const count = (n: number, total: number) => `${n.toLocaleString()} / ${total.toLocaleString()}`;

async function runBulk(itemId: string, refs: Ref[], deps: ToolDeps, priorDone = 0) {
  const st = useAssistant.getState();
  const card = bulkCard(itemId);
  if (!card || undoing.has(itemId)) return;
  // A run orphaned by Clear must not leave notes or expire Undo in the new chat.
  const chat = st.chatId;
  const live = () => useAssistant.getState().chatId === chat && !!bulkCard(itemId);
  const note = (t: string) => {
    if (live()) useAssistant.getState().note(t);
  };
  // A stop pressed after an earlier run finished must not stop this one.
  stopping.delete(itemId);
  // A new action makes every earlier Undo unsafe (its before-state may no longer be true).
  st.expireUndo(itemId);
  st.patchCard(itemId, { status: "running", error: undefined, phase: undefined });
  const cancelled = () => stopping.has(itemId);
  let res;
  let gone = 0;
  try {
    const emails = await deps.loadHeaders(
      refs,
      (n, total) => useAssistant.getState().patchCard(itemId, { phase: `Reading ${count(n, total)}…` }),
      cancelled,
    );
    if (cancelled()) {
      useAssistant.getState().patchCard(itemId, { status: "partial", done: priorDone, failedRefs: refs, error: "Stopped.", phase: undefined });
      note(`The user stopped "${card.title}" before anything was changed.`);
      return;
    }
    // Rows the server no longer has are gone: count them as skipped.
    gone = refs.length - emails.length;
    useAssistant.getState().patchCard(itemId, { phase: undefined, done: priorDone + gone });
    res = await deps.bulk(emails, card.op, {
      onProgress: (n) => useAssistant.getState().patchCard(itemId, { done: priorDone + gone + n }),
      isCancelled: cancelled,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useAssistant.getState().patchCard(itemId, { status: "partial", done: priorDone, failedRefs: refs, error: message, phase: undefined });
    note(`The user confirmed "${card.title}" but it failed: ${message}. Nothing more was changed.`);
    return;
  } finally {
    stopping.delete(itemId);
  }
  const now = bulkCard(itemId);
  const failedRefs = res.failed.map((e) => ({ id: e.id, accountId: e.accountId }));
  const skipped = res.skipped + gone;
  useAssistant.getState().patchCard(itemId, {
    status: failedRefs.length ? "partial" : "done",
    done: priorDone + gone + res.done + res.skipped,
    skipped: (now?.skipped ?? 0) + skipped,
    // This card's own Undo from before a Resume is kept and extended, unless a later action already expired it.
    undo: now?.undoExpired ? undefined : [...(now?.undo ?? []), ...res.undo],
    failedRefs,
    error: res.error,
  });
  // This run is now the newest action, so every other card's Undo is stale.
  if (live()) useAssistant.getState().expireUndo(itemId);
  note(`The user confirmed "${card.title}": ${res.done} done${skipped ? `, ${skipped} already done or gone` : ""}${failedRefs.length ? `, ${failedRefs.length} not done (${res.error ?? "failed"})` : ""}.`);
}

export function confirmBulk(itemId: string, deps: ToolDeps = realDeps()) {
  const card = bulkCard(itemId);
  if (!card || card.status !== "pending") return Promise.resolve();
  return runBulk(itemId, card.refs, deps);
}

export function resumeBulk(itemId: string, deps: ToolDeps = realDeps()) {
  const card = bulkCard(itemId);
  if (card?.status !== "partial" || !card.failedRefs?.length || undoing.has(itemId)) return Promise.resolve();
  return runBulk(itemId, card.failedRefs, deps, card.done);
}

export function stopBulk(itemId: string) {
  stopping.add(itemId);
}

export function cancelCard(itemId: string) {
  const card = bulkCard(itemId);
  if (!card || card.status !== "pending") return;
  useAssistant.getState().patchCard(itemId, { status: "cancelled" });
  useAssistant.getState().note(`The user cancelled "${card.title}". Nothing was changed.`);
}

/**
 * Put back what a card changed. Runs once at a time per card; returns false if
 * nothing was undone (no undo record, already undoing, or it failed).
 */
export async function undoBulk(itemId: string, deps: ToolDeps = realDeps()): Promise<boolean> {
  const card = bulkCard(itemId);
  if (!card?.undo?.length || card.status === "running" || undoing.has(itemId)) return false;
  undoing.add(itemId);
  useAssistant.getState().patchCard(itemId, { undoing: true, error: undefined });
  let res;
  try {
    res = await deps.undo(card.undo, card.op);
  } catch (err) {
    // Nothing is known to be put back, so the record is kept for another try.
    useAssistant.getState().patchCard(itemId, { undoing: undefined, error: `Couldn't undo: ${err instanceof Error ? err.message : String(err)}` });
    return false;
  } finally {
    undoing.delete(itemId);
  }
  // Only the failed emails' records are kept, so Undo can retry just those; the card is undone once none are left.
  const failed = new Set(res.failed.map((e) => `${e.accountId}\n${e.id}`));
  const left = card.undo.filter((u) => failed.has(`${u.accountId}\n${u.id}`));
  useAssistant.getState().patchCard(itemId, left.length ? { undo: left, undoing: undefined, error: `${left.length} couldn't be put back.` } : { status: "undone", undo: [], undoing: undefined, error: res.failed.length ? `${res.failed.length} couldn't be put back.` : undefined });
  useAssistant.getState().note(`The user undid "${card.title}"${res.failed.length ? ` (${res.failed.length} couldn't be put back)` : ""}.`);
  return !res.failed.length;
}

/** The Undo button on a toast: same as the card's Undo, with failures reported in a toast. */
export function undoFromToast(itemId: string, deps: ToolDeps = realDeps()) {
  const card = bulkCard(itemId);
  if (card?.status === "undone") {
    deps.toast("Already undone");
    return Promise.resolve();
  }
  // An undo already in flight will report for itself.
  if (card?.undoing) return Promise.resolve();
  if (!card?.undo?.length) {
    deps.toast("Undo expired: a later action changed this mail.");
    return Promise.resolve();
  }
  return undoBulk(itemId, deps)
    .then((ok) => {
      if (!ok) deps.toast("Couldn't undo");
    })
    .catch(() => deps.toast("Couldn't undo"));
}

export async function addEvent(itemId: string, calendarId: string, deps: ToolDeps = realDeps()) {
  const item = useAssistant.getState().items.find((i) => i.id === itemId);
  if (item?.kind !== "card" || item.card.type !== "event") return;
  if (item.card.status !== "pending" || adding.has(itemId)) return;
  const e = item.card.event;
  adding.add(itemId);
  try {
    await deps.createEvent({ calendarId, title: e.title, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(), allDay: e.allDay, location: e.location, description: e.notes });
  } finally {
    adding.delete(itemId);
  }
  useAssistant.getState().patchCard(itemId, { status: "added" });
  useAssistant.getState().note(`The user added "${e.title}" to their calendar.`);
}

export function dismissEvent(itemId: string) {
  const item = useAssistant.getState().items.find((i) => i.id === itemId);
  if (item?.kind !== "card" || item.card.type !== "event" || item.card.status !== "pending" || adding.has(itemId)) return;
  useAssistant.getState().patchCard(itemId, { status: "dismissed" });
  useAssistant.getState().note("The user dismissed the event card.");
}

/** Show a set in the mail list (switching to the list layout). */
export function reviewSet(setId: string) {
  // Switch layout first: changing the view clears the active set (see App).
  const v = useMail.getState().view.kind;
  if (v !== "inbox" && v !== "folder" && v !== "starred" && v !== "snoozed") useMail.getState().setView({ kind: "inbox" });
  queueMicrotask(() => useAssistant.getState().showSet(setId));
}

/**
 * A set chip from an earlier session (its set is gone): run its search again,
 * point the chip at the new set and show it. Breakdown groups aren't re-run.
 */
export async function rerunSetChip(itemId: string, deps: ToolDeps = realDeps()): Promise<"shown" | "too_many" | "skipped"> {
  const item = useAssistant.getState().items.find((i) => i.id === itemId);
  if (item?.kind !== "set" || item.groups || !item.query || useAssistant.getState().sets[item.setId]) return "skipped";
  const r = await deps.search(item.query, SET_CAP);
  if (r.tooMany) {
    deps.toast(`More than ${SET_CAP.toLocaleString()} emails match now. Ask the assistant to narrow it.`);
    return "too_many";
  }
  const st = useAssistant.getState();
  st.addHeaders(r.headers);
  const set = st.addSet({ label: item.label, query: item.query, refs: r.refs });
  st.patchSetItem(itemId, { setId: set.id, count: r.refs.length, capped: r.capped || undefined });
  reviewSet(set.id);
  return "shown";
}

// ---- follow-up after cleaning up one sender ---------------------------------------

type Bulk = Extract<Card, { type: "bulk" }>;

/** A rule card for exactly this sender and action (no subject words) is already in the chat. */
export function hasRuleCard(items: Item[], from: string, action: RuleAction): boolean {
  return items.some((i) => i.kind === "card" && i.card.type === "rule" && i.card.from === from && i.card.action === action && !i.card.subjectAny?.length);
}

/**
 * What a bulk card's follow-up row offers once its trash or archive of one sender's mail has
 * (at least partly) run: making it automatic, and unsubscribing. Null hides the row. A button
 * is left out once used, or when the chat already has that card for the sender.
 */
export function bulkFollowUp(card: Bulk, sets: Record<string, ResultSet>, items: Item[]): { sender: string; rule: boolean; unsub: boolean } | null {
  if (card.op.kind !== "trash" && card.op.kind !== "archive") return null;
  if (!(card.status === "done" || (card.status === "partial" && card.done > 0)) || card.followUpDismissed) return null;
  // Cards from before the sender was stored fall back to their set's search (this session only).
  const raw = card.sender ?? (card.setId && Object.hasOwn(sets, card.setId) ? sets[card.setId].query?.from : undefined);
  const sender = raw ? normalizeFrom(raw) : null;
  if (!sender) return null;
  const rule = !card.ruleOffered && !hasRuleCard(items, sender, card.op.kind);
  const unsub = card.unsubOffered !== "done" && !items.some((i) => i.kind === "card" && i.card.type === "unsubscribe" && i.card.from === sender);
  return rule || unsub ? { sender, rule, unsub } : null;
}

function followUpOf(itemId: string) {
  const card = bulkCard(itemId);
  const st = useAssistant.getState();
  const f = card ? bulkFollowUp(card, st.sets, st.items) : null;
  return card && f ? { card, f } : null;
}

/** "Do this automatically": a rule card for new mail from the sender, with the card's action. */
export function automateFromBulk(itemId: string) {
  const it = followUpOf(itemId);
  if (!it?.f.rule || (it.card.op.kind !== "trash" && it.card.op.kind !== "archive")) return;
  useAssistant.getState().patchCard(itemId, { ruleOffered: true });
  pushRuleCard({ from: it.f.sender, action: it.card.op.kind });
}

/** "Unsubscribe": the same check as check_unsubscribe, showing an Unsubscribe card or saying there's no link. */
export async function unsubscribeFromBulk(itemId: string, deps: ToolDeps = realDeps()) {
  const it = followUpOf(itemId);
  if (!it?.f.unsub || it.card.unsubOffered === "checking") return;
  const chat = useAssistant.getState().chatId;
  const live = () => useAssistant.getState().chatId === chat && !!bulkCard(itemId);
  useAssistant.getState().patchCard(itemId, { unsubOffered: "checking" });
  try {
    const found = await findUnsubscribe(it.f.sender, deps);
    if (!live()) return;
    useAssistant.getState().patchCard(itemId, { unsubOffered: "done" });
    if (typeof found === "string") deps.toast(`No unsubscribe link from ${it.f.sender}`);
    else useAssistant.getState().push({ kind: "card", card: found });
  } catch (err) {
    if (!live()) return;
    // Nothing was shown, so the button can be tried again.
    useAssistant.getState().patchCard(itemId, { unsubOffered: undefined });
    deps.toast(`Couldn't check how to unsubscribe: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** "No thanks" on the follow-up row. */
export function dismissFollowUp(itemId: string) {
  if (bulkCard(itemId)) useAssistant.getState().patchCard(itemId, { followUpDismissed: true });
}
