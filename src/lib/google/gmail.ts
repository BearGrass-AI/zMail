// Gmail API provider: labels as folders, full fetch on first run, incremental
// sync via users.history afterwards, everything cached in local SQLite.

import type { Account, Email, Folder } from "@/lib/types";
import type { BatchOutcome, EmbeddedImage, MailProvider, SearchPage, SendRequest, SyncChanges } from "@/lib/mail/provider";
import { gmailQuery, resolveFolder, type MailQuery } from "@/lib/ai/assistant/query";
import { HttpError, request, requestText, type Method } from "@/lib/transport";
import { accessToken } from "@/lib/oauth";
import { cacheDeleteMessages, cacheGetMessage, cacheListIds, cacheListMessages, cachePutFolders, cachePutMessages, syncGet, syncSet } from "@/lib/db";
import {
  buildMime,
  encodeBase64Url,
  labelChangesForMove,
  labelFolderId,
  folderForLabels,
  inlineParts,
  labelsToFolders,
  messageToEmail,
  parseBatchResponse,
  type GLabel,
  type GMessage,
} from "./gmail-map";
import { gmailCost, limiterFor, withQuota } from "./quota";
import { NeedsPermissionError, fromGmailVacation, isPermissionError, toGmailVacation, type AutoReply, type GmailVacation } from "@/lib/mail/auto-replies";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Run `fn` over items with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export class GmailProvider implements MailProvider {
  private labelFolder = new Map<string, string>(); // Gmail label id → folder id (user labels)
  private labelsByMessage = new Map<string, string[]>();

  constructor(readonly account: Account) {}

  /** Every Gmail call is paced against the account's per-minute quota and retried if Google pushes back. */
  private api<T>(method: Method, path: string, body?: unknown): Promise<T> {
    return withQuota(limiterFor(this.account.id), gmailCost(method, path), async () => {
      const token = await accessToken(this.account.id);
      return request<T>(method, `${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, body });
    });
  }

  async profile() {
    return this.api<{ emailAddress: string; historyId: string; messagesTotal: number }>("GET", "/profile");
  }

  private folderCache?: { at: number; folders: Folder[] };

  /** Folder tree, re-fetched at most every 10 minutes (counts change slowly; refresh runs every 2). */
  async listFolders(force = false): Promise<Folder[]> {
    if (!force && this.folderCache && Date.now() - this.folderCache.at < 10 * 60_000) return this.folderCache.folders;
    const folders = await this.fetchFolders();
    this.folderCache = { at: Date.now(), folders };
    return folders;
  }

  /** Full label name ("Finance/Taxes") by folder id, for user labels. */
  private labelNames = new Map<string, string>();

  /**
   * One new label, nested by name: "Kids" under a "Family" parent is the label "Family/Kids". A parent that
   * only exists because a deeper label implies it (a `path:` folder) is created as a real label first.
   */
  async createFolder(name: string, parentId?: string): Promise<Folder> {
    const prefix = `${this.account.id}:`;
    if (parentId && !parentId.startsWith(prefix)) throw new Error("That parent folder belongs to another account.");
    const implied = !!parentId?.startsWith(`${prefix}path:`);
    let parentPath: string | undefined;
    if (parentId) {
      if (implied) parentPath = parentId.slice(`${prefix}path:`.length);
      else {
        if (!this.labelNames.has(parentId)) await this.listFolders(true);
        parentPath = this.labelNames.get(parentId);
        if (parentPath === undefined) throw new Error("That parent folder no longer exists.");
      }
    }
    if (implied && parentPath) {
      const parts = parentPath.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join("/");
        if (![...this.labelNames.values()].some((n) => n.toLowerCase() === path.toLowerCase())) await this.createLabel(path);
      }
    }
    const full = parentPath ? `${parentPath}/${name}` : name;
    const label = await this.createLabel(full);
    const folder: Folder = { id: labelFolderId(this.account.id, label.id), accountId: this.account.id, name: label.name.split("/").pop() ?? name, parentId };
    // Real labels replaced made-up parents (or this label replaced a grouping of the same name), so the next
    // folder sync re-reads the tree; otherwise the new folder joins the cached one.
    const wasGrouping = !!this.folderCache?.folders.some((f) => f.id === `${prefix}path:${full}`);
    if (implied || wasGrouping) this.folderCache = undefined;
    else if (this.folderCache) this.folderCache.folders = [...this.folderCache.folders.filter((f) => f.id !== folder.id), folder];
    return folder;
  }

  /** POST a user label by its full name; one that already exists (409) is looked up instead. */
  private async createLabel(fullName: string): Promise<GLabel> {
    let label: GLabel;
    try {
      label = await this.api<GLabel>("POST", "/labels", { name: fullName, labelListVisibility: "labelShow", messageListVisibility: "show" });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      const { labels } = await this.api<{ labels: GLabel[] }>("GET", "/labels");
      const there = labels.find((l) => l.type === "user" && l.name.toLowerCase() === fullName.toLowerCase());
      if (!there) throw err;
      label = there;
    }
    const id = labelFolderId(this.account.id, label.id);
    this.labelFolder.set(label.id, id);
    this.labelNames.set(id, label.name);
    return label;
  }

  /** Cheap count refresh: one `labels.get` (1 quota unit) per label, at most 5. */
  async refreshCounts(folderIds: string[]): Promise<Record<string, number>> {
    const prefix = `${this.account.id}:`;
    const labelIds = folderIds
      .filter((id) => id.startsWith(prefix))
      .map((id) => id.slice(prefix.length))
      .filter((l) => l && l !== "ARCHIVE" && !l.startsWith("path:"))
      .slice(0, 5);
    const out: Record<string, number> = {};
    for (const l of labelIds) {
      const { messagesUnread } = await this.api<GLabel>("GET", `/labels/${encodeURIComponent(l)}`);
      if (typeof messagesUnread === "number") out[`${prefix}${l}`] = messagesUnread;
    }
    if (this.folderCache) {
      this.folderCache.folders = this.folderCache.folders.map((f) => (f.id in out ? { ...f, unread: out[f.id] } : f));
    }
    return out;
  }

  private async fetchFolders(): Promise<Folder[]> {
    const { labels } = await this.api<{ labels: GLabel[] }>("GET", "/labels");
    // labels.list has no counts; fetch them for Inbox and user labels.
    const withCounts = await pool(labels, 8, async (l) =>
      l.type === "user" || l.id === "INBOX" || l.id === "SPAM" || l.id === "DRAFT"
        ? { ...l, messagesUnread: (await this.api<GLabel>("GET", `/labels/${encodeURIComponent(l.id)}`)).messagesUnread }
        : l,
    );
    const folders = labelsToFolders(this.account.id, withCounts);
    this.labelFolder = new Map(withCounts.filter((l) => l.type === "user").map((l) => [l.id, `${this.account.id}:${l.id}`]));
    this.labelNames = new Map(withCounts.filter((l) => l.type === "user").map((l) => [labelFolderId(this.account.id, l.id), l.name]));
    // Server unread counts double-count mail zMail has synced; keep them only for unsynced labels.
    void cachePutFolders(this.account.id, folders.map((f) => [f.id, JSON.stringify(f)]));
    return folders;
  }

  private toEmail(m: GMessage): Email {
    this.labelsByMessage.set(m.id, m.labelIds ?? []);
    return messageToEmail(this.account.id, m, (id) => this.labelFolder.get(id));
  }

  private async fetchMessages(ids: string[]): Promise<Email[]> {
    return (await this.fetchOrGone(ids)).emails;
  }

  /**
   * Full messages for `ids`. A message deleted between list and get returns 404: it's
   * listed in `gone`. Any other failure (network, auth, rate limit) aborts so the sync
   * cursor doesn't advance.
   */
  private async fetchOrGone(ids: string[]): Promise<{ emails: Email[]; gone: string[] }> {
    const gone: string[] = [];
    const msgs = await pool(ids, 4, (id) =>
      this.api<GMessage>("GET", `/messages/${id}?format=full`).catch((err) => {
        if (err instanceof HttpError && err.status === 404) {
          gone.push(id);
          return null;
        }
        throw err;
      }),
    );
    return { emails: msgs.filter((m): m is GMessage => !!m).map((m) => this.toEmail(m)), gone };
  }

  private async save(emails: Email[]) {
    await cachePutMessages(
      this.account.id,
      emails.map((e) => ({ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) })),
    );
  }

  /** One page of Inbox mail not yet cached; saved to the cache chunk by chunk. */
  async backfillInbox(cursor?: string): Promise<{ emails: Email[]; next?: string; total?: number }> {
    const q = new URLSearchParams({ q: "in:inbox -in:chats", maxResults: "100" });
    if (cursor) q.set("pageToken", cursor);
    const res = await this.api<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>("GET", `/messages?${q}`);
    const have = new Set(await cacheListIds(this.account.id, [labelFolderId(this.account.id, "INBOX")]));
    const todo = (res.messages ?? []).map((m) => m.id).filter((id) => !have.has(id));
    const emails: Email[] = [];
    for (let i = 0; i < todo.length; i += 25) {
      const chunk = await this.fetchMessages(todo.slice(i, i + 25));
      await this.save(chunk);
      emails.push(...chunk);
    }
    return { emails, next: res.nextPageToken, total: res.resultSizeEstimate };
  }

  /** Full fetch of recent mail (first run, or when history has expired). */
  private async fullSync(limit: number): Promise<void> {
    const { historyId } = await this.profile();
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ maxResults: String(Math.min(100, limit - ids.length)), q: "newer_than:90d -in:chats" });
      if (pageToken) q.set("pageToken", pageToken);
      const res = await this.api<{ messages?: { id: string }[]; nextPageToken?: string }>("GET", `/messages?${q}`);
      ids.push(...(res.messages ?? []).map((m) => m.id));
      pageToken = res.nextPageToken;
    } while (pageToken && ids.length < limit);
    // Save as we go and skip what an interrupted earlier attempt already cached,
    // so a slow or failed first sync never starts from zero.
    const have = new Set(await cacheListIds(this.account.id, [labelFolderId(this.account.id, "INBOX")]));
    const todo = ids.filter((id) => !have.has(id));
    for (let i = 0; i < todo.length; i += 25) await this.save(await this.fetchMessages(todo.slice(i, i + 25)));
    await this.reconcileInbox(new Set(todo));
    await syncSet(this.account.id, historyId);
  }

  /**
   * After a history gap, cached Inbox rows may have been archived, deleted, read or starred elsewhere.
   * List what's in the Inbox now (ids only, 500 per page) and refetch every cached Inbox
   * row that isn't: gone (404) leaves the cache, the rest are saved with their new folder.
   * Rows still in the Inbox (except `fresh`, just downloaded) get their labels refreshed.
   */
  private async reconcileInbox(fresh: Set<string>): Promise<void> {
    const inbox = labelFolderId(this.account.id, "INBOX");
    const now = new Set<string>();
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ q: "in:inbox -in:chats", maxResults: "500" });
      if (pageToken) q.set("pageToken", pageToken);
      const res = await this.api<{ messages?: { id: string }[]; nextPageToken?: string }>("GET", `/messages?${q}`);
      for (const m of res.messages ?? []) now.add(m.id);
      pageToken = res.nextPageToken;
    } while (pageToken);
    const cached = await cacheListIds(this.account.id, [inbox], 0);
    const stale = cached.filter((id) => !now.has(id));
    for (let i = 0; i < stale.length; i += 25) {
      const { emails, gone } = await this.fetchOrGone(stale.slice(i, i + 25));
      if (gone.length) await cacheDeleteMessages(gone);
      await this.save(emails);
    }
    const kept = cached.filter((id) => now.has(id) && !fresh.has(id));
    for (let i = 0; i < kept.length; i += 100) await this.patchLabels(await this.cachedRows(kept.slice(i, i + 100)));
  }

  /** Full cached rows by id (list rows are slim); ids not cached are left out. */
  private async cachedRows(ids: string[]): Promise<Map<string, Email>> {
    const found = await Promise.all(ids.map(async (id) => [id, await cacheGetMessage(id)] as const));
    return new Map(found.flatMap(([id, c]) => (c ? [[id, JSON.parse(c.json) as Email] as const] : [])));
  }

  /**
   * Label-only refresh of cached rows from a `format=minimal` read: read, star, labels and folder change,
   * the body is kept. Ids Gmail answers 404 for are uncached and returned in `gone`.
   */
  private async patchLabels(rows: Map<string, Email>): Promise<{ patched: Email[]; gone: string[] }> {
    if (!rows.size) return { patched: [], gone: [] };
    const { labels, gone } = await this.labelsFor([...rows.keys()]);
    if (gone.length) await cacheDeleteMessages(gone);
    const patched: Email[] = [];
    for (const [id, labelIds] of labels) {
      const e = rows.get(id);
      if (!e) continue;
      this.labelsByMessage.set(id, labelIds);
      patched.push({
        ...e,
        labels: labelIds,
        unread: labelIds.includes("UNREAD"),
        starred: labelIds.includes("STARRED"),
        folderId: folderForLabels(this.account.id, labelIds, (l) => this.labelFolder.get(l)),
      });
    }
    if (patched.length) await this.save(patched);
    return { patched, gone };
  }

  /** Apply changes since the last sync and return them. Returns null if a full sync is needed. */
  private async incrementalSync(startHistoryId: string): Promise<{ changed: Email[]; removed: string[] } | null> {
    const added = new Set<string>();
    const relabeled = new Set<string>();
    const deleted = new Set<string>();
    let pageToken: string | undefined;
    let latest = startHistoryId;
    try {
      do {
        const q = new URLSearchParams({ startHistoryId, maxResults: "500" });
        if (pageToken) q.set("pageToken", pageToken);
        const res = await this.api<{
          history?: {
            messagesAdded?: { message: { id: string } }[];
            messagesDeleted?: { message: { id: string } }[];
            labelsAdded?: { message: { id: string } }[];
            labelsRemoved?: { message: { id: string } }[];
          }[];
          historyId: string;
          nextPageToken?: string;
        }>("GET", `/history?${q}`);
        for (const h of res.history ?? []) {
          for (const x of h.messagesAdded ?? []) added.add(x.message.id);
          for (const x of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) relabeled.add(x.message.id);
          for (const x of h.messagesDeleted ?? []) deleted.add(x.message.id);
        }
        latest = res.historyId;
        pageToken = res.nextPageToken;
      } while (pageToken);
    } catch (err) {
      // 404: startHistoryId is too old — fall back to a full sync.
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
    for (const id of deleted) {
      added.delete(id);
      relabeled.delete(id);
    }
    for (const id of added) relabeled.delete(id); // added counts as added
    const removed = [...deleted];
    if (removed.length) await cacheDeleteMessages(removed);

    // Label-only changes to mail we already hold need just the new label list, not the whole message.
    const toFetch = new Set(added);
    // No cached row means not cached, so download it.
    const rows = await this.cachedRows([...relabeled]);
    for (const id of relabeled) if (!rows.has(id)) toFetch.add(id);
    const { patched, gone } = await this.patchLabels(rows);
    removed.push(...gone); // only a 404 means the message is gone
    const fetched = toFetch.size ? await this.fetchMessages([...toFetch]) : [];
    if (fetched.length) await this.save(fetched);
    const out = [...fetched, ...patched];
    await syncSet(this.account.id, latest);
    return { changed: out, removed };
  }

  async listMessages(opts?: { folderId?: string; limit?: number }): Promise<Email[]> {
    const cursor = await syncGet(this.account.id);
    const ok = cursor ? (await this.incrementalSync(cursor)) !== null : false;
    if (!ok) await this.fullSync(opts?.limit ?? 300);
    const cached = await cacheListMessages(this.account.id, undefined, [labelFolderId(this.account.id, "INBOX")]);
    const emails = cached.map((c) => JSON.parse(c.json) as Email);
    for (const e of emails) if (!this.labelsByMessage.has(e.id)) this.labelsByMessage.set(e.id, e.labels);
    return emails.filter((e) => !opts?.folderId || e.folderId === opts.folderId);
  }

  async syncChanges(): Promise<SyncChanges> {
    const cursor = await syncGet(this.account.id);
    const res = cursor ? await this.incrementalSync(cursor) : null;
    if (!res) {
      await this.fullSync(300);
      return { full: true };
    }
    return { full: false, ...res };
  }

  private async modify(id: string, add: string[], remove: string[]) {
    const res = await this.api<{ labelIds: string[] }>("POST", `/messages/${id}/modify`, { addLabelIds: add, removeLabelIds: remove });
    this.labelsByMessage.set(id, res.labelIds ?? []);
  }

  async move(emailId: string, folderId: string) {
    if (folderId === `${this.account.id}:TRASH`) {
      await this.api("POST", `/messages/${emailId}/trash`);
      return;
    }
    const { add, remove } = labelChangesForMove(this.account.id, this.labelsByMessage.get(emailId) ?? [], folderId);
    await this.modify(emailId, add, remove);
  }

  setRead(emailId: string, read: boolean) {
    return read ? this.modify(emailId, [], ["UNREAD"]) : this.modify(emailId, ["UNREAD"], []);
  }

  setStarred(emailId: string, starred: boolean) {
    return starred ? this.modify(emailId, ["STARRED"], []) : this.modify(emailId, [], ["STARRED"]);
  }

  readonly batchSize = 1000;

  async search(q: MailQuery, folders: Folder[], page?: string): Promise<SearchPage> {
    const folder = resolveFolder(q, this.account.id, folders);
    // A folder the query names but this account doesn't have must not widen the search.
    if (q.folder && !folder) return { ids: [] };
    // Drafts aren't mail to act on; leave them out unless the query names a folder.
    const params = new URLSearchParams({ q: `${gmailQuery(q, folder, folders)}${folder ? "" : " -in:drafts"} -in:chats`.trim(), maxResults: "500" });
    if (page) params.set("pageToken", page);
    const res = await this.api<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>("GET", `/messages?${params}`);
    return { ids: (res.messages ?? []).map((m) => m.id), next: res.nextPageToken, estimate: res.resultSizeEstimate };
  }

  /** Metadata rows for any number of ids, in HTTP batch requests of at most 100. Throws 429 if Google is still throttling after one retry. */
  async headers(ids: string[]): Promise<Email[]> {
    const rows: Email[] = [];
    for (let i = 0; i < ids.length; i += 100) rows.push(...(await this.headerChunk(ids.slice(i, i + 100), true)));
    return rows;
  }

  private async headerChunk(ids: string[], retry: boolean): Promise<Email[]> {
    const meta = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post&metadataHeaders=Auto-Submitted&metadataHeaders=X-Autoreply&metadataHeaders=X-Autorespond";
    // 404s are deleted mail and are left out.
    const parts = await this.batchGets(ids, meta, retry);
    return parts.filter((p) => p.status === 200 && p.body?.id).map((p) => ({ ...this.toEmail(p.body!), partial: true }));
  }

  /** Current label ids for `ids` (HTTP batches of 100, `format=minimal`). `gone` lists ids Gmail answered 404 for. */
  private async labelsFor(ids: string[]): Promise<{ labels: Map<string, string[]>; gone: string[] }> {
    const labels = new Map<string, string[]>();
    const gone: string[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      for (const p of await this.batchGets(ids.slice(i, i + 100), "format=minimal", true)) {
        if (p.status === 200 && p.body?.id) labels.set(p.body.id, p.body.labelIds ?? []);
        else if (p.status === 404) gone.push(p.id);
        else throw new HttpError(p.status || 500, `Gmail could not refresh labels for ${p.id}.`);
      }
    }
    return { labels, gone };
  }

  /** One multipart batch of message GETs with the given query. Throttled parts are retried once; others come back with their status. */
  private async batchGets(ids: string[], query: string, retry: boolean): Promise<{ id: string; status: number; body?: GMessage }[]> {
    if (!ids.length) return [];
    const boundary = "zmail_batch";
    const body =
      ids.map((id, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <m${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?${query}\r\n\r\n`).join("") +
      `--${boundary}--`;
    const text = await withQuota(limiterFor(this.account.id), 5 * ids.length, async () => {
      const token = await accessToken(this.account.id);
      return requestText("POST", "https://gmail.googleapis.com/batch/gmail/v1", {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/mixed; boundary=${boundary}` },
        body,
      });
    });
    const parts = parseBatchResponse<GMessage>(text);
    const rows: { id: string; status: number; body?: GMessage }[] = parts.flatMap((p, pos) => (p.status === 429 ? [] : [{ id: ids[p.index ?? pos] ?? ids[pos], status: p.status, body: p.body }])).filter((r) => !!r.id);
    const throttled = parts.flatMap((p, pos) => (p.status === 429 ? [ids[p.index ?? pos] ?? ids[pos]] : [])).filter((id): id is string => !!id);
    if (throttled.length) {
      if (!retry) throw new HttpError(429, "Gmail is still throttling requests.");
      await new Promise((r) => setTimeout(r, 1000));
      rows.push(...(await this.batchGets(throttled, query, false)));
    }
    return rows;
  }

  async getMessage(id: string): Promise<Email> {
    const [e] = await this.fetchMessages([id]);
    if (!e) throw new HttpError(404, "That email no longer exists.");
    await this.save([e]);
    return e;
  }

  /** One batchModify call per 1000 ids. Failed chunks are returned, not thrown; labels update only for chunks that succeeded. */
  private async batchModify(ids: string[], add: string[], remove: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const part = ids.slice(i, i + 1000);
      try {
        await this.api("POST", "/messages/batchModify", { ids: part, addLabelIds: add, removeLabelIds: remove });
      } catch {
        failed.push(...part);
        continue;
      }
      for (const id of part) {
        const cur = new Set(this.labelsByMessage.get(id) ?? []);
        add.forEach((l) => cur.add(l));
        remove.forEach((l) => cur.delete(l));
        this.labelsByMessage.set(id, [...cur]);
      }
    }
    return failed;
  }

  async batchMove(emails: Email[], folderId: string): Promise<BatchOutcome> {
    const groups = new Map<string, { add: string[]; remove: string[]; ids: string[] }>();
    for (const e of emails) {
      const ch = labelChangesForMove(this.account.id, this.labelsByMessage.get(e.id) ?? e.labels ?? [], folderId);
      const key = JSON.stringify(ch);
      const g = groups.get(key) ?? { ...ch, ids: [] };
      g.ids.push(e.id);
      groups.set(key, g);
    }
    const failed: string[] = [];
    for (const g of groups.values()) failed.push(...(await this.batchModify(g.ids, g.add, g.remove)));
    return { skipped: [], failed };
  }

  /**
   * Undo of a move: bring folder labels (Inbox, Trash, Spam, user labels) back to the
   * recorded set. Read, star and category labels are left alone.
   */
  async restoreLabels(entries: { id: string; labels: string[] }[]): Promise<BatchOutcome> {
    const folderish = (l: string) => l === "INBOX" || l === "TRASH" || l === "SPAM" || l.startsWith("Label_");
    const groups = new Map<string, { add: string[]; remove: string[]; ids: string[] }>();
    for (const en of entries) {
      const want = new Set(en.labels.filter(folderish));
      const known = this.labelsByMessage.get(en.id);
      const have = new Set((known ?? []).filter(folderish));
      const add = [...want].filter((l) => !have.has(l)).sort();
      // Unknown current state: at least make sure it leaves Trash/Spam unless it was there.
      const remove = known ? [...have].filter((l) => !want.has(l)).sort() : ["TRASH", "SPAM"].filter((l) => !want.has(l));
      const key = JSON.stringify({ add, remove });
      const g = groups.get(key) ?? { add, remove, ids: [] };
      g.ids.push(en.id);
      groups.set(key, g);
    }
    const failed: string[] = [];
    for (const g of groups.values()) if (g.add.length || g.remove.length) failed.push(...(await this.batchModify(g.ids, g.add, g.remove)));
    return { skipped: [], failed };
  }

  async batchSetRead(ids: string[], read: boolean): Promise<BatchOutcome> {
    return { skipped: [], failed: await this.batchModify(ids, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []) };
  }

  async batchSetStarred(ids: string[], starred: boolean): Promise<BatchOutcome> {
    return { skipped: [], failed: await this.batchModify(ids, starred ? ["STARRED"] : [], starred ? [] : ["STARRED"]) };
  }

  private mimeFor(msg: SendRequest): string {
    return buildMime({
      from: this.account.address,
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      inline: msg.inline,
      inReplyTo: msg.replyTo?.rfc?.messageId,
      references: msg.replyTo?.rfc?.references,
      attachments: msg.attachments,
    });
  }

  /** Raw message plus Gmail's thread id, which only means something in the replied-to email's own account. */
  private messageFor(msg: SendRequest) {
    const sameAccount = msg.replyTo?.accountId === this.account.id;
    return { raw: encodeBase64Url(this.mimeFor(msg)), ...(msg.replyTo && sameAccount ? { threadId: msg.replyTo.threadId } : {}) };
  }

  async send(msg: SendRequest) {
    await this.api("POST", "/messages/send", this.messageFor(msg));
  }

  async saveDraft(msg: SendRequest, draftId?: string): Promise<{ draftId: string; messageId: string }> {
    const message = this.messageFor(msg);
    const res = draftId
      ? await this.api<{ id: string; message: { id: string } }>("PUT", `/drafts/${draftId}`, { id: draftId, message })
      : await this.api<{ id: string; message: { id: string } }>("POST", "/drafts", { message });
    return { draftId: res.id, messageId: res.message.id };
  }

  async sendDraft(msg: SendRequest, draftId: string) {
    await this.saveDraft(msg, draftId);
    await this.api("POST", "/drafts/send", { id: draftId });
  }

  /**
   * Scheduled send: Gmail can't hold mail on the server, so zMail sends the saved draft at the time.
   * If the user edits that draft directly in Gmail meanwhile, the edited version goes out (acceptable).
   */
  async sendSavedDraft(draftId: string) {
    await this.api("POST", "/drafts/send", { id: draftId });
  }

  async deleteDraft(draftId: string) {
    await this.api("DELETE", `/drafts/${draftId}`);
  }

  /** The draft holding `messageId`, searched across every page of Drafts. Throws if it isn't there (a message id is not a draft id). */
  async draftIdFor(messageId: string): Promise<string> {
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ maxResults: "500" });
      if (pageToken) q.set("pageToken", pageToken);
      const res = await this.api<{ drafts?: { id: string; message: { id: string } }[]; nextPageToken?: string }>("GET", `/drafts?${q}`);
      const hit = res.drafts?.find((d) => d.message.id === messageId);
      if (hit) return hit.id;
      pageToken = res.nextPageToken;
    } while (pageToken);
    throw new Error("That draft is no longer in Gmail's Drafts.");
  }

  async getAttachment(emailId: string, attachmentId: string): Promise<string> {
    const res = await this.api<{ data: string }>("GET", `/messages/${emailId}/attachments/${attachmentId}`);
    return res.data.replace(/-/g, "+").replace(/_/g, "/");
  }

  async inlineImages(emailId: string): Promise<EmbeddedImage[]> {
    const m = await this.api<GMessage>("GET", `/messages/${emailId}?format=full`);
    const parts = inlineParts(m.payload);
    return pool(parts, 4, async (p) => ({
      cid: p.cid,
      mimeType: p.mimeType,
      base64: (p.data ?? (await this.getAttachment(emailId, p.attachmentId!))).replace(/-/g, "+").replace(/_/g, "/"),
    }));
  }

  async getAutoReply(): Promise<AutoReply> {
    try {
      return fromGmailVacation(await this.api<GmailVacation>("GET", "/settings/vacation"));
    } catch (e) {
      if (isPermissionError(e)) throw new NeedsPermissionError();
      throw e;
    }
  }

  async setAutoReply(r: AutoReply): Promise<void> {
    try {
      // Gmail has one reply for everyone; an Outlook-style external message is dropped.
      const mine = toGmailVacation({ ...r, externalMessage: undefined });
      // PUT replaces the whole resource, so start from what's there to keep fields zMail doesn't edit.
      let current: GmailVacation = {};
      try {
        current = await this.api<GmailVacation>("GET", "/settings/vacation");
      } catch (e) {
        if (isPermissionError(e)) throw e;
        // Any other read failure: save what we have rather than block the user.
      }
      const merged: GmailVacation = { ...current, ...mine };
      // A cleared schedule must not survive from the old settings.
      if (mine.startTime === undefined) delete merged.startTime;
      if (mine.endTime === undefined) delete merged.endTime;
      await this.api("PUT", "/settings/vacation", merged);
    } catch (e) {
      if (isPermissionError(e)) throw new NeedsPermissionError();
      throw e;
    }
  }
}
