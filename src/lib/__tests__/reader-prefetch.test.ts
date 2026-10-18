// @vitest-environment jsdom
// Pins which emails the Reader warms around the open one, and that warming a neighbour
// only runs the dark-mode adapter (the costly step on hostile mail) when it would show dark.
import { describe, expect, it, vi } from "vitest";
import { neighborsOf } from "@/lib/store";
import { adaptEmail } from "@/lib/mail/dark-adapt";
import { warmRender } from "@/lib/mail/dark-mode";

vi.mock("@/lib/mail/dark-adapt", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mail/dark-adapt")>();
  return { ...real, adaptEmail: vi.fn(real.adaptEmail) };
});

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

describe("warmRender", () => {
  // Each case its own body, so no cached decision hides whether the adapter ran.
  const colorful = (n: number) => `<p style="color:#333;background:#fff">Hi Ann, note ${n}</p>`;

  it("doesn't adapt a neighbour in light mode", () => {
    vi.mocked(adaptEmail).mockClear();
    warmRender(colorful(1), false, "theme");
    expect(adaptEmail).not.toHaveBeenCalled();
  });

  it("doesn't adapt a neighbour when messages always show light", () => {
    vi.mocked(adaptEmail).mockClear();
    warmRender(colorful(2), true, "light");
    expect(adaptEmail).not.toHaveBeenCalled();
  });

  it("adapts a neighbour when it would show dark", () => {
    vi.mocked(adaptEmail).mockClear();
    warmRender(colorful(3), true, "theme");
    expect(adaptEmail).toHaveBeenCalledTimes(1);
  });
});
