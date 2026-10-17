// Who "you" are: the name zMail greets you by, signs drafts with and tells the sorting model, and
// the address it treats as yours. The name comes from your Mac user account first, then from the
// name on mail you sent, then from your address; the address is your first connected account's.
// With only the demo mailbox connected, it's the demo user.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { displayName } from "./contacts";
import { ME } from "./mail/mock-data";
import type { Account, Email } from "./types";

export type Me = { name: string; address: string };

const MAX_NAME = 100;

/** Your Mac user account's full name ("Jane Appleseed"), or "" outside the app or when it's unset. */
export async function macUserName(): Promise<string> {
  if (!isTauri()) return "";
  try {
    const name = await invoke<unknown>("full_user_name");
    return typeof name === "string" ? name.trim().slice(0, MAX_NAME) : "";
  } catch (err) {
    console.warn("[me] couldn't read the Mac user name", err);
    return "";
  }
}

/** The name you send mail under, by the most common From name on mail from your own addresses. */
function sentName(emails: Email[], addresses: Set<string>): string {
  const counts = new Map<string, number>();
  for (const e of emails) {
    const name = displayName(e.from?.name ?? "");
    if (!name || name.includes("@") || !addresses.has(e.from.address.toLowerCase())) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = "";
  let most = 0;
  for (const [name, n] of counts) if (n > most) [best, most] = [name, n];
  return best.slice(0, MAX_NAME);
}

/** "jane.appleseed@example.org" → "Jane Appleseed", the last resort. */
function nameFromAddress(address: string): string {
  const local = address.split("@")[0] ?? "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function deriveMe(accounts: Account[], emails: Email[], macName: string): Me {
  const real = accounts.filter((a) => a.kind !== "mock");
  if (!real.length) return ME;
  const address = real[0].address;
  const addresses = new Set(real.map((a) => a.address.toLowerCase()));
  const name = macName.trim() || sentName(emails, addresses) || nameFromAddress(address);
  return { name, address };
}
