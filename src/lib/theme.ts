// Applies theme mode + color palette to the document and, inside Tauri, toggles
// native macOS vibrancy behind the webview for the translucent theme.

import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { PaletteId, ThemeMode, Tinted } from "./settings";
import { useSettings } from "./settings";

type Hues = Record<Tinted | "accent", number>;

export const PALETTES: Record<PaletteId, { label: string; hues: Hues }> = {
  glacier: {
    label: "Glacier",
    hues: {
      accent: 255, primary: 255, transactions: 160, updates: 295, promotions: 350, social: 195,
      newsletters: 75, security: 210, needs_you: 20, worth_skim: 285, ready_archive: 150,
    },
  },
  ember: {
    label: "Ember",
    hues: {
      accent: 40, primary: 40, transactions: 95, updates: 340, promotions: 15, social: 320,
      newsletters: 60, security: 300, needs_you: 25, worth_skim: 60, ready_archive: 120,
    },
  },
  grove: {
    label: "Grove",
    hues: {
      accent: 155, primary: 155, transactions: 130, updates: 200, promotions: 85, social: 270,
      newsletters: 50, security: 230, needs_you: 35, worth_skim: 190, ready_archive: 145,
    },
  },
  aurora: {
    label: "Aurora",
    hues: {
      accent: 300, primary: 280, transactions: 175, updates: 320, promotions: 350, social: 190,
      newsletters: 230, security: 200, needs_you: 345, worth_skim: 265, ready_archive: 170,
    },
  },
  mono: {
    label: "Graphite",
    hues: {
      accent: 260, primary: 260, transactions: 260, updates: 260, promotions: 260, social: 260,
      newsletters: 260, security: 260, needs_you: 25, worth_skim: 260, ready_archive: 260,
    },
  },
};

/** Whether the app renders dark for a theme mode, given the OS preference. */
export function isAppDark(mode: ThemeMode, osDark: boolean) {
  return mode === "dark" || (mode !== "light" && osDark);
}

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

async function setVibrancy(on: boolean, dark: boolean) {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, Effect, EffectState } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (on) {
      await win.setEffects({
        effects: [dark ? Effect.HudWindow : Effect.Sidebar],
        state: EffectState.FollowsWindowActiveState,
      });
    } else {
      await win.clearEffects();
    }
  } catch (err) {
    console.warn("[theme] vibrancy unavailable", err);
  }
}

function apply(mode: ThemeMode, palette: PaletteId, overrides: Partial<Record<Tinted, number>>) {
  const root = document.documentElement;
  const dark = isAppDark(mode, prefersDark());
  root.classList.toggle("dark", dark);
  root.classList.toggle("translucent", mode === "translucent");
  root.classList.toggle("in-tauri", isTauri());

  const hues = { ...PALETTES[palette].hues, ...overrides };
  for (const [k, v] of Object.entries(hues)) root.style.setProperty(`--h-${k}`, String(v));
  root.style.setProperty("--chroma", palette === "mono" ? "0.03" : "0.16");

  void setVibrancy(mode === "translucent", dark);
}

export function useApplyTheme() {
  const { theme, palette, hues } = useSettings();
  useEffect(() => {
    apply(theme, palette, hues);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply(theme, palette, hues);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme, palette, hues]);
}

/** True when the app is currently rendering dark (dark/glass themes, or system + dark OS). */
export function useAppDark() {
  const theme = useSettings((s) => s.theme);
  const [os, setOs] = useState(prefersDark);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setOs(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isAppDark(theme, os);
}
