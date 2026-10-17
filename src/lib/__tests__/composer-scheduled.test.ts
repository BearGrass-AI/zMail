// @vitest-environment jsdom
// A scheduled email reopened in the composer: saved with changes (by hand, or an assistant change the user
// approved), it leaves the schedule and waits in Drafts; saved or closed as it was, it still goes out at its time.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendRequest } from "@/lib/mail/provider";
import type { ScheduledSend } from "@/lib/mail/scheduled";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no execCommand state; the editor's toolbar asks for it.
document.queryCommandState = () => false;

const h = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  /** Saves to the scheduled list and to the provider's drafts, in order. */
  log: [] as string[],
  toasts: [] as { text: string; opts?: { description?: string } }[],
  failSave: false,
}));
const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const provider = vi.hoisted(() => ({
  saveDraft: vi.fn(async (_m: SendRequest, id?: string) => {
    if (h.failSave) throw new Error("offline");
    h.log.push(`saveDraft:${id}`);
    return { draftId: id ?? "GD2", messageId: "GM1" };
  }),
  sendSavedDraft: vi.fn<(id: string) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: (account: typeof gmail) => ({ account, batchSize: 50, listFolders: async () => [], listMessages: async () => [], ...provider }),
}));
vi.mock("@/lib/db", () => ({
  kvGet: async (k: string) => structuredClone(h.kv.get(k) ?? null),
  kvSet: async (k: string, v: unknown) => {
    if (k === "scheduled.v1") h.log.push(`scheduled:${(v as ScheduledSend[]).map((r) => r.id).join(",")}`);
    h.kv.set(k, structuredClone(v));
  },
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
  cachePutFolders: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("sonner", () => {
  const t = (text: string, opts?: { description?: string }) => (h.toasts.push({ text, opts }), 1);
  t.error = t;
  t.success = t;
  t.dismiss = () => {};
  return { toast: t };
});

const { useMail } = await import("@/lib/store");
const { Composer } = await import("@/components/mail/composer");
const { executeTool } = await import("@/lib/ai/assistant/tools");
const { realDeps } = await import("@/lib/ai/assistant/deps");
const { runConfirm } = await import("@/lib/ai/assistant/modules/confirm");
const { useAssistant } = await import("@/lib/ai/assistant/state");

/** Already due: only the open composer holds it back. */
const SEND_AT = Date.now() - 60_000;
const row: ScheduledSend = { id: "GD1", accountId: "g", draftId: "GD1", messageId: "GM1", sendAt: SEND_AT, subject: "Plans", to: ["ann@example.com"], snippet: "", server: false, createdAt: 0, editing: true };

const buttons = () => [...document.querySelectorAll("button")];
const barSave = () => buttons().find((b) => b.textContent?.trim() === "Save draft");
const toolbarSave = () => buttons().find((b) => b.textContent?.includes("⌘S"));
const subjectInput = (v: string) => [...document.querySelectorAll("input")].find((i) => i.value === v);
const editor = () => document.querySelector("[contenteditable]") as HTMLElement;
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const scheduled = () => useMail.getState().scheduled;
const savedList = () => (h.kv.get("scheduled.v1") as ScheduledSend[] | undefined) ?? [];

let root: Root;
beforeAll(async () => {
  // Sets up the account's provider (nothing is scheduled yet, so the launch run sends nothing).
  await useMail.getState().load();
});
beforeEach(async () => {
  h.log.length = 0;
  h.toasts.length = 0;
  h.failSave = false;
  provider.saveDraft.mockClear();
  provider.sendSavedDraft.mockClear();
  h.kv.set("scheduled.v1", [row]);
  useMail.setState({ accounts: [gmail], emails: [], scheduled: [row], compose: null, composeDirty: false, composeCloseAsk: null, composeEdit: null, composeView: null });
  useAssistant.getState().newChat();
  // As Scheduled → Edit opens it.
  await useMail.getState().openCompose({
    mode: "blank",
    fromAccountId: "g",
    draft: { id: "GD1", emailId: "GM1" },
    prefill: { to: "ann@example.com", cc: "", bcc: "", subject: "Plans", body: "<p>See you at eight.</p>", bodyIsHtml: true },
    scheduledAt: SEND_AT,
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(createElement(Composer)));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

/** Close the composer, then let the scheduler run. */
async function closeAndRun() {
  await act(async () => useMail.getState().closeCompose());
  if (useMail.getState().composeCloseAsk) throw new Error("the composer asked to save");
  await act(async () => void (await useMail.getState().runDueScheduled()));
}

describe("a reopened scheduled email", () => {
  it("changed by hand and saved, it leaves the schedule (on disk first) and isn't sent at its time", async () => {
    await act(async () => type(subjectInput("Plans")!, "Plans (new account details)"));
    await act(async () => toolbarSave()!.click());

    expect(provider.saveDraft).toHaveBeenCalledTimes(1);
    expect(scheduled()).toEqual([]);
    expect(savedList()).toEqual([]);
    // Off the saved schedule before the changed draft reached the server: a restart in between can't send it.
    expect(h.log).toEqual(["scheduled:", "saveDraft:GD1"]);
    expect(h.toasts.map((t) => t.text)).toContain("Saved, and no longer scheduled");

    await closeAndRun();
    expect(provider.sendSavedDraft).not.toHaveBeenCalled();
    expect(h.toasts.map((t) => t.text).some((t) => t.startsWith("Still scheduled"))).toBe(false);
  });

  it("an assistant change only lands when approved, and saving it from the close prompt unschedules it", async () => {
    // The composer publishes what it shows for the assistant after a short pause.
    await act(() => new Promise((r) => setTimeout(r, 300)));
    const r = await executeTool({ id: "c1", name: "edit_draft", args: { body: "Pay to the new account instead." } }, realDeps());
    expect(r.content).toMatchObject({ status: "awaiting_confirmation" });
    const item = useAssistant.getState().items.at(-1)!;
    expect(item).toMatchObject({ card: { type: "confirm", title: "Change the scheduled email" } });
    await act(async () => {});
    expect(editor().innerHTML).not.toContain("new account");

    await act(async () => runConfirm(item.id));
    expect(editor().innerHTML).toContain("new account");

    await act(async () => useMail.getState().closeCompose());
    expect(document.body.textContent).toContain("Saving takes it off the schedule.");
    await act(async () => barSave()!.click());
    expect(useMail.getState().compose).toBeNull();
    expect(scheduled()).toEqual([]);
    await act(async () => void (await useMail.getState().runDueScheduled()));
    expect(provider.sendSavedDraft).not.toHaveBeenCalled();
  });

  it("Bcc added by the assistant waits for the card too", async () => {
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await executeTool({ id: "c1", name: "set_draft_recipients", args: { bcc: ["eve@example.org"] } }, realDeps());
    const item = useAssistant.getState().items.at(-1)!;
    expect(item).toMatchObject({ card: { preview: { fields: [{ label: "Add Bcc", value: "eve@example.org" }] } } });
    await act(async () => {});
    expect(document.body.innerHTML).not.toContain("eve@example.org");
    await act(async () => runConfirm(item.id));
    expect(document.body.innerHTML).toContain("eve@example.org");
  });

  it("saved or closed unchanged, it still goes out at its time", async () => {
    await act(async () => toolbarSave()!.click());
    expect(provider.saveDraft).toHaveBeenCalledTimes(1);
    expect(scheduled()).toHaveLength(1);
    await closeAndRun();
    expect(h.toasts.map((t) => t.text).some((t) => t.startsWith("Still scheduled"))).toBe(true);
    expect(provider.sendSavedDraft).toHaveBeenCalledWith("GD1");
  });

  it("a save that fails leaves it scheduled with what the server still holds", async () => {
    h.failSave = true;
    await act(async () => type(subjectInput("Plans")!, "Plans v2"));
    await act(async () => toolbarSave()!.click());
    expect(h.toasts.map((t) => t.text)).toContain("Couldn't save the draft");
    expect(scheduled()).toMatchObject([{ id: "GD1", editing: true }]);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(savedList()).toHaveLength(1);
  });
});
