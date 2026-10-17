// Connecting real accounts: OAuth sign-in, identify the mailbox, register it.

import type { Account } from "@/lib/types";
import { GOOGLE_SCOPES, MICROSOFT_SCOPES, moveSignIn, signIn, signOut } from "@/lib/oauth";
import { newAccountId } from "@/lib/accounts";
import { GmailProvider } from "@/lib/google/gmail";
import { kvGet, kvSet } from "@/lib/db";
import { getSecret, setSecret } from "@/lib/secrets";
import { request } from "@/lib/transport";
import { graphThrottle } from "@/lib/microsoft/throttle";
import { useMail } from "@/lib/store";

export interface OAuthApp {
  clientId: string;
  /** Google desktop clients have a (non-confidential) secret; stored in the Keychain. */
  clientSecret?: string;
  /** Microsoft only: "common", "organizations" or a tenant id. */
  tenant?: string;
}

const appKey = (p: "google" | "microsoft") => `oauthapp.${p}`;

export async function loadOAuthApp(p: "google" | "microsoft"): Promise<OAuthApp> {
  const saved = (await kvGet<OAuthApp>(appKey(p))) ?? { clientId: "" };
  const clientSecret = (await getSecret(`${appKey(p)}.secret`).catch(() => null)) ?? undefined;
  return { ...saved, clientSecret };
}

export async function saveOAuthApp(p: "google" | "microsoft", app: OAuthApp) {
  await kvSet(appKey(p), { clientId: app.clientId.trim(), tenant: app.tenant });
  if (app.clientSecret !== undefined) await setSecret(`${appKey(p)}.secret`, app.clientSecret.trim());
}

async function register(account: Account) {
  const existing = useMail.getState().accounts.find((a) => a.address === account.address && a.kind === account.kind);
  if (existing) {
    await signOut(account.id);
    throw new Error(`${account.address} is already connected.`);
  }
  await useMail.getState().addAccount(account);
  return account;
}

/** The Gmail address signed in under `id`, lowercased. */
async function gmailAddress(id: string) {
  const { emailAddress } = await new GmailProvider({ id, kind: "gmail", name: "Gmail", address: "" }).profile();
  return emailAddress.toLowerCase();
}

/** The Microsoft 365 mailbox a sign-in token belongs to: its address first, then its user principal name, lowercased. */
async function microsoftAddresses(id: string, token: string) {
  // Uses the sign-in token directly (the account isn't registered yet), but still goes through the Graph throttle.
  const me = await graphThrottle.run(id, () =>
    request<{ mail?: string; userPrincipalName: string; displayName?: string }>("GET", "https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { idempotent: true },
  );
  return [me.mail ?? me.userPrincipalName, me.userPrincipalName].map((a) => a.toLowerCase());
}

export async function connectGoogle(app: OAuthApp): Promise<Account> {
  if (!app.clientId) throw new Error("Enter your Google OAuth client ID first.");
  await saveOAuthApp("google", app);
  const id = newAccountId("gmail");
  await signIn(id, { provider: "google", client_id: app.clientId.trim(), client_secret: app.clientSecret?.trim() || null, scopes: GOOGLE_SCOPES });
  return register({ id, kind: "gmail", name: "Gmail", address: await gmailAddress(id) });
}

export async function connectMicrosoft(app: OAuthApp): Promise<Account> {
  if (!app.clientId) throw new Error("Enter your Entra application (client) ID first.");
  await saveOAuthApp("microsoft", app);
  const id = newAccountId("m365");
  const token = await signIn(id, {
    provider: "microsoft",
    client_id: app.clientId.trim(),
    client_secret: null,
    scopes: MICROSOFT_SCOPES,
    tenant: app.tenant?.trim() || "organizations",
  });
  const [address] = await microsoftAddresses(id, token);
  return register({ id, kind: "m365", name: "Microsoft 365", address });
}

/**
 * Sign in again for an existing account (expired or revoked refresh token). The sign-in lands under a
 * temporary id and replaces the account's tokens only if it's the same mailbox.
 */
export async function reconnect(account: Account): Promise<void> {
  const provider = account.kind === "gmail" ? "google" : "microsoft";
  const app = await loadOAuthApp(provider);
  if (!app.clientId) throw new Error("No saved OAuth app for this provider — connect it again from Add account.");
  const temp = newAccountId(account.kind);
  const token = await signIn(
    temp,
    {
      provider,
      client_id: app.clientId,
      client_secret: provider === "google" ? app.clientSecret || null : null,
      scopes: provider === "google" ? GOOGLE_SCOPES : MICROSOFT_SCOPES,
      tenant: provider === "microsoft" ? app.tenant || "organizations" : undefined,
    },
    account.address,
  );
  let addresses: string[];
  try {
    addresses = provider === "google" ? [await gmailAddress(temp)] : await microsoftAddresses(temp, token);
  } catch (err) {
    await signOut(temp).catch(() => undefined);
    throw err;
  }
  if (!addresses.includes(account.address.toLowerCase())) {
    await signOut(temp).catch(() => undefined);
    throw new Error(`You signed in as ${addresses[0]}. Sign in as ${account.address} to reconnect it.`);
  }
  await moveSignIn(temp, account.id).catch(async (err: unknown) => {
    await signOut(temp).catch(() => undefined);
    throw err;
  });
  await useMail.getState().refresh();
}
