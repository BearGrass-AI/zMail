// Scheduled send: mail saved as a draft and sent by zMail at its time (or held on Outlook's server).

import type { StoreApi } from "zustand";
import { toast } from "sonner";
import type { Email } from "@/lib/types";
import { kvGet, kvSet } from "@/lib/db";
import { HttpError } from "@/lib/transport";
import { INSTANCE_ID, LATE_MS, OUTLOOK_SERVER_HOLD, claimedElsewhere, dueNow, validSendAt, whenLabel, type ScheduledSend } from "@/lib/mail/scheduled";
import { useMail } from "@/lib/store";
import { providerFor } from "./providers";
import type { MailState } from "./types";

export const SCHEDULED_KEY = "scheduled.v1";
/** The due-scheduled run in progress (one at a time), and scheduled ids being sent right now. */
let scheduledRun: Promise<void> | null = null;
const scheduledInFlight = new Set<string>();
/** Scheduled ids whose failure was already toasted this session. */
const scheduleFailToasted = new Set<string>();

/** Saves of the scheduled list (and claims), one at a time in call order: an older list can't land over a newer one. */
let saves: Promise<unknown> = Promise.resolve();
function queued<T>(job: () => Promise<T>): Promise<T> {
  const next = saves.then(job);
  saves = next.catch(() => undefined);
  return next;
}

function publish(update: (list: ScheduledSend[]) => ScheduledSend[]) {
  const s = useMail.getState();
  const scheduled = update(s.scheduled);
  // The Scheduled view has nothing left to show: back to the inbox (compose stays open, unlike setView).
  useMail.setState({ scheduled, ...(s.view.kind === "scheduled" && !scheduled.length && { view: { kind: "inbox" as const } }) });
}

/**
 * Change the scheduled list and save it at once (not debounced: a schedule made just before quitting must survive).
 * Resolves once it's on disk. If the save fails, `undo` reverts the change in memory before any later save runs.
 */
function saveScheduled(update: (list: ScheduledSend[]) => ScheduledSend[], undo?: (list: ScheduledSend[]) => ScheduledSend[]): Promise<void> {
  publish(update);
  return queued(async () => {
    try {
      // The list as it is when this save runs, so a later save never writes back an undone change.
      await kvSet(SCHEDULED_KEY, useMail.getState().scheduled);
    } catch (err) {
      if (undo) publish(undo);
      throw err;
    }
  });
}

/** saveScheduled for changes nobody waits on: a failed save is logged, and the next save writes the whole list again. */
export function setScheduled(update: (list: ScheduledSend[]) => ScheduledSend[]) {
  saveScheduled(update).catch((err) => console.error("[scheduled]", err));
}

export const withoutEditing = ({ editing: _, ...r }: ScheduledSend): ScheduledSend => r;

/** A scheduled draft the composer closed without scheduling, sending or deleting it: back to the scheduler. */
export function releaseEditing(draftId: string | undefined) {
  if (!draftId) return;
  const r = useMail.getState().scheduled.find((x) => x.draftId === draftId && x.editing);
  if (!r) return;
  setScheduled((l) => l.map((x) => (x.id === r.id ? withoutEditing(x) : x)));
  toast(`Still scheduled for ${whenLabel(r.sendAt)}`);
}

/** Drop rows (a sent draft's draft and message ids) from the list. */
function dropRows(ids: string[]) {
  const gone = new Set(ids);
  useMail.setState((s) => ({ emails: s.emails.filter((e) => !gone.has(e.id)) }));
}

/** A recipient's display name when mail in the store knows it, else the address. */
function nameFor(raw: string, emails: Email[]) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (m?.[1]) return m[1];
  const address = (m?.[2] ?? raw).trim().toLowerCase();
  for (const e of emails)
    for (const c of [e.from, ...e.to, ...(e.cc ?? [])]) if (c.address.toLowerCase() === address && c.name && c.name !== c.address) return c.name;
  return m?.[2] ?? raw;
}

const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

let schedulerStarted = false;
/** Send due scheduled mail every 30 s, on window focus, and once right after the launch refresh (overdue mail goes out then). */
export function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const run = () => void useMail.getState().runDueScheduled();
  setInterval(run, 30_000);
  window.addEventListener("focus", run);
  // Joins the launch refresh that load() starts next.
  void useMail.getState().refresh().catch(() => undefined).then(run);
}


/** The store's scheduled-send actions. */
export function scheduledActions(
  set: StoreApi<MailState>["setState"],
  get: StoreApi<MailState>["getState"],
): Pick<MailState, "scheduleMessage" | "cancelScheduled" | "sendScheduledNow" | "editScheduled" | "withdrawScheduled" | "runDueScheduled"> {
  return {
    async scheduleMessage(accountId, msg, sendAt, draft) {
      if (!validSendAt(sendAt, Date.now())) throw new Error("Pick a time at least a minute from now");
      const saved = await get().saveDraft(accountId, msg, draft?.id);
      const p = providerFor(accountId);
      let server = false;
      if (get().accounts.find((a) => a.id === accountId)?.kind === "m365" && OUTLOOK_SERVER_HOLD && p.holdOnServer) {
        await p.holdOnServer(msg, saved.draftId, sendAt);
        server = true;
      }
      const emails = get().emails;
      const record: ScheduledSend = {
        id: saved.draftId,
        accountId,
        draftId: saved.draftId,
        messageId: saved.messageId,
        sendAt,
        subject: msg.subject || "(no subject)",
        to: msg.to.map((a) => nameFor(a, emails)),
        snippet: msg.text.slice(0, 120),
        server,
        createdAt: Date.now(),
      };
      let replaced: ScheduledSend | undefined;
      try {
        await saveScheduled(
          (list) => {
            replaced = list.find((r) => r.draftId === record.draftId);
            return [...list.filter((r) => r.draftId !== record.draftId), record];
          },
          (list) => {
            const rest = list.filter((r) => r !== record);
            return replaced && !rest.some((r) => r.draftId === record.draftId) ? [...rest, replaced] : rest;
          },
        );
      } catch (err) {
        throw new Error("zMail couldn't save the schedule. The draft is saved.", { cause: err });
      }
      // Gmail gives each save a new message id: the composer's old draft row is stale.
      if (draft?.emailId && draft.emailId !== saved.messageId) dropRows([draft.emailId]);
      return record;
    },

    async cancelScheduled(id) {
      const r = get().scheduled.find((x) => x.id === id);
      if (!r) return;
      if (scheduledInFlight.has(id)) throw new Error("It's being sent right now.");
      if (r.server) await providerFor(r.accountId).releaseFromServer?.(r.messageId);
      let removed: ScheduledSend | undefined;
      try {
        await saveScheduled(
          (list) => {
            removed = list.find((x) => x.id === id);
            return list.filter((x) => x.id !== id);
          },
          (list) => (removed && !list.some((x) => x.id === id) ? [...list, removed] : list),
        );
      } catch (err) {
        throw new Error("zMail couldn't save the change. It's still scheduled.", { cause: err });
      }
      toast("Not scheduled. It's in Drafts.");
    },

    async sendScheduledNow(id) {
      const r = get().scheduled.find((x) => x.id === id);
      if (!r || scheduledInFlight.has(id)) return;
      // Claimed before any await: a due run that reaches this id skips it.
      scheduledInFlight.add(id);
      try {
        const p = providerFor(r.accountId);
        if (!p.sendSavedDraft) throw new Error("This account can't send saved drafts");
        if (r.server) await p.releaseFromServer?.(r.messageId);
        await p.sendSavedDraft(r.draftId);
      } finally {
        scheduledInFlight.delete(id);
      }
      setScheduled((list) => list.filter((x) => x.id !== id));
      dropRows([r.draftId, r.messageId]);
      toast.success("Sent");
    },

    async editScheduled(id) {
      const r = get().scheduled.find((x) => x.id === id);
      if (!r) return;
      if (scheduledInFlight.has(id)) throw new Error("It's being sent right now.");
      // Unsaved composer text is never dropped silently: ask first, then come back here.
      const s = get();
      if (s.compose && s.composeDirty)
        return s.closeCompose(() => void get().editScheduled(id).catch((err) => toast.error("Couldn't open it", { description: err instanceof Error ? err.message : String(err) })));
      if (r.server) await providerFor(r.accountId).releaseFromServer?.(r.messageId);
      // Kept, but held while the composer has it (released from the server, zMail sends it): schedule, send, delete or close decides.
      setScheduled((list) => list.map((x) => (x.id === id ? { ...x, server: false, editing: true } : x)));
      // Gmail drafts may not be loaded; openDraft reads the row from `emails` (ensureEmail adds it).
      if (!get().emails.some((e) => e.id === r.messageId)) await get().ensureEmail({ id: r.messageId, accountId: r.accountId }).catch(() => undefined);
      const opened = await get().openDraft(r.messageId, { scheduledAt: r.sendAt, draftId: r.draftId }).catch(() => false);
      // Not open after all: the scheduler resumes.
      if (!opened) setScheduled((list) => list.map((x) => (x.id === id ? withoutEditing(x) : x)));
    },

    async withdrawScheduled(draftId) {
      const r = get().scheduled.find((x) => x.draftId === draftId);
      if (!r) return null;
      if (scheduledInFlight.has(r.id)) throw new Error("It's being sent right now.");
      if (r.server) await providerFor(r.accountId).releaseFromServer?.(r.messageId);
      // Released from Outlook's hold above, so zMail sends it if it goes back.
      const back = { ...r, server: false };
      try {
        // On disk before the draft is saved: a restart in between can't send the changed draft.
        await saveScheduled(
          (list) => list.filter((x) => x.id !== r.id),
          (list) => (list.some((x) => x.id === r.id) ? list : [...list, back]),
        );
      } catch (err) {
        throw new Error("zMail couldn't take it off the schedule. Nothing was saved.", { cause: err });
      }
      // The save failed: the server still holds what was scheduled, so it goes back on the schedule (held while open).
      return () => setScheduled((list) => (list.some((x) => x.draftId === draftId) ? list : [...list, { ...back, editing: true }]));
    },

    runDueScheduled() {
      if (scheduledRun) return scheduledRun;
      const run = (async () => {
        const due = dueNow(get().scheduled, Date.now()).filter((r) => !scheduledInFlight.has(r.id));
        const late: ScheduledSend[] = [];
        const onTime: ScheduledSend[] = [];
        // Another copy of zMail can share the data folder (a dev build beside an installed one; release builds are
        // single-instance). Each copy keeps its own list and saves all of it on every change, so one can still overwrite
        // the other's list; the claim in the saved list only keeps two copies from sending the same email.
        /** Claim `id` in the saved list: "gone" (another copy sent or cancelled it), "taken" (another copy is sending it) or "ours".
         *  Queued with the list's saves, so the saved list it reads has every change made before it. */
        const claim = (id: string): Promise<"gone" | "taken" | "ours"> =>
          queued(async () => {
            const saved = (await kvGet<ScheduledSend[]>(SCHEDULED_KEY)) ?? [];
            const rec = saved.find((x) => x.id === id);
            if (!rec) return "gone";
            if (claimedElsewhere(rec, Date.now())) return "taken";
            const mine = { by: INSTANCE_ID, at: Date.now() };
            await kvSet(SCHEDULED_KEY, saved.map((x) => (x.id === id ? { ...x, claim: mine } : x)));
            // Read back: a copy that wrote in between wins.
            const check = ((await kvGet<ScheduledSend[]>(SCHEDULED_KEY)) ?? []).find((x) => x.id === id);
            if (!check) return "gone";
            if (check.claim?.by !== INSTANCE_ID) return "taken";
            // In memory too, so this copy's own saves keep the claim while it sends.
            set((st) => ({ scheduled: st.scheduled.map((x) => (x.id === id ? { ...x, claim: mine } : x)) }));
            return "ours";
          });
        const withoutClaim = ({ claim: _, ...x }: ScheduledSend): ScheduledSend => x;
        for (const snap of due) {
          // An earlier send can take a while: skip it if it was cancelled, edited, retimed, failed, claimed or opened since.
          const r = get().scheduled.find((x) => x.id === snap.id);
          if (!r || r.sendAt !== snap.sendAt || r.lastTry !== snap.lastTry || r.editing || scheduledInFlight.has(r.id)) continue;
          // Open in the composer: wait for the next tick (no error).
          if (get().compose?.draft?.id === r.draftId) continue;
          scheduledInFlight.add(r.id);
          try {
            const claimed = await claim(r.id);
            if (claimed === "gone") setScheduled((list) => list.filter((x) => x.id !== r.id));
            if (claimed !== "ours") continue;
            // Opened in the composer while claiming: let it go and wait.
            if (get().compose?.draft?.id === r.draftId) {
              setScheduled((list) => list.map((x) => (x.id === r.id ? withoutClaim(x) : x)));
              continue;
            }
            const p = providerFor(r.accountId);
            if (!p.sendSavedDraft) throw new Error("This account can't send saved drafts");
            await p.sendSavedDraft(r.draftId);
            setScheduled((list) => list.filter((x) => x.id !== r.id));
            dropRows([r.draftId, r.messageId]);
            (Date.now() - r.sendAt > LATE_MS ? late : onTime).push(r);
          } catch (err) {
            if (err instanceof HttpError && err.status === 404) {
              setScheduled((list) => list.filter((x) => x.id !== r.id));
              toast("A scheduled email was deleted before it went out");
            } else {
              const error = err instanceof Error ? err.message : String(err);
              setScheduled((list) => list.map((x) => (x.id === r.id ? { ...withoutClaim(x), error, lastTry: Date.now() } : x)));
              if (!scheduleFailToasted.has(r.id)) {
                scheduleFailToasted.add(r.id);
                toast.error("Couldn't send a scheduled email", { description: "zMail will try again in 5 minutes. Open Scheduled to send or cancel it." });
              }
            }
          } finally {
            scheduledInFlight.delete(r.id);
          }
        }
        const n = late.length;
        if (n > 0) toast.success(`Sent ${n} scheduled email${n > 1 ? "s" : ""} that ${n > 1 ? "were" : "was"} due at ${timeOf(late[0].sendAt)}`);
        else for (const r of onTime) toast.success("Sent scheduled email", { description: r.subject });
        if (late.length || onTime.length) void get().refresh();
      })();
      // Cleared after the run settles (a run with nothing due finishes before this assignment).
      const settled: Promise<void> = run.finally(() => {
        if (scheduledRun === settled) scheduledRun = null;
      });
      scheduledRun = settled;
      return settled;
    },
  };
}
