// @vitest-environment jsdom
// Assistant organize module: rules, categories, sections, re-sorting, folder suggestions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Email, Folder } from "@/lib/types";
import type { AutoRule } from "@/lib/rules";
import type { MailSection } from "@/lib/sections";

vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
const { useAssistant } = await import("@/lib/ai/assistant/state");
const { executeTool } = await import("@/lib/ai/assistant/tools");
const { runConfirm } = await import("@/lib/ai/assistant/modules/confirm");
import type { ToolDeps } from "@/lib/ai/assistant/tools";
import type { OrganizeDeps } from "@/lib/ai/assistant/modules/organize";

const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:L1", accountId: "g", name: "Receipts" },
  { id: "g:L2", accountId: "g", name: "Bills" },
];
const mk = (i: number): Email =>
  ({ id: `m${i}`, accountId: "g", threadId: `m${i}`, folderId: "g:INBOX", from: { name: "Shop", address: `s${i}@shop.com` }, to: [], subject: `Order ${i}`, snippet: "", text: "", date: "2026-10-01T00:00:00Z", unread: true, starred: false, labels: [] }) as unknown as Email;
const emails = Array.from({ length: 40 }, (_, i) => mk(i));

function setup() {
  const cats: Record<string, Category | undefined> = { m1: "updates" };
  const rule: AutoRule = { id: "r1", match: { from: "news.com" }, action: "archive", createdAt: "2026-01-01T00:00:00Z", enabled: true, hits: 3 };
  const calls: string[] = [];
  const toasts: { text: string; undo?: () => void }[] = [];
  const st = {
    autoRules: [rule] as AutoRule[],
    rules: { "boss@x.com": "g:L1" } as Record<string, string>,
    sections: [{ id: "sec1", name: "Bills", description: "bills", icon: "credit-card", hue: 1, accountIds: [], dates: false }] as MailSection[],
    accounts: [{ id: "g", address: "z@gmail.com" }],
    viewAccount: undefined as string | undefined,
  };
  const o: OrganizeDeps = {
    autoRules: () => st.autoRules,
    rules: () => st.rules,
    folders: () => folders,
    sections: () => st.sections,
    accountCount: () => 1,
    inbox: () => emails,
    suggestionFor: (e) => (e.id === "m0" || e.id === "m2" ? { folderId: "g:L1", probability: 0.9 } : undefined),
    modelName: () => "Test model",
    setAutoRuleEnabled: (id, on) => {
      calls.push(`enable:${id}:${on}`);
      st.autoRules = st.autoRules.map((r) => (r.id === id ? { ...r, enabled: on } : r));
    },
    removeAutoRule: (id) => {
      calls.push(`removeAutoRule:${id}`);
      st.autoRules = st.autoRules.filter((r) => r.id !== id);
    },
    addRule: (s, f) => {
      calls.push(`addRule:${s}:${f}`);
      st.rules = { ...st.rules, [s]: f };
    },
    removeRule: (s) => {
      calls.push(`removeRule:${s}`);
      delete st.rules[s];
    },
    snapshotCategories: (ids) => ({ prev: Object.fromEntries(ids.map((id) => [id, cats[id]])), lessons: [] }),
    setCategory: (ids, c, teach) => {
      calls.push(`setCategory:${ids.length}:${c}${teach ? ":teach" : ""}`);
      for (const id of ids) cats[id] = c;
    },
    sendersOf: (ids) => [...new Set(emails.filter((e) => ids.includes(e.id)).map((e) => e.from.address))],
    restoreCategories: (ids, snap) => {
      for (const id of ids) cats[id] = snap.prev[id];
    },
    addSection: (input) => {
      calls.push(`addSection:${input.name}`);
      st.sections = [...st.sections, { ...input, id: "sec2" }];
      return "sec2";
    },
    updateSection: (id, patch) => {
      calls.push(`updateSection:${id}`);
      st.sections = st.sections.map((x) => (x.id === id ? { ...x, ...patch } : x));
    },
    removeSection: (id) => {
      calls.push(`removeSection:${id}`);
      st.sections = st.sections.filter((x) => x.id !== id);
    },
    sort: async (opts) => void calls.push(`sort:${JSON.stringify(opts ?? {})}`),
    acceptSuggestion: async (ids) => {
      calls.push(`accept:${ids.join(",")}`);
      return { done: ids.length, failed: 0 };
    },
    dismissSuggestion: (ids) => void calls.push(`dismiss:${ids.join(",")}`),
    accounts: () => st.accounts,
    viewAccount: () => st.viewAccount,
    createFolder: async (accountId, path) => {
      calls.push(`createFolder:${accountId}:${path}`);
      return { id: `${accountId}:new`, accountId, name: path.split("/").at(-1)! };
    },
  };
  const deps = { ext: { organize: o }, folders: () => folders, toast: (text: string, undo?: () => void) => toasts.push({ text, undo }) } as unknown as ToolDeps;
  return { o, deps, cats, calls, toasts, st };
}

const run = (name: string, args: Record<string, unknown>, deps: ToolDeps) => executeTool({ id: "c1", name, args }, deps);
const cards = () => useAssistant.getState().items.filter((i) => i.kind === "card");
const lastCardId = () => cards().at(-1)!.id;
const confirmCard = () => {
  const c = cards().at(-1)!;
  if (c.kind !== "card" || c.card.type !== "confirm") throw new Error("not a confirm card");
  return c.card;
};
const know = (...ids: string[]) => useAssistant.getState().remember(ids.map((id) => ({ id, accountId: "g" })));

beforeEach(() => useAssistant.getState().newChat());

describe("rules", () => {
  it("lists both kinds of rules", async () => {
    const { deps } = setup();
    const r = (await run("list_rules", {}, deps)).content as { automatic: { id: string; hits: number }[]; always_file: { sender: string; folder: string }[] };
    expect(r.automatic).toMatchObject([{ id: "r1", enabled: true, hits: 3 }]);
    expect(r.always_file).toEqual([{ sender: "boss@x.com", folder: "Receipts" }]);
  });

  it("turns a rule on or off only after a card that names the rule; unknown id errors", async () => {
    const { deps, calls } = setup();
    const res = await run("set_rule_enabled", { id: "r1", enabled: false }, deps);
    expect(res.content).toMatchObject({ status: "awaiting_confirmation" });
    expect(calls).toEqual([]);
    const card = confirmCard();
    expect(card.title).toBe("Turn off rule");
    expect(card.detail).toContain("news.com");
    expect(card.preview?.fields?.find((f) => f.label === "Rule")?.value).toContain("news.com");
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["enable:r1:false"]);
    expect(confirmCard()).toMatchObject({ status: "done", result: "Rule turned off" });
    // Already in that state: nothing to confirm.
    const same = await run("set_rule_enabled", { id: "r1", enabled: false }, deps);
    expect(same.content).toMatchObject({ id: "r1", enabled: false });
    expect(cards()).toHaveLength(1);
    const bad = await run("set_rule_enabled", { id: "nope", enabled: true }, deps);
    expect(JSON.stringify(bad)).toContain("unknown rule id");
  });

  it("deletes an automatic rule only after confirming", async () => {
    const { deps, calls } = setup();
    const res = await run("delete_rule", { id: "r1" }, deps);
    expect(JSON.stringify(res)).toContain("awaiting_confirmation");
    expect(calls).toEqual([]);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["removeAutoRule:r1"]);
  });

  it("deletes an always-file rule by sender; unknown sender errors", async () => {
    const { deps, calls } = setup();
    await run("delete_rule", { sender: "boss@x.com" }, deps);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["removeRule:boss@x.com"]);
    expect(JSON.stringify(await run("delete_rule", { sender: "who@x.com" }, deps))).toContain("unknown sender");
  });

  it("always_file resolves the folder by name and adds the rule on confirm", async () => {
    const { deps, calls } = setup();
    await run("always_file", { sender: "Pat@Shop.com", folder: "bills" }, deps);
    expect(calls).toEqual([]);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["addRule:pat@shop.com:g:L2"]);
    expect(JSON.stringify(await run("always_file", { sender: "not an address", folder: "Bills" }, deps))).toContain("sender must be an email address");
    expect(JSON.stringify(await run("always_file", { sender: "a@b.com", folder: "Nope" }, deps))).toContain("unknown folder");
  });
});

describe("categories", () => {
  it("sets up to 3 at once for display only (the sorting model isn't taught), and Undo restores previous values", async () => {
    const { deps, cats, calls, toasts } = setup();
    know("m1", "m2");
    const r = await run("set_category", { ids: ["m1", "m2"], category: "promotions" }, deps);
    expect(r.content).toMatchObject({ done: 2, category: "promotions", taught: false });
    expect(calls).toEqual(["setCategory:2:promotions"]);
    expect(cats).toMatchObject({ m1: "promotions", m2: "promotions" });
    toasts[0].undo!();
    expect(cats.m1).toBe("updates");
    expect(cats.m2).toBeUndefined();
  });

  it("uses a confirm card past 3 emails, still display only, naming the senders", async () => {
    const { deps, calls, cats } = setup();
    know(...emails.slice(0, 4).map((e) => e.id));
    const res = await run("set_category", { ids: emails.slice(0, 4).map((e) => e.id), category: "social" }, deps);
    expect(JSON.stringify(res)).toContain("awaiting_confirmation");
    expect(cats.m3).toBeUndefined();
    const card = confirmCard();
    expect(card.preview?.fields?.find((f) => f.label === "From")?.value).toContain("s0@shop.com");
    expect(card.detail).toMatch(/doesn't learn/);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["setCategory:4:social"]);
  });

  it("teaching the sorting model always asks first, on a card that names the senders and says so", async () => {
    const { deps, calls } = setup();
    know("m1", "m2");
    const res = await run("set_category", { ids: ["m1", "m2"], category: "promotions", teach: true }, deps);
    expect(res.content).toMatchObject({ status: "awaiting_confirmation" });
    expect(calls).toEqual([]);
    const card = confirmCard();
    expect(card.preview?.fields?.find((f) => f.label === "From")?.value).toBe("s1@shop.com, s2@shop.com");
    expect(card.detail).toMatch(/sorting model will learn/i);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["setCategory:2:promotions:teach"]);
  });

  it("the real store records lessons only for a confirmed teach", async () => {
    const { organizeModule } = await import("@/lib/ai/assistant/modules/organize");
    const { useMail } = await import("@/lib/store");
    const { senderExamples } = await import("@/lib/store/learning");
    const real = organizeModule.realDeps!() as OrganizeDeps;
    const saved = { emails: useMail.getState().emails, lessons: useMail.getState().lessons, categoryOverrides: useMail.getState().categoryOverrides };
    try {
      useMail.setState({ emails: [mk(1)], lessons: [], categoryOverrides: {} });
      real.setCategory(["m1"], "promotions", false);
      expect(useMail.getState().categoryOverrides.m1).toBe("promotions");
      expect(senderExamples(useMail.getState().emails, useMail.getState().lessons).get("s1@shop.com")?.categories).toBeUndefined();
      real.setCategory(["m1"], "promotions", true);
      expect(senderExamples(useMail.getState().emails, useMail.getState().lessons).get("s1@shop.com")?.categories).toEqual([{ subject: "Order 1", category: "promotions" }]);
      expect(real.sendersOf(["m1"])).toEqual(["s1@shop.com"]);
    } finally {
      useMail.setState(saved);
    }
  });

  it("rejects unknown ids and bad categories", async () => {
    const { deps } = setup();
    expect(JSON.stringify(await run("set_category", { ids: ["zzz"], category: "social" }, deps))).toContain("unknown id");
    know("m1");
    expect(JSON.stringify(await run("set_category", { ids: ["m1"], category: "weird" }, deps))).toContain("category must be one of");
  });
});

describe("sections", () => {
  it("lists sections", async () => {
    const { deps } = setup();
    const r = (await run("list_sections", {}, deps)).content as { sections: { id: string; folder: string | null }[] };
    expect(r.sections).toMatchObject([{ id: "sec1", folder: null }]);
  });

  it("creates a section on confirm, linking a folder, then re-sorts stale mail", async () => {
    const { deps, calls } = setup();
    await run("create_section", { name: "Receipts", description: "Order receipts", folder: "Receipts", catch_dates: true }, deps);
    expect(calls).toEqual([]);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["addSection:Receipts", 'sort:{"staleSections":true}']);
    expect(JSON.stringify(await run("create_section", { name: "bills", description: "x" }, deps))).toContain("already exists");
  });

  it("updates a section only after a card showing the full new text, then re-sorts stale mail; unknown id errors", async () => {
    const { deps, calls, st } = setup();
    const long = `Any email about account security, sign-in alerts or invoices. ${"More words. ".repeat(20)}`.trim();
    const res = await run("update_section", { id: "sec1", name: "Money", description: long }, deps);
    expect(res.content).toMatchObject({ status: "awaiting_confirmation" });
    expect(st.sections[0]).toMatchObject({ name: "Bills", description: "bills" });
    expect(calls).toEqual([]);
    const card = confirmCard();
    expect(card.preview?.fields).toEqual([
      { label: "Name", value: "Money" },
      { label: "Description", value: long },
    ]);
    await runConfirm(lastCardId(), deps);
    expect(st.sections[0]).toMatchObject({ name: "Money", description: long });
    expect(calls).toEqual(["updateSection:sec1", 'sort:{"staleSections":true}']);
    expect(JSON.stringify(await run("update_section", { id: "nope", name: "x" }, deps))).toContain("unknown section");
  });

  it("caps section descriptions, which the sorting model reads as criteria", async () => {
    const { deps } = setup();
    const huge = "x".repeat(501);
    expect(JSON.stringify(await run("update_section", { id: "sec1", description: huge }, deps))).toContain("500 characters or fewer");
    expect(JSON.stringify(await run("create_section", { name: "New", description: huge }, deps))).toContain("500 characters or fewer");
    expect(cards()).toHaveLength(0);
  });

  it("deletes a section on confirm", async () => {
    const { deps, calls } = setup();
    await run("delete_section", { id: "sec1" }, deps);
    expect(calls).toEqual([]);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["removeSection:sec1"]);
  });
});

describe("resort", () => {
  it("sorts new mail at once", async () => {
    const { deps, calls } = setup();
    await run("resort", { scope: "new" }, deps);
    expect(calls).toEqual(['sort:{"onlyNew":true}']);
  });

  it("whole-inbox re-sort needs a card naming the model and count", async () => {
    const { deps, calls } = setup();
    await run("resort", { scope: "inbox" }, deps);
    expect(calls).toEqual([]);
    const card = cards().at(-1)!;
    expect(card.kind === "card" && card.card.type === "confirm" && card.card.title).toBe("Re-sort 40 inbox emails with Test model");
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["sort:{}"]);
    expect(JSON.stringify(await run("resort", { scope: "all" }, deps))).toContain("scope must be");
  });

  it("a failed sort is reported, not claimed: no step line, and the card fails", async () => {
    const { o, deps } = setup();
    o.sort = async () => {
      throw new Error("Sorting failed: rate limited");
    };
    const r = await run("resort", { scope: "new" }, deps);
    expect(r.content).toEqual({ error: "Sorting failed: rate limited" });
    expect(useAssistant.getState().items.some((i) => i.kind === "step")).toBe(false);
    await run("resort", { scope: "inbox" }, deps);
    await runConfirm(lastCardId(), deps);
    const card = cards().at(-1)!;
    expect(card.kind === "card" && card.card.type === "confirm" && [card.card.status, card.card.error]).toEqual(["failed", "Sorting failed: rate limited"]);
  });

  it("a sort where some emails failed says how many, not plain success", async () => {
    const { o, deps } = setup();
    o.sort = async () => ({ failed: 2, total: 5, error: "rate limited" });
    const r = await run("resort", { scope: "new" }, deps);
    expect(r.content).toEqual({ status: "partial", note: "2 of 5 emails couldn't be sorted (rate limited); the rest are sorted now." });
    await run("resort", { scope: "inbox" }, deps);
    await runConfirm(lastCardId(), deps);
    const card = cards().at(-1)!;
    expect(card.kind === "card" && card.card.type === "confirm" && card.card.result).toBe("Inbox re-sorted; 2 of 5 couldn't be sorted (rate limited)");
  });

  it("the real sort throws when the store recorded an error during it", async () => {
    const { organizeModule } = await import("@/lib/ai/assistant/modules/organize");
    const { useMail } = await import("@/lib/store");
    const real = organizeModule.realDeps!() as OrganizeDeps;
    const sort = useMail.getState().sort;
    try {
      useMail.setState({ sort: async () => useMail.setState((s) => ({ sorting: { ...s.sorting, running: false, error: "Error: rate limited" } })) });
      await expect(real.sort()).rejects.toThrow("Sorting failed: rate limited");
      useMail.setState({ sort: async () => useMail.setState({ sorting: { running: false, done: 1, total: 1 } }) });
      await expect(real.sort()).resolves.toBeUndefined();
    } finally {
      useMail.setState({ sort });
    }
  });
});

describe("direct-action budget", () => {
  it("set_category shares the 3-email message budget with other modules", async () => {
    const { deps, calls } = setup();
    know(...emails.map((e) => e.id));
    useAssistant.setState({ directThisTurn: 1 });
    await run("set_category", { ids: ["m1", "m2", "m3"], category: "social" }, deps);
    expect(calls).toEqual([]);
    expect(cards().at(-1)!.kind === "card" && (cards().at(-1) as { card: { type: string } }).card.type).toBe("confirm");
    await run("set_category", { ids: ["m1", "m2"], category: "social" }, deps);
    expect(calls).toEqual(["setCategory:2:social"]);
    expect(useAssistant.getState().directThisTurn).toBe(3);
  });

  it("dismiss_suggestions past the budget shows a card", async () => {
    const { deps, calls } = setup();
    know("m0", "m2");
    useAssistant.setState({ directThisTurn: 2 });
    const r = await run("dismiss_suggestions", { ids: ["m0", "m2"] }, deps);
    expect(r.content).toMatchObject({ status: "awaiting_confirmation" });
    expect(calls).toEqual([]);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["dismiss:m0,m2"]);
  });
});

describe("folder suggestions", () => {
  it("lists suggestions with refs, accepts via card, dismisses at once", async () => {
    const { deps, calls } = setup();
    const r = (await run("folder_suggestions", {}, deps)).content as { suggestions: { id: string; ref: string; folder: string; confidence: number }[] };
    expect(r.suggestions.map((s) => s.id)).toEqual(["m0", "m2"]);
    expect(r.suggestions[0]).toMatchObject({ folder: "Receipts", confidence: 0.9 });
    expect(r.suggestions[0].ref).toMatch(/^m\d+$/);

    await run("accept_suggestions", { ids: ["m0", "m2"] }, deps);
    expect(calls).toEqual([]);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["accept:m0,m2"]);

    await run("dismiss_suggestions", { ids: ["m0"] }, deps);
    expect(calls.at(-1)).toBe("dismiss:m0");
  });

  it("errors when no listed email has a suggestion", async () => {
    const { deps } = setup();
    know("m5");
    expect(JSON.stringify(await run("accept_suggestions", { ids: ["m5"] }, deps))).toContain("none of those emails has a folder suggestion");
  });
});

describe("create_folder", () => {
  type ConfirmCard = { title: string; detail?: string; preview?: { fields?: { label: string; value: string }[] }; payload: unknown };
  const lastCard = () => (cards().at(-1) as { card: ConfirmCard }).card;

  it("puts a new folder and its missing parent on one card, and creates nothing until confirmed", async () => {
    const { deps, calls } = setup();
    const r = await run("create_folder", { path: "Kids / Lincoln Elementary – Sam" }, deps);
    expect(r.content).toMatchObject({ status: "awaiting_confirmation" });
    expect(lastCard()).toMatchObject({ title: 'Create folder "Kids/Lincoln Elementary – Sam"', detail: "z@gmail.com" });
    expect(lastCard().preview!.fields!.map((f) => f.value)).toEqual(["Kids", "Kids/Lincoln Elementary – Sam"]);
    expect(calls).toEqual([]);
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["createFolder:g:Kids/Lincoln Elementary – Sam"]);
    expect(useAssistant.getState().items.find((i) => i.id === lastCardId())).toMatchObject({ card: { status: "done", result: 'Created "Kids/Lincoln Elementary – Sam"' } });
  });

  it("lists only the levels that are missing", async () => {
    const { deps } = setup();
    await run("create_folder", { path: "receipts/2026" }, deps);
    expect(lastCard().preview!.fields!.map((f) => f.value)).toEqual(["receipts/2026"]);
  });

  it("returns exists for a folder that is already there, with no card", async () => {
    const { deps } = setup();
    expect((await run("create_folder", { path: "RECEIPTS" }, deps)).content).toEqual({ exists: true, folder_id: "g:L1", path: "Receipts" });
    expect(cards()).toHaveLength(0);
  });

  it("rejects empty levels, control characters and long names as malformed", async () => {
    const { deps } = setup();
    for (const path of ["Kids//Sam", " ", "Kids/\u0007bell", `Kids/${"x".repeat(101)}`]) {
      expect((await run("create_folder", { path }, deps)).malformed, path).toBe(true);
    }
    expect(cards()).toHaveLength(0);
  });

  it("asks which account when it can't tell, and uses the open folder's account", async () => {
    const { deps, st } = setup();
    st.accounts = [{ id: "g", address: "z@gmail.com" }, { id: "o", address: "z@example.org" }];
    expect((await run("create_folder", { path: "Kids" }, deps)).malformed).toBe(true);
    st.viewAccount = "o";
    await run("create_folder", { path: "Kids" }, deps);
    expect(lastCard()).toMatchObject({ detail: "z@example.org", payload: { accountId: "o" } });
    await run("create_folder", { path: "Trips", account_id: "z@gmail.com" }, deps);
    expect(lastCard()).toMatchObject({ payload: { accountId: "g" } });
  });

  it("while the card is pending, moving or filing into that folder waits instead of failing", async () => {
    const { deps } = setup();
    await run("create_folder", { path: "Kids/Lincoln Elementary – Sam" }, deps);
    know("m1");
    const moved = await run("act", { ids: ["m1"], op: "move_to_folder", folder: "Kids/Lincoln Elementary - Sam" }, deps);
    expect(moved).toEqual({ content: { status: "waiting_for_folder", note: expect.stringContaining("hasn't confirmed") } });
    const filed = await run("always_file", { sender: "coach@district.example.org", folder: "Lincoln Elementary – Sam" }, deps);
    expect(filed.content).toMatchObject({ status: "waiting_for_folder" });
    // Asking for the same folder again doesn't stack a second card.
    await run("create_folder", { path: "Kids/Lincoln Elementary – Sam" }, deps);
    expect(cards()).toHaveLength(1);
  });
});

describe("always_file with a domain", () => {
  it("accepts a bare domain (or @domain) and files it as the domain", async () => {
    const { deps, calls } = setup();
    const r = await run("always_file", { sender: "@District.example.org", folder: "Bills" }, deps);
    expect(r.malformed).toBeUndefined();
    expect(JSON.stringify(cards().at(-1))).toContain("Anyone at district.example.org");
    await runConfirm(lastCardId(), deps);
    expect(calls).toEqual(["addRule:district.example.org:g:L2"]);
  });

  it("a missing folder is a plain error naming existing folders and create_folder", async () => {
    const { deps } = setup();
    const r = await run("always_file", { sender: "district.example.org", folder: "Kids/Sam" }, deps);
    expect(r.malformed).toBeUndefined();
    const msg = (r.content as { error: string }).error;
    expect(msg).toMatch(/^unknown folder "Kids\/Sam"\. Existing folders: "Bills", "Receipts"\./);
    expect(msg).toContain("call create_folder first");
  });
});
