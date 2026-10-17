// @vitest-environment jsdom
// The decision model's answers are untrusted: a choice that wasn't one of the options asked about is
// treated as no answer (the email stays unsorted, or gets no folder or section), saved triage with an
// unknown bucket or kind is dropped on launch, and a row, card or bundle with an unknown kind still draws.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";
import type { ChoiceAnswer, DecisionProvider } from "@/lib/ai/decision";
import type { MailSection } from "@/lib/sections";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }), Toaster: () => null }));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
vi.mock("@/lib/ai/generative", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/generative")>()), oneLiner: async () => "" }));

const { MockDecisionProvider } = await import("@/lib/ai/mock-decision");
const { triageAll } = await import("@/lib/ai/triage");
const { useMail } = await import("@/lib/store");
const { snapshot, restore } = await import("@/lib/store/persistence");
const { categoryMeta, CATEGORY_META } = await import("@/lib/meta");
const { InboxRow, CompactRow } = await import("@/components/mail/email-row");
const { TriageView } = await import("@/components/triage/triage-view");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const inbox: Folder = { id: "a:inbox", accountId: "a", name: "Inbox", system: "inbox" };
const receipts: Folder = { id: "a:receipts", accountId: "a", name: "Receipts" };
const mail = (id: string, subject = "Lunch on Friday?"): Email =>
  ({ id, accountId: "a", threadId: id, folderId: inbox.id, from: { name: "Jane Appleseed", address: "jane@example.com" }, to: [], subject, snippet: subject, text: subject, date: "2026-10-09T10:00:00Z", unread: true, starred: false, labels: [] }) as Email;
const sorted = (id: string, over: Partial<Triage> = {}): Triage =>
  ({ emailId: id, bucket: "worth_skim", bucketProbs: { needs_you: 0, worth_skim: 1, ready_archive: 0 }, category: "updates", urgency: 0, needsReply: 0, model: "fake", ...over }) as Triage;
const section: MailSection = { id: "sec-bills", name: "Bills", description: "Bills to pay", icon: "credit-card", hue: 30, accountIds: [], dates: false };

// A decision model that answers like the mock, except for the choices a test replaces.
const hostile = (replace: Record<string, unknown>): DecisionProvider => {
  const real = new MockDecisionProvider();
  return {
    name: "Hostile",
    maxChoiceOptions: real.maxChoiceOptions,
    decide: async (req) => {
      const res = await real.decide(req);
      for (const [q, choice] of Object.entries(replace)) {
        const prev = res.answers[q] as ChoiceAnswer | undefined;
        res.answers[q] = { type: "choice", confidence: 0.99, probabilities: prev?.probabilities ?? {}, choice } as ChoiceAnswer;
      }
      return res;
    },
  };
};

const BAD = "definitely-not-a-category-<img src=x>";
const sort = async (provider: DecisionProvider) => {
  const out: Triage[] = [];
  const run = await triageAll(provider, [mail("1")], { me: { name: "Ann", address: "ann@example.com" }, folders: [inbox, receipts], habits: new Map(), sections: [section] }, (t) => out.push(t));
  return { out, run };
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("choice answers that weren't offered", () => {
  it("an unknown kind leaves the email unsorted, and the log says how long it was, not what it said", async () => {
    const { out, run } = await sort(hostile({ category: BAD }));
    expect(out).toEqual([]);
    expect(run).toMatchObject({ done: 0, failed: 1 });
    expect(warn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("definitely");
    expect(logged).toContain(String(BAD.length));
  });

  it("an unknown bucket leaves the email unsorted", async () => {
    const { out, run } = await sort(hostile({ bucket: "worth_a_look" }));
    expect(out).toEqual([]);
    expect(run).toMatchObject({ done: 0, failed: 1 });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("a key that only looks like an option (inherited from Object) is not one", async () => {
    const { out } = await sort(hostile({ category: "constructor" }));
    expect(out).toEqual([]);
  });

  it("a folder or section that wasn't offered is no suggestion; the rest of the sort stands", async () => {
    const { out, run } = await sort(hostile({ folder: "a:somewhere-else", section: "sec-made-up" }));
    expect(run).toMatchObject({ done: 1, failed: 0 });
    expect(out[0].folder).toBeUndefined();
    expect(out[0].section).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("offered folder and section answers still go through", async () => {
    const { out } = await sort(hostile({ category: "transactions", folder: receipts.id, section: section.id }));
    expect(out[0]).toMatchObject({ category: "transactions", folder: { folderId: receipts.id }, section: section.id });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("saved triage", () => {
  it("drops entries with an unknown kind or bucket on launch and keeps the rest", () => {
    useMail.setState({ emails: [mail("1"), mail("2"), mail("3"), mail("4")], triage: {} });
    const snap = snapshot(useMail.getState());
    snap.triage = {
      "1": sorted("1"),
      "2": sorted("2", { category: BAD as never }),
      "3": sorted("3", { bucket: "worth_a_look" as never }),
      "4": sorted("4", { category: "constructor" as never }),
    };
    restore(snap, new Map());
    expect(Object.keys(useMail.getState().triage)).toEqual(["1"]);
  });
});

describe("drawing an unknown kind", () => {
  let root: Root;
  beforeEach(() => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });
  // State that got in some other way (a future model, an older build) than triage or launch.
  const poisoned = () =>
    useMail.setState({
      folders: [inbox],
      emails: [mail("1", "Weekly digest")],
      triage: { "1": sorted("1", { category: BAD as never }) },
      overrides: {},
      sectionOverrides: {},
      categoryOverrides: {},
    } as never);

  it("falls back to a neutral tile, and known kinds keep theirs", () => {
    expect(categoryMeta("updates")).toBe(CATEGORY_META.updates);
    expect(categoryMeta(BAD).icon).toBeTypeOf("object");
    expect(categoryMeta("constructor").icon).toBe(categoryMeta(BAD).icon);
  });

  it("inbox and compact rows still draw", () => {
    poisoned();
    const email = useMail.getState().emails[0];
    act(() => root.render(createElement("div", null, createElement(InboxRow, { email }), createElement(CompactRow, { email }))));
    expect(document.body.textContent).toContain("Weekly digest");
  });

  it("the Triage board still draws", () => {
    poisoned();
    act(() => root.render(createElement(TriageView)));
    expect(document.body.textContent).toContain("Weekly digest");
  });
});
