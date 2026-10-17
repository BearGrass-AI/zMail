// @vitest-environment jsdom
// "Ask Assistant about this…" from an email's menu: points the assistant at that email and opens the ask box.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

import { askAssistantAbout } from "@/components/email-actions";
import { useMail } from "@/lib/store";
import { useAssistant } from "@/lib/ai/assistant/state";

beforeEach(() => {
  useMail.setState({ checked: new Set(), checkAnchor: null, selectedId: null, emails: [], folders: [] });
  useAssistant.setState({ open: false, focusAsk: 0 });
});

describe("askAssistantAbout", () => {
  it("opens the email, opens the panel and asks for focus", () => {
    askAssistantAbout(["a"]);
    expect(useMail.getState().selectedId).toBe("a");
    expect(useAssistant.getState().open).toBe(true);
    expect(useAssistant.getState().focusAsk).toBe(1);
  });
  it("one right-clicked email clears other ticks so 'this' means that email", () => {
    useMail.setState({ checked: new Set(["x", "y"]) });
    askAssistantAbout(["a"]);
    expect(useMail.getState().checked.size).toBe(0);
  });
  it("several keep their ticks (\"these\") and nothing gets opened", () => {
    useMail.setState({ checked: new Set(["x", "y"]) });
    askAssistantAbout(["x", "y"]);
    expect([...useMail.getState().checked]).toEqual(["x", "y"]);
    expect(useMail.getState().selectedId).toBeNull();
    expect(useAssistant.getState().open).toBe(true);
  });
});
