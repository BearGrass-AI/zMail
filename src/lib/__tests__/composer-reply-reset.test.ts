// @vitest-environment jsdom
// A reply in progress survives a sync that refreshes the email being answered.
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
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

const email = {
  id: "e1",
  accountId: "g",
  folderId: "g:INBOX",
  threadId: "t1",
  from: { name: "Ravi", address: "ravi@example.com" },
  to: [{ name: "Z", address: "z@gmail.com" }],
  subject: "Hello",
  date: "2026-10-14T15:00:00Z",
  unread: true,
  text: "Hi",
} as unknown as Email;

/** Sets an input's value the way typing does, so React's onChange fires. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const subjectInput = () =>
  [...document.querySelectorAll("input")].find((i) => i.value.startsWith("Re:") || i.value.startsWith("My")) as HTMLInputElement;

beforeEach(() => {
  useMail.setState({ accounts: [gmail], emails: [email], compose: { replyTo: "e1", mode: "blank" } as never });
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("Composer reply", () => {
  it("keeps what you typed when the answered email is refreshed by a sync", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(createElement(Composer)));
    expect(subjectInput().value).toBe("Re: Hello");

    await act(async () => type(subjectInput(), "My own subject"));
    expect(subjectInput().value).toBe("My own subject");

    // A sync hands back a new object for the same email (here: marked read elsewhere).
    await act(async () => useMail.setState({ emails: [{ ...email, unread: false }] }));
    expect(subjectInput().value).toBe("My own subject");
    act(() => root.unmount());
  });
});
