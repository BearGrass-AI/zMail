// @vitest-environment jsdom
// The assistant log follows new messages while you're at the bottom, and leaves you be while you
// read history higher up.
import { createElement, act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEAR_BOTTOM_PX, useStickToBottom } from "@/lib/stick-to-bottom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let height = 1000;
const scrollTo = vi.fn();

const ref = createRef<HTMLDivElement>();
function Log({ n }: { n: number }) {
  useStickToBottom(ref, n);
  return createElement("div", { ref, id: "log" }, `messages: ${n}`);
}

const el = () => document.getElementById("log")!;
const render = (n: number) => act(() => root.render(createElement(Log, { n })));
/** The user scrolls to `top` (the view is 400px tall). */
const scrollUserTo = (top: number) =>
  act(() => {
    el().scrollTop = top;
    el().dispatchEvent(new Event("scroll"));
  });

beforeEach(() => {
  height = 1000;
  HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  root = createRoot(document.body.appendChild(document.createElement("div")));
  render(1);
  Object.defineProperty(el(), "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(el(), "clientHeight", { configurable: true, get: () => 400 });
  scrollUserTo(600);
  scrollTo.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("useStickToBottom", () => {
  it("follows a new message while you're at the bottom", () => {
    height = 1200;
    render(2);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1200 }));
  });

  it("keeps your place while you're scrolled up reading", () => {
    scrollUserTo(200);
    height = 1200;
    render(2);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("follows again once you scroll back near the end", () => {
    scrollUserTo(200);
    scrollUserTo(600 - NEAR_BOTTOM_PX + 8);
    height = 1200;
    render(2);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("isn't knocked off by its own scroll down passing through the middle", () => {
    height = 1200;
    render(2);
    // A smooth scroll toward 800 reports 700 on the way.
    scrollUserTo(700);
    height = 1400;
    render(3);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});
