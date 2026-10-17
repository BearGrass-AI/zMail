// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clampWidth } from "@/lib/ai/assistant/panel-width";

describe("clampWidth", () => {
  it("clamps to a 320 minimum", () => expect(clampWidth(100, 1600)).toBe(320));
  it("clamps to 900 on wide windows", () => expect(clampWidth(2000, 2000)).toBe(900));
  it("clamps to 60% of a narrower window", () => expect(clampWidth(900, 1000)).toBe(600));
  it("never goes below the minimum even in tiny windows", () => expect(clampWidth(500, 400)).toBe(320));
  it("rounds to an integer", () => expect(clampWidth(400.6, 1600)).toBe(401));
  it("passes through in-range values", () => expect(clampWidth(340, 1600)).toBe(340));
});

import { vi } from "vitest";
import { copyText, MESSAGE_SELECTABLE } from "@/components/assistant/message-item";

describe("message copy", () => {
  it("marks messages selectable so the native menu is allowed", () => expect(MESSAGE_SELECTABLE).toBe("selectable"));
  it("writes the Markdown to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(await copyText("| a |\n|---|")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("| a |\n|---|");
  });
  it("reports failure when the clipboard rejects", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("no")) }, configurable: true });
    expect(await copyText("x")).toBe(false);
  });
});
