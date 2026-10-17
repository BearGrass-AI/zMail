// @vitest-environment jsdom
// The store's createFolder (missing levels through the provider, merged into folders and the folder cache)
// and always-file rules that name a domain.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const base: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:Label_1", accountId: "g", name: "Kids" },
];
const created: { name: string; parentId?: string }[] = [];
const cached: { accountId: string; ids: string[] }[] = [];
let seq = 0;

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: (account: typeof gmail) => ({
    account,
    batchSize: 50,
    listFolders: async () => base,
    listMessages: async () => [],
    createFolder: async (name: string, parentId?: string): Promise<Folder> => {
      created.push({ name, parentId });
      return { id: `g:New_${++seq}`, accountId: "g", name, parentId };
    },
  }),
}));
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
  cachePutFolders: async (accountId: string, rows: [string, string][]) => void cached.push({ accountId, ids: rows.map(([id]) => id) }),
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

const { useMail, suggestionFor } = await import("@/lib/store");
const { filingRuleFor } = await import("@/lib/rules");

beforeEach(async () => {
  created.length = 0;
  cached.length = 0;
  if (!useMail.getState().accounts.length) await useMail.getState().load();
  useMail.setState({ folders: base });
});

describe("createFolder", () => {
  it("creates only the missing levels, in order, and merges them into folders and the cache", async () => {
    const f = await useMail.getState().createFolder("g", "kids/Lincoln Elementary – Sam/2026");
    expect(created).toEqual([
      { name: "Lincoln Elementary – Sam", parentId: "g:Label_1" },
      { name: "2026", parentId: "g:New_1" },
    ]);
    expect(f).toMatchObject({ id: "g:New_2", name: "2026", parentId: "g:New_1" });
    expect(useMail.getState().folders.map((x) => x.id)).toEqual(["g:INBOX", "g:Label_1", "g:New_1", "g:New_2"]);
    expect(cached).toEqual([{ accountId: "g", ids: ["g:INBOX", "g:Label_1", "g:New_1", "g:New_2"] }]);
  });

  it("treats dashes and spaces alike when matching levels that already exist", async () => {
    useMail.setState({ folders: [...base, { id: "g:Label_2", accountId: "g", name: "Lincoln Elementary - Sam", parentId: "g:Label_1" }] });
    const f = await useMail.getState().createFolder("g", "Kids/Lincoln  Elementary – Sam");
    expect(created).toEqual([]);
    expect(f.id).toBe("g:Label_2");
  });
});

describe("always-file rules by domain", () => {
  it("an address rule wins; a domain rule covers its subdomains", () => {
    const rules = { "coach@district.example.org": "g:A", "district.example.org": "g:B" };
    expect(filingRuleFor(rules, "Coach@District.example.org")).toBe("g:A");
    expect(filingRuleFor(rules, "office@district.example.org")).toBe("g:B");
    expect(filingRuleFor(rules, "news@mail.district.example.org")).toBe("g:B");
    expect(filingRuleFor(rules, "x@notdistrict.example.org")).toBeUndefined();
    expect(filingRuleFor({ constructor: "g:X" } as Record<string, string>, "a@b.com")).toBeUndefined();
  });

  it("suggests the rule's folder for inbox mail from the domain", () => {
    const e = { id: "e1", accountId: "g", folderId: "g:INBOX", from: { name: "Coach", address: "coach@mail.district.example.org" } } as unknown as Email;
    const s = { ...useMail.getState(), rules: { "district.example.org": "g:Label_1" } };
    expect(suggestionFor(s, e, 0.9)).toMatchObject({ folderId: "g:Label_1", rule: true });
  });
});

describe("replaceGrouping", () => {
  it("swaps a Gmail grouping for its real label and moves its children under it", async () => {
    const { replaceGrouping } = await import("@/lib/store/folder-actions");
    const g = { id: "a:path:Bills", accountId: "a", name: "Bills" };
    const kid = { id: "a:Label_9", accountId: "a", name: "Visa", parentId: "a:path:Bills" };
    const other = { id: "a:Label_2", accountId: "a", name: "Kids" };
    const label = { id: "a:Label_10", accountId: "a", name: "Bills" };
    const out = replaceGrouping([g, kid, other] as never, g.id, label as never);
    expect(out.map((f) => f.id).sort()).toEqual(["a:Label_10", "a:Label_2", "a:Label_9"]);
    expect(out.find((f) => f.id === "a:Label_9")?.parentId).toBe("a:Label_10");
  });
});

describe("realizeFolder", () => {
  it("makes a Gmail grouping a real label, relinks its section and children", async () => {
    const grouping: Folder = { id: "g:path:Bills", accountId: "g", name: "Bills" };
    const visa: Folder = { id: "g:Label_7", accountId: "g", name: "Visa", parentId: "g:path:Bills" };
    useMail.setState({
      folders: [...base, grouping, visa],
      sections: [{ id: "bills", name: "Bills", description: "", icon: "credit-card", hue: 140, accountIds: [], dates: true, folderId: "g:path:Bills" }],
    });
    const label = await useMail.getState().realizeFolder("g:path:Bills");
    expect(created.at(-1)).toEqual({ name: "Bills", parentId: undefined });
    const s = useMail.getState();
    expect(s.folders.some((f) => f.id === "g:path:Bills")).toBe(false);
    expect(s.folders.find((f) => f.id === "g:Label_7")?.parentId).toBe(label.id);
    expect(s.sections[0].folderId).toBe(label.id);
  });
  it("returns a real folder as it is", async () => {
    const f = await useMail.getState().realizeFolder("g:Label_1");
    expect(f.id).toBe("g:Label_1");
    expect(created).toEqual([]);
  });
});
