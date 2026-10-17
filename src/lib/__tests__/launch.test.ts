// @vitest-environment jsdom
// Launch behavior that decides how much mail goes to the decision model (Jev).
import { describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";

const acct = { id: "g1", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const inbox: Folder = { id: "g1:INBOX", accountId: "g1", name: "Inbox", system: "inbox" };
const mail = (id: string): Email =>
  ({ id, accountId: "g1", threadId: id, folderId: inbox.id, from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date: `2026-10-0${id.slice(1)}T00:00:00Z`, unread: false, starred: false, labels: [] }) as unknown as Email;
const triaged = (id: string): Triage => ({ emailId: id, bucket: "worth_skim", category: "updates", urgency: 0, model: "jev" }) as unknown as Triage;

const sentToModel: string[][] = [];
let releaseNetwork: () => void = () => {};
const network = new Promise<void>((r) => (releaseNetwork = r));

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [acct],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: () => ({
    account: acct,
    listFolders: async () => (await network, [inbox]),
    // e3 arrived while zMail was closed.
    listMessages: async () => (await network, [mail("e1"), mail("e2"), mail("e3")]),
  }),
}));
vi.mock("@/lib/db", () => ({
  kvGet: async () => ({ triage: { e1: triaged("e1"), e2: triaged("e2") } }),
  kvSet: async () => {},
  cacheListFolders: async () => [JSON.stringify(inbox)],
  cacheListMessages: async () => [mail("e1"), mail("e2")].map((m) => ({ id: m.id, folder_id: m.folderId, date: m.date, json: JSON.stringify(m) })),
  cachePutMessages: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/triage")>()),
  triageAll: async (_p: unknown, emails: Email[], _c: unknown, onResult: (t: Triage) => void) => {
    sentToModel.push(emails.map((e) => e.id));
    for (const e of emails) onResult(triaged(e.id));
    return { done: emails.length, failed: 0 };
  },
}));

const { useMail } = await import("@/lib/store");

describe("launch", () => {
  it("shows cached mail and saved sorting before the network answers, then sorts only new mail", async () => {
    const loading = useMail.getState().load();
    await vi.waitFor(() => expect(useMail.getState().emails.map((e) => e.id)).toEqual(["e2", "e1"]));
    expect(useMail.getState().triage.e1).toBeDefined();
    expect(sentToModel).toEqual([]);

    releaseNetwork();
    await loading;
    expect(useMail.getState().emails).toHaveLength(3);
    expect(sentToModel).toEqual([["e3"]]);
  });

  it("checking for new mail doesn't re-send sorted mail; only an explicit re-sort does", async () => {
    sentToModel.length = 0;
    await useMail.getState().refresh();
    expect(sentToModel).toEqual([[]]);
    await useMail.getState().sort();
    expect(sentToModel.at(-1)?.sort()).toEqual(["e1", "e2", "e3"]);
  });
});
