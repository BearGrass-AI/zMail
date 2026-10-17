// @vitest-environment jsdom
// Real ToolDeps (deps.ts) against the store with the mock mail provider: local
// category search, header loading, the kind-label cache, and header rows kept
// fresh after actions.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";
import type { GenerativeProvider } from "@/lib/ai/generative";

const kv = vi.hoisted(() => new Map<string, unknown>());
const model = vi.hoisted(() => ({ calls: 0, writes: 0 }));

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
  kvGet: async (k: string) => kv.get(k) ?? null,
  kvSet: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));
vi.mock("@/lib/ai/providers", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/providers")>();
  const labeller: GenerativeProvider = {
    name: "counting",
    chat: async () => ({ text: "", toolCalls: [] }),
    complete: async (m) => {
      model.calls++;
      const n = [...m.at(-1)!.content.matchAll(/^(\d+)\. /gm)].map((x) => x[1]);
      return JSON.stringify(Object.fromEntries(n.map((k) => [k, "order_delivery"])));
    },
  };
  return {
    ...real,
    assistantProvider: () => labeller,
    generativeProvider: () => {
      const g = real.generativeProvider();
      return { ...g, complete: (...a: Parameters<typeof g.complete>) => (model.writes++, g.complete(...a)) } as GenerativeProvider;
    },
  };
});

const { useMail, providerOf } = await import("@/lib/store");
const { useAssistant } = await import("@/lib/ai/assistant/state");
const { realDeps, localSearch, fetchHeaders, newestFromAccounts, KIND_CACHE_MAX } = await import("@/lib/ai/assistant/deps");

const mk = (id: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "a", threadId: id, folderId: "a:inbox", from: { name: "Shop", address: "s@shop.com" }, to: [], subject: "Sale", snippet: "", text: "", date: "2025-01-01T00:00:00Z", unread: false, starred: false, labels: [], ...over }) as Email;

beforeAll(async () => {
  await useMail.getState().load();
});
beforeEach(() => useAssistant.getState().newChat());

describe("local (category/section) search", () => {
  const folders: Folder[] = [
    { id: "a:inbox", accountId: "a", name: "Inbox", system: "inbox" },
    { id: "a:trash", accountId: "a", name: "Trash", system: "trash" },
    { id: "a:spam", accountId: "a", name: "Spam", system: "spam" },
    { id: "a:drafts", accountId: "a", name: "Drafts", system: "drafts" },
    { id: "a:archive", accountId: "a", name: "All Mail", system: "archive" },
    { id: "b:inbox", accountId: "b", name: "Inbox", system: "inbox" },
  ];
  const emails = [
    mk("in"),
    mk("arch", { folderId: "a:archive" }),
    mk("trash", { folderId: "a:trash" }),
    mk("spam", { folderId: "a:spam" }),
    mk("draft", { folderId: "a:drafts" }),
    mk("other", { accountId: "b", folderId: "b:inbox" }),
  ];
  const accounts = [
    { id: "a", kind: "mock" as const, name: "A", address: "a@x.com" },
    { id: "b", kind: "mock" as const, name: "B", address: "b@x.com" },
  ];
  const ctx = { categoryOf: () => "promotions" as const, sectionOf: () => undefined };
  const ids = (q: Parameters<typeof localSearch>[3]) => localSearch(emails, accounts, folders, q, ctx).map((e) => e.id);

  it("leaves out Trash, Spam and Drafts when no folder is named", () => {
    expect(ids({ category: "promotions" })).toEqual(["in", "arch", "other"]);
  });
  it("honours a named folder per account", () => {
    expect(ids({ category: "promotions", folder: "inbox" })).toEqual(["in", "other"]);
    expect(ids({ category: "promotions", folder: "trash" })).toEqual(["trash"]);
    // A folder id from one account never widens another account's search.
    expect(ids({ category: "promotions", folder: "a:archive" })).toEqual(["arch"]);
  });
});

describe("header loading", () => {
  it("reports increasing progress and stops early when cancelled", async () => {
    const refs = Array.from({ length: 550 }, (_, i) => ({ id: `h${i}`, accountId: "a" }));
    const known = { h0: mk("h0"), h1: mk("h1") };
    const fetched: string[][] = [];
    let cancelled = false;
    const progress: [number, number][] = [];
    const rows = await fetchHeaders(
      refs,
      known,
      async (_a, part) => {
        fetched.push(part);
        await new Promise((r) => setTimeout(r, 0));
        return part.map((id) => mk(id));
      },
      (n, total) => {
        progress.push([n, total]);
        if (progress.length === 2) cancelled = true;
      },
      () => cancelled,
    );
    expect(progress.map((p) => p[1]).every((t) => t === 550)).toBe(true);
    expect(progress.map((p) => p[0])).toEqual([...progress.map((p) => p[0])].sort((x, y) => x - y));
    expect(progress[0][0]).toBe(102);
    // 548 missing → 6 chunks; two run at a time, so cancelling after the second stops the rest.
    expect(fetched.length).toBeLessThan(6);
    expect(rows.length).toBeLessThan(550);
  });

  it("loads everything with no cancel", async () => {
    const refs = Array.from({ length: 250 }, (_, i) => ({ id: `k${i}`, accountId: "a" }));
    const rows = await fetchHeaders(refs, {}, async (_a, part) => part.map((id) => mk(id)));
    expect(rows).toHaveLength(250);
  });
});

describe("kind cache through deps", () => {
  it("keeps the newest 20,000 labels and makes no model call the second time", async () => {
    const old = Object.fromEntries(Array.from({ length: KIND_CACHE_MAX - 2 }, (_, i) => [`old${i}`, "promotion"]));
    kv.set("assistant.kinds", old);
    const rows = Array.from({ length: 5 }, (_, i) => mk(`new${i}`));
    const first = await realDeps().kinds(rows);
    expect(model.calls).toBe(1);
    expect(Object.values(first)).toEqual(Array(5).fill("order_delivery"));
    const saved = kv.get("assistant.kinds") as Record<string, string>;
    expect(Object.keys(saved)).toHaveLength(KIND_CACHE_MAX);
    expect(saved.new4).toBe("order_delivery");
    expect(saved.old0).toBeUndefined();
    expect(saved.old2).toBeUndefined();
    expect(saved.old3).toBe("promotion");
    await realDeps().kinds(rows);
    expect(model.calls).toBe(1);
  });
});

describe("header rows after actions", () => {
  it("bulk and undo update the assistant's header rows for mail not in the store", async () => {
    const s = useMail.getState();
    const target = s.emails.find((e) => e.accountId === "personal" && e.folderId === "personal:inbox")!;
    // Pretend zMail only knows this email from a search header row.
    useMail.setState({ emails: s.emails.filter((e) => e.id !== target.id) });
    useAssistant.getState().addHeaders([{ ...target, partial: true }]);
    const deps = realDeps();
    const res = await deps.bulk([{ ...target, partial: true }], { kind: "archive" });
    expect(res.done).toBe(1);
    expect(useAssistant.getState().headers[target.id].folderId).toBe("personal:archive");
    // The next action records the true before-state.
    const second = await deps.bulk([useAssistant.getState().headers[target.id]], { kind: "star", starred: true });
    expect(second.undo[0].folderId).toBe("personal:archive");
    expect(useAssistant.getState().headers[target.id].starred).toBe(true);
    await deps.undo(second.undo, { kind: "star", starred: true });
    expect(useAssistant.getState().headers[target.id].starred).toBe(false);
    await deps.undo(res.undo, { kind: "archive" });
    expect(useAssistant.getState().headers[target.id].folderId).toBe("personal:inbox");
  });
});

describe("Outlook search cap through deps.search", () => {
  it("marks the result capped when a backend's limit was reached", async () => {
    const p = providerOf("personal");
    const spy = vi.spyOn(p, "search").mockImplementation(async (_q, _f, page) =>
      page ? { ids: ["x2"], limit: 3, scanned: 1 } : { ids: ["x1"], limit: 3, scanned: 2, next: "p2" },
    );
    try {
      const r = await realDeps().search({ from: "shop.com" }, 10_000);
      expect([r.refs.length, r.capped]).toEqual([2, true]);
      spy.mockImplementation(async () => ({ ids: ["x1"], limit: 3, scanned: 2 }));
      expect((await realDeps().search({ from: "shop.com" }, 10_000)).capped).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("attachment search through deps.search", () => {
  // The set a bulk action runs on: "without attachments" must leave attachment mail out.
  it("hasAttachment false and true split the mail between them", async () => {
    const ids = async (q: Parameters<ReturnType<typeof realDeps>["search"]>[0]) => (await realDeps().search(q, 10_000)).refs.map((r) => r.id).sort();
    const all = await ids({});
    const withFiles = await ids({ hasAttachment: true });
    const without = await ids({ hasAttachment: false });
    expect(withFiles.length).toBeGreaterThan(0);
    expect(without.filter((id) => withFiles.includes(id))).toEqual([]);
    expect([...withFiles, ...without].sort()).toEqual(all);
  });
});

describe("newestFromAccounts", () => {
  const row = (id: string, accountId: string, date: string) => ({ id, accountId, date }) as Email;
  type Page = { ids: string[]; headers?: Email[]; next?: string };
  const fake = (pages: Page[] | Error, headerRows: Email[] = []) => {
    const seen: (string | undefined)[] = [];
    return {
      seen,
      search: async (_q: unknown, _f: Folder[], page?: string) => {
        seen.push(page);
        if (pages instanceof Error) throw pages;
        return pages[page ? Number(page) : 0];
      },
      headers: async (ids: string[]) => headerRows.filter((r) => ids.includes(r.id)),
    };
  };

  it("picks the newest first hit across accounts", async () => {
    const g = fake([{ ids: ["g1", "g0"] }], [row("g1", "g", "2026-10-01T00:00:00Z")]);
    const m = fake([{ ids: ["m1"], headers: [row("m1", "m", "2026-10-05T00:00:00Z")] }]);
    const p = { g, m } as Record<string, ReturnType<typeof fake>>;
    expect(await newestFromAccounts("amazon.com", ["g", "m"], [], (id) => p[id])).toEqual({ id: "m1", accountId: "m" });
  });

  it("skips an account that fails", async () => {
    const g = fake(new Error("token expired"));
    const m = fake([{ ids: ["m1"], headers: [row("m1", "m", "2026-10-05T00:00:00Z")] }]);
    const p = { g, m } as Record<string, ReturnType<typeof fake>>;
    expect(await newestFromAccounts("amazon.com", ["g", "m"], [], (id) => p[id])).toEqual({ id: "m1", accountId: "m" });
  });

  it("throws when nothing was found and an account failed, null when none have mail", async () => {
    const g = fake(new Error("token expired"));
    const m = fake([{ ids: [] }]);
    const p = { g, m } as Record<string, ReturnType<typeof fake>>;
    await expect(newestFromAccounts("amazon.com", ["g", "m"], [], (id) => p[id])).rejects.toThrow("token expired");
    expect(await newestFromAccounts("amazon.com", ["m"], [], (id) => p[id])).toBeNull();
  });

  it("follows a couple of pages emptied by filtering, then stops", async () => {
    const m = fake([{ ids: [], next: "1" }, { ids: [], next: "2" }, { ids: ["m9"], headers: [row("m9", "m", "2026-09-01T00:00:00Z")] }]);
    expect(await newestFromAccounts("amazon.com", ["m"], [], () => m)).toEqual({ id: "m9", accountId: "m" });
    expect(m.seen).toEqual([undefined, "1", "2"]);
    const far = fake([{ ids: [], next: "1" }, { ids: [], next: "2" }, { ids: [], next: "3" }, { ids: ["x"] }]);
    expect(await newestFromAccounts("amazon.com", ["m"], [], () => far)).toBeNull();
    // Three pages of normal mail, then three of Trash.
    expect(far.seen).toEqual([undefined, "1", "2", undefined, "1", "2"]);
  });

  it("looks in Trash when normal mail has nothing (mail just cleaned up)", async () => {
    const queries: unknown[] = [];
    const m = {
      search: async (q: { folder?: string }) => {
        queries.push(q);
        return q.folder === "trash" ? { ids: ["t1"], headers: [row("t1", "m", "2026-10-10T00:00:00Z")] } : { ids: [] };
      },
      headers: async () => [],
    };
    expect(await newestFromAccounts("amazon.com", ["m"], [], () => m)).toEqual({ id: "t1", accountId: "m" });
    expect(queries).toEqual([{ from: "amazon.com" }, { from: "amazon.com", folder: "trash" }]);
  });

  it("doesn't search Trash when normal mail has a hit", async () => {
    const queries: unknown[] = [];
    const m = {
      search: async (q: unknown) => (queries.push(q), { ids: ["m1"], headers: [row("m1", "m", "2026-10-05T00:00:00Z")] }),
      headers: async () => [],
    };
    expect(await newestFromAccounts("amazon.com", ["m"], [], () => m)).toEqual({ id: "m1", accountId: "m" });
    expect(queries).toEqual([{ from: "amazon.com" }]);
  });

  it("Trash search keeps the page bound and per-account errors", async () => {
    const seen: (string | undefined)[] = [];
    const far = {
      search: async (q: { folder?: string }, _f: Folder[], page?: string) => {
        if (q.folder === "trash") seen.push(page);
        return { ids: [], next: String(Number(page ?? 0) + 1) };
      },
      headers: async () => [],
    };
    expect(await newestFromAccounts("amazon.com", ["m"], [], () => far)).toBeNull();
    expect(seen).toHaveLength(3);
    const g = { search: async (q: { folder?: string }) => (q.folder === "trash" ? Promise.reject(new Error("trash down")) : { ids: [] }), headers: async () => [] };
    const m = { search: async (q: { folder?: string }) => (q.folder === "trash" ? { ids: ["t2"], headers: [row("t2", "m", "2026-10-01T00:00:00Z")] } : { ids: [] }), headers: async () => [] };
    const p = { g, m } as Record<string, typeof g>;
    expect(await newestFromAccounts("amazon.com", ["g", "m"], [], (id) => p[id])).toEqual({ id: "t2", accountId: "m" });
    await expect(newestFromAccounts("amazon.com", ["g"], [], (id) => p[id])).rejects.toThrow("trash down");
  });
});

describe("draft with pending attachments", () => {
  it("opens the draft with the files and clears the pending list", async () => {
    const files = [{ filename: "a.pdf", mimeType: "application/pdf", base64: "AAAA" }];
    useAssistant.getState().setPendingAttachments(files);
    const c = await realDeps().draft({ kind: "new", instructions: "hello", to: "x@y.edu" });
    expect(c.attachments).toEqual([{ ...files[0], size: 3 }]);
    expect(useAssistant.getState().pendingAttachments).toEqual([]);
    const again = await realDeps().draft({ kind: "new", instructions: "hello", to: "x@y.edu" });
    expect(again.attachments).toBeUndefined();
  });

  it("opens the draft from the account picked in the Draft-with-AI box, once", async () => {
    useAssistant.getState().setPendingFrom("outlook-1");
    const c = await realDeps().draft({ kind: "new", instructions: "hello", to: "x@y.edu" });
    expect(c.fromAccountId).toBe("outlook-1");
    expect(useAssistant.getState().pendingFrom).toBeNull();
    const again = await realDeps().draft({ kind: "new", instructions: "hello", to: "x@y.edu" });
    expect(again.fromAccountId).toBeUndefined();
  });
});

describe("draft written by the assistant", () => {
  it("uses the assistant's subject and body without calling the writer", async () => {
    const before = model.writes;
    const c = await realDeps().draft({ kind: "new", body: "**Hi**", subject: "S", to: "a@b.c" });
    expect(c.prefill).toMatchObject({ body: "**Hi**", subject: "S", to: "a@b.c" });
    expect(model.writes).toBe(before);
  });
});

describe("composer sharing", () => {
  it("editCompose bumps seq and openCompose(null) clears the shared state", () => {
    const s = useMail.getState();
    s.setComposeView({ to: "", cc: "", bcc: "", subject: "S", body: "b" });
    s.editCompose({ body: "one" });
    s.editCompose({ subject: "two" });
    expect(useMail.getState().composeEdit).toEqual({ seq: 2, subject: "two", session: useMail.getState().composeSession });
    expect(useMail.getState().composeView?.subject).toBe("S");
    s.openCompose(null);
    expect(useMail.getState().composeView).toBeNull();
    expect(useMail.getState().composeEdit).toBeNull();
  });

  it("realDeps().view() carries the shared composer", () => {
    const v = { to: "a@b.c", cc: "", bcc: "", subject: "S", body: "b" };
    useMail.getState().setComposeView(v);
    expect(realDeps().view().compose).toEqual(v);
    useMail.getState().setComposeView(null);
  });
});

describe("lane rule card count", () => {
  it("counts the emails saving the rule moved, not every match (the user's own placements stay)", () => {
    const s = useMail.getState();
    const inbox = s.folders.find((f) => f.system === "inbox")!;
    const from = { name: "J", address: "jbs@example.org" };
    const prev = { emails: s.emails, overrides: s.overrides, laneRuled: s.laneRuled, autoRules: s.autoRules };
    try {
      useMail.setState({
        emails: ["l1", "l2", "l3"].map((id) => mk(id, { accountId: inbox.accountId, folderId: inbox.id, from })),
        overrides: { l3: "worth_skim" },
        laneRuled: {},
        autoRules: [],
      });
      const deps = realDeps();
      const id = deps.addRule({ from: "jbs@example.org", action: { lane: "needs_you" } });
      expect(useMail.getState().overrides).toEqual({ l1: "needs_you", l2: "needs_you", l3: "worth_skim" });
      expect(deps.laneMatches!(id)).toBe(2);
    } finally {
      useMail.setState(prev);
    }
  });
});
