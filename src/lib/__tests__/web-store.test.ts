// @vitest-environment jsdom
// Settings kept in localStorage are mirrored into zMail's database, which wins at launch, so the dev
// build and the installed app (different origins, different localStorage) see the same settings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ tauri: true, kv: new Map<string, unknown>(), sets: [] as [string, unknown][], hang: false }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => h.tauri }));
vi.mock("@/lib/db", () => ({
  kvGet: async (key: string) => (h.hang ? new Promise(() => {}) : h.kv.has(key) ? h.kv.get(key) : null),
  kvSet: async (key: string, value: unknown) => {
    h.sets.push([key, value]);
    h.kv.set(key, value);
  },
}));

import { loadMirrored, mirroredStorage, resetForTests, settled } from "@/lib/web-store";

beforeEach(() => {
  h.tauri = true;
  h.hang = false;
  h.kv.clear();
  h.sets.length = 0;
  localStorage.clear();
  resetForTests();
});
afterEach(() => vi.useRealTimers());

describe("settings mirrored into the database", () => {
  it("uses the database's settings over this window's localStorage at launch", async () => {
    h.kv.set("webstore:zmail.settings", '{"state":{"theme":"dark"},"version":2}');
    localStorage.setItem("zmail.settings", '{"state":{"theme":"light"},"version":2}');
    await loadMirrored();
    expect(localStorage.getItem("zmail.settings")).toBe('{"state":{"theme":"dark"},"version":2}');
    expect(h.sets).toEqual([]);
  });

  it("copies localStorage into the database the first time, when the database has none", async () => {
    localStorage.setItem("zmail.settings", '{"state":{"aiProviders":[{"id":"p1"}]},"version":2}');
    await loadMirrored();
    expect(h.kv.get("webstore:zmail.settings")).toBe('{"state":{"aiProviders":[{"id":"p1"}]},"version":2}');
    expect(h.kv.has("webstore:zmail.zoom")).toBe(false);
  });

  it("doesn't write to the database before launch has read it", async () => {
    mirroredStorage.setItem("zmail.zoom", "1.2");
    await settled();
    expect(h.sets).toEqual([]);
    expect(localStorage.getItem("zmail.zoom")).toBe("1.2");
  });

  it("saves every change after launch, the latest value last", async () => {
    await loadMirrored();
    mirroredStorage.setItem("zmail.zoom", "1.1");
    mirroredStorage.setItem("zmail.zoom", "1.3");
    mirroredStorage.removeItem("zmail.folders");
    await settled();
    expect(h.kv.get("webstore:zmail.zoom")).toBe("1.3");
    expect(h.kv.get("webstore:zmail.folders")).toBeNull();
  });

  it("goes on without the database when it doesn't answer, and then never writes to it", async () => {
    vi.useFakeTimers();
    h.hang = true;
    localStorage.setItem("zmail.settings", "local");
    const launch = loadMirrored(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await launch;
    mirroredStorage.setItem("zmail.settings", "changed");
    await settled();
    expect(h.sets).toEqual([]);
    expect(localStorage.getItem("zmail.settings")).toBe("changed");
  });

  it("leaves the browser preview on plain localStorage", async () => {
    h.tauri = false;
    await loadMirrored();
    mirroredStorage.setItem("zmail.zoom", "1.2");
    await settled();
    expect(h.sets).toEqual([]);
    expect(localStorage.getItem("zmail.zoom")).toBe("1.2");
  });
});
