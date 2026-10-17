import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { SPRING } from "@/lib/motion";

/**
 * Motion defaults for the whole app: follow the system's Reduce motion setting, and give any
 * element that doesn't name a transition the critically damped spring instead of Motion's
 * bouncy default.
 */
export function AppMotion({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={SPRING}>
      {children}
    </MotionConfig>
  );
}
