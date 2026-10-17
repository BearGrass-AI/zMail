// @vitest-environment jsdom
// Settings › Sorting & Rules: Reset asks first, naming what it forgets, and Cancel changes nothing.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: () => ({}),
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

const { useMail } = await import("@/lib/store");
const { RulesPage } = await import("@/components/settings/rules-page");

const buttonText = (t: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === t);
let root: Root;

beforeEach(async () => {
  useMail.setState({
    overrides: { a: "need", b: "skim" } as never,
    categoryOverrides: { c: "receipts" } as never,
    sectionOverrides: {},
    laneRuled: {},
    lessons: [{ from: "x@y.com" }, { from: "z@y.com" }] as never,
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(createElement(RulesPage)));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Reset what zMail has learned", () => {
  it("asks first, naming the corrections and lessons", async () => {
    await act(async () => buttonText("Reset")!.click());
    expect(Object.keys(useMail.getState().overrides)).toHaveLength(2);
    expect(document.body.textContent).toContain("Forget 3 corrections and 2 lessons?");
  });

  it("Cancel changes nothing", async () => {
    await act(async () => buttonText("Reset")!.click());
    await act(async () => buttonText("Cancel")!.click());
    expect(Object.keys(useMail.getState().overrides)).toHaveLength(2);
    expect(useMail.getState().lessons).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Forget");
  });

  it("confirming forgets them", async () => {
    await act(async () => buttonText("Reset")!.click());
    await act(async () => buttonText("Reset")!.click());
    expect(useMail.getState().overrides).toEqual({});
    expect(useMail.getState().lessons).toEqual([]);
  });
});
