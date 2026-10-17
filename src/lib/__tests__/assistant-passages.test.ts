// @vitest-environment jsdom
// find_passages: with meaning-based search ready, the assistant gets the five best emails with the
// passage that answers, instead of reading whole bodies; without it the tool isn't offered and the
// assistant searches and reads as before.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";
import type { GenerativeProvider } from "@/lib/ai/generative";
import type { PassageHit, SemanticStatus } from "@/lib/semantic";

vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
const mailState = vi.hoisted(() => ({
  accounts: [{ id: "g", name: "Personal", address: "z@x.com" }],
  folders: [
    { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
    { id: "g:SPAM", accountId: "g", name: "Spam", system: "spam" },
    { id: "g:TRASH", accountId: "g", name: "Trash", system: "trash" },
  ],
  emails: [],
  me: { name: "Alex Rivera" },
}));
vi.mock("@/lib/store", async (orig) => ({ ...(await orig<typeof import("@/lib/store")>()), useMail: { getState: () => mailState } }));
const sem = vi.hoisted(() => ({
  status: null as SemanticStatus | null,
  passages: vi.fn(),
}));
vi.mock("@/lib/semantic", async (orig) => ({
  ...(await orig<typeof import("@/lib/semantic")>()),
  semanticStatus: async () => sem.status,
  semanticPassages: sem.passages,
}));

const { useAssistant } = await import("@/lib/ai/assistant/state");
const { executeTool } = await import("@/lib/ai/assistant/tools");
const { passagesModule } = await import("@/lib/ai/assistant/modules/passages");
const { ask } = await import("@/lib/ai/assistant/loop");
import type { ToolDeps } from "@/lib/ai/assistant/tools";

const READY: SemanticStatus = { enabled: true, model: "ready", downloaded: 1, size: 1, error: null, indexed: 10, total: 10, indexing: false };

// A fixture mailbox: 20 emails about a trip, a budget and the usual noise, with realistic bodies.
const topics = ["Flight confirmation DEN", "Q3 budget review", "Parking permit renewal", "Board meeting agenda", "Your order has shipped"];
const para = (t: string, i: number) =>
  `Hi Alex, following up on ${t.toLowerCase()} (item ${i}). ` +
  "Here are the details we discussed on the call last week, including times, locations and who is responsible for each part. ".repeat(12) +
  `Your confirmation number is ${4417 + i}. Departure is at 7:${10 + i} AM from gate B${i}. Let me know if anything changes.`;
const fixture: Email[] = Array.from({ length: 20 }, (_, i) => {
  const t = topics[i % topics.length];
  return {
    id: `e${i}`,
    accountId: "g",
    threadId: `e${i}`,
    folderId: "g:INBOX",
    from: { name: `Sender ${i}`, address: `sender${i}@example.com` },
    to: [{ name: "Alex", address: "z@x.com" }],
    subject: `${t} #${i}`,
    snippet: para(t, i).slice(0, 160),
    text: para(t, i).repeat(i % 3 === 0 ? 4 : 1),
    date: `2026-09-${String(i + 1).padStart(2, "0")}T09:00:00Z`,
    unread: false,
    starred: false,
    labels: [],
  } as Email;
});
const hit = (e: Email): PassageHit => {
  const body = e.text;
  const at = body.indexOf("Your confirmation number");
  return { id: e.id, account_id: e.accountId, folder_id: e.folderId, date: e.date, from_name: e.from.name, from_address: e.from.address, subject: e.subject, passage: body.slice(at - 60, at + 240) };
};

function deps(find: (q: string, a?: string) => Promise<{ ready: boolean; hits: PassageHit[] }>): ToolDeps {
  return {
    folders: () => mailState.folders,
    sections: () => [],
    search: async () => ({ refs: fixture.map((e) => ({ id: e.id, accountId: e.accountId })), headers: fixture, tooMany: false }),
    loadHeaders: async (refs: { id: string }[]) => refs.map((r) => fixture.find((e) => e.id === r.id)!),
    getEmail: async (r: { id: string }) => fixture.find((e) => e.id === r.id)!,
    ext: { passages: { find } },
  } as unknown as ToolDeps;
}
const call = (name: string, args: Record<string, unknown>) => ({ id: name, name, args });

beforeEach(() => {
  useAssistant.getState().newChat();
  sem.status = READY;
  sem.passages.mockReset();
});

describe("find_passages", () => {
  it("returns the top hits as from, subject, date and a bounded passage, usable by read_email", async () => {
    const hits = fixture.slice(0, 5).map(hit);
    hits[0] = { ...hits[0], passage: "x".repeat(2000), subject: "s".repeat(1000) };
    const d = deps(async () => ({ ready: true, hits }));
    const res = (await executeTool(call("find_passages", { query: "when does my flight to Denver leave" }), d)).content as { results: Record<string, string>[]; note: string };
    expect(res.results).toHaveLength(5);
    expect(res.results[1]).toEqual({ id: "e1", ref: "m2", from: "Sender 1 <sender1@example.com>", subject: "Q3 budget review #1", date: "2026-09-02", passage: hits[1].passage });
    expect(res.results[0].passage.length).toBe(300);
    expect(res.results[0].subject.length).toBe(200);
    expect(res.note).toMatch(/untrusted/i);
    // The ids are known, so read_email (and draft, act) take them.
    const read = (await executeTool(call("read_email", { id: "e3" }), d)).content as { subject: string };
    expect(read.subject).toBe(fixture[3].subject);
  });

  it("without the index, says so and points at search_mail", async () => {
    const d = deps(async () => ({ ready: false, hits: [] }));
    const res = (await executeTool(call("find_passages", { query: "flight" }), d)).content as { available: boolean; message: string };
    expect(res.available).toBe(false);
    expect(res.message).toContain("search_mail");
  });

  it("refuses empty and oversized queries", async () => {
    const d = deps(async () => ({ ready: true, hits: [] }));
    expect((await executeTool(call("find_passages", { query: "  " }), d)).malformed).toBe(true);
    expect((await executeTool(call("find_passages", { query: "q".repeat(301) }), d)).malformed).toBe(true);
  });

  it("searches all mail but spam and trash, and drops hits from an account removed meanwhile", async () => {
    sem.passages.mockImplementation(async () => {
      // The account goes away while the search runs.
      const answer = { ready: true, hits: [hit(fixture[0]), { ...hit(fixture[1]), account_id: "gone" }] };
      return answer;
    });
    const real = passagesModule.realDeps!() as { find: (q: string, a?: string) => Promise<{ hits: PassageHit[] }> };
    const r = await real.find("flight", "g");
    expect(sem.passages).toHaveBeenCalledWith("flight", { accountIds: ["g"], excludeFolderIds: ["g:SPAM", "g:TRASH"] }, 5);
    expect(r.hits.map((h) => h.id)).toEqual(["e0"]);
  });

  it("uses a fraction of the characters of searching and reading whole emails", async () => {
    const d = deps(async () => ({ ready: true, hits: fixture.slice(0, 5).map(hit) }));
    // Today: search_mail's 20-row sample, then read_email on the top 3.
    const search = (await executeTool(call("search_mail", { query: { words: "flight denver" } }), d)).content;
    let before = JSON.stringify(search).length;
    for (const id of ["e0", "e1", "e2"]) before += JSON.stringify((await executeTool(call("read_email", { id }), d)).content).length;
    useAssistant.getState().newChat();
    const after = JSON.stringify((await executeTool(call("find_passages", { query: "when does my flight to Denver leave" }), d)).content).length;
    expect(after).toBeLessThan(before / 4);
    expect(after).toBeLessThan(2_600);
  });
});

describe("the loop", () => {
  const recording = (): GenerativeProvider & { tools: string[][] } => {
    const tools: string[][] = [];
    return { name: "rec", tools, complete: async () => "", chat: async (_s, _m, t) => (tools.push(t.map((x) => x.name)), { text: "ok", toolCalls: [] }) };
  };

  it("offers find_passages only while meaning-based search is ready", async () => {
    const p = recording();
    await ask("when is my flight?", deps(async () => ({ ready: true, hits: [] })), p);
    expect(p.tools[0]).toContain("find_passages");
    expect(p.tools[0]).toContain("search_mail");
    sem.status = { ...READY, model: "missing", indexed: 0 };
    useAssistant.getState().newChat();
    const q = recording();
    await ask("when is my flight?", deps(async () => ({ ready: true, hits: [] })), q);
    expect(q.tools[0]).not.toContain("find_passages");
    expect(q.tools[0]).toContain("search_mail");
  });
});
