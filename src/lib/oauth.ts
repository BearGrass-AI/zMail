// OAuth sign-in and access tokens (implemented in Rust: PKCE + loopback,
// refresh tokens in the Keychain).

import { invoke, isTauri } from "@tauri-apps/api/core";

export type OAuthProvider = "google" | "microsoft";

export interface ClientConfig {
  provider: OAuthProvider;
  client_id: string;
  client_secret?: string | null;
  scopes: string[];
  tenant?: string;
}

interface AccessToken {
  access_token: string;
  expires_at: number;
}

function requireTauri() {
  if (!isTauri()) throw new Error("Sign-in needs the zMail app (it runs the secure browser flow from Rust).");
}

/** `loginHint` (an address) points the provider's account picker at that mailbox. */
export async function signIn(account: string, config: ClientConfig, loginHint?: string): Promise<string> {
  requireTauri();
  const t = await invoke<AccessToken>("oauth_sign_in", { account, config: { tenant: "common", ...config }, loginHint: loginHint ?? null });
  return t.access_token;
}

/** Make the sign-in stored under `from` (a temporary id) the account `to`'s, replacing its old one. */
export async function moveSignIn(from: string, to: string): Promise<void> {
  requireTauri();
  await invoke("oauth_move_account", { from, to });
}

export async function accessToken(account: string): Promise<string> {
  requireTauri();
  const t = await invoke<AccessToken>("oauth_access_token", { account });
  return t.access_token;
}

/** Stop a sign-in that is waiting for the browser (its signIn call then rejects with "sign-in cancelled"). */
export async function cancelSignIn(): Promise<void> {
  if (isTauri()) await invoke("oauth_cancel_sign_in");
}

export async function signOut(account: string): Promise<void> {
  if (isTauri()) await invoke("oauth_sign_out", { account });
}

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

export const MICROSOFT_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Files.Read.All",
  "People.Read",
  "User.ReadBasic.All",
  "MailboxSettings.ReadWrite",
];
