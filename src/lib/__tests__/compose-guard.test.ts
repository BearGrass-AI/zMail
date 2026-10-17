// @vitest-environment jsdom
// Unsaved composer text is never dropped silently: switching views, opening another message (also from the
// assistant) and Redraft with AI all keep it, or ask first.
import { createElement, act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no execCommand state; the editor's toolbar asks for it.
document.queryCommandState = () => false;

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: (account: typeof gmail) => ({ account, batchSize: 50, listFolders: async () => [], listMessages: async () => [] }),
}));
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheGetMessage: async () => null,
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
const toasts: { text: string; opts?: { action?: { label: string; onClick: () => void } } }[] = [];
vi.mock("sonner", () => {
  const t = (text: string, opts?: never) => (toasts.push({ text, opts }), 1);
  t.error = t;
  t.success = t;
  t.dismiss = () => {};
  return { toast: t };
});
const ask = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/lib/ai/assistant/loop", () => ({ ask: (...args: unknown[]) => ask(...args) }));

const { useMail, composerActive } = await import("@/lib/store");
const { Composer } = await import("@/components/mail/composer");
const { executeTool } = await import("@/lib/ai/assistant/tools");
const { realDeps } = await import("@/lib/ai/assistant/deps");
const { useAssistant } = await import("@/lib/ai/assistant/state");

const email = {
  id: "e1",
  accountId: "g",
  folderId: "g:INBOX",
  threadId: "t1",
  from: { name: "Ravi Patel", address: "ravi@example.com" },
  to: [{ name: "Z", address: "z@gmail.com" }],
  subject: "Hello",
  snippet: "",
  date: "2026-10-14T15:00:00Z",
  unread: false,
  text: "Hi",
} as unknown as Email;

const buttonText = (t: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === t);
const subjectInput = (v: string) => [...document.querySelectorAll("input")].find((i) => i.value === v);
const editor = () => document.querySelector("[contenteditable]") as HTMLElement;

let root: Root;
async function mount() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(createElement(Composer)));
}
/** A message with unsaved text (an unsaved prefill counts), on screen. */
async function openDirty() {
  await act(async () => void useMail.getState().openCompose({ mode: "blank", prefill: { to: "ann@example.com", subject: "Mine", body: "My own words" } }));
  await mount();
  expect(useMail.getState().composeDirty).toBe(true);
}

beforeEach(() => {
  toasts.length = 0;
  ask.mockClear();
  useMail.setState({ accounts: [gmail], emails: [email], view: { kind: "inbox" }, compose: null, composeDirty: false, composeCloseAsk: null, composeEdit: null });
  useAssistant.setState({ busy: false });
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

describe("switching views with an unsaved message", () => {
  it("asks first, and Keep editing stays on the view with the message open", async () => {
    await openDirty();
    const compose = useMail.getState().compose;
    await act(async () => useMail.getState().setView({ kind: "triage" }));
    expect(useMail.getState().composeCloseAsk).not.toBeNull();
    expect(useMail.getState().view.kind).toBe("inbox");
    await act(async () => buttonText("Keep editing")!.click());
    expect(useMail.getState().view.kind).toBe("inbox");
    expect(useMail.getState().compose).toBe(compose);
    expect(subjectInput("Mine")).toBeDefined();
  });

  it("Discard goes on to the view", async () => {
    await openDirty();
    await act(async () => useMail.getState().setView({ kind: "triage" }));
    await act(async () => buttonText("Discard")!.click());
    expect(useMail.getState().view.kind).toBe("triage");
    expect(useMail.getState().compose).toBeNull();
  });
});

describe("opening a message over an unsaved one", () => {
  it("asks first; Keep editing keeps the one being typed", async () => {
    await openDirty();
    const mine = useMail.getState().compose;
    let opened!: Promise<string>;
    await act(async () => void (opened = useMail.getState().openCompose({ mode: "blank", replyTo: "e1" })));
    expect(useMail.getState().compose).toBe(mine);
    await act(async () => buttonText("Keep editing")!.click());
    expect(await opened).toBe("kept");
    expect(useMail.getState().compose).toBe(mine);
    expect(subjectInput("Mine")).toBeDefined();
  });

  it("the assistant's draft says it wasn't opened when the user keeps editing", async () => {
    await openDirty();
    const mine = useMail.getState().compose;
    useAssistant.getState().remember([{ id: "e1", accountId: "g" }]);
    const result = executeTool({ id: "c1", name: "draft", args: { kind: "reply", email_id: "e1", body: "Sounds good." } }, realDeps());
    for (let i = 0; i < 5 && !useMail.getState().composeCloseAsk; i++) await act(async () => {});
    expect(useMail.getState().composeCloseAsk).not.toBeNull();
    await act(async () => buttonText("Keep editing")!.click());
    const r = await result;
    expect(r.content).toMatchObject({ status: "not_opened" });
    expect(JSON.stringify(r.content)).toContain("unsaved message");
    expect(JSON.stringify(r.content)).not.toContain("opened_in_compose");
    expect(useMail.getState().compose).toBe(mine);
  });

  it("the assistant's draft opens after Discard", async () => {
    await openDirty();
    useAssistant.getState().remember([{ id: "e1", accountId: "g" }]);
    const result = executeTool({ id: "c1", name: "draft", args: { kind: "reply", email_id: "e1", body: "Sounds good." } }, realDeps());
    for (let i = 0; i < 5 && !useMail.getState().composeCloseAsk; i++) await act(async () => {});
    await act(async () => buttonText("Discard")!.click());
    const r = await result;
    expect(r.content).toMatchObject({ status: "opened_in_compose" });
    expect(useMail.getState().compose?.replyTo).toBe("e1");
  });
});

describe("Redraft with AI", () => {
  it("keeps the text, sends it to be reworked, and Undo brings it back", async () => {
    await openDirty();
    const mine = useMail.getState().compose;
    // The assistant's turn runs until the test ends it.
    let endTurn!: () => void;
    ask.mockImplementationOnce(() => new Promise<void>((r) => (endTurn = r)));
    await act(async () => buttonText("Redraft with AI")!.click());
    // Still unsaved while asking: closing would ask.
    expect(useMail.getState().composeDirty).toBe(true);
    await act(async () => (document.querySelector('[aria-label="Generate draft"]') as HTMLButtonElement).click());

    expect(ask).toHaveBeenCalledTimes(1);
    const text = String(ask.mock.calls[0][0]);
    expect(text).toMatch(/^Rewrite the draft open in compose/);
    expect(text).toContain("My own words");
    expect(text).toContain("edit_draft");
    // The message stays open, with its fields, and still unsaved.
    expect(useMail.getState().compose).toBe(mine);
    expect(subjectInput("Mine")).toBeDefined();
    expect(editor().innerHTML).toContain("My own words");
    expect(useMail.getState().composeDirty).toBe(true);

    // The assistant rewrites the body in place: the user asked for it, so there's no card.
    await act(() => new Promise((r) => setTimeout(r, 300)));
    const r = await executeTool({ id: "c1", name: "edit_draft", args: { body: "Brand new words" } }, realDeps());
    expect(r.content).toMatchObject({ status: "edited" });
    await act(async () => {});
    expect(editor().innerHTML).toContain("Brand new words");
    // Once the turn is over, the assistant's edits need a card again.
    await act(async () => endTurn());
    const again = await executeTool({ id: "c2", name: "edit_draft", args: { body: "Sneaky words" } }, realDeps());
    expect(again.content).toMatchObject({ status: "awaiting_confirmation" });
    await act(async () => {});
    expect(editor().innerHTML).not.toContain("Sneaky words");
    const undo = toasts.find((t) => t.text === "Redrafted with AI")?.opts?.action;
    expect(undo?.label).toBe("Undo");
    await act(async () => undo!.onClick());
    expect(editor().innerHTML).toContain("My own words");
    expect(editor().innerHTML).not.toContain("Brand new words");

    await act(async () => useMail.getState().closeCompose());
    expect(useMail.getState().composeCloseAsk).not.toBeNull();
  });
});

describe("opening a reply", () => {
  it("shows the editor on the very first frame", async () => {
    useMail.setState({ compose: { mode: "blank", replyTo: "e1" } });
    // What the first commit put on screen, before any effect ran.
    let first = "";
    function FirstFrame() {
      useLayoutEffect(() => void (first ||= document.body.innerHTML), []);
      return createElement(Composer);
    }
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(createElement(FirstFrame)));
    expect(first).toContain("Re: Hello");
    expect(first).not.toContain("What should we tell");
  });

  it("keeps the mail shortcuts off while the reply is still opening", async () => {
    let release!: () => void;
    const loading = new Promise<void>((r) => (release = r));
    useMail.setState({ emails: [{ ...email, bodyTrimmed: true }], ensureBody: () => loading.then(() => undefined) });
    expect(composerActive()).toBe(false);
    const opened = useMail.getState().openCompose({ mode: "blank", replyTo: "e1" });
    expect(useMail.getState().compose).toBeNull();
    expect(composerActive()).toBe(true);
    release();
    expect(await opened).toBe("opened");
    expect(composerActive()).toBe(true);
    await useMail.getState().openCompose(null);
    expect(composerActive()).toBe(false);
  });
});
