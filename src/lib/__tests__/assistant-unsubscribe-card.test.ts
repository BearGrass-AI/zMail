// @vitest-environment jsdom
// The unsubscribe card is the confirm step for an email zMail sends as the user, so before the click it
// shows every part the sender's header chose: the recipient and the exact subject, not just the address.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const { UnsubscribeCard } = await import("@/components/assistant/unsubscribe-card");
type Props = Parameters<typeof UnsubscribeCard>[0];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
const text = () => document.body.textContent ?? "";
const show = (mailto: string) => {
  const card = { type: "unsubscribe", from: "news.example.com", accountId: "g", accountAddress: "jane@example.org", method: "email", mailto, status: "pending" } as Props["card"];
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(createElement(UnsubscribeCard, { id: "c1", card })));
};
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("unsubscribe card", () => {
  it("shows the exact subject the email will carry, with its recipient", () => {
    show("mailto:hr@example.com?subject=Please%20process%20my%20resignation%20effective%20today");
    expect(text()).toContain("hr@example.com");
    expect(text()).toContain("“Please process my resignation effective today”");
  });

  it("shows the subject that's actually sent when the header has none", () => {
    show("mailto:stop@example.com");
    expect(text()).toContain("“unsubscribe”");
  });
});
