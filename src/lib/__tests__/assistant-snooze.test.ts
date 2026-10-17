// @vitest-environment jsdom
// Assistant snooze module: snooze, unsnooze, list_snoozed, confirm card, store.unsnooze.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import { runConfirm } from "@/lib/ai/assistant/modules/confirm";
import type { SnoozeDeps } from "@/lib/ai/assistant/modules/snooze";
import { useAssistant } from "@/lib/ai/assistant/state";
import { useMail } from "@/lib/store";
import type { Email } from "@/lib/types";
import { localDate } from "@/lib/dates/local";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const mk = (i: number) => ({ id: `e${i}`, accountId: "a", from: { name: `S${i}`, address: `s${i}@x.com` }, subject: `Sub ${i}`, date: "2026-10-01T10:00:00Z" }) as unknown as Email;
function future(days: number) {
  const d = new Date(Date.now() + days * 86400000);
  return `${localDate(d)}T08:00`;
}

let snoozed: Record<string, number>;
let emails: Email[];
let toast: ReturnType<typeof vi.fn>;
let deps: ToolDeps;
const fake: SnoozeDeps = {
  emails: () => emails,
  snoozed: () => snoozed,
  snooze: (ids, until) => { for (const id of ids) snoozed[id] = until; },
  unsnooze: (ids) => { for (const id of ids) delete snoozed[id]; },
  restore: (prev) => { for (const [id, t] of Object.entries(prev)) if (t === undefined) delete snoozed[id]; else snoozed[id] = t; },
};

beforeEach(() => {
  useAssistant.getState().newChat();
  snoozed = {};
  emails = Array.from({ length: 30 }, (_, i) => mk(i));
  useAssistant.getState().remember(emails.map((e) => ({ id: e.id, accountId: "a" })));
  toast = vi.fn();
  deps = { ext: { snooze: fake }, toast } as unknown as ToolDeps;
});

const run = (name: string, args: Record<string, unknown>) => executeTool({ id: "c1", name, args }, deps);

describe("snooze", () => {
  it("snoozes in range and offers undo", async () => {
    const r = await run("snooze", { ids: ["e1", "e2"], until: future(2) });
    expect(r.content).toMatchObject({ status: "snoozed", count: 2 });
    expect(Object.keys(snoozed).sort()).toEqual(["e1", "e2"]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatch(/^Snoozed 2 until /);
    toast.mock.calls[0][1]();
    expect(snoozed).toEqual({});
  });

  it("rejects the past and more than a year out", async () => {
    expect((await run("snooze", { ids: ["e1"], until: future(-1) })).content).toMatchObject({ error: expect.stringMatching(/past/) });
    expect((await run("snooze", { ids: ["e1"], until: future(400) })).content).toMatchObject({ error: expect.stringMatching(/year/) });
    expect(snoozed).toEqual({});
  });

  it("treats a malformed time or unknown id as a malformed call", async () => {
    const bad = await run("snooze", { ids: ["e1"], until: "tomorrow" });
    expect(JSON.stringify(bad)).toMatch(/until must be/);
    const unk = await run("snooze", { ids: ["nope"], until: future(1) });
    expect(JSON.stringify(unk)).toMatch(/unknown id/);
  });

  it("snoozes exactly 25 at once but asks first for 26", async () => {
    const ids25 = emails.slice(0, 25).map((e) => e.id);
    await run("snooze", { ids: ids25, until: future(1) });
    expect(Object.keys(snoozed)).toHaveLength(25);
    snoozed = {};
    const ids26 = emails.slice(0, 26).map((e) => e.id);
    const r = await run("snooze", { ids: ids26, until: future(1) });
    expect(r.content).toMatchObject({ status: "awaiting_confirmation" });
    expect(snoozed).toEqual({});
    const item = useAssistant.getState().items.find((i) => i.kind === "card")!;
    expect(item.kind === "card" && item.card.type === "confirm" && item.card.confirmLabel).toBe("Snooze 26");
    await runConfirm(item.id, deps);
    expect(Object.keys(snoozed)).toHaveLength(26);
  });

  it("shares one 25-email budget per user message: a second snooze of 20 becomes a card", async () => {
    const first = await run("snooze", { ids: emails.slice(0, 20).map((e) => e.id), until: future(1) });
    expect(first.content).toMatchObject({ status: "snoozed", count: 20 });
    const second = await run("snooze", { ids: emails.slice(10, 30).map((e) => e.id), until: future(2) });
    expect(second.content).toMatchObject({ status: "awaiting_confirmation", count: 20 });
    expect(Object.keys(snoozed)).toHaveLength(20);
    expect(useAssistant.getState().items.filter((i) => i.kind === "card")).toHaveLength(1);
  });

  it("Undo puts back an earlier snooze time and clears new ones", async () => {
    const earlier = Date.now() + 5e6;
    snoozed = { e1: earlier };
    await run("snooze", { ids: ["e1", "e2"], until: future(3) });
    expect(snoozed.e1).not.toBe(earlier);
    toast.mock.calls[0][1]();
    expect(snoozed).toEqual({ e1: earlier });
  });

  it("does not treat a stale id as a malformed call", async () => {
    const r = await run("snooze", { ids: ["gone"], until: future(1) });
    expect(r.malformed).toBeUndefined();
    expect(r.content).toMatchObject({ error: expect.stringMatching(/^unknown id "gone"/) });
  });

  it("accepts a set_id", async () => {
    useAssistant.setState({ sets: { s1: { id: "s1", label: "x", refs: [{ id: "e3", accountId: "a" }] } } });
    await run("snooze", { set_id: "s1", until: future(1) });
    expect(Object.keys(snoozed)).toEqual(["e3"]);
  });
});

describe("unsnooze and list_snoozed", () => {
  it("unsnoozes only snoozed emails", async () => {
    snoozed = { e1: Date.now() + 1e7 };
    const r = await run("unsnooze", { ids: ["e1", "e2"] });
    expect(r.content).toMatchObject({ status: "unsnoozed", count: 1 });
    expect(snoozed).toEqual({});
  });

  it("unsnooze has an Undo that restores the removed times", async () => {
    const t = Date.now() + 1e7;
    snoozed = { e1: t, e2: t + 1 };
    await run("unsnooze", { ids: ["e1", "e2"] });
    expect(snoozed).toEqual({});
    expect(toast.mock.calls[0][0]).toBe("Unsnoozed 2");
    toast.mock.calls[0][1]();
    expect(snoozed).toEqual({ e1: t, e2: t + 1 });
  });

  it("unsnooze past the message budget shows a card", async () => {
    const t = Date.now() + 1e7;
    snoozed = Object.fromEntries(emails.map((e) => [e.id, t]));
    const r = await run("unsnooze", { ids: emails.map((e) => e.id) });
    expect(r.content).toMatchObject({ status: "awaiting_confirmation", count: 30 });
    expect(Object.keys(snoozed)).toHaveLength(30);
    const item = useAssistant.getState().items.find((i) => i.kind === "card")!;
    await runConfirm(item.id, deps);
    expect(snoozed).toEqual({});
  });

  it("lists snoozed mail soonest first with refs", async () => {
    snoozed = { e2: Date.now() + 2e7, e1: Date.now() + 1e7, e3: Date.now() - 5 };
    const r = (await run("list_snoozed", {})).content as { total: number; emails: { id: string; ref: string }[] };
    expect(r.total).toBe(2);
    expect(r.emails.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(r.emails[0].ref).toMatch(/^m\d+$/);
  });
});

describe("store.unsnooze", () => {
  it("removes snoozes", () => {
    useMail.setState({ snoozed: { a: 1, b: 2 } });
    useMail.getState().unsnooze(["a"]);
    expect(useMail.getState().snoozed).toEqual({ b: 2 });
  });
  it("real restore puts times back and removes ids that had none", async () => {
    const { snoozeModule } = await import("@/lib/ai/assistant/modules/snooze");
    useMail.setState({ snoozed: { a: 5, b: 6 } });
    (snoozeModule.realDeps!() as SnoozeDeps).restore({ a: 1, b: undefined, c: 3 });
    expect(useMail.getState().snoozed).toEqual({ a: 1, c: 3 });
  });
});
