// macOS notifications through Rust (UserNotifications). Outside the app (the browser preview)
// everything reports "unavailable" and does nothing.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type NotifyStatus = "notDetermined" | "denied" | "authorized" | "provisional" | "unavailable";

/** One banner. `id` is the email id, or "summary-<ms>" / "test-<ms>". */
export interface Note {
  id: string;
  title: string;
  subtitle?: string;
  body?: string;
  /** Groups banners per account in Notification Center. */
  thread?: string;
  sound: boolean;
  emailId?: string;
  accountId?: string;
}

export interface NotificationOpen {
  id: string;
  emailId?: string | null;
  accountId?: string | null;
}

export async function notifyStatus(): Promise<NotifyStatus> {
  if (!isTauri()) return "unavailable";
  try {
    return await invoke<NotifyStatus>("notify_status");
  } catch (err) {
    console.error("[notify] status failed", err);
    return "unavailable";
  }
}

/** Shows macOS's own prompt once. True when allowed. */
export async function notifyRequest(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("notify_request");
  } catch (err) {
    console.error("[notify] request failed", err);
    return false;
  }
}

export async function notifyShow(note: Note): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("notify_show", { note });
  } catch (err) {
    console.error("[notify] show failed", err);
  }
}

export async function notifyRemove(ids: string[]): Promise<void> {
  if (!isTauri() || !ids.length) return;
  try {
    await invoke("notify_remove", { ids });
  } catch (err) {
    console.error("[notify] remove failed", err);
  }
}

/** Identifiers of the banners still in Notification Center, including earlier sessions'. */
export async function notifyDelivered(): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<string[]>("notify_delivered");
  } catch (err) {
    console.error("[notify] delivered failed", err);
    return [];
  }
}

/** The banner click nobody has handled yet (one that launched zMail), once. */
export async function notifyTakePending(): Promise<NotificationOpen | null> {
  if (!isTauri()) return null;
  try {
    return (await invoke<NotificationOpen | null>("notify_take_pending")) ?? null;
  } catch (err) {
    console.error("[notify] take pending failed", err);
    return null;
  }
}

export async function notifyOpenSettings(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("notify_open_settings");
  } catch (err) {
    console.error("[notify] open settings failed", err);
  }
}

/** A banner was clicked. Resolves to an unlisten function. */
export async function onNotificationOpen(cb: (e: NotificationOpen) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    return await listen<NotificationOpen>("notification-open", (ev) => cb(ev.payload));
  } catch (err) {
    console.error("[notify] listen failed", err);
    return () => {};
  }
}
