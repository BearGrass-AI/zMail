// @vitest-environment jsdom
// Undo against the real MockMailProvider, whose records used to be the very objects the app held.
import { describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";

vi.mock("@/lib/accounts", async () => {
  const { ACCOUNTS } = await import("@/lib/mail/mock-data");
  const { MockMailProvider } = await import("@/lib/mail/mock-provider");
  return {
    loadRegistry: async () => [ACCOUNTS[0]],
    saveRegistry: async () => {},
    calendarProviderFor: () => null,
    mailProviderFor: (a: import("@/lib/types").Account) => new MockMailProvider(a),
  };
});
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

const { useMail, providerOf } = await import("@/lib/store");

describe("bulk undo with the mock provider", () => {
  it("trash then undo puts every email back where it was", async () => {
    await useMail.getState().load();
    const s = useMail.getState();
    const p = providerOf("personal");
    const page = await p.search({ from: "amazon.com" } as never, s.folders);
    expect(page.ids.length).toBeGreaterThan(0);
    const inStore = new Map(useMail.getState().emails.map((e) => [e.id, e]));
    const emails = (page.headers ?? []).map((h) => inStore.get(h.id) ?? h) as Email[];
    const before = new Map(emails.map((e) => [e.id, e.folderId]));

    const res = await useMail.getState().bulkApply(emails, { kind: "trash" });
    expect(res.done).toBe(emails.length);
    const undone = await useMail.getState().bulkUndo(res.undo, { kind: "trash" });
    expect(undone.done).toBe(emails.length);

    const now = new Map((await p.headers(emails.map((e) => e.id))).map((e) => [e.id, e.folderId]));
    for (const [id, folder] of before) {
      expect(now.get(id)).toBe(folder);
      expect(useMail.getState().emails.find((e) => e.id === id)?.folderId).toBe(folder);
    }
  });
});
