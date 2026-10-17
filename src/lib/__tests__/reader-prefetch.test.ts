// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { neighborsOf } from "@/lib/store";

describe("neighborsOf", () => {
  const order = ["a", "b", "c", "d"];
  it("returns the next two, then the previous one", () => {
    expect(neighborsOf(order, "b")).toEqual(["c", "d", "a"]);
  });
  it("at the end, returns only the previous one", () => {
    expect(neighborsOf(order, "d")).toEqual(["c"]);
  });
  it("at the start, returns only the next two", () => {
    expect(neighborsOf(order, "a")).toEqual(["b", "c"]);
  });
  it("returns nothing for an unknown id", () => {
    expect(neighborsOf(order, "z")).toEqual([]);
  });
});
