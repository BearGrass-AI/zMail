// @vitest-environment jsdom
// The reader doesn't move under you: a folder suggestion on the next email is there on the first
// paint instead of growing in and pushing the body down, and a summary you've already seen shows
// at once instead of typing itself out again.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }), Toaster: () => null }));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

import { SuggestionBanner, TypeIn } from "@/components/mail/reader";
import { useMail } from "@/lib/store";
import { typeInWord } from "@/lib/motion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mail = (id: string) =>
  ({ id, accountId: "a", threadId: id, folderId: "a:inbox", from: { name: "Dana Morrow", address: "dana@x.edu" }, to: [], subject: "Invoice", snippet: "", text: "", date: "2026-10-01T10:00:00Z", unread: false, starred: false, labels: [] }) as unknown as Email;

let root: Root;
beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("folder suggestion banner", () => {
  beforeEach(() => {
    useMail.setState({
      folders: [
        { id: "a:inbox", accountId: "a", name: "Inbox", system: "inbox" },
        { id: "a:bills", accountId: "a", name: "Bills" },
      ],
      emails: [mail("plain"), mail("filed")],
      triage: { filed: { emailId: "filed", bucket: "worth_skim", folder: { folderId: "a:bills", probability: 0.97 } } },
      dismissed: new Set(),
      rules: [],
    } as never);
  });

  it("is already in place when you move onto an email that has one", () => {
    act(() => root.render(createElement(SuggestionBanner, { email: mail("plain") })));
    expect(document.body.textContent).not.toContain("Bills");
    act(() => root.render(createElement(SuggestionBanner, { email: mail("filed") })));
    const banner = [...document.querySelectorAll<HTMLElement>(".overflow-hidden")].find((d) => d.textContent?.includes("Bills"))!;
    expect(banner).toBeTruthy();
    // Not starting collapsed and see-through, which is what pushed the body down as it grew.
    expect(banner.style.opacity).not.toBe("0");
    expect(banner.style.height).not.toBe("0px");
  });
});

describe("summary type-in", () => {
  const spans = () => [...document.querySelectorAll<HTMLElement>("span span")];

  it("reveals a new summary word by word", () => {
    act(() => root.render(createElement(TypeIn, { text: "Pay the invoice by Friday." })));
    expect(spans().length).toBeGreaterThan(1);
    expect(spans()[0].style.opacity).toBe("0");
  });

  it("shows a summary it has already revealed at once when reopened", () => {
    const text = "The board meets Tuesday; bring the budget.";
    act(() => root.render(createElement(TypeIn, { text })));
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root.render(createElement(TypeIn, { text })));
    expect(document.body.textContent).toContain(text);
    expect(spans()).toHaveLength(0);
  });

  it("finishes within 0.2s however long the summary is", () => {
    for (const n of [1, 10, 200]) {
      const last = typeInWord(n - 1, n);
      expect(last.delay + last.duration).toBeLessThanOrEqual(0.2);
    }
  });
});
