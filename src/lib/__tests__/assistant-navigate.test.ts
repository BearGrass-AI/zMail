// @vitest-environment jsdom
// The navigate module: open_view, open_email, show_account.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Email, Folder } from "@/lib/types";

vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
const { useAssistant } = await import("@/lib/ai/assistant/state");
const { executeTool } = await import("@/lib/ai/assistant/tools");
import type { ToolDeps } from "@/lib/ai/assistant/tools";
import type { NavigateDeps } from "@/lib/ai/assistant/modules/navigate";
import type { View } from "@/lib/store";

const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:R", accountId: "g", name: "Receipts" },
  { id: "g:W", accountId: "g", name: "Work" },
  { id: "g:WR", accountId: "g", name: "Receipts", parentId: "g:W" },
];
const accounts = [
  { id: "g", kind: "gmail", name: "Alex", address: "z@gmail.com", label: "Personal" },
  { id: "m", kind: "m365", name: "Alex R", address: "z@example.org" },
] as Account[];
const emails = [
  { id: "e1", accountId: "g", folderId: "g:INBOX", subject: "Hello", starred: false },
  { id: "e2", accountId: "g", folderId: "g:R", subject: "Your receipt", starred: false },
] as Email[];

function fake(over: Partial<NavigateDeps> = {}) {
  const log: unknown[] = [];
  let view: View = { kind: "brief" };
  const nav: NavigateDeps = {
    folders: () => folders,
    accounts: () => accounts,
    emails: () => emails,
    currentView: () => view,
    accountFilter: () => null,
    setView: (v) => {
      view = v;
      log.push(["view", v]);
    },
    select: (id) => void log.push(["select", id]),
    setAccountFilter: (id) => void log.push(["filter", id]),
    ...over,
  };
  return { deps: { ext: { navigate: nav } } as unknown as ToolDeps, log };
}
const run = (name: string, args: Record<string, unknown>, deps: ToolDeps) => executeTool({ id: "c1", name, args }, deps);
beforeEach(() => useAssistant.getState().newChat());

describe("open_view", () => {
  it("maps the simple views and writes a step", async () => {
    const { deps, log } = fake();
    expect((await run("open_view", { view: "triage" }, deps)).content).toEqual({ opened: "Triage" });
    await run("open_view", { view: "today" }, deps);
    expect(log).toEqual([["view", { kind: "triage" }], ["view", { kind: "brief" }]]);
    expect(useAssistant.getState().items.some((i) => i.kind === "step" && i.text === "Opened Triage")).toBe(true);
  });
  it("resolves a folder by name, case-insensitively, and by path", async () => {
    const { deps, log } = fake();
    await run("open_view", { view: "folder", folder: "WORK" }, deps);
    await run("open_view", { view: "folder", folder: "work › receipts" }, deps);
    await run("open_view", { view: "folder", folder: "g:R" }, deps);
    expect(log).toEqual([["view", { kind: "folder", folderId: "g:W" }], ["view", { kind: "folder", folderId: "g:WR" }], ["view", { kind: "folder", folderId: "g:R" }]]);
  });
  it("reports ambiguous folders as malformed calls and unknown ones as plain errors", async () => {
    const { deps, log } = fake();
    const amb = await run("open_view", { view: "folder", folder: "receipts" }, deps);
    expect(amb.malformed).toBe(true);
    expect(JSON.stringify(amb.content)).toContain("Work › Receipts");
    expect(await run("open_view", { view: "folder", folder: "nope" }, deps)).toEqual({ content: { error: expect.stringMatching(/^unknown folder/) } });
    expect((await run("open_view", { view: "folder" }, deps)).malformed).toBe(true);
    expect((await run("open_view", { view: "bogus" }, deps)).malformed).toBe(true);
    expect(log).toEqual([]);
  });
});

describe("open_email", () => {
  it("rejects an id the model never saw", async () => {
    const { deps, log } = fake();
    const r = await run("open_email", { id: "e1" }, deps);
    // An unknown id is an error, not a malformed call: ids from before a relaunch go stale.
    expect(r).toEqual({ content: { error: expect.stringMatching(/^unknown id "e1"/) } });
    expect(log).toEqual([]);
    expect((await run("open_email", { id: "__proto__" }, deps)).content).toMatchObject({ error: expect.stringMatching(/^unknown id/) });
  });
  it("selects in place when the view already lists it, else switches first", async () => {
    useAssistant.getState().remember([{ id: "e1", accountId: "g" }, { id: "e2", accountId: "g" }]);
    const a = fake({ currentView: () => ({ kind: "inbox" }) });
    expect((await run("open_email", { id: "e1" }, a.deps)).content).toEqual({ opened: "Hello" });
    expect(a.log).toEqual([["select", "e1"]]);
    const b = fake();
    await run("open_email", { id: "e1" }, b.deps);
    expect(b.log).toEqual([["view", { kind: "inbox" }], ["select", "e1"]]);
    const c = fake();
    await run("open_email", { id: "e2" }, c.deps);
    expect(c.log).toEqual([["view", { kind: "folder", folderId: "g:R" }], ["select", "e2"]]);
    expect(useAssistant.getState().items.some((i) => i.kind === "step" && i.text === "Opened “Your receipt”")).toBe(true);
  });
  it("clears an account filter that hides the email", async () => {
    useAssistant.getState().remember([{ id: "e1", accountId: "g" }]);
    const { deps, log } = fake({ accountFilter: () => "m" });
    await run("open_email", { id: "e1" }, deps);
    expect(log[0]).toEqual(["filter", null]);
  });
});

describe("show_account", () => {
  it("matches address, label or name, and clears with all", async () => {
    const { deps, log } = fake();
    await run("show_account", { account: "personal" }, deps);
    await run("show_account", { account: "z@example.org" }, deps);
    await run("show_account", { account: "all" }, deps);
    await run("show_account", {}, deps);
    expect(log).toEqual([["filter", "g"], ["filter", "m"], ["filter", null], ["filter", null]]);
  });
  it("rejects an unknown account (a plain error, not a malformed call)", async () => {
    const { deps } = fake();
    expect(await run("show_account", { account: "nobody" }, deps)).toEqual({ content: { error: expect.stringMatching(/^unknown account/) } });
  });
});
