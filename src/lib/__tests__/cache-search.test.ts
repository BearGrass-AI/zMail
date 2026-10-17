import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ on: true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => h.on, invoke: h.invoke }));

import { cacheGetRows, cacheSearch } from "@/lib/db";

beforeEach(() => {
  h.on = true;
  h.invoke.mockReset();
  h.invoke.mockResolvedValue({ hits: [], indexing: false });
});

const defaults = { accountIds: null, folderIds: null, excludeFolderIds: null, starred: false, order: "rank" };

describe("cacheSearch", () => {
  it("returns no hits outside Tauri", async () => {
    h.on = false;
    expect(await cacheSearch("hello")).toEqual({ hits: [], indexing: false });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("passes the query, filters and a default limit", async () => {
    const result = { hits: [{ id: "1", account_id: "a", folder_id: "f", date: "d", rank: -1 }], indexing: true };
    h.invoke.mockResolvedValueOnce(result);
    expect(await cacheSearch("budget", { accountIds: ["a"], folderIds: ["f"] })).toEqual(result);
    expect(h.invoke).toHaveBeenCalledWith("cache_search", { ...defaults, query: "budget", accountIds: ["a"], folderIds: ["f"], limit: 50 });
    await cacheSearch("x");
    expect(h.invoke).toHaveBeenLastCalledWith("cache_search", { ...defaults, query: "x", limit: 50 });
  });

  it("passes the exclusions, the starred filter and the order", async () => {
    await cacheSearch("x", { excludeFolderIds: ["spam", "trash"], starred: true, order: "date", limit: 500 });
    expect(h.invoke).toHaveBeenLastCalledWith("cache_search", {
      ...defaults,
      query: "x",
      excludeFolderIds: ["spam", "trash"],
      starred: true,
      order: "date",
      limit: 500,
    });
    // Anything but "date" is the default order.
    await cacheSearch("x", { order: "newest" as "date" });
    expect((h.invoke.mock.lastCall?.[1] as { order: string }).order).toBe("rank");
  });

  it("keeps the limit an integer in 1-500", async () => {
    const limits: number[] = [];
    for (const limit of [0, -3, 2.7, 10_000, 1e300, Infinity, -Infinity, NaN]) {
      await cacheSearch("x", { limit });
      limits.push((h.invoke.mock.lastCall?.[1] as { limit: number }).limit);
    }
    expect(limits).toEqual([1, 1, 2, 500, 500, 500, 1, 50]);
  });
});

describe("cacheGetRows", () => {
  it("reads nothing outside Tauri or for no ids", async () => {
    expect(await cacheGetRows([])).toEqual([]);
    h.on = false;
    expect(await cacheGetRows(["a"])).toEqual([]);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("asks for at most 500 ids", async () => {
    h.invoke.mockResolvedValueOnce([{ id: "a", folder_id: "f", date: "d", json: "{}" }]);
    expect(await cacheGetRows(["a"])).toEqual([{ id: "a", folder_id: "f", date: "d", json: "{}" }]);
    expect(h.invoke).toHaveBeenLastCalledWith("cache_get_rows", { ids: ["a"] });
    await cacheGetRows(Array.from({ length: 600 }, (_, i) => `m${i}`));
    expect((h.invoke.mock.lastCall?.[1] as { ids: string[] }).ids).toHaveLength(500);
  });
});
