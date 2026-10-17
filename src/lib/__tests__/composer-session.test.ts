// @vitest-environment jsdom
// Async work started in one compose session (a send, an assistant attachment) never lands in the next one.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";
import type { Compose } from "@/lib/store";

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
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
  cachePutFolders: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));
// Exit animations never finish in jsdom, so AnimatePresence mode="wait" would hold the old view forever.
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));

const { useMail } = await import("@/lib/store");
const { Composer } = await import("@/components/mail/composer");
const { useAssistant } = await import("@/lib/ai/assistant/state");
const { executeTool } = await import("@/lib/ai/assistant/tools");
const { realDeps } = await import("@/lib/ai/assistant/deps");

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Sets an input's value the way typing does, so React's onChange fires. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const inputs = () => [...document.querySelectorAll("input")];
const subjectInput = (v: string) => inputs().find((i) => i.value === v);
const sendButton = () => [...document.querySelectorAll("button")].find((b) => !b.getAttribute("aria-label") && b.textContent?.trim().startsWith("Send"));

let root: Root;
async function mount() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(createElement(Composer)));
}

const buttonText = (t: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === t);
/** Open another message over the unsaved one, answering Discard when the composer asks. */
async function openOver(c: Compose) {
  let opened!: Promise<unknown>;
  await act(async () => void (opened = useMail.getState().openCompose(c)));
  if (useMail.getState().composeCloseAsk) await act(async () => buttonText("Discard")!.click());
  await act(async () => void (await opened));
}

beforeEach(() => {
  useMail.setState({ accounts: [gmail], emails: [], compose: null, composeDirty: false, composeCloseAsk: null, composeEdit: null, composeView: null });
  useMail.getState().openCompose({ mode: "blank", prefill: { to: "ann@example.com", subject: "Draft A" } });
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Composer session ownership", () => {
  it("a send that finishes after another message was opened leaves that message open with its text", async () => {
    const sent = deferred<void>();
    const send = vi.fn(() => sent.promise);
    useMail.setState({ send });
    await mount();

    await act(async () => sendButton()!.click());
    expect(send).toHaveBeenCalledTimes(1);

    // While A is sending, the user starts a new message (dropping A's unsaved copy when asked) and types into it.
    const b = { mode: "blank" as const, prefill: { subject: "Draft B" } };
    await openOver(b);
    await act(async () => type(subjectInput("Draft B")!, "B's own subject"));
    expect(useMail.getState().composeDirty).toBe(true);

    await act(async () => sent.resolve());
    expect(useMail.getState().compose).toBe(b);
    expect(useMail.getState().composeDirty).toBe(true);
    expect(subjectInput("B's own subject")).toBeDefined();
  });

  it("a send closes its own message", async () => {
    const sent = deferred<void>();
    useMail.setState({ send: vi.fn(() => sent.promise) });
    await mount();

    await act(async () => sendButton()!.click());
    await act(async () => sent.resolve());
    expect(useMail.getState().compose).toBeNull();
    expect(useMail.getState().composeDirty).toBe(false);
  });

  it("files the assistant was downloading for one draft don't land in the next", async () => {
    const download = deferred<string>();
    const email: Email = {
      id: "m1",
      accountId: "g",
      threadId: "t1",
      folderId: "g:INBOX",
      from: { name: "Ravi", address: "ravi@example.com" },
      to: [{ name: "Z", address: "z@gmail.com" }],
      attachments: [{ id: "a1", filename: "budget.pdf", mimeType: "application/pdf", size: 10 }],
      subject: "Budget",
      snippet: "",
      text: "",
      date: "2026-10-14T15:00:00Z",
      unread: false,
      starred: false,
      labels: [],
    };
    useMail.setState({ ensureEmail: async () => email, attachmentData: () => download.promise });
    useAssistant.setState({ known: { m1: { id: "m1", accountId: "g" } } });
    await mount();
    // The composer publishes what it shows for the assistant after a short pause.
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(useMail.getState().composeView?.subject).toBe("Draft A");
    const sessionA = useMail.getState().composeSession;

    const result = executeTool({ id: "c1", name: "attach_to_draft", args: { email_id: "m1" } }, realDeps());
    await act(async () => {});
    await openOver({ mode: "blank", prefill: { subject: "Draft B" } });
    await act(async () => download.resolve("ZGF0YQ=="));
    const r = await result;
    await act(async () => {});

    expect(JSON.stringify(r.content)).toContain("changed");
    expect(document.body.textContent).not.toContain("budget.pdf");
    expect(subjectInput("Draft B")).toBeDefined();

    // And an edit addressed to the old session is ignored by the composer itself.
    await act(async () => useMail.getState().editCompose({ subject: "Stale" }, sessionA));
    expect(subjectInput("Draft B")).toBeDefined();
  });
});
