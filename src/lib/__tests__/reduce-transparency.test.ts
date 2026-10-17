// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ on: true, invoke: vi.fn(), media: new Set<string>() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => h.on, invoke: h.invoke }));

import { installReduceTransparency, syncReduceTransparency } from "@/lib/reduce-transparency";

const listeners: Record<string, (() => void)[]> = {};

beforeEach(() => {
  h.on = true;
  h.invoke.mockReset();
  h.invoke.mockResolvedValue(false);
  h.media.clear();
  for (const k of Object.keys(listeners)) delete listeners[k];
  document.documentElement.className = "";
  window.matchMedia = ((q: string) => ({
    matches: h.media.has(q),
    addEventListener: (_: string, fn: () => void) => (listeners[q] ??= []).push(fn),
    removeEventListener: (_: string, fn: () => void) => (listeners[q] = (listeners[q] ?? []).filter((f) => f !== fn)),
  })) as unknown as typeof window.matchMedia;
});

const solid = () => document.documentElement.classList.contains("reduce-transparency");

describe("reduce transparency", () => {
  it("follows the macOS setting, which WebKit doesn't expose", async () => {
    h.invoke.mockResolvedValue(true);
    expect(await syncReduceTransparency()).toBe(true);
    expect(h.invoke).toHaveBeenCalledWith("reduce_transparency");
    expect(solid()).toBe(true);
    h.invoke.mockResolvedValue(false);
    await syncReduceTransparency();
    expect(solid()).toBe(false);
  });

  it("goes solid for the media query or Increase contrast too", async () => {
    h.media.add("(prefers-reduced-transparency: reduce)");
    await syncReduceTransparency();
    expect(solid()).toBe(true);
    h.media.clear();
    h.media.add("(prefers-contrast: more)");
    await syncReduceTransparency();
    expect(solid()).toBe(true);
  });

  it("stays translucent when Rust can't answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.invoke.mockRejectedValue(new Error("no"));
    expect(await syncReduceTransparency()).toBe(false);
    expect(solid()).toBe(false);
    warn.mockRestore();
  });

  it("only asks Rust inside the app", async () => {
    h.on = false;
    await syncReduceTransparency();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("applies only the newest of overlapping checks", async () => {
    let first!: (v: boolean) => void;
    h.invoke.mockImplementationOnce(() => new Promise<boolean>((r) => (first = r))).mockResolvedValueOnce(true);
    const a = syncReduceTransparency();
    await syncReduceTransparency();
    first(false);
    await a;
    expect(solid()).toBe(true);
  });

  it("checks again when zMail comes back to the front, and stops after cleanup", async () => {
    const stop = installReduceTransparency();
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    expect(solid()).toBe(false);
    h.invoke.mockResolvedValue(true);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(solid()).toBe(true));
    stop();
    h.invoke.mockResolvedValue(false);
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(solid()).toBe(true);
  });
});
