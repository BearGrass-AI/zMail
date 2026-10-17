// Photos from the Mac Contacts app: opt-in, checked against macOS's Contacts permission.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSettings } from "@/lib/settings";

/** "authorized" | "limited" | "denied" | "restricted" | "notDetermined" | "unavailable" */
export async function macContactsStatus(): Promise<string> {
  if (!isTauri()) return "unavailable";
  try {
    return await invoke<string>("mac_contacts_status");
  } catch {
    return "unavailable";
  }
}

/** Asks macOS for Contacts access when it hasn't been decided yet. */
export async function enableMacContacts(): Promise<"granted" | "denied" | "unavailable"> {
  const status = await macContactsStatus();
  if (status === "unavailable") return "unavailable";
  if (status === "authorized" || status === "limited") return "granted";
  if (status !== "notDetermined") return "denied";
  try {
    return (await invoke<boolean>("mac_contacts_request")) ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/** The photo (a data: URL) of the Mac contact with this address, if the setting is on and macOS allows it. */
export async function macContactPhoto(address: string): Promise<string | null> {
  if (!isTauri() || !useSettings.getState().macContactsPhotos) return null;
  try {
    return (await invoke<string | null>("mac_contact_photo", { address })) ?? null;
  } catch {
    return null;
  }
}
