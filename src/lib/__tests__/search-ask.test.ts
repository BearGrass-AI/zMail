import { describe, expect, it } from "vitest";
import { searchAskAction } from "@/lib/ai/assistant/search-ask";

describe("searchAskAction", () => {
  it("toggles the panel when the box is empty or blank", () => {
    expect(searchAskAction({ text: "", busy: false })).toBe("toggle");
    expect(searchAskAction({ text: "   ", busy: false })).toBe("toggle");
    expect(searchAskAction({ text: "", busy: true })).toBe("toggle");
  });
  it("asks when there is text and the assistant is idle", () => {
    expect(searchAskAction({ text: "unread from Sam", busy: false })).toBe("ask");
  });
  it("only opens the panel when busy with text", () => {
    expect(searchAskAction({ text: "unread from Sam", busy: true })).toBe("open");
  });
});
