// Secrets (API keys, OAuth tokens) go to the macOS Keychain via Rust. In the
// browser preview there is no Keychain, so they live in memory only.

import { invoke, isTauri } from "@tauri-apps/api/core";

const memory = new Map<string, string>();

export async function getSecret(name: string): Promise<string | null> {
  if (!isTauri()) return memory.get(name) ?? null;
  return invoke<string | null>("secret_get", { name });
}

export async function setSecret(name: string, value: string): Promise<void> {
  if (!isTauri()) {
    if (value) memory.set(name, value);
    else memory.delete(name);
    return;
  }
  await invoke("secret_set", { name, value });
}

export async function deleteSecret(name: string): Promise<void> {
  if (!isTauri()) return void memory.delete(name);
  await invoke("secret_delete", { name });
}
