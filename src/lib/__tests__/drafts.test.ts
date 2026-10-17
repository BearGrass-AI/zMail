// @vitest-environment jsdom
// Saving drafts, asking before the composer closes with unsaved text, and reopening a draft from Drafts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";
import type { SendRequest } from "@/lib/mail/provider";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:DRAFT", accountId: "g", name: "Drafts", system: "drafts" },
];
const row = (id: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date: "2026-01-01T00:00:00Z", unread: false, starred: false, labels: [], ...over }) as Email;

const saved: { msg: SendRequest; id?: string }[] = [];
const sentDrafts: string[] = [];
const fake = {
  account: gmail,
  batchSize: 50,
  listFolders: async () => folders,
  listMessages: async () => [] as Email[],
  getMessage: async (id: string) => row(id),
  getAttachment: async (_e: string, a: string) => `bytes-of-${a}`,
  saveDraft: async (msg: SendRequest, id?: string) => {
    saved.push({ msg, id });
    return { draftId: id ?? "D1", messageId: "M1" };
  },
  sendDraft: async (_msg: SendRequest, id: string) => void sentDrafts.push(id),
  draftIdFor: async (messageId: string) => `D-for-${messageId}`,
  forgetDraftQuote: vi.fn(),
};

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: () => fake,
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ai/triage")>()), triageAll: async () => ({ done: 0, failed: 0 }) }));
vi.mock("sonner", () => {
  const t = () => 1;
  t.error = t;
  t.success = t;
  return { toast: t };
});

const { useMail } = await import("@/lib/store");
const flush = () => new Promise((r) => setTimeout(r, 0));
const msg: SendRequest = { to: ["a@b.com"], subject: "Hi", text: "Body" };

beforeEach(async () => {
  if (!useMail.getState().accounts.length) await useMail.getState().load();
  saved.length = 0;
  sentDrafts.length = 0;
  useMail.setState({ folders, emails: [row("a"), row("b")], selectedId: null, compose: null, composeDirty: false, composeCloseAsk: null });
});

describe("saving drafts", () => {
  it("creates a draft, then passes its id back on the next save", async () => {
    const first = await useMail.getState().saveDraft("g", msg);
    expect(first).toEqual({ draftId: "D1", messageId: "M1" });
    await useMail.getState().saveDraft("g", msg, first.draftId);
    expect(saved.map((s) => s.id)).toEqual([undefined, "D1"]);
  });

  it("sendDraft calls the provider and removes the draft email from the list", async () => {
    useMail.setState({ emails: [row("a"), row("M1", { folderId: "g:DRAFT" })] });
    await useMail.getState().sendDraft("g", msg, "M1");
    expect(sentDrafts).toEqual(["M1"]);
    expect(useMail.getState().emails.map((e) => e.id)).toEqual(["a"]);
  });

  it("says so when the account can't save drafts", async () => {
    const real = fake.saveDraft;
    (fake as { saveDraft?: unknown }).saveDraft = undefined;
    try {
      await expect(useMail.getState().saveDraft("g", msg)).rejects.toThrow("This account can't save drafts");
    } finally {
      fake.saveDraft = real;
    }
  });
});

describe("closing the composer", () => {
  it("closes at once when nothing is unsaved", () => {
    useMail.setState({ compose: { mode: "blank" }, composeDirty: false });
    useMail.getState().closeCompose();
    expect(useMail.getState().compose).toBeNull();
    expect(useMail.getState().composeCloseAsk).toBeNull();
  });

  it("asks instead when there are unsaved changes, leaving the composer open", () => {
    useMail.setState({ compose: { mode: "blank" }, composeDirty: true });
    useMail.getState().closeCompose();
    expect(useMail.getState().compose).not.toBeNull();
    expect(useMail.getState().composeCloseAsk).not.toBeNull();
  });

  it("asks before selecting another email, and selects it once the question is answered", () => {
    useMail.setState({ compose: { mode: "blank" }, composeDirty: true });
    useMail.getState().select("b");
    expect(useMail.getState().selectedId).toBeNull();
    const ask = useMail.getState().composeCloseAsk!;
    expect(ask).not.toBeNull();
    // Discard: the composer closes and clears the flag, then runs `then`.
    useMail.getState().setComposeCloseAsk(null);
    useMail.getState().setComposeDirty(false);
    useMail.getState().openCompose(null);
    ask.then();
    expect(useMail.getState().selectedId).toBe("b");
    expect(useMail.getState().compose).toBeNull();
  });

  it("selects straight away when the composer is open but clean", () => {
    useMail.setState({ compose: { mode: "blank" }, composeDirty: false });
    useMail.getState().select("b");
    expect(useMail.getState().selectedId).toBe("b");
    expect(useMail.getState().compose).toBeNull();
  });
});

describe("opening a draft", () => {
  it("opens an email in a Drafts folder in the composer, with its draft id, HTML body and attachments", async () => {
    useMail.setState({
      emails: [
        row("m9", {
          folderId: "g:DRAFT",
          to: [{ name: "B", address: "b@x.com" }],
          subject: "Hello",
          html: "<p>Hi <b>there</b></p>",
          attachments: [
            { id: "att1", filename: "a.pdf", mimeType: "application/pdf", size: 12 },
            { id: "att2", filename: "logo.png", mimeType: "image/png", size: 3, inline: true },
          ],
        }),
      ],
    });
    useMail.getState().select("m9");
    await flush();
    await flush();
    const c = useMail.getState().compose!;
    expect(c).toBeTruthy();
    expect(c.draft).toEqual({ id: "D-for-m9", emailId: "m9" });
    expect(c.prefill).toMatchObject({ to: "b@x.com", subject: "Hello", bodyIsHtml: true });
    expect(c.prefill!.body).toContain("there");
    expect(c.attachments).toEqual([{ filename: "a.pdf", mimeType: "application/pdf", size: 12, base64: "bytes-of-att1" }]);
    expect(c.fromAccountId).toBe("g");
    expect(useMail.getState().selectedId).toBeNull();
  });

  it("forgets the provider's remembered quote for a draft it opens", async () => {
    useMail.setState({ emails: [row("m8", { folderId: "g:DRAFT", html: "<p>x</p>" })] });
    await useMail.getState().openDraft("m8");
    expect(fake.forgetDraftQuote).toHaveBeenCalledWith("D-for-m8");
  });
});
