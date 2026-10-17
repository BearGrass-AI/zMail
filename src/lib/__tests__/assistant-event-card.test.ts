// @vitest-environment jsdom
// The assistant's event card shows everything Add writes to the calendar: end time, location and notes.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }), Toaster: () => null }));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const { MessageItem } = await import("@/components/assistant/message-item");
const { useAssistant } = await import("@/lib/ai/assistant/state");
const { executeTool } = await import("@/lib/ai/assistant/tools");
const { addEvent } = await import("@/lib/ai/assistant/cards");
import type { ToolDeps } from "@/lib/ai/assistant/tools";
import type { NewEvent } from "@/lib/calendar/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  useAssistant.getState().newChat();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const propose = (args: Record<string, unknown>, deps: Partial<ToolDeps> = {}) => executeTool({ id: "c1", name: "create_event", args }, { folders: () => [], ...deps } as ToolDeps);
const renderLast = () => {
  const item = useAssistant.getState().items.at(-1)!;
  act(() => root.render(createElement(MessageItem, { item, last: true })));
  return host.textContent ?? "";
};

describe("assistant event card", () => {
  it("shows the end time, the location and the notes, and Add writes nothing else", async () => {
    await propose({ title: "Budget review", start: "2026-11-02T08:15:00", end: "2026-11-02T10:40:00", location: "Room 4", notes: "Bring the sheet: https://example.com/sheet" });
    const text = renderLast();
    expect(text).toContain("Budget review");
    expect(text).toContain("Room 4");
    expect(text).toContain("Bring the sheet: https://example.com/sheet");
    expect(text).toMatch(/10:40/);

    const written: NewEvent[] = [];
    const item = useAssistant.getState().items.at(-1)!;
    await addEvent(item.id, "g:primary", { createEvent: async (e: NewEvent) => void written.push(e) } as unknown as ToolDeps);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ title: "Budget review", location: "Room 4", description: "Bring the sheet: https://example.com/sheet" });
  });

  it("shows the last day of a multi-day all-day event", async () => {
    await propose({ title: "Conference", start: "2026-11-05", end: "2026-11-07", all_day: true });
    // An all-day end is exclusive: this one is written as Nov 5 and 6, and the card says so.
    expect(renderLast()).toMatch(/Through .*Nov 6/);
  });

  it("caps notes and location", async () => {
    const long = await propose({ title: "T", start: "2026-11-02T08:15:00", notes: "x".repeat(2001) });
    expect(JSON.stringify(long)).toContain("2,000 characters or fewer");
    const where = await propose({ title: "T", start: "2026-11-02T08:15:00", location: "y".repeat(301) });
    expect(JSON.stringify(where)).toContain("300 characters or fewer");
    expect(useAssistant.getState().items).toHaveLength(0);
  });
});
