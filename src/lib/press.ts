// Tactile feedback for every button: a quick press-in on pointer down and a
// crisp release. Uses the Web Animations API so it composes with whatever
// CSS transitions a button already has. This is the only press effect: don't
// add `active:scale-*` classes on top, or the two stack and press twice as deep.

const PRESSABLE = 'button, [role="button"], [role="checkbox"], [role="tab"], a[href], summary';
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/** Smaller buttons move more; wide ones barely, so big targets don't wobble. */
export function pressScale(width: number) {
  if (width > 280) return 0.99;
  if (width > 120) return 0.98;
  return 0.97;
}

/** The x scale of a computed `transform` ("matrix(…)" / "matrix3d(…)"), or null when there isn't one. */
export function scaleOf(transform: string): number | null {
  const m = /^matrix(?:3d)?\(\s*([-\d.e]+)/.exec(transform);
  const a = m ? Number(m[1]) : NaN;
  return Number.isFinite(a) ? a : null;
}

export function installPressFeedback(root: Document = document) {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || reduce?.matches) return;
    const el = (e.target as Element | null)?.closest<HTMLElement>(PRESSABLE);
    if (!el || el.matches(":disabled, [aria-disabled='true']") || el.closest("[data-no-press]")) return;
    const s = pressScale(el.getBoundingClientRect().width);
    const down = el.animate([{ transform: "scale(1)" }, { transform: `scale(${s})` }], { duration: 100, easing: EASE, fill: "forwards" });
    const release = () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      el.removeEventListener("pointerleave", release);
      // Start from where the button is now: a quick click lets go before the press-in has finished.
      const from = scaleOf(getComputedStyle(el).transform) ?? s;
      down.cancel();
      el.animate([{ transform: `scale(${from})` }, { transform: "scale(1)" }], { duration: 160, easing: EASE });
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    // Sliding off a pressed button lets it go, as on macOS.
    el.addEventListener("pointerleave", release);
  };
  root.addEventListener("pointerdown", onDown, true);
  return () => root.removeEventListener("pointerdown", onDown, true);
}
