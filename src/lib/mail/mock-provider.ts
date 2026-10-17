import type { Account, Email, Folder } from "@/lib/types";
import type { BatchOutcome, MailProvider, SearchPage, SendRequest } from "./provider";
import { FOLDERS, seed } from "./mock-data";
import { matchesLocal, resolveFolder, type MailQuery } from "@/lib/ai/assistant/query";
import type { AutoReply } from "./auto-replies";

/** Shared in-memory store so multiple mock accounts see one dataset. */
const store = { emails: seed() };
let draftSeq = 0;
/** Demo automatic replies by account id, kept for the session. */
const autoReplies = new Map<string, AutoReply>();
/** Folders made in the demo this session (the seeded ones are in FOLDERS). */
const madeFolders: Folder[] = [];
let folderSeq = 0;

export type MockOverlay = Record<string, Pick<Email, "folderId" | "unread" | "starred">>;

/** Re-apply the user's saved changes (moves, read, star) to the seeded mailbox. */
export function applyMockOverlay(overlay: MockOverlay) {
  for (const e of store.emails) {
    const o = overlay[e.id];
    if (o) Object.assign(e, o);
  }
}

export class MockMailProvider implements MailProvider {
  readonly batchSize = 100;

  async search(q: MailQuery, folders: Folder[], page?: string): Promise<SearchPage> {
    const folder = resolveFolder(q, this.account.id, folders);
    // A folder that doesn't resolve for this account must not widen the search.
    if (q.folder && !folder) return { ids: [] };
    const hidden = new Set(folders.filter((f) => f.accountId === this.account.id && (f.system === "trash" || f.system === "spam" || f.system === "drafts")).map((f) => f.id));
    const hits = store.emails
      .filter((e) => e.accountId === this.account.id)
      .filter((e) => (folder ? true : !hidden.has(e.folderId)))
      .filter((e) => matchesLocal(e, q, { folderId: folder?.id, categoryOf: () => undefined, sectionOf: () => undefined }))
      .sort((a, b) => b.date.localeCompare(a.date));
    const start = Number(page ?? 0);
    const slice = hits.slice(start, start + 500);
    return { ids: slice.map((e) => e.id), headers: slice.map((e) => ({ ...e, partial: true })), next: start + 500 < hits.length ? String(start + 500) : undefined };
  }

  async headers(ids: string[]): Promise<Email[]> {
    return store.emails.filter((e) => ids.includes(e.id)).map((e) => ({ ...e, partial: true }));
  }

  async getMessage(id: string): Promise<Email> {
    const e = store.emails.find((x) => x.id === id);
    if (!e) throw new Error("That email no longer exists.");
    return { ...e };
  }

  private each(ids: string[], p: Partial<Email>): BatchOutcome {
    const skipped = ids.filter((id) => !store.emails.some((e) => e.id === id));
    for (const id of ids) this.patch(id, p);
    return { skipped, failed: [] };
  }

  async batchMove(emails: Email[], folderId: string) {
    return this.each(emails.map((e) => e.id), { folderId });
  }
  async batchSetRead(ids: string[], read: boolean) {
    return this.each(ids, { unread: !read });
  }
  async batchSetStarred(ids: string[], starred: boolean) {
    return this.each(ids, { starred });
  }

  constructor(readonly account: Account) {}

  async listFolders(): Promise<Folder[]> {
    return [...FOLDERS, ...madeFolders].filter((f) => f.accountId === this.account.id);
  }

  async createFolder(name: string, parentId?: string): Promise<Folder> {
    const lc = name.toLowerCase();
    const there = (await this.listFolders()).find((f) => !f.system && f.parentId === parentId && f.name.toLowerCase() === lc);
    if (there) return there;
    const folder: Folder = { id: `${this.account.id}:made-${++folderSeq}`, accountId: this.account.id, name, ...(parentId ? { parentId } : {}) };
    madeFolders.push(folder);
    return folder;
  }

  async backfillInbox(): Promise<{ emails: Email[] }> {
    return { emails: [] };
  }
  async listMessages(opts?: { folderId?: string; limit?: number }): Promise<Email[]> {
    return store.emails
      .filter((e) => e.accountId === this.account.id)
      .filter((e) => !opts?.folderId || e.folderId === opts.folderId)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, opts?.limit ?? 500)
      .map((e) => ({ ...e }));
  }

  async move(emailId: string, folderId: string) {
    this.patch(emailId, { folderId });
  }
  async setRead(emailId: string, read: boolean) {
    this.patch(emailId, { unread: !read });
  }
  async setStarred(emailId: string, starred: boolean) {
    this.patch(emailId, { starred });
  }
  async send() {
    await new Promise((r) => setTimeout(r, 300));
  }

  /** A draft is an email in this account's Drafts folder. */
  async saveDraft(msg: SendRequest, draftId?: string): Promise<{ draftId: string; messageId: string }> {
    const id = draftId ?? `draft-${++draftSeq}`;
    const me = { name: this.account.name, address: this.account.address };
    const contact = (address: string) => ({ name: address, address });
    const prev = store.emails.find((x) => x.id === id);
    const draft: Email = {
      id,
      accountId: this.account.id,
      threadId: msg.replyTo?.threadId ?? id,
      folderId: `${this.account.id}:drafts`,
      from: me,
      to: msg.to.map(contact),
      cc: msg.cc?.map(contact),
      bcc: msg.bcc?.map(contact),
      attachments: (msg.attachments ?? []).map((a, i) => ({ id: `${id}-att-${i}`, filename: a.filename, mimeType: a.mimeType, size: Math.floor((a.base64.length * 3) / 4) })),
      subject: msg.subject,
      snippet: msg.text.slice(0, 120),
      text: msg.text,
      html: msg.html,
      date: new Date().toISOString(),
      unread: false,
      starred: prev?.starred ?? false,
      labels: [],
    };
    if (prev) store.emails[store.emails.indexOf(prev)] = draft;
    else store.emails.push(draft);
    return { draftId: id, messageId: id };
  }
  async sendDraft(msg: SendRequest, draftId: string) {
    await this.saveDraft(msg, draftId);
    await new Promise((r) => setTimeout(r, 300));
    await this.deleteDraft(draftId);
  }
  /** Scheduled send: the saved draft moves to Sent. */
  async sendSavedDraft(draftId: string) {
    if (!store.emails.some((e) => e.id === draftId)) throw new Error("That draft no longer exists.");
    this.patch(draftId, { folderId: `${this.account.id}:sent`, date: new Date().toISOString() });
  }
  async deleteDraft(draftId: string) {
    store.emails = store.emails.filter((e) => e.id !== draftId);
  }
  async draftIdFor(messageId: string): Promise<string | undefined> {
    return store.emails.some((e) => e.id === messageId) ? messageId : undefined;
  }

  /** Demo attachments: a small text file standing in for the real document. */
  async getAttachment(emailId: string, attachmentId: string): Promise<string> {
    const e = store.emails.find((x) => x.id === emailId);
    const a = e?.attachments?.find((x) => x.id === attachmentId);
    const text = `zMail demo attachment\n\n${a?.filename ?? "file"} from "${e?.subject ?? ""}".\nConnect a real account to open actual files.\n`;
    return btoa(text);
  }

  async getAutoReply(): Promise<AutoReply> {
    return { ...(autoReplies.get(this.account.id) ?? { enabled: false, message: "", audience: "all" }) };
  }
  async setAutoReply(r: AutoReply): Promise<void> {
    autoReplies.set(this.account.id, { ...r });
  }

  private patch(id: string, p: Partial<Email>) {
    const i = store.emails.findIndex((x) => x.id === id);
    if (i >= 0) store.emails[i] = { ...store.emails[i], ...p };
  }
}
