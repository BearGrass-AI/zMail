// @vitest-environment jsdom
// Lane rules in the store: pin a sender's inbox mail to a lane, over the model's answer.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const folders: Folder[] = [{ id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" }];
const row = (id: string, address = "jbs@example.org", over: Partial<Email> = {}) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "S", address }, to: [], subject: "Hello", snippet: "", text: "", date: "2020-01-01T00:00:00Z", unread: true, starred: false, labels: ["INBOX"], ...over }) as Email;

let inboxMail: Email[] = [];
const fake = {
  account: gmail,
  batchSize: 50,
  listFolders: async () => folders,
  listMessages: async () => inboxMail,
  batchMove: async () => ({ skipped: [], failed: [] }),
  batchSetRead: async () => ({ skipped: [], failed: [] }),
  batchSetStarred: async () => ({ skipped: [], failed: [] }),
};

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: () => fake,
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

const { useMail, bucketOf } = await import("@/lib/store");
const st = () => useMail.getState();

beforeEach(async () => {
  inboxMail = [];
  if (!st().accounts.length) await st().load();
  useMail.setState({
    autoRules: [],
    overrides: {},
    laneRuled: {},
    lessons: [],
    triage: {},
    autoHandled: {},
    emails: [row("a1"), row("a2", "JBS@example.org"), row("b1", "other@x.com")],
  });
  useMail.setState((s) => ({ triage: Object.fromEntries(s.emails.map((e) => [e.id, { bucket: "worth_skim" } as never])) }));
});

describe("lane rules in the store", () => {
  it("moves existing mail from the sender into the lane, leaving others alone, without lessons", () => {
    st().addAutoRule({ from: "jbs@example.org", action: { lane: "needs_you" } });
    expect(bucketOf(st(), "a1")).toBe("needs_you");
    expect(bucketOf(st(), "a2")).toBe("needs_you");
    expect(bucketOf(st(), "b1")).toBe("worth_skim");
    expect(st().lessons).toEqual([]);
    expect(st().applyLaneRules()).toBe(0);
  });

  it("a user setBucket wins and survives another applyLaneRules", () => {
    st().addAutoRule({ from: "jbs@example.org", action: { lane: "needs_you" } });
    st().setBucket(["a1"], "ready_archive");
    expect(st().laneRuled.a1).toBeUndefined();
    st().applyLaneRules();
    expect(bucketOf(st(), "a1")).toBe("ready_archive");
    expect(bucketOf(st(), "a2")).toBe("needs_you");
  });

  it("assistant set_lane (bulk op) records the correction and Undo restores the prior state", async () => {
    st().addAutoRule({ from: "jbs@example.org", action: { lane: "needs_you" } });
    st().setBucket(["b1"], "ready_archive");
    const before = { overrides: { ...st().overrides }, laneRuled: { ...st().laneRuled }, lessons: st().lessons };
    const emails = st().emails.filter((e) => e.id !== "a2");
    const res = await st().bulkApply(emails, { kind: "lane", lane: "worth_skim" });
    expect(res.done).toBe(2);
    expect(bucketOf(st(), "a1")).toBe("worth_skim");
    expect(st().laneRuled.a1).toBeUndefined();
    expect(st().lessons.length).toBeGreaterThan(before.lessons.length);
    await st().bulkUndo(res.undo, { kind: "lane", lane: "worth_skim" });
    expect(st().overrides).toEqual(before.overrides);
    expect(st().laneRuled).toEqual(before.laneRuled);
    expect(st().lessons).toEqual(before.lessons);
  });

  it("disabling or removing the rule restores the model's answer for rule-set emails only", () => {
    const r = st().addAutoRule({ from: "jbs@example.org", action: { lane: "needs_you" } });
    st().setBucket(["a2"], "ready_archive");
    st().setAutoRuleEnabled(r.id, false);
    expect(bucketOf(st(), "a1")).toBe("worth_skim");
    expect(bucketOf(st(), "a2")).toBe("ready_archive");
    st().setAutoRuleEnabled(r.id, true);
    expect(bucketOf(st(), "a1")).toBe("needs_you");
    st().removeAutoRule(r.id);
    expect(bucketOf(st(), "a1")).toBe("worth_skim");
    expect(bucketOf(st(), "a2")).toBe("ready_archive");
    expect(st().laneRuled).toEqual({});
  });
});
