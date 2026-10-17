// The assistant panel's state: what's on screen (items), what the model has
// seen (history), result sets, header rows, and ids the model may act on.
// The conversation is saved locally; sets are not. A set chip from an earlier
// session re-runs its search when clicked (rerunSetChip in cards.ts);
// breakdown groups from an earlier session stay disabled.

import { create } from "zustand";
import { toast } from "sonner";
import type { Email } from "@/lib/types";
import type { OutgoingAttachment } from "@/lib/google/gmail-map";
import type { AgentMessage } from "@/lib/ai/tool-chat";
import { withoutRaw } from "@/lib/ai/tool-chat";
export { withoutRaw };
import type { MailQuery } from "./query";
import type { MentionRef } from "./mentions";
import type { BulkOp, UndoEntry } from "@/lib/mail/bulk";
import type { Compose } from "@/lib/store";
import type { RuleAction } from "@/lib/rules";
import type { UnsubMethod } from "@/lib/mail/unsubscribe";
import { useMail } from "@/lib/store";
import { kvGet, kvSet } from "@/lib/db";
import { parseSlash, type SlashCommand } from "./commands";

/** Most emails a result set holds. */
export const SET_CAP = 10_000;

export interface Ref {
  id: string;
  accountId: string;
}

/** An email the model may cite as [mN]; date is YYYY-MM-DD. */
export interface RefInfo {
  id: string;
  accountId: string;
  from: string;
  subject: string;
  date: string;
}

export interface ResultSet {
  id: string;
  label: string;
  /** The search behind the set (breakdown groups inherit their parent's). */
  query?: MailQuery;
  refs: Ref[];
  parentId?: string;
  /** Breakdown groups, shown as tabs above the mail list. */
  groups?: { label: string; count: number; setId: string }[];
}

export interface EventDraft {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  emailId?: string;
}

export type Card =
  | {
      type: "bulk";
      op: BulkOp;
      setId?: string;
      refs: Ref[];
      title: string;
      detail: string;
      /** partial = stopped or failed partway (Resume retries failedRefs). */
      status: "pending" | "running" | "done" | "partial" | "cancelled" | "undone";
      done: number;
      total: number;
      failedRefs?: Ref[];
      /** Emails already in the target state, or gone, so not changed. */
      skipped?: number;
      undo?: UndoEntry[];
      /** A later action (or a relaunch) made this card's Undo unsafe, so it was dropped. */
      undoExpired?: boolean;
      /** Undo is running. */
      undoing?: boolean;
      /** What a running card is doing before the action starts ("Reading 1,200 / 3,000…"). */
      phase?: string;
      error?: string;
      /** The one sender the set was searched by (normalized), for the follow-up row after trash or archive. */
      sender?: string;
      /** Follow-up row: "Do this automatically" was used. */
      ruleOffered?: boolean;
      /** Follow-up row: Unsubscribe is being checked, or was used. */
      unsubOffered?: "checking" | "done";
      /** Follow-up row: the user clicked No thanks. */
      followUpDismissed?: boolean;
    }
  | { type: "event"; event: EventDraft; status: "pending" | "added" | "dismissed" }
  | { type: "draft"; summary: string; compose: Compose }
  | { type: "rule"; from: string; subjectAny?: string[]; action: RuleAction; folderName?: string; accountLabel?: string; status: "pending" | "saved" | "dismissed"; ruleId?: string; moved?: number }
  | {
      type: "unsubscribe";
      from: string;
      accountId: string;
      accountAddress: string;
      method: Exclude<UnsubMethod, "none">;
      /** From the sender's List-Unsubscribe header: untrusted, only ever used if https. */
      http?: string;
      mailto?: string;
      status: "pending" | "working" | "done" | "failed" | "opened" | "dismissed";
      error?: string;
      /** "Trash new mail from … meanwhile" was used. */
      meanwhileOffered?: boolean;
    }
  | {
      type: "confirm";
      /** Module id and its confirm action name. */
      module: string;
      action: string;
      title: string;
      detail?: string;
      /** What will be sent or changed, shown on the card. Text only (no HTML). */
      preview?: { fields?: { label: string; value: string }[]; body?: string };
      payload: unknown;
      confirmLabel: string;
      /** Show the Send later menu (send cards). */
      later?: boolean;
      status: "pending" | "running" | "done" | "failed" | "dismissed";
      result?: string;
      error?: string;
    };

type CardPatch =
  | Partial<Extract<Card, { type: "bulk" }>>
  | Partial<Extract<Card, { type: "event" }>>
  | Partial<Extract<Card, { type: "rule" }>>
  | Partial<Extract<Card, { type: "unsubscribe" }>>
  | Partial<Extract<Card, { type: "confirm" }>>;

export type Item =
  | { id: string; kind: "user"; text: string; display?: { command: string; text: string }; mentions?: MentionRef[] }
  | { id: string; kind: "assistant"; text: string; webSources?: { url: string; title: string }[] }
  | { id: string; kind: "step"; text: string }
  | { id: string; kind: "set"; setId: string; label: string; count: number; query?: MailQuery; groups?: { label: string; count: number; setId: string }[]; by?: "sender" | "month" | "kind"; capped?: boolean }
  | { id: string; kind: "card"; card: Card }
  | { id: string; kind: "error"; text: string; retry?: string; toolTrouble?: boolean };

type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

interface AssistantState {
  open: boolean;
  busy: boolean;
  /** Clear is waiting for a running action to settle; not saved. */
  clearing: boolean;
  /** Bumped by newChat so an in-flight ask can tell its chat is gone. */
  chatId: number;
  /** Bumped by stopTurn so an in-flight ask can tell it was stopped or redirected; not saved. */
  turnId: number;
  /** Files the next draft opens with (from the Draft-with-AI box); not saved. */
  pendingAttachments: OutgoingAttachment[];
  /** The account the Draft-with-AI box was set to send from; the next draft opens with it. Not saved. */
  pendingFrom: string | null;
  items: Item[];
  history: AgentMessage[];
  sets: Record<string, ResultSet>;
  headers: Record<string, Email>;
  known: Record<string, Ref>;
  notes: string[];
  /** Citable emails by ref ("m1"), and the last ref number handed out. */
  refs: Record<string, RefInfo>;
  refSeq: number;
  /** The ref for an email: the one it already has, or the next. */
  refFor: (e: Email) => string;
  /** Set shown in the mail list, if any. */
  activeSetId: string | null;
  /** Emails changed without a confirm card during the current user message (the DIRECT_LIMIT budget). */
  directThisTurn: number;
  /** Long-running work in the current turn ("Reading 1,200 / 3,000…"); not saved. */
  progress: string | null;
  setProgress: (text: string | null) => void;
  toggle: (open?: boolean) => void;
  /** Bumped to move focus to the ask box (e.g. "Ask Assistant…" from an email's menu); not saved. */
  focusAsk: number;
  /** Open the panel and put the cursor in the ask box. */
  askFocus: () => void;
  newChat: () => void;
  setPendingAttachments: (list: OutgoingAttachment[]) => void;
  setPendingFrom: (accountId: string | null) => void;
  push: (item: NewItem) => string;
  patchCard: (id: string, patch: CardPatch) => void;
  /** Replace a set chip's set (after re-running an old chip's search). */
  patchSetItem: (id: string, patch: { setId: string; count: number; capped?: boolean }) => void;
  /** A new bulk action ran: drop Undo from every other bulk card (its before-state may be stale). */
  expireUndo: (exceptId?: string) => void;
  pushHistory: (m: AgentMessage) => void;
  /** Remove the last history message if it matches (used by Retry). */
  popHistoryIf: (pred: (m: AgentMessage) => boolean) => void;
  addSet: (s: Omit<ResultSet, "id">) => ResultSet;
  patchSet: (id: string, patch: Partial<ResultSet>) => void;
  addHeaders: (rows: Email[]) => void;
  remember: (refs: Ref[]) => void;
  note: (text: string) => void;
  /** End the current model turn without clearing the chat. Its pending replies are ignored. */
  stopTurn: (reason?: "stopped" | "redirected") => void;
  drainNotes: () => string[];
  showSet: (id: string | null) => void;
}

const newId = () => Math.random().toString(36).slice(2, 10);

export const useAssistant = create<AssistantState>()((set, get) => ({
  open: false,
  busy: false,
  clearing: false,
  chatId: 0,
  turnId: 0,
  pendingAttachments: [],
  pendingFrom: null,
  items: [],
  history: [],
  sets: {},
  headers: {},
  known: {},
  notes: [],
  refs: {},
  refSeq: 0,
  refFor: (e) => {
    const s = get();
    const have = Object.keys(s.refs).find((k) => s.refs[k].id === e.id && s.refs[k].accountId === e.accountId);
    if (have) return have;
    const key = `m${s.refSeq + 1}`;
    const info: RefInfo = { id: e.id, accountId: e.accountId, from: e.from.name || e.from.address, subject: e.subject, date: e.date.slice(0, 10) };
    set({ refs: { ...s.refs, [key]: info }, refSeq: s.refSeq + 1 });
    return key;
  },
  activeSetId: null,
  directThisTurn: 0,
  progress: null,
  setProgress: (progress) => set({ progress }),
  toggle: (open) => set((s) => ({ open: open ?? !s.open })),
  focusAsk: 0,
  askFocus: () => set((s) => ({ open: true, focusAsk: s.focusAsk + 1 })),
  setPendingAttachments: (list) => set({ pendingAttachments: list }),
  setPendingFrom: (pendingFrom) => set({ pendingFrom }),
  newChat: () => set((s) => ({ pendingAttachments: [], pendingFrom: null, items: [], history: [], sets: {}, headers: {}, known: {}, notes: [], refs: {}, refSeq: 0, activeSetId: null, busy: false, directThisTurn: 0, progress: null, chatId: s.chatId + 1 })),
  push: (item) => {
    const id = newId();
    set((s) => ({ items: [...s.items, { ...item, id } as Item] }));
    return id;
  },
  patchCard: (id, patch) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id && i.kind === "card" ? { ...i, card: { ...i.card, ...patch } as Card } : i)) })),
  patchSetItem: (id, patch) => set((s) => ({ items: s.items.map((i) => (i.id === id && i.kind === "set" ? { ...i, ...patch } : i)) })),
  expireUndo: (exceptId) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.id !== exceptId && i.kind === "card" && i.card.type === "bulk" && i.card.undo?.length ? { ...i, card: { ...i.card, undo: undefined, undoExpired: true } } : i,
      ),
    })),
  pushHistory: (m) => set((s) => ({ history: [...s.history, m] })),
  popHistoryIf: (pred) => set((s) => (s.history.length && pred(s.history[s.history.length - 1]) ? { history: s.history.slice(0, -1) } : {})),
  addSet: (input) => {
    const rs: ResultSet = { ...input, id: `set_${newId()}` };
    set((s) => ({ sets: { ...s.sets, [rs.id]: rs } }));
    return rs;
  },
  patchSet: (id, patch) => set((s) => (s.sets[id] ? { sets: { ...s.sets, [id]: { ...s.sets[id], ...patch } } } : {})),
  addHeaders: (rows) => set((s) => ({ headers: { ...s.headers, ...Object.fromEntries(rows.map((r) => [r.id, r])) } })),
  remember: (refs) => set((s) => ({ known: { ...s.known, ...Object.fromEntries(refs.map((r) => [r.id, r])) } })),
  note: (text) => set((s) => ({ notes: [...s.notes, text] })),
  stopTurn: (reason = "stopped") => {
    set((s) => ({ turnId: s.turnId + 1, busy: false, progress: null }));
    if (reason === "stopped") get().push({ kind: "step", text: "Stopped." });
  },
  drainNotes: () => {
    const notes = get().notes;
    set({ notes: [] });
    return notes;
  },
  showSet: (activeSetId) => {
    // Ticked inbox rows are hidden while a set is shown, so they must not be actable from there.
    if (activeSetId) useMail.getState().clearChecked();
    set({ activeSetId });
  },
}));

/** A typed command: "/clear" (or "/new") starts over instead of going to the model. */
export function parseCommand(text: string): "clear" | null {
  const t = text.trim().toLowerCase();
  return t === "/clear" || t === "/new" ? "clear" : null;
}

/** What sending `text` does: a bare /clear works even mid-answer; anything else waits until idle. */
export function submitAction(text: string, busy: boolean, clearing = false): "clear" | "ask" | "redirect" | "ignore" {
  const t = text.trim();
  if (!t) return "ignore";
  if (parseCommand(t) === "clear") return "clear";
  if (clearing) return "ignore";
  return busy ? "redirect" : "ask";
}

export type SendPlan = { kind: "clear" } | { kind: "plain"; text: string; redirect?: boolean } | { kind: "command"; command: SlashCommand; arg: string; redirect?: boolean };

/** What Enter does in the assistant input (with an optional command chip), or null when it can't send. */
export function planSend(chip: SlashCommand | null, text: string, busy: boolean, clearing: boolean): SendPlan | null {
  const t = text.trim();
  const parsed = chip ? null : parseSlash(t);
  const c = chip ?? parsed?.command ?? null;
  const arg = chip ? t : (parsed?.arg ?? "");
  if (c?.local === "clear" && !arg) return { kind: "clear" };
  // "/clear out amazon mail" is a request, not a reset: it goes to the model as typed, without the chip.
  if (!c || c.local === "clear") {
    const plain = chip ? arg : t;
    const act = submitAction(plain, busy, clearing);
    return act === "ask" ? { kind: "plain", text: plain } : act === "redirect" ? { kind: "plain", text: plain, redirect: true } : null;
  }
  if (clearing || (c.arg !== "none" && !arg)) return null;
  return busy ? { kind: "command", command: c, arg, redirect: true } : { kind: "command", command: c, arg };
}

const SETTLE_MS = 4000;

const isBusy = (c: Extract<Card, { type: "bulk" }>) => c.status === "running" || !!c.undoing;
const bulkCards = (ids: string[]) =>
  ids.flatMap((id) => {
    const it = useAssistant.getState().items.find((i) => i.id === id);
    return it?.kind === "card" && it.card.type === "bulk" ? [it.card] : [];
  });

/** Resolves when every listed card has stopped running/undoing, or after `ms`. */
function settled(ids: string[], ms: number): Promise<void> {
  return new Promise((resolve) => {
    let unsub = () => {};
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      unsub();
      resolve();
    }
    const check = () => {
      if (!bulkCards(ids).some(isBusy)) done();
    };
    unsub = useAssistant.subscribe(check);
    check();
  });
}

const PAST: Record<string, string> = { trash: "moved", archive: "archived", spam: "marked as spam", move: "moved" };

let clearing: Promise<void> | null = null;

/**
 * Start over. Never refuses: a running bulk action is asked to stop and given a few seconds
 * to settle, then the chat is cleared regardless, with one toast per card saying what already
 * happened. Repeated calls while waiting share the same clear.
 */
export function clearChat(): Promise<void> {
  if (clearing) return clearing;
  const ids = useAssistant
    .getState()
    .items.flatMap((i) => (i.kind === "card" && i.card.type === "bulk" && isBusy(i.card) ? [i.id] : []));
  if (!ids.length) {
    useAssistant.getState().newChat();
    return Promise.resolve();
  }
  useAssistant.setState({ clearing: true });
  clearing = clearBusy(ids).finally(() => {
    clearing = null;
    useAssistant.setState({ clearing: false });
  });
  return clearing;
}

async function clearBusy(ids: string[]): Promise<void> {
  // Drop the in-flight model turn right away; its replies are ignored once chatId changes.
  useAssistant.setState((s) => ({ chatId: s.chatId + 1 }));
  const { stopBulk } = await import("./cards");
  for (const id of ids) if (bulkCards([id])[0]?.status === "running") stopBulk(id);
  await settled(ids, SETTLE_MS);
  const cards = bulkCards(ids);
  useAssistant.getState().newChat();
  for (const card of cards) {
    if (card.status === "undone") continue;
    const still = isBusy(card);
    const verb = PAST[card.op.kind] ?? "changed";
    const n = card.done.toLocaleString();
    const msg = still
      ? `“${card.title}” may still finish in the background.`
      : card.status === "done"
        ? `Finished “${card.title}” — ${n} ${verb}.`
        : `Stopped “${card.title}” — ${n} were already ${verb}.`;
    // While it is still running or undoing, Undo could race it.
    const undo = !still && card.undo?.length ? card.undo : undefined;
    toast(
      msg,
      undo
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                void useMail
                  .getState()
                  .bulkUndo(undo, card.op)
                  .catch(() => toast("Couldn't undo"));
              },
            },
          }
        : undefined,
    );
  }
}

/**
 * While an assistant set is shown, the mail list's own order (orderedEmails) is hidden, so
 * shortcuts that walk or select that list must do nothing: ⌘A, j/k and the arrow keys.
 */
export function listKeyBlocked(key: string, mod: boolean, activeSetId: string | null): boolean {
  if (!activeSetId) return false;
  if (mod) return key === "a";
  return key === "j" || key === "k" || key === "ArrowDown" || key === "ArrowUp";
}

// ---- persistence ----------------------------------------------------------------

const KEY = "assistant.v1";

export interface AssistantSnapshot {
  items: Item[];
  history: AgentMessage[];
  refs?: Record<string, RefInfo>;
  refSeq?: number;
}

/** A draft card's files without their bytes: the chat is saved often, and attachments can be megabytes. */
function withoutFileBytes(i: Item): Item {
  if (i.kind !== "card" || i.card.type !== "draft" || !i.card.compose.attachments?.length) return i;
  const attachments = i.card.compose.attachments.map(({ filename, mimeType, size }) => ({ filename, mimeType, size }));
  return { ...i, card: { ...i.card, compose: { ...i.card.compose, attachments: attachments as Compose["attachments"] } } };
}

export function assistantSnapshot(s: Pick<AssistantState, "items" | "history" | "refs" | "refSeq">): AssistantSnapshot {
  return { items: s.items.slice(-200).map(withoutFileBytes), history: withoutRaw(s.history.slice(-40)), refs: s.refs, refSeq: s.refSeq };
}

const INTERRUPTED = "Interrupted when zMail closed. It may have gone through.";

/** A saved draft card opens without files whose bytes weren't kept; its line names them to attach again. */
function restoreDraft(card: Extract<Card, { type: "draft" }>): Extract<Card, { type: "draft" }> {
  const files = card.compose.attachments ?? [];
  const missing = files.filter((f) => typeof f.base64 !== "string");
  if (!missing.length) return card;
  const kept = files.filter((f) => typeof f.base64 === "string");
  const compose: Compose = { ...card.compose, attachments: kept.length ? kept : undefined };
  return { ...card, compose, summary: `${card.summary} · attach again: ${missing.map((f) => f.filename).join(", ")}` };
}

export function restoreAssistant(snap: AssistantSnapshot) {
  // A trimmed history must not start with tool results: their tool calls were cut off.
  let history = snap.history ?? [];
  while (history.length && history[0].role !== "user") history = history.slice(1);
  const items = (snap.items ?? []).map((i): Item => {
    // An unsubscribe or confirmed action cut off by quitting may or may not have gone through.
    if (i.kind === "card" && i.card.type === "unsubscribe" && i.card.status === "working") return { ...i, card: { ...i.card, status: "failed", error: INTERRUPTED } };
    if (i.kind === "card" && i.card.type === "confirm" && i.card.status === "running") return { ...i, card: { ...i.card, status: "failed", error: INTERRUPTED } };
    if (i.kind === "card" && i.card.type === "draft") return { ...i, card: restoreDraft(i.card) };
    if (i.kind !== "card" || i.card.type !== "bulk") return i;
    // Undo records are from a previous session: the mail may have changed since, so they're dropped.
    // An Unsubscribe check cut off by quitting can be tried again.
    const card = {
      ...i.card,
      undo: undefined,
      undoExpired: i.card.undoExpired || !!i.card.undo?.length,
      undoing: undefined,
      phase: undefined,
      unsubOffered: i.card.unsubOffered === "checking" ? undefined : i.card.unsubOffered,
    };
    if (card.status !== "running") return { ...i, card };
    // Everything not known to be finished is retried, so count only what's outside failedRefs as done.
    const failedRefs = card.failedRefs ?? card.refs;
    return { ...i, card: { ...card, status: "partial", error: "Interrupted when zMail closed.", failedRefs, done: Math.max(0, card.total - failedRefs.length) } };
  });
  // Sets and known ids live only in memory, so the model must not reuse ids from the saved history.
  const restarted = history.length ? ["zMail restarted: earlier sets and email ids are gone; search again before acting."] : [];
  useAssistant.setState((s) => ({ items, history, notes: [...s.notes, ...restarted], refs: snap.refs ?? {}, refSeq: snap.refSeq ?? 0 }));
}

export async function loadAssistant() {
  const snap = await kvGet<AssistantSnapshot>(KEY).catch(() => null);
  // A conversation started before loading finished wins over the saved one.
  const now = useAssistant.getState();
  if (snap && !now.items.length && !now.history.length) restoreAssistant(snap);
}

let saving = false;
/** Save soon after changes settle, but never later than MAX_WAIT after the first unsaved one. */
const SETTLE = 600;
const MAX_WAIT = 2000;

export function startAssistantAutosave(target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined" ? undefined : window) {
  if (saving) return () => {};
  saving = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let last: AssistantSnapshot | null = null;
  const save = () => {
    clearTimeout(timer);
    clearTimeout(maxTimer);
    timer = maxTimer = undefined;
    if (!dirty) return;
    dirty = false;
    void kvSet(KEY, assistantSnapshot(useAssistant.getState())).catch((err) => console.error("[assistant] save failed", err));
  };
  const unsubscribe = useAssistant.subscribe((s) => {
    if (last && s.items === last.items && s.history === last.history && s.refs === last.refs) return;
    last = { items: s.items, history: s.history, refs: s.refs };
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(save, SETTLE);
    maxTimer ??= setTimeout(save, MAX_WAIT);
  });
  // Closing the window: write what's pending now rather than lose it.
  target?.addEventListener("pagehide", save);
  target?.addEventListener("beforeunload", save);
  return () => {
    save();
    unsubscribe();
    target?.removeEventListener("pagehide", save);
    target?.removeEventListener("beforeunload", save);
    saving = false;
  };
}
