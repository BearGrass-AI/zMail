// @vitest-environment jsdom
// Dragging Triage cards: a drop back on the lane the card came from changes nothing and says
// nothing; a drop on another lane moves it, pins it there and says so.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Triage } from "@/lib/types";

const h = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: h.toast, Toaster: () => null }));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
vi.mock("@/lib/ai/generative", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/generative")>()), oneLiner: async () => "" }));

import { TriageView } from "@/components/triage/triage-view";
import { useMail } from "@/lib/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mail = (id: string, subject: string) =>
  ({ id, accountId: "a", threadId: id, folderId: "a:inbox", from: { name: "Dana Morrow", address: "dana@x.edu" }, to: [], subject, snippet: subject, text: subject, date: "2026-10-01T10:00:00Z", unread: false, starred: false, labels: [] }) as unknown as Email;
const sorted = (id: string, bucket: Triage["bucket"]) =>
  ({ emailId: id, bucket, bucketProbs: { needs_you: 0, worth_skim: 0, ready_archive: 0, [bucket]: 1 }, category: "updates", urgency: 0, needsReply: 0, model: "fake" }) as Triage;

let root: Root;
const lane = (label: string) => {
  const head = [...document.querySelectorAll("span")].find((s) => s.textContent === label)!;
  return head.parentElement!.parentElement!;
};
const dropOn = (label: string, id: string) =>
  act(() => {
    const ev = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    Object.defineProperty(ev, "dataTransfer", { value: { getData: () => id } });
    lane(label).dispatchEvent(ev);
  });

beforeEach(() => {
  h.toast.mockClear();
  useMail.setState({
    folders: [{ id: "a:inbox", accountId: "a", name: "Inbox", system: "inbox" }],
    emails: [mail("1", "Weekly digest"), mail("2", "Your receipt")],
    triage: { "1": sorted("1", "worth_skim"), "2": sorted("2", "ready_archive") },
    overrides: {},
    sectionOverrides: {},
  } as never);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(createElement(TriageView)));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("dropping a Triage card", () => {
  it("does nothing when it lands back on its own lane", () => {
    expect(lane("Worth a skim").textContent).toContain("Weekly digest");
    dropOn("Worth a skim", "1");
    expect(h.toast).not.toHaveBeenCalled();
    expect(useMail.getState().overrides).toEqual({});
    expect(lane("Worth a skim").textContent).toContain("Weekly digest");
  });

  it("moves, pins and confirms when it lands on another lane", () => {
    dropOn("Can go", "1");
    expect(h.toast).toHaveBeenCalledWith("Got it: Can go", expect.anything());
    expect(useMail.getState().overrides).toEqual({ "1": "ready_archive" });
    expect(lane("Can go").textContent).toContain("Weekly digest");
  });
});
