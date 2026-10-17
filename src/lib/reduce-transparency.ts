// System Settings › Accessibility › Display › Reduce transparency (and Increase contrast, which
// macOS pairs with it). WebKit doesn't implement prefers-reduced-transparency, so inside the app
// Rust reads the setting; the media query still counts where a browser has it. index.css makes
// panes, menus and dialogs solid while html has the class.

import { invoke, isTauri } from "@tauri-apps/api/core";

export const REDUCE_TRANSPARENCY_CLASS = "reduce-transparency";
const QUERIES = ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)"];

function mediaWantsSolid(): boolean {
  return QUERIES.some((q) => window.matchMedia(q).matches);
}

async function nativeWantsSolid(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return (await invoke<boolean>("reduce_transparency")) === true;
  } catch (err) {
    console.warn("[display] reduce transparency unavailable", err);
    return false;
  }
}

let latest = 0;

/** Sets or clears the class from the current settings. Only the newest of overlapping checks applies. */
export async function syncReduceTransparency(): Promise<boolean> {
  const call = ++latest;
  const on = mediaWantsSolid() || (await nativeWantsSolid());
  if (call === latest) document.documentElement.classList.toggle(REDUCE_TRANSPARENCY_CLASS, on);
  return on;
}

/**
 * Applies the setting now and again whenever it may have changed: macOS sends no event the page
 * can hear, and the setting is changed in System Settings, so zMail checks when it's back in front.
 * Returns a cleanup.
 */
export function installReduceTransparency(): () => void {
  const sync = () => void syncReduceTransparency();
  const onVisible = () => {
    if (document.visibilityState === "visible") sync();
  };
  const lists = QUERIES.map((q) => window.matchMedia(q));
  sync();
  window.addEventListener("focus", sync);
  document.addEventListener("visibilitychange", onVisible);
  for (const mq of lists) mq.addEventListener("change", sync);
  return () => {
    window.removeEventListener("focus", sync);
    document.removeEventListener("visibilitychange", onVisible);
    for (const mq of lists) mq.removeEventListener("change", sync);
  };
}
