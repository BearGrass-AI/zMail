// In-app updates. The Tauri updater plugin fetches latest.json from the release page in Rust and
// checks the download's signature against the public key in tauri.conf.json; this module turns
// that into a small store the About page reads. It never installs on its own and never shows UI:
// automatic checks only find out whether an update exists.

import { isTauri } from "@tauri-apps/api/core";
import { relaunch as relaunchProcess } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { mirroredStorage } from "./web-store";

export type UpdateCheck =
  | { kind: "none" }
  | { kind: "available"; version: string; notes: string; date: string | null }
  | { kind: "error"; message: string };

export type InstallResult = { ok: true; version: string } | { ok: false; message: string };

export interface UpdateProgress {
  downloaded: number;
  /** Bytes in the whole download, when the server said. */
  total: number | null;
}

/** What the About page shows. */
export type UpdateStatus =
  /** The browser preview and dev builds can't update themselves. */
  | { kind: "unsupported"; message: string }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; version: string; notes: string; date: string | null }
  | ({ kind: "installing"; version: string } & UpdateProgress)
  /** Installed; it runs after a relaunch. */
  | { kind: "installed"; version: string }
  | { kind: "error"; message: string };

export const UNSUPPORTED_MESSAGE = "Updates work in release builds.";
export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** How often the running app looks at whether a day has passed (a sleeping Mac pauses timers). */
const TICK_MS = 60 * 60 * 1000;
const MAX_VERSION = 64;
const MAX_NOTES = 20_000;
const MAX_MESSAGE = 300;

interface UpdatesStore {
  /** Look for updates at launch and once a day. Persisted. */
  autoCheckUpdates: boolean;
  /** When a check last got an answer (ms since 1970). Persisted. */
  lastChecked: number | null;
  status: UpdateStatus;
  setAutoCheck: (on: boolean) => void;
}

/** A persisted timestamp zMail can trust: finite, after 2020 and not in the future (a day of clock skew allowed). */
export function sanitizeLastChecked(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= Date.UTC(2020, 0, 1) && value <= now + 86_400_000 ? Math.floor(value) : null;
}

export const useUpdates = create<UpdatesStore>()(
  persist(
    (set) => ({
      autoCheckUpdates: true,
      lastChecked: null,
      status: { kind: "idle" },
      setAutoCheck: (on) => set({ autoCheckUpdates: on }),
    }),
    {
      name: "zmail.updates",
      storage: createJSONStorage(() => mirroredStorage),
      partialize: ({ autoCheckUpdates, lastChecked }) => ({ autoCheckUpdates, lastChecked }),
      // Whatever was saved, only a boolean and a sane timestamp come back.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Record<"autoCheckUpdates" | "lastChecked", unknown>>;
        return {
          ...current,
          autoCheckUpdates: typeof p.autoCheckUpdates === "boolean" ? p.autoCheckUpdates : current.autoCheckUpdates,
          lastChecked: sanitizeLastChecked(p.lastChecked),
        };
      },
    },
  ),
);

/** False in the browser preview and in dev builds, which have nothing to update. */
export function updatesSupported(): boolean {
  return isTauri() && !import.meta.env.DEV;
}

const setStatus = (status: UpdateStatus) => useUpdates.setState({ status });

function messageOf(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const text = raw.trim().replace(/\s+/g, " ");
  return (text || fallback).slice(0, MAX_MESSAGE);
}

/** The update the last check found, held until it's installed or replaced. */
let pending: { update: Update; version: string } | null = null;
let checking: Promise<UpdateCheck> | null = null;
let installing: Promise<InstallResult> | null = null;

function release(update: Update) {
  update.close().catch((err: unknown) => console.warn("[updates] couldn't release the update", err));
}

/** The parts of the plugin's answer zMail uses, or null when they don't look right. */
function readUpdate(update: Update): { version: string; notes: string; date: string | null } | null {
  const version = typeof update.version === "string" ? update.version.trim() : "";
  if (!version || version.length > MAX_VERSION || !/^v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(version)) return null;
  const notes = typeof update.body === "string" ? update.body.trim().slice(0, MAX_NOTES) : "";
  const time = typeof update.date === "string" ? Date.parse(update.date) : NaN;
  return { version, notes, date: Number.isFinite(time) ? new Date(time).toISOString() : null };
}

async function runCheck(): Promise<UpdateCheck> {
  setStatus({ kind: "checking" });
  let found: Update | null;
  try {
    found = await check();
  } catch (err) {
    const message = messageOf(err, "Couldn't reach the update server.");
    setStatus({ kind: "error", message });
    return { kind: "error", message };
  }
  if (pending && pending.update !== found) {
    release(pending.update);
    pending = null;
  }
  if (found === null || found === undefined) {
    useUpdates.setState({ status: { kind: "none" }, lastChecked: Date.now() });
    return { kind: "none" };
  }
  const info = typeof found === "object" ? readUpdate(found) : null;
  if (!info) {
    if (typeof found === "object") release(found);
    const message = "The update server sent something zMail couldn't read.";
    setStatus({ kind: "error", message });
    return { kind: "error", message };
  }
  pending = { update: found, version: info.version };
  useUpdates.setState({ status: { kind: "available", ...info }, lastChecked: Date.now() });
  return { kind: "available", ...info };
}

/** Asks the update server whether there's a newer zMail. Overlapping calls share one check. */
export function checkForUpdate(): Promise<UpdateCheck> {
  if (!updatesSupported()) {
    setStatus({ kind: "unsupported", message: UNSUPPORTED_MESSAGE });
    return Promise.resolve({ kind: "error", message: UNSUPPORTED_MESSAGE });
  }
  // Checking again mid-install would release the update being installed.
  if (installing) return Promise.resolve({ kind: "error", message: "An update is being installed." });
  checking ??= runCheck().finally(() => {
    checking = null;
  });
  return checking;
}

async function runInstall(update: Update, version: string, onProgress?: (p: UpdateProgress) => void): Promise<InstallResult> {
  const progress: UpdateProgress = { downloaded: 0, total: null };
  const report = () => {
    setStatus({ kind: "installing", version, ...progress });
    try {
      onProgress?.({ ...progress });
    } catch (err) {
      console.warn("[updates] progress callback failed", err);
    }
  };
  report();
  try {
    await update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started") {
        const total = event.data.contentLength;
        progress.total = typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null;
      } else if (event.event === "Progress") {
        const chunk = event.data.chunkLength;
        if (typeof chunk === "number" && Number.isFinite(chunk) && chunk > 0) progress.downloaded += chunk;
      } else if (progress.total !== null) {
        progress.downloaded = Math.max(progress.downloaded, progress.total);
      }
      report();
    });
  } catch (err) {
    const message = messageOf(err, "The update didn't install.");
    // Rust may still hold the download; a fresh check starts over cleanly.
    if (pending?.update === update) pending = null;
    release(update);
    setStatus({ kind: "error", message });
    return { ok: false, message };
  }
  if (pending?.update === update) pending = null;
  setStatus({ kind: "installed", version });
  return { ok: true, version };
}

/**
 * Downloads and installs the update the last check found, reporting bytes as they arrive.
 * Resolves ok only once the new version is installed; call `relaunch()` to start it.
 */
export function installUpdate(onProgress?: (p: UpdateProgress) => void): Promise<InstallResult> {
  if (!updatesSupported()) return Promise.resolve({ ok: false, message: UNSUPPORTED_MESSAGE });
  if (installing) return installing;
  if (!pending) return Promise.resolve({ ok: false, message: "Check for updates first." });
  const { update, version } = pending;
  installing = runInstall(update, version, onProgress).finally(() => {
    installing = null;
  });
  return installing;
}

/** Quits and reopens zMail, which then runs the installed version. */
export async function relaunch(): Promise<void> {
  await relaunchProcess();
}

let started = false;

/**
 * Checks once shortly after launch and again whenever a day has passed since the last answer,
 * while `autoCheckUpdates` is on. Does nothing (beyond saying so) in the preview and dev builds.
 * Returns a cleanup.
 */
export function startUpdateChecks(): () => void {
  if (!updatesSupported()) {
    setStatus({ kind: "unsupported", message: UNSUPPORTED_MESSAGE });
    return () => {};
  }
  if (started) return () => {};
  started = true;
  const auto = () => useUpdates.getState().autoCheckUpdates;
  const first = setTimeout(() => {
    if (auto()) void checkForUpdate();
  }, FIRST_CHECK_DELAY_MS);
  const tick = setInterval(() => {
    const { lastChecked } = useUpdates.getState();
    if (auto() && (lastChecked === null || Date.now() - lastChecked >= CHECK_EVERY_MS)) void checkForUpdate();
  }, TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(tick);
    started = false;
  };
}
