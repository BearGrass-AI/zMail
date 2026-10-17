// src/lib/ai/assistant/panel-width.ts
// Width rules for the resizable assistant panel, plus the in-progress drag width
// (shared so App's wrapper can follow the drag without touching persisted settings).

import { create } from "zustand";

export const MIN_WIDTH = 320;
export const MAX_WIDTH = 900;
export const DEFAULT_WIDTH = 340;

export function clampWidth(w: number, windowWidth: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, windowWidth * 0.6));
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, w)));
}

/** Live width while the handle is being dragged; null when idle. */
export const useDragWidth = create<{ live: number | null; setLive: (w: number | null) => void }>((set) => ({
  live: null,
  setLive: (live) => set({ live }),
}));
