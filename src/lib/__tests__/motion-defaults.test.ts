// @vitest-environment jsdom
// App-wide motion defaults: no bouncy fallback spring, entrances that play once per session, and
// tooltips that switch instantly once one is showing.
import { createElement, act, useContext, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MotionConfigContext } from "motion/react";
import { AppMotion } from "@/components/app-motion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SPRING, useEntranceOnce } from "@/lib/motion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("AppMotion", () => {
  it("falls back to the critically damped spring and follows Reduce motion", () => {
    let seen: { transition?: unknown; reducedMotion?: string } = {};
    function Probe() {
      seen = useContext(MotionConfigContext);
      return null;
    }
    act(() => root.render(createElement(AppMotion, null, createElement(Probe))));
    expect(seen.transition).toMatchObject({ type: "spring", bounce: 0 });
    expect(seen.transition).toMatchObject(SPRING);
    expect(seen.reducedMotion).toBe("user");
  });
});

describe("useEntranceOnce", () => {
  const got: unknown[] = [];
  function Hero() {
    got.push(useEntranceOnce("test-hero", { opacity: 0 }));
    return null;
  }

  it("plays on the first visit, even under StrictMode's double render, and not on later ones", () => {
    act(() => root.render(createElement(StrictMode, null, createElement(Hero))));
    expect(got.at(-1)).toEqual({ opacity: 0 });
    act(() => root.render(null));
    act(() => root.render(createElement(StrictMode, null, createElement(Hero))));
    expect(got.at(-1)).toBe(false);
  });
});

describe("tooltip", () => {
  it("skips its animation when it opens instantly, and has no broken class tokens", () => {
    act(() =>
      root.render(
        createElement(Tooltip, { open: true }, createElement(TooltipTrigger, null, "Archive"), createElement(TooltipContent, null, "Archive")),
      ),
    );
    const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
    expect(popup).toBeTruthy();
    const classes = popup.className.split(/\s+/);
    expect(classes).toContain("data-instant:animate-none!");
    expect(classes.some((c) => c.includes("animate-indata"))).toBe(false);
    expect(classes).toContain("data-open:animate-in");
  });
});
