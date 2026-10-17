// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ on: true, setZoom: vi.fn<(v: number) => Promise<void>>() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => h.on }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: h.setZoom }) }));

type Zoom = typeof import("@/lib/page-zoom");
let z: Zoom;

beforeEach(async () => {
  h.on = true;
  h.setZoom.mockReset();
  h.setZoom.mockResolvedValue(undefined);
  localStorage.clear();
  // The module remembers the applied level, so each test starts from a fresh copy.
  vi.resetModules();
  z = await import("@/lib/page-zoom");
});

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

describe("clampZoom", () => {
  it("keeps levels in range on 0.1 steps", () => {
    expect(z.clampZoom(1.2)).toBe(1.2);
    expect(z.clampZoom("1.3")).toBe(1.3);
    expect(z.clampZoom(1.04)).toBe(1);
  });
  it("clamps to 0.8–1.6", () => {
    expect(z.clampZoom(0.2)).toBe(0.8);
    expect(z.clampZoom(9)).toBe(1.6);
    expect(z.clampZoom("-3")).toBe(0.8);
  });
  it("falls back to 1 for anything that isn't a finite number", () => {
    for (const v of [null, undefined, "", "abc", "NaN", NaN, Infinity, -Infinity, {}, [], true]) expect(z.clampZoom(v)).toBe(1);
  });
});

describe("zoomShortcut", () => {
  it("maps ⌘+, ⌘=, ⌘− and ⌘0", () => {
    expect(z.zoomShortcut(key("="))).toBe(1);
    expect(z.zoomShortcut(key("+", { shiftKey: true }))).toBe(1);
    expect(z.zoomShortcut(key("-"))).toBe(-1);
    expect(z.zoomShortcut(key("0"))).toBe(0);
  });
  it("leaves ⌘⇧0 (all accounts), plain keys, ⌥ combos and other shortcuts alone", () => {
    expect(z.zoomShortcut(key("0", { shiftKey: true }))).toBeNull();
    expect(z.zoomShortcut(key(")", { shiftKey: true }))).toBeNull();
    expect(z.zoomShortcut(key("=", { metaKey: false }))).toBeNull();
    expect(z.zoomShortcut(key("-", { metaKey: false }))).toBeNull();
    expect(z.zoomShortcut(key("=", { altKey: true }))).toBeNull();
    for (const k of ["1", "2", "3", "k", "j", ",", "a"]) expect(z.zoomShortcut(key(k))).toBeNull();
  });
});

describe("stepZoom", () => {
  it("steps the web view and saves the level once it applied", async () => {
    expect(await z.stepZoom(1)).toBe(true);
    expect(h.setZoom).toHaveBeenLastCalledWith(1.1);
    expect(localStorage.getItem("zmail.zoom")).toBe("1.1");
    expect(await z.stepZoom(-1)).toBe(true);
    expect(await z.stepZoom(-1)).toBe(true);
    expect(h.setZoom).toHaveBeenLastCalledWith(0.9);
    expect(z.currentZoom()).toBe(0.9);
    expect(await z.stepZoom(0)).toBe(true);
    expect(h.setZoom).toHaveBeenLastCalledWith(1);
    expect(localStorage.getItem("zmail.zoom")).toBeNull();
  });

  it("stops at the ends of the range", async () => {
    for (let i = 0; i < 12; i++) await z.stepZoom(1);
    expect(z.currentZoom()).toBe(1.6);
    for (let i = 0; i < 12; i++) await z.stepZoom(-1);
    expect(z.currentZoom()).toBe(0.8);
  });

  it("takes one step per press even when presses overlap", async () => {
    await Promise.all([z.stepZoom(1), z.stepZoom(1), z.stepZoom(1)]);
    expect(h.setZoom.mock.calls.map((c) => c[0])).toEqual([1.1, 1.2, 1.3]);
    expect(localStorage.getItem("zmail.zoom")).toBe("1.3");
  });

  it("doesn't save or move on when the web view refuses", async () => {
    h.setZoom.mockRejectedValueOnce(new Error("not allowed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await z.stepZoom(1)).toBe(false);
    expect(z.currentZoom()).toBe(1);
    expect(localStorage.getItem("zmail.zoom")).toBeNull();
    warn.mockRestore();
  });

  it("does nothing outside the app", async () => {
    h.on = false;
    expect(await z.stepZoom(1)).toBe(false);
    expect(h.setZoom).not.toHaveBeenCalled();
  });
});

describe("restoreZoom", () => {
  it("applies the saved level at launch", async () => {
    localStorage.setItem("zmail.zoom", "1.4");
    expect(await z.restoreZoom()).toBe(true);
    expect(h.setZoom).toHaveBeenCalledWith(1.4);
    expect(z.currentZoom()).toBe(1.4);
  });

  it("clamps an out-of-range saved level", async () => {
    localStorage.setItem("zmail.zoom", "40");
    await z.restoreZoom();
    expect(h.setZoom).toHaveBeenCalledWith(1.6);
    expect(localStorage.getItem("zmail.zoom")).toBe("1.6");
  });

  it("drops a garbled saved level without zooming", async () => {
    localStorage.setItem("zmail.zoom", "huge");
    expect(await z.restoreZoom()).toBe(true);
    expect(h.setZoom).not.toHaveBeenCalled();
    expect(localStorage.getItem("zmail.zoom")).toBeNull();
  });

  it("leaves actual size alone", async () => {
    await z.restoreZoom();
    expect(h.setZoom).not.toHaveBeenCalled();
  });
});

describe("handleZoomKey", () => {
  it("handles zoom keys and blocks their default", async () => {
    const e = new KeyboardEvent("keydown", { key: "=", metaKey: true, cancelable: true });
    expect(z.handleZoomKey(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(h.setZoom).toHaveBeenCalledWith(1.1));
  });

  it("lets other keys through", () => {
    const e = new KeyboardEvent("keydown", { key: "0", code: "Digit0", metaKey: true, shiftKey: true, cancelable: true });
    expect(z.handleZoomKey(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("leaves the browser's own zoom alone outside the app", () => {
    h.on = false;
    const e = new KeyboardEvent("keydown", { key: "=", metaKey: true, cancelable: true });
    expect(z.handleZoomKey(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});
