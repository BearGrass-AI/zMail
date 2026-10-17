// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import { useAssistant } from "@/lib/ai/assistant/state";
import { dismissConfirm, runConfirm, type ConfirmCardData } from "@/lib/ai/assistant/modules/confirm";
import type { PeopleDeps } from "@/lib/ai/assistant/modules/people";
import { useMail } from "@/lib/store";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

type View = { to: string; cc: string; bcc: string; subject: string; body: string } | null;
function make(view: View, atts: { id: string; filename: string; mimeType: string; size: number; inline?: boolean }[] = []) {
  const edits: unknown[] = [];
  const downloads: string[] = [];
  const fake: PeopleDeps = {
    search: async () => [{ name: "Ann Lee", address: "ann@x.com", title: "Dean" }, { name: "Bo", address: "bo@x.com" }],
    view: () => view,
    session: () => (view ? 1 : null),
    editCompose: (p) => void edits.push(p),
    scheduled: () => false,
    ensureEmail: async (r) => ({ id: r.id, accountId: r.accountId, subject: "Budget", attachments: atts }) as never,
    attachmentData: async (_e, a) => (downloads.push(a), `data-${a}`),
  };
  return { edits, downloads, fake, deps: { ext: { people: fake } } as unknown as ToolDeps };
}
/** The newest card in the chat. */
const lastCard = () => {
  const items = useAssistant.getState().items;
  const item = items[items.length - 1];
  return item?.kind === "card" && item.card.type === "confirm" ? { id: item.id, card: item.card as ConfirmCardData } : undefined;
};
const run = (name: string, args: Record<string, unknown>, deps: ToolDeps) => executeTool({ id: "c1", name, args }, deps);
const v = (to = "", cc = "", bcc = ""): View => ({ to, cc, bcc, subject: "", body: "" });

beforeEach(() => {
  useAssistant.setState({ items: [], notes: [], known: { m1: { id: "m1", accountId: "a" } } as never });
});

describe("find_people", () => {
  it("maps fields", async () => {
    const { deps } = make(null);
    const r = await run("find_people", { query: "ann" }, deps);
    expect(r.content).toEqual({ people: [{ name: "Ann Lee", address: "ann@x.com", title: "Dean" }, { name: "Bo", address: "bo@x.com" }] });
  });
});

describe("set_draft_recipients", () => {
  it("shows a card with only the new addresses and changes nothing until Apply", async () => {
    const { deps, edits } = make(v("Ann@x.com"));
    const r = await run("set_draft_recipients", { to: ["ann@x.com", "bo@x.com"], cc: ["c@x.com"], bcc: ["eve@example.org"] }, deps);
    expect(r.content).toMatchObject({ status: "awaiting_confirmation" });
    expect(edits).toEqual([]);
    const c = lastCard()!;
    expect(c.card.preview?.fields).toEqual([
      { label: "Add To", value: "bo@x.com" },
      { label: "Add Cc", value: "c@x.com" },
      { label: "Add Bcc", value: "eve@example.org" },
    ]);
    await runConfirm(c.id, deps);
    expect(lastCard()!.card.status).toBe("done");
    expect(edits).toEqual([{ to: "Ann@x.com, bo@x.com", cc: "c@x.com", bcc: "eve@example.org" }]);
  });
  it("a dismissed card leaves the draft alone", async () => {
    const { deps, edits } = make(v("ann@x.com"));
    await run("set_draft_recipients", { bcc: ["eve@example.org"] }, deps);
    dismissConfirm(lastCard()!.id);
    await runConfirm(lastCard()!.id, deps);
    expect(lastCard()!.card.status).toBe("dismissed");
    expect(edits).toEqual([]);
  });
  it("replaces, adds to what the draft has when applied, and skips addresses already there", async () => {
    const a = make(v("old@x.com"));
    await run("set_draft_recipients", { to: ["new@x.com"], mode: "replace" }, a.deps);
    expect(lastCard()!.card.preview?.fields).toEqual([{ label: "To", value: "new@x.com" }]);
    await runConfirm(lastCard()!.id, a.deps);
    expect(a.edits).toEqual([{ to: "new@x.com" }]);

    // The user typed another address while the card was up: it stays.
    let view = v("ann@x.com");
    const b = make(view);
    b.fake.view = () => view;
    await run("set_draft_recipients", { cc: ["c@x.com"] }, b.deps);
    view = v("ann@x.com", "dee@x.com");
    await runConfirm(lastCard()!.id, b.deps);
    expect(b.edits).toEqual([{ cc: "dee@x.com, c@x.com" }]);

    const items = useAssistant.getState().items.length;
    const same = await run("set_draft_recipients", { to: ["ANN@x.com"] }, make(v("ann@x.com")).deps);
    expect(JSON.stringify(same.content)).toContain("already on the draft");
    expect(useAssistant.getState().items).toHaveLength(items);
  });
  it("errors with no draft", async () => {
    const { deps, edits } = make(null);
    const r = await run("set_draft_recipients", { to: ["a@x.com"] }, deps);
    expect(JSON.stringify(r)).toContain("No draft is open; use draft first.");
    expect(edits).toEqual([]);
  });
  it("a card for a draft that is no longer open changes nothing", async () => {
    const { deps, edits, fake } = make(v());
    await run("set_draft_recipients", { bcc: ["eve@example.org"] }, deps);
    fake.session = () => 2;
    await runConfirm(lastCard()!.id, deps);
    expect(lastCard()!.card).toMatchObject({ status: "failed", error: "That draft isn't open anymore. Nothing was changed." });
    expect(edits).toEqual([]);
  });
  it("says on the card when the open draft is a scheduled email", async () => {
    const { deps, fake } = make(v());
    fake.scheduled = () => true;
    await run("set_draft_recipients", { bcc: ["eve@example.org"] }, deps);
    expect(lastCard()!.card.detail).toContain("scheduled");
  });
});

describe("attach_to_draft", () => {
  const atts = [
    { id: "1", filename: "a.pdf", mimeType: "application/pdf", size: 10 },
    { id: "2", filename: "b.png", mimeType: "image/png", size: 5, inline: true },
    { id: "3", filename: "c.txt", mimeType: "text/plain", size: 5 },
  ];
  it("shows the files on a card and downloads and attaches them only on Attach", async () => {
    const { deps, edits, downloads } = make(v(), atts);
    const r = await run("attach_to_draft", { email_id: "m1" }, deps);
    expect(r.content).toMatchObject({ status: "awaiting_confirmation" });
    expect(edits).toEqual([]);
    expect(downloads).toEqual([]);
    const c = lastCard()!;
    expect(c.card.preview?.fields).toEqual([{ label: "Attach", value: "a.pdf (10 B), c.txt (5 B)" }]);
    await runConfirm(c.id, deps);
    expect(edits).toEqual([{ addFiles: [
      { filename: "a.pdf", mimeType: "application/pdf", size: 10, base64: "data-1" },
      { filename: "c.txt", mimeType: "text/plain", size: 5, base64: "data-3" },
    ] }]);
  });
  it("a dismissed card attaches nothing", async () => {
    const { deps, edits, downloads } = make(v(), atts);
    await run("attach_to_draft", { email_id: "m1" }, deps);
    dismissConfirm(lastCard()!.id);
    expect(edits).toEqual([]);
    expect(downloads).toEqual([]);
  });
  it("filters by filename and rejects oversize and unknown ids", async () => {
    const a = make(v(), atts);
    await run("attach_to_draft", { email_id: "m1", filenames: ["C.TXT"] }, a.deps);
    await runConfirm(lastCard()!.id, a.deps);
    expect(a.edits).toHaveLength(1);
    expect(a.downloads).toEqual(["3"]);
    const big = make(v(), [{ id: "1", filename: "big", mimeType: "x/y", size: 21 * 1024 * 1024 }]);
    const r = await run("attach_to_draft", { email_id: "m1" }, big.deps);
    expect(JSON.stringify(r)).toContain("20 MB");
    expect(big.edits).toEqual([]);
    const u = await run("attach_to_draft", { email_id: "zz" }, a.deps);
    expect(JSON.stringify(u)).toContain("unknown");
  });
  it("attaches nothing when another draft was opened during the download", async () => {
    const a = make(v(), atts);
    let session = 1;
    a.fake.session = () => session;
    a.fake.attachmentData = async (_e, id) => {
      session = 2;
      return `data-${id}`;
    };
    await run("attach_to_draft", { email_id: "m1" }, a.deps);
    await runConfirm(lastCard()!.id, a.deps);
    expect(lastCard()!.card.status).toBe("failed");
    expect(a.edits).toEqual([]);
  });
});

describe("store", () => {
  it("editCompose bumps seq and carries recipients and the target session", () => {
    useMail.setState({ composeEdit: null });
    useMail.getState().editCompose({ to: "a@x.com" });
    useMail.getState().editCompose({ cc: "b@x.com" });
    expect(useMail.getState().composeEdit).toEqual({ seq: 2, cc: "b@x.com", session: 0 });
    useMail.getState().editCompose({ to: "c@x.com" }, 7);
    expect(useMail.getState().composeEdit).toEqual({ seq: 3, to: "c@x.com", session: 7 });
  });
});
