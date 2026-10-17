// Safari-style page zoom: ⌘+ / ⌘= bigger, ⌘− smaller, ⌘0 actual size. It zooms the whole web
// view (the email frame included) and the level comes back at the next launch.

import { isTauri } from "@tauri-apps/api/core";
import { mirroredStorage } from "./web-store";

export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 1.6;
export const ZOOM_STEP = 0.1;
const KEY = "zmail.zoom";

/** A safe zoom level from anything: finite, within 0.8–1.6, on a 0.1 step. Otherwise 1. */
export function clampZoom(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  const stepped = Math.round(n / ZOOM_STEP) * ZOOM_STEP;
  return Number(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped)).toFixed(1));
}

type ZoomKey = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/** +1 / -1 / 0 (reset) for a zoom shortcut, null for any other key. ⌘⇧0 stays "all accounts". */
export function zoomShortcut(e: ZoomKey): 1 | -1 | 0 | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+") return 1;
  if (e.key === "-" && !e.shiftKey) return -1;
  if (e.key === "0" && !e.shiftKey) return 0;
  return null;
}

function readSaved(): number {
  try {
    return clampZoom(mirroredStorage.getItem(KEY) as string | null);
  } catch {
    return 1;
  }
}

function save(level: number) {
  try {
    if (level === 1) void mirroredStorage.removeItem(KEY);
    else void mirroredStorage.setItem(KEY, String(level));
  } catch (err) {
    console.warn("[zoom] couldn't save the zoom level", err);
  }
}

let current = 1;
let queue: Promise<unknown> = Promise.resolve();

/** The level last applied to the web view. */
export function currentZoom() {
  return current;
}

async function apply(level: number): Promise<boolean> {
  const next = clampZoom(level);
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(next);
  } catch (err) {
    console.warn("[zoom] couldn't zoom", err);
    return false;
  }
  current = next;
  save(next);
  return true;
}

/** Applies the change after any still running, so fast repeats each take one step. */
function enqueue(task: () => Promise<boolean>): Promise<boolean> {
  const run = queue.then(task, task);
  queue = run;
  return run;
}

/** Zooms one step in (1) or out (-1), or back to actual size (0). False outside the app or on failure. */
export function stepZoom(dir: 1 | -1 | 0): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  return enqueue(() => apply(dir === 0 ? 1 : current + dir * ZOOM_STEP));
}

/** Restores the saved level at launch. */
export function restoreZoom(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  const saved = readSaved();
  if (saved === 1) {
    // Drop an unreadable or out-of-range value so it isn't read again.
    save(1);
    return Promise.resolve(true);
  }
  return enqueue(() => apply(saved));
}

/** Handles a zoom shortcut inside the app. True when the key was one. */
export function handleZoomKey(e: KeyboardEvent): boolean {
  const dir = zoomShortcut(e);
  if (dir === null || !isTauri()) return false;
  e.preventDefault();
  void stepZoom(dir);
  return true;
}
