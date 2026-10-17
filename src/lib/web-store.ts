// Settings that live in the webview's localStorage (AI providers and roles, appearance, folder
// favorites, zoom, update preferences) are also kept in zMail's database, which is the copy that
// counts. localStorage belongs to the page's origin, so the dev build (http://localhost:1420) and
// the installed app (tauri://localhost) each have their own, and WebKit may clear it; the database
// is shared by every build with this app id.
//
// At launch `loadMirrored()` copies the database's version into localStorage before the stores
// rehydrate, and the first launch with this code copies what localStorage already has into the
// database. After that every write goes to both, the database writes one at a time per key so an
// older value can't land after a newer one.

import { isTauri } from "@tauri-apps/api/core";
import type { StateStorage } from "zustand/middleware";
import { kvGet, kvSet } from "./db";

export const MIRRORED = ["zmail.settings", "zmail.folders", "zmail.model-health", "zmail.updates", "zmail.zoom"] as const;
export type MirroredKey = (typeof MIRRORED)[number];

/** Anything larger isn't a settings blob; it's left where it is. */
const MAX_CHARS = 1_000_000;
const kvKey = (name: string) => `webstore:${name}`;

/** Database writes wait until launch has read the database, so a default can't overwrite a saved value. */
let ready = false;
const pending = new Map<string, string | null>();
let flushing: Promise<void> | null = null;

async function flush() {
  for (let next = pending.entries().next(); !next.done; next = pending.entries().next()) {
    const [name, value] = next.value;
    pending.delete(name);
    try {
      await kvSet(kvKey(name), value);
    } catch (err) {
      console.error("[web-store] couldn't save", name, err);
    }
  }
  flushing = null;
}

function queue(name: string, value: string | null) {
  if (!ready || !isTauri()) return;
  pending.set(name, value);
  flushing ??= flush();
}

/** Resolves once every queued database write has been tried. */
export function settled(): Promise<void> {
  return flushing ?? Promise.resolve();
}

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** localStorage, with each write also queued for the database. For zustand's `createJSONStorage`. */
export const mirroredStorage: StateStorage = {
  getItem: (name) => local()?.getItem(name) ?? null,
  setItem: (name, value) => {
    try {
      local()?.setItem(name, value);
    } catch (err) {
      console.warn("[web-store] localStorage refused", name, err);
    }
    queue(name, value);
  },
  removeItem: (name) => {
    try {
      local()?.removeItem(name);
    } catch (err) {
      console.warn("[web-store] localStorage refused", name, err);
    }
    queue(name, null);
  },
};

/**
 * Before the stores rehydrate: the database's saved value replaces localStorage's, and a key the
 * database doesn't have yet is copied there from localStorage. A failed read leaves that key's
 * localStorage alone. Outside the app (the browser preview) there's no database, so nothing changes.
 * If the database doesn't answer within `timeoutMs`, launch goes on with localStorage and nothing is
 * written to the database this session, so a stale copy can't replace what's saved there.
 */
export async function loadMirrored(timeoutMs = 3000): Promise<void> {
  if (!isTauri()) {
    ready = true;
    return;
  }
  const store = local();
  let late = false;
  const load = Promise.all(
    MIRRORED.map(async (name) => {
      try {
        const saved = await kvGet<unknown>(kvKey(name));
        if (late) return;
        if (typeof saved === "string" && saved.length <= MAX_CHARS) {
          store?.setItem(name, saved);
          return;
        }
        const existing = store?.getItem(name);
        if (existing != null && existing.length <= MAX_CHARS) await kvSet(kvKey(name), existing);
      } catch (err) {
        console.error("[web-store] couldn't load", name, err);
      }
    }),
  ).then(() => {
    if (!late) ready = true;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      console.error("[web-store] the database didn't answer; settings won't be saved there this session");
      resolve();
    }, timeoutMs);
  });
  await Promise.race([load, timeout]);
  clearTimeout(timer);
}

/** For tests: back to the state before launch. */
export function resetForTests() {
  ready = false;
  pending.clear();
  flushing = null;
}
