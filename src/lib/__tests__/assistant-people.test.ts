// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import { useAssistant } from "@/lib/ai/assistant/state";
import type { PeopleDeps } from "@/lib/ai/assistant/modules/people";
import { useMail } from "@/lib/store";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

type View = { to: string; cc: string; bcc: string; subject: string; body: string } | null;
function make(view: View, atts: { id: string; filename: string; mimeType: string; size: number; inline?: boolean }[] = []) {
  const edits: unknown[] = [];
  const fake: PeopleDeps = {
    search: async () => [{ name: "Ann Lee", address: "ann@x.com", title: "Dean" }, { name: "Bo", address: "bo@x.com" }],
    view: () => view,
    session: () => (view ? 1 : null),
    editCompose: (p) => void edits.push(p),
    ensureEmail: async (r) => ({ id: r.id, accountId: r.accountId, attachments: atts }) as never,
    attachmentData: async (_e, a) => `data-${a}`,
  };
  return { edits, deps: { ext: { people: fake } } as unknown as ToolDeps };
}
const run = (name: string, args: Record<string, unknown>, deps: ToolDeps) => executeTool({ id: "c1", name, args }, deps);
const v = (to = "", cc = "", bcc = ""): View => ({ to, cc, bcc, subject: "", body: "" });

beforeEach(() => {
  useAssistant.setState({ known: { m1: { id: "m1", accountId: "a" } } as never });
});

describe("find_people", () => {
  it("maps fields", async () => {
    const { deps } = make(null);
    const r = await run("find_people", { query: "ann" }, deps);
    expect(r.content).toEqual({ people: [{ name: "Ann Lee", address: "ann@x.com", title: "Dean" }, { name: "Bo", address: "bo@x.com" }] });
  });
});

describe("set_draft_recipients", () => {
  it("adds and dedupes case-insensitively", async () => {
    const { deps, edits } = make(v("Ann@x.com"));
    await run("set_draft_recipients", { to: ["ann@x.com", "bo@x.com"], cc: ["c@x.com"] }, deps);
    expect(edits).toEqual([{ to: "Ann@x.com, bo@x.com", cc: "c@x.com" }]);
  });
  it("replaces", async () => {
    const { deps, edits } = make(v("old@x.com"));
    await run("set_draft_recipients", { to: ["new@x.com"], mode: "replace" }, deps);
    expect(edits).toEqual([{ to: "new@x.com" }]);
  });
  it("errors with no draft", async () => {
    const { deps, edits } = make(null);
    const r = await run("set_draft_recipients", { to: ["a@x.com"] }, deps);
    expect(JSON.stringify(r)).toContain("No draft is open; use draft first.");
    expect(edits).toEqual([]);
  });
});

describe("attach_to_draft", () => {
  const atts = [
    { id: "1", filename: "a.pdf", mimeType: "application/pdf", size: 10 },
    { id: "2", filename: "b.png", mimeType: "image/png", size: 5, inline: true },
    { id: "3", filename: "c.txt", mimeType: "text/plain", size: 5 },
  ];
  it("fetches non-inline files and passes them", async () => {
    const { deps, edits } = make(v(), atts);
    await run("attach_to_draft", { email_id: "m1" }, deps);
    expect(edits).toEqual([{ addFiles: [
      { filename: "a.pdf", mimeType: "application/pdf", size: 10, base64: "data-1" },
      { filename: "c.txt", mimeType: "text/plain", size: 5, base64: "data-3" },
    ] }]);
  });
  it("filters by filename and rejects oversize and unknown ids", async () => {
    const a = make(v(), atts);
    await run("attach_to_draft", { email_id: "m1", filenames: ["C.TXT"] }, a.deps);
    expect(a.edits).toHaveLength(1);
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
    const people = a.deps.ext.people as PeopleDeps;
    people.session = () => session;
    people.attachmentData = async (_e, id) => {
      session = 2;
      return `data-${id}`;
    };
    const r = await run("attach_to_draft", { email_id: "m1" }, a.deps);
    expect(JSON.stringify(r)).toContain("changed");
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
