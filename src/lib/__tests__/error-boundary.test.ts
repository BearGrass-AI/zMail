// @vitest-environment jsdom
// One crashing part shows its own error; the rest of the window keeps rendering.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

import { ErrorBoundary } from "@/components/error-boundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let crash = true;
function Boom({ name }: { name: string }) {
  if (crash) throw new Error(`${name} broke`);
  return createElement("p", null, `${name} ok`);
}

let root: Root;
const tree = (resetKey: string, props: Partial<{ quiet: boolean; onError: () => void }> = {}) =>
  createElement(
    "div",
    null,
    createElement("span", null, "sidebar ok"),
    createElement(ErrorBoundary, { label: "the mail list", resetKey, ...props, children: createElement(Boom, { name: "list" }) }),
  );

beforeEach(() => {
  crash = true;
  toastError.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("shows the error in place and keeps the rest of the window", () => {
    act(() => root.render(tree("a")));
    expect(document.body.textContent).toContain("sidebar ok");
    expect(document.body.textContent).toContain("Something went wrong in the mail list.");
    expect(document.body.textContent).toContain("list broke");
  });

  it("Try again renders the part again", () => {
    act(() => root.render(tree("a")));
    crash = false;
    const retry = [...document.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    act(() => retry.click());
    expect(document.body.textContent).toContain("list ok");
  });

  it("tries again on its own when the reset key changes", () => {
    act(() => root.render(tree("a")));
    crash = false;
    act(() => root.render(tree("b")));
    expect(document.body.textContent).toContain("list ok");
  });

  it("quiet boundaries render nothing, toast, and call onError", () => {
    const onError = vi.fn();
    act(() => root.render(tree("a", { quiet: true, onError })));
    expect(document.body.textContent).toBe("sidebar ok");
    expect(toastError).toHaveBeenCalledWith("Something went wrong in the mail list", { description: "list broke" });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
