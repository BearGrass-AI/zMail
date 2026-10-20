// @vitest-environment jsdom
// The screening panel shows the finding and records a check without moving the message.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
  cacheGetMessage: async () => null,
  cacheDeleteAccount: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, calendarProviderFor: () => null, mailProviderFor: () => ({}) }));

const { useMail } = await import("@/lib/store");
const { RopeLineScreen } = await import("@/components/mail/ropeline-screen");
const { validRopeLineFlags } = await import("@/lib/ropeline");

const email = {
  id: "e1",
  accountId: "g",
  threadId: "e1",
  folderId: "g:INBOX",
  from: { name: "Accounts", address: "a@example.com" },
  to: [],
  subject: "Invoice due",
  snippet: "",
  text: "Please wire the invoice today.",
  date: "2026-10-01T00:00:00Z",
  unread: true,
  starred: false,
  labels: [],
  security: { replyTo: "pay@other.example" },
} as Email;

let root: Root;
let el: HTMLDivElement;

beforeEach(() => {
  useMail.setState({ emails: [email], ropelineFlags: {}, folders: [{ id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" }] });
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

describe("RopeLine panel", () => {
  it("shows the hold and a question, and checking it leaves the message in place", () => {
    act(() => {
      root.render(createElement(RopeLineScreen, { email }));
    });
    expect(el.textContent).toContain("RopeLine · Hold");
    expect(el.textContent).toContain("Were you expecting this invoice?");
    expect(el.textContent).toContain("Nothing was deleted");
    const box = el.querySelector("input[type=checkbox]") as HTMLInputElement;
    act(() => {
      box.click();
    });
    expect(useMail.getState().ropelineFlags.e1?.checks?.["expect-invoice"]).toBe(true);
    expect(useMail.getState().emails[0].folderId).toBe("g:INBOX");
    expect(validRopeLineFlags(useMail.getState().ropelineFlags).e1.checks).toEqual({ "expect-invoice": true });
  });
});
