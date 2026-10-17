// src/lib/ai/assistant/deps.ts
// Real ToolDeps: the mail store, mail providers, the writing model for drafts,
// the assistant model for kind labels, and the local kind-label cache.

import { toast } from "sonner";
import type { Account, Email, Folder } from "@/lib/types";
import type { BulkOp, UndoEntry } from "@/lib/mail/bulk";
import type { MailProvider } from "@/lib/mail/provider";
import { categoryOf, defaultCalendarFor, providerOf, sectionOf, useMail, type Compose } from "@/lib/store";
import { kvGet, kvSet } from "@/lib/db";
import { assistantProvider, generativeProvider } from "@/lib/ai/providers";
import { draft as writeDraft } from "@/lib/ai/generative";
import { forwardBody } from "@/lib/mail/compose-text";
import { pool } from "@/lib/google/gmail";
import { oneClickUnsubscribe, safeHttps } from "@/lib/mail/unsubscribe";
import { openExternal } from "@/components/mail/email-body";
import { matchesLocal, resolveFolder, type LocalCtx, type MailQuery } from "./query";
import { kindsFor, type Kind } from "./kinds";
import { useAssistant, type Ref } from "./state";
import type { ToolDeps } from "./tools";
import { MODULES } from "./modules";

const KINDS_KEY = "assistant.kinds";
/** Kind labels kept in the local cache (newest first to survive). */
export const KIND_CACHE_MAX = 20_000;
let kindCache: Record<string, Kind> | null = null;

async function loadKinds() {
  kindCache ??= (await kvGet<Record<string, Kind>>(KINDS_KEY).catch(() => null)) ?? {};
  return kindCache;
}

async function saveKinds(learned: Record<string, Kind>) {
  const cache = { ...(await loadKinds()), ...learned };
  const ids = Object.keys(cache);
  // Keep the newest KIND_CACHE_MAX (insertion order approximates recency).
  kindCache = Object.fromEntries(ids.slice(-KIND_CACHE_MAX).map((id) => [id, cache[id]]));
  await kvSet(KINDS_KEY, kindCache).catch(() => {});
}

/**
 * Search mail zMail holds locally (category and section exist only there). A named folder is
 * resolved per account; with none named, Trash, Spam and Drafts are left out like server search.
 */
export function localSearch(emails: Email[], accounts: Account[], folders: Folder[], q: MailQuery, ctx: Omit<LocalCtx, "folderId">): Email[] {
  const scope = new Map<string, { folderId?: string; hidden: Set<string> }>();
  for (const a of accounts) {
    const folder = resolveFolder(q, a.id, folders);
    // A folder this account doesn't have must not widen the search to all of its mail.
    if (q.folder && !folder) continue;
    const hidden = new Set(folder ? [] : folders.filter((f) => f.accountId === a.id && (f.system === "trash" || f.system === "spam" || f.system === "drafts")).map((f) => f.id));
    scope.set(a.id, { folderId: folder?.id, hidden });
  }
  return emails.filter((e) => {
    const sc = scope.get(e.accountId);
    return !!sc && !sc.hidden.has(e.folderId) && matchesLocal(e, q, { ...ctx, folderId: sc.folderId });
  });
}

/**
 * Header rows for refs: known rows first, the rest fetched in 100-id chunks (two at a time).
 * Reports (rows ready, total) as chunks land and stops starting chunks once isCancelled() is true.
 */
export async function fetchHeaders(
  refs: { id: string; accountId: string }[],
  known: Record<string, Email>,
  fetch: (accountId: string, ids: string[]) => Promise<Email[]>,
  onProgress?: (n: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<Email[]> {
  const have = { ...known };
  const missing = refs.filter((r) => !have[r.id]);
  const byAccount = new Map<string, string[]>();
  for (const r of missing) {
    const list = byAccount.get(r.accountId);
    if (list) list.push(r.id);
    else byAccount.set(r.accountId, [r.id]);
  }
  const total = refs.length;
  let n = total - missing.length;
  for (const [accountId, ids] of byAccount) {
    if (isCancelled?.()) break;
    const parts: string[][] = [];
    for (let i = 0; i < ids.length; i += 100) parts.push(ids.slice(i, i + 100));
    await pool(parts, 2, async (part) => {
      if (isCancelled?.()) return;
      const rows = await fetch(accountId, part);
      for (const r of rows) have[r.id] = r;
      n += part.length;
      onProgress?.(n, total);
    });
  }
  return refs.map((r) => have[r.id]).filter((e): e is Email => !!e);
}

/** After a bulk action or its undo, bring the assistant's header rows in line so the next action records the truth. */
function refreshHeaders(entries: UndoEntry[], op: BulkOp, undoing: boolean) {
  const a = useAssistant.getState();
  const s = useMail.getState();
  const stored = new Map(s.emails.map((e) => [e.id, e]));
  const rows: Email[] = [];
  for (const u of entries) {
    const row = a.headers[u.id];
    if (!row) continue;
    // Mail in the store was patched by the action itself; copy its state.
    const live = stored.get(u.id);
    if (live) {
      rows.push({ ...row, folderId: live.folderId, unread: live.unread, starred: live.starred, labels: live.labels });
      continue;
    }
    if (op.kind === "section" || op.kind === "lane") continue;
    if (undoing) {
      if (op.kind === "read") rows.push({ ...row, unread: u.unread });
      else if (op.kind === "star") rows.push({ ...row, starred: u.starred });
      else rows.push({ ...row, folderId: u.folderId, labels: u.labels ?? row.labels });
      continue;
    }
    if (op.kind === "read") rows.push({ ...row, unread: !op.read });
    else if (op.kind === "star") rows.push({ ...row, starred: op.starred });
    else {
      const target = op.kind === "move" ? op.folderId : s.folders.find((f) => f.accountId === u.accountId && f.system === op.kind)?.id;
      // Labels can't be predicted here; a stale label list is never trusted by Undo when it disagrees with the folder.
      if (target) rows.push({ ...row, folderId: target });
    }
  }
  if (rows.length) a.addHeaders(rows);
}

/** Search pages read per account looking for a first hit (Graph can return a page emptied by local filtering). */
export const NEWEST_PAGES = 3;

/**
 * The newest email from a sender: each account's first search hit (providers list newest first),
 * then the newest of those. Search leaves Trash out, so when normal mail has nothing (a cleanup just
 * moved it all) Trash is searched the same way. An account that fails is skipped; if nothing was
 * found and an account failed, that error is thrown.
 */
export async function newestFromAccounts(
  from: string,
  accountIds: string[],
  folders: Folder[],
  providerFor: (accountId: string) => Pick<MailProvider, "search" | "headers">,
): Promise<Ref | null> {
  let firstError: unknown;
  const scan = async (q: MailQuery): Promise<Email | undefined> => {
    let best: Email | undefined;
    for (const accountId of accountIds) {
      try {
        const p = providerFor(accountId);
        let page: string | undefined;
        let r: Awaited<ReturnType<MailProvider["search"]>> | undefined;
        for (let n = 0; n < NEWEST_PAGES; n++) {
          r = await p.search(q, folders, page);
          if (r.ids.length || !r.next) break;
          page = r.next;
        }
        const id = r?.ids[0];
        if (!id) continue;
        const row = r?.headers?.find((h) => h.id === id) ?? (await p.headers([id]))[0];
        if (row && (!best || row.date > best.date)) best = { ...row, accountId };
      } catch (err) {
        firstError ??= err;
      }
    }
    return best;
  };
  const best = (await scan({ from })) ?? (await scan({ from, folder: "trash" }));
  if (!best && firstError !== undefined) throw firstError;
  return best ? { id: best.id, accountId: best.accountId } : null;
}

/** How many emails saving each lane rule moved, by rule id (read by the rule card right after Save). */
const laneMoved = new Map<string, number>();

export function realDeps(): ToolDeps {
  const mail = () => useMail.getState();
  const ctx = () => ({ categoryOf: (id: string) => categoryOf(mail(), id), sectionOf: (e: Email) => sectionOf(mail(), e)?.id });

  return {
    folders: () => mail().folders,
    sections: () => mail().sections,

    async search(q, cap) {
      const s = mail();
      const accounts = s.accounts.filter((a) => !q.account || a.id === q.account);
      // zMail-only fields exist only on mail zMail has sorted, which lives in the store.
      if (q.category || q.section) {
        const hits = localSearch(s.emails, accounts, s.folders, q, ctx());
        return { refs: hits.slice(0, cap).map((e) => ({ id: e.id, accountId: e.accountId })), headers: hits.slice(0, cap), tooMany: hits.length > cap };
      }
      const refs: Ref[] = [];
      const headers: Email[] = [];
      let capped = false;
      for (const a of accounts) {
        const p = providerOf(a.id);
        let page: string | undefined;
        let limit: number | undefined;
        let scanned = 0;
        do {
          const r = await p.search(q, s.folders, page);
          if (r.estimate !== undefined && r.estimate > cap * 1.5) return { refs: [], headers: [], tooMany: true };
          refs.push(...r.ids.map((id) => ({ id, accountId: a.id })));
          headers.push(...(r.headers ?? []));
          if (refs.length > cap) return { refs: refs.slice(0, cap), headers, tooMany: true };
          limit ??= r.limit;
          scanned += r.scanned ?? r.ids.length;
          page = r.next;
        } while (page);
        if (limit !== undefined && scanned >= limit) capped = true;
      }
      return { refs, headers, tooMany: false, ...(capped ? { capped } : {}) };
    },

    loadHeaders(refs, onProgress, isCancelled) {
      const known = { ...useAssistant.getState().headers };
      for (const e of mail().emails) known[e.id] = e;
      return fetchHeaders(
        refs,
        known,
        async (accountId, ids) => {
          const rows = await providerOf(accountId).headers(ids);
          useAssistant.getState().addHeaders(rows);
          return rows;
        },
        onProgress,
        isCancelled,
      );
    },

    getEmail: (ref) => mail().ensureEmail(ref),

    view() {
      const s = mail();
      const open = s.selectedId ? s.emails.find((e) => e.id === s.selectedId) : undefined;
      const a = useAssistant.getState();
      return {
        open,
        checked: s.emails.filter((e) => s.checked.has(e.id)),
        listLabel: a.activeSetId ? (a.sets[a.activeSetId]?.label ?? "Assistant set") : s.view.kind === "folder" ? (s.folders.find((f) => f.id === (s.view as { folderId: string }).folderId)?.name ?? "Folder") : s.view.kind,
        setId: a.activeSetId,
        compose: s.composeView,
      };
    },

    async kinds(rows, onProgress) {
      const { kinds, learned } = await kindsFor(rows, { categoryOf: ctx().categoryOf, cache: await loadKinds(), provider: assistantProvider(), onProgress });
      if (Object.keys(learned).length) await saveKinds(learned);
      return kinds;
    },

    async bulk(emails, op, opts) {
      const res = await mail().bulkApply(emails, op, opts);
      refreshHeaders(res.undo, op, false);
      return res;
    },
    async undo(entries, op) {
      const res = await mail().bulkUndo(entries, op);
      const failed = new Set(res.failed.map((e) => e.id));
      refreshHeaders(entries.filter((u) => !failed.has(u.id)), op, true);
      return res;
    },

    async draft(args) {
      const s = mail();
      const email = args.email;
      const replying = args.kind === "reply" || args.kind === "reply_all";
      // The assistant's own subject and body skip the writer model; instructions alone still use it.
      const out = args.body ? { subject: args.subject ?? "", body: args.body } : await writeDraft(generativeProvider(), args.instructions ?? "", s.me, replying ? email : undefined);
      const cc = { ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}) };
      // What the Draft-with-AI box handed over: files to attach and the account to send from.
      const st = useAssistant.getState();
      const extra: Partial<Compose> = {
        ...(st.pendingAttachments.length ? { attachments: st.pendingAttachments.map((f) => ({ ...f, size: Math.floor((f.base64.length * 3) / 4) })) } : {}),
        ...(st.pendingFrom ? { fromAccountId: st.pendingFrom } : {}),
      };
      st.setPendingAttachments([]);
      st.setPendingFrom(null);
      if (args.kind === "new") return { mode: "blank", ...extra, prefill: { to: args.to, ...cc, subject: out.subject, body: out.body } };
      if (args.kind === "forward" && email)
        return { mode: "blank", replyTo: email.id, forward: true, ...extra, prefill: { to: args.to, ...cc, body: `${out.body}${forwardBody(email)}` } };
      return { mode: "blank", replyTo: email?.id, ...(args.kind === "reply_all" ? { all: true } : {}), ...extra, prefill: { body: out.body } };
    },

    openCompose: (c) => mail().openCompose(c),
    defaultCalendar: () => {
      const s = mail();
      return defaultCalendarFor(s, s.accounts.find((a) => a.kind !== "mock")?.id ?? s.accounts[0]?.id ?? "") || undefined;
    },
    createEvent: async (e) => void (await mail().createEvent(e)),
    accountLabel: (id) => {
      const s = mail();
      const a = s.accounts.length > 1 ? s.accounts.find((x) => x.id === id) : undefined;
      return a ? `${a.label ?? a.name} · ${a.address}` : undefined;
    },
    accountAddress: (id) => mail().accounts.find((x) => x.id === id)?.address ?? "",
    addRule: (input) => {
      // Saving a lane rule applies it at once (addAutoRule → applyLaneRules). Count what that changed:
      // emails the user placed themselves keep their lane, so matches alone would overstate it.
      const before = useMail.getState().overrides;
      const id = useMail.getState().addAutoRule(input).id;
      const after = useMail.getState().overrides;
      if (after !== before) laneMoved.set(id, new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => before[k] !== after[k])).size);
      return id;
    },
    laneMatches: (ruleId) => laneMoved.get(ruleId) ?? 0,

    // Straight from the provider: a cached copy may predate List-Unsubscribe parsing.
    freshMessage: (ref) => providerOf(ref.accountId).getMessage(ref.id),

    // Not deps.search(q, 1): Gmail's result estimate would call any busy sender "too many".
    newestFrom: (from) => {
      const s = mail();
      return newestFromAccounts(from, s.accounts.map((a) => a.id), s.folders, providerOf);
    },

    sendUnsubscribe: (accountId, to, subject) => mail().send(accountId, { to: [to], subject, text: "unsubscribe" }),
    oneClick: (url) => oneClickUnsubscribe(url),
    openLink: (url) => {
      const safe = safeHttps(url);
      if (safe) void openExternal(safe);
    },
    toast: (text, undo) => void toast(text, undo ? { action: { label: "Undo", onClick: undo } } : undefined),
    ext: Object.fromEntries(MODULES.filter((m) => m.realDeps).map((m) => [m.id, m.realDeps!()])),
  };
}
