// @vitest-environment jsdom
// Automatic replies are filed under Ready to archive by rule; the model never sees them.
import { describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";

const acct = { id: "p", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const inbox: Folder = { id: "p:INBOX", accountId: "p", name: "Inbox", system: "inbox" };
const mail = (id: string, subject = id, extra: Partial<Email> = {}): Email =>
  ({ id, accountId: "p", threadId: id, folderId: inbox.id, from: { name: "A", address: `${id}@x.com` }, to: [], subject, snippet: "", text: "", date: "2026-10-09T00:00:00Z", unread: false, starred: false, labels: [], ...extra }) as unknown as Email;

const sentToDecision: string[][] = [];

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [acct],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "p", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: () => ({
    account: acct,
    listFolders: async () => [inbox],
    listMessages: async () => [mail("note"), mail("ooo", "Automatic reply: away"), mail("hdr", "Hi", { autoReply: true })],
    batchSize: 100,
  }),
}));
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({
  triageAll: async (_p: unknown, emails: Email[], _c: unknown, onResult: (t: Triage) => void) => {
    sentToDecision.push(emails.map((e) => e.id));
    for (const e of emails) onResult({ emailId: e.id, bucket: "worth_skim", category: "primary", urgency: 0, needsReply: 0, model: "jev" } as unknown as Triage);
    return { done: emails.length, failed: 0 };
  },
}));

const { useMail, bucketOf } = await import("@/lib/store");

describe("automatic replies in the store", () => {
  it("files them under Ready to archive without asking the model", async () => {
    await useMail.getState().load();
    const s = useMail.getState();
    for (const id of ["ooo", "hdr"]) {
      expect(s.triage[id].bucket).toBe("ready_archive");
      expect(s.triage[id].folder).toBeUndefined();
    }
    expect(s.triage.note.bucket).toBe("worth_skim");
    const seen = sentToDecision.flat();
    expect(seen).toContain("note");
    expect(seen).not.toContain("ooo");
    expect(seen).not.toContain("hdr");
  });

  it("re-files one the model had put in Worth a skim", async () => {
    useMail.setState((s) => ({ triage: { ...s.triage, ooo: { ...s.triage.ooo, bucket: "worth_skim", model: "jev" } } }));
    await useMail.getState().sort();
    expect(useMail.getState().triage.ooo.bucket).toBe("ready_archive");
  });

  it("a manual correction still wins", async () => {
    useMail.setState({ overrides: { ooo: "needs_you" } });
    await useMail.getState().sort();
    expect(bucketOf(useMail.getState(), "ooo")).toBe("needs_you");
  });
});
