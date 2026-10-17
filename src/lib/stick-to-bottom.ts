// A chat log that follows new messages only while you're at the bottom. Scroll up to read
// history and it stays put; scroll back down to the end and it follows again.
import { useEffect, useRef, type RefObject } from "react";

/** This close to the end (px) counts as at the bottom. */
export const NEAR_BOTTOM_PX = 48;

/** Scroll `ref` to its end whenever `a` or `b` changes, unless the user has scrolled up away from it. */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, a: unknown, b?: unknown) {
  const following = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap <= NEAR_BOTTOM_PX) following.current = true;
      // Only a move up is the user leaving: our own smooth scroll down passes through gaps too.
      else if (el.scrollTop < lastTop) following.current = false;
      lastTop = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !following.current) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [ref, a, b]);
}
