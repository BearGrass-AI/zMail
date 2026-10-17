// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPressFeedback, pressScale, scaleOf } from "@/lib/press";

describe("press feedback", () => {
  let uninstall = () => {};
  afterEach(() => {
    uninstall();
    document.body.innerHTML = "";
  });

  const setup = (html: string) => {
    document.body.innerHTML = html;
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
    uninstall = installPressFeedback();
    return animate;
  };
  const press = (el: Element) => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  };

  it("presses in and settles back when a button (or its icon) is clicked", () => {
    const animate = setup('<button id="b"><svg id="icon"></svg></button>');
    press(document.getElementById("icon")!);
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("skips disabled buttons and opted-out areas", () => {
    const animate = setup('<button id="d" disabled>x</button><div data-no-press><button id="n">y</button></div>');
    press(document.getElementById("d")!);
    press(document.getElementById("n")!);
    expect(animate).not.toHaveBeenCalled();
  });

  it("moves wide buttons less than small ones", () => {
    expect(pressScale(28)).toBeLessThan(pressScale(200));
    expect(pressScale(200)).toBeLessThan(pressScale(400));
    expect(pressScale(28)).toBe(0.97);
    expect(pressScale(200)).toBe(0.98);
    expect(pressScale(400)).toBe(0.99);
  });

  it("releases without overshoot", () => {
    const animate = setup('<button id="b">x</button>');
    press(document.getElementById("b")!);
    const calls = animate.mock.calls as unknown as [unknown, KeyframeAnimationOptions][];
    expect(calls[0][1]).toMatchObject({ duration: 100, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    expect(calls[1][1]).toMatchObject({ duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  });

  it("releases from where the button is, not from the full press depth", () => {
    const animate = setup('<button id="b">x</button>');
    const b = document.getElementById("b")!;
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    // Let go 40ms in: the press-in has only got part of the way.
    b.style.transform = "matrix(0.985, 0, 0, 0.985, 0, 0)";
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    const calls = animate.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions][];
    expect(calls[1][0]).toEqual([{ transform: "scale(0.985)" }, { transform: "scale(1)" }]);
  });

  it("lets go when the pointer slides off, once", () => {
    const animate = setup('<button id="b">x</button>');
    const b = document.getElementById("b")!;
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    b.dispatchEvent(new PointerEvent("pointerleave"));
    expect(animate).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("reads the scale out of a computed transform", () => {
    expect(scaleOf("matrix(0.97, 0, 0, 0.97, 0, 0)")).toBe(0.97);
    expect(scaleOf("matrix3d(0.99, 0, 0, 0, 0, 0.99, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)")).toBe(0.99);
    expect(scaleOf("none")).toBeNull();
    expect(scaleOf("")).toBeNull();
  });
});
