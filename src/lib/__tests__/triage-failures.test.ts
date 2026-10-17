// @vitest-environment jsdom
// Sorting reports decision-model failures: the real triageAll through the store,
// with a decision model that rejects some (or every) request.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";
import type { DecisionProvider } from "@/lib/ai/decision";
import type { OrganizeDeps } from "@/lib/ai/assistant/modules/organize";

const inbox: Folder = { id: "p:INBOX", accountId: "p", name: "Inbox", system: "inbox" };
const mail = (id: string, subject = "Lunch?"): Email => ({ id, accountId: "p", threadId: id, folderId: inbox.id, from: { name: "A", address: `${id}@x.com` }, to: [], subject, snippet: "", text: "", date: "2026-10-09T00:00:00Z", unread: false, starred: false, labels: [] });

const { MockDecisionProvider } = await import("@/lib/ai/mock-decision");
const real = new MockDecisionProvider();
let decided = 0;
// Requests for mail whose subject says FAIL are rejected, as a rate limit would.
const flaky: DecisionProvider = {
  name: "Flaky",
  maxChoiceOptions: real.maxChoiceOptions,
  decide: async (req) => {
    decided++;
    if (JSON.stringify(req.state).includes("FAIL")) throw new Error("rate limited");
    return real.decide(req);
  },
};

vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, calendarProviderFor: () => null, mailProviderFor: () => ({}) }));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/providers", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/providers")>()), decisionProvider: () => flaky }));

const { useMail } = await import("@/lib/store");
const { organizeModule } = await import("@/lib/ai/assistant/modules/organize");
const organize = () => {
  const deps = organizeModule.realDeps?.();
  if (!deps) throw new Error("no organize deps");
  return deps as OrganizeDeps;
};

beforeEach(() => {
  decided = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  useMail.setState({ folders: [inbox], triage: {}, sorting: { running: false, done: 0, total: 0 } });
});

describe("sorting failures", () => {
  it("every request failing is a failed sort, and the assistant says so", async () => {
    useMail.setState({ emails: [mail("a", "FAIL"), mail("b", "FAIL"), mail("c", "FAIL")] });
    await useMail.getState().sort();
    expect(decided).toBe(3);
    expect(useMail.getState().sorting).toMatchObject({ running: false, done: 0, total: 3, error: "Error: rate limited" });
    expect(useMail.getState().triage).toEqual({});
    await expect(organize().sort()).rejects.toThrow("Sorting failed: rate limited");
  });

  it("some failing keeps the rest, counts the failures, and the assistant hears it", async () => {
    useMail.setState({ emails: [mail("a"), mail("b", "FAIL"), mail("c")] });
    await useMail.getState().sort();
    const { sorting, triage } = useMail.getState();
    expect(Object.keys(triage).sort()).toEqual(["a", "c"]);
    expect(sorting).toMatchObject({ running: false, done: 2, total: 3, failed: { count: 1, error: "Error: rate limited" } });
    expect(sorting.error).toBeUndefined();
    expect(sorting.at).toBeTypeOf("number");
    expect(await organize().sort()).toEqual({ failed: 1, total: 3, error: "rate limited" });
  });

  it("a clean sort clears an earlier partial failure", async () => {
    useMail.setState({ emails: [mail("a"), mail("b", "FAIL")] });
    await useMail.getState().sort();
    useMail.setState({ emails: [mail("a"), mail("b")] });
    await useMail.getState().sort();
    const { sorting } = useMail.getState();
    expect(sorting).toMatchObject({ running: false, done: 2, total: 2 });
    expect([sorting.failed, sorting.error]).toEqual([undefined, undefined]);
    expect(await organize().sort()).toBeUndefined();
  });
});
