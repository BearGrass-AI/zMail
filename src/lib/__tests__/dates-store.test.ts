// @vitest-environment jsdom
// Date checks without sections: sorted real mail with a date is read once
// (also across a reload); promos and unsorted mail are never sent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";

const acct = { id: "p", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const inbox: Folder = { id: "p:INBOX", accountId: "p", name: "Inbox", system: "inbox" };
const mail = (id: string, subject: string, text: string): Email =>
  ({ id, accountId: "p", threadId: id, folderId: inbox.id, from: { name: "A", address: `${id}@x.com` }, to: [], subject, snippet: "", text, date: new Date().toISOString(), unread: false, starred: false, labels: [] }) as unknown as Email;

let sent: string[] = [];
let triageMode: "ok" | "throw" | "skip" = "ok";
let snapshot: unknown = null;

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [acct],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: () => ({
    account: acct,
    listFolders: async () => [inbox],
    listMessages: async () => [mail("bill", "Statement", "Payment due October 18"), mail("promo", "Sale", "Sale ends October 18")],
  }),
}));
vi.mock("@/lib/db", () => ({
  kvGet: async () => snapshot,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/triage")>()),
  triageAll: async (_p: unknown, emails: Email[], _c: unknown, onResult: (t: Triage) => void) => {
    if (triageMode === "throw") throw new Error("model down");
    if (triageMode === "skip") return { done: 0, failed: 0 };
    for (const e of emails)
      onResult({ emailId: e.id, bucket: "worth_skim", category: e.id === "promo" ? "promotions" : "transactions", urgency: 0, model: "jev" } as unknown as Triage);
    return { done: emails.length, failed: 0 };
  },
}));
vi.mock("@/lib/ai/providers", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/providers")>()),
  generativeProvider: () => ({ name: "fake-writer" }),
}));
vi.mock("@/lib/ai/dates", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/dates")>()),
  extractDates: async (_p: unknown, e: Email, section?: string) => {
    sent.push(`${e.id}:${section ?? ""}`);
    return [];
  },
}));

const fresh = async () => {
  vi.resetModules();
  return (await import("@/lib/store")).useMail;
};

beforeEach(() => {
  sent = [];
  triageMode = "ok";
  snapshot = null;
});

describe("dates without sections", () => {
  it("checks a transactions email with a date once, and never a promotion", async () => {
    const useMail = await fresh();
    await useMail.getState().load();
    await vi.waitFor(() => expect("bill" in useMail.getState().dateFinds).toBe(true));
    expect(sent).toEqual(["bill:"]);
    expect("promo" in useMail.getState().dateFinds).toBe(false);
    await useMail.getState().refresh();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(["bill:"]);
    expect(useMail.getState().noDateSenders).toEqual({});
  });

  it.each(["throw", "skip"] as const)("sends nothing when sorting %s leaves mail unsorted", async (mode) => {
    triageMode = mode;
    const useMail = await fresh();
    await useMail.getState().load();
    await new Promise((r) => setTimeout(r, 20));
    expect(useMail.getState().triage).toEqual({});
    expect(sent).toEqual([]);
  });

  it("doesn't read mail again after a reload that restores dateFinds", async () => {
    snapshot = { dateFinds: { bill: [] }, triage: { bill: { emailId: "bill", bucket: "worth_skim", category: "transactions", urgency: 0, model: "jev" } } };
    const useMail = await fresh();
    await useMail.getState().load();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    expect(useMail.getState().dateFinds).toEqual({ bill: [] });
  });

  it("uses the user's category corrections to pick what to read", async () => {
    const t = (id: string, category: string) => ({ emailId: id, bucket: "worth_skim", category, urgency: 0, model: "jev" });
    snapshot = {
      triage: { bill: t("bill", "transactions"), promo: t("promo", "promotions") },
      categoryOverrides: { bill: "promotions", promo: "transactions" },
    };
    const useMail = await fresh();
    await useMail.getState().load();
    await vi.waitFor(() => expect(sent).toEqual(["promo:"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(["promo:"]);
  });
});
