import { useEffect, useState } from "react";

// Shared motion presets: a crisp app — no visible bounce except active-pill indicators.
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** Entrances, cards, bars: quick and settled. */
export const SPRING = { type: "spring", duration: 0.35, bounce: 0 } as const;
/** Active-tab / pill indicators (layoutId): a hint of life. */
export const SPRING_PILL = { type: "spring", duration: 0.3, bounce: 0.15 } as const;
/** Expand/collapse and small fades. */
export const QUICK = { duration: 0.18, ease: EASE_OUT } as const;
/** Word `i` of `n` in a type-in reveal: staggered over 80ms, each fading for 120ms (0.2s in all). */
export const typeInWord = (i: number, n: number) => ({ delay: n > 1 ? (i / (n - 1)) * 0.08 : 0, duration: 0.12, ease: EASE_OUT });
/** Mail list rows: settle in from just below; leaving, fold away. */
export const ROW_MOTION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, height: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, transition: { duration: 0.2 } },
  transition: SPRING,
};

const played = new Set<string>();

/**
 * An entrance that plays once per app session: the first mount gets `initial`, later mounts
 * (coming back to the view) start settled. Read once per mount, marked after it commits, so
 * React's double render in development doesn't use it up.
 */
export function useEntranceOnce<T>(key: string, initial: T): T | false {
  const [first] = useState(() => !played.has(key));
  useEffect(() => {
    played.add(key);
  }, [key]);
  return first ? initial : false;
}
