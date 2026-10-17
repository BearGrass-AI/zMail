// Account registry: which mailboxes zMail is connected to, persisted locally,
// and the mail/calendar provider for each.

import type { Account } from "@/lib/types";
import type { MailProvider } from "@/lib/mail/provider";
import type { CalendarProvider } from "@/lib/calendar/provider";
import { MockMailProvider } from "@/lib/mail/mock-provider";
import { ACCOUNTS as MOCK_ACCOUNTS } from "@/lib/mail/mock-data";
import { GmailProvider } from "@/lib/google/gmail";
import { GoogleCalendarProvider } from "@/lib/google/calendar";
import { GraphProvider } from "@/lib/microsoft/graph";
import { OutlookCalendarProvider } from "@/lib/microsoft/calendar";
import { kvGet, kvSet } from "@/lib/db";

const KEY = "accounts.v1";

export async function loadRegistry(): Promise<Account[]> {
  return (await kvGet<Account[]>(KEY).catch(() => null)) ?? MOCK_ACCOUNTS;
}

export async function saveRegistry(accounts: Account[]) {
  await kvSet(KEY, accounts);
}

export function mailProviderFor(a: Account): MailProvider {
  switch (a.kind) {
    case "gmail":
      return new GmailProvider(a);
    case "m365":
      return new GraphProvider(a);
    default:
      return new MockMailProvider(a);
  }
}

export function calendarProviderFor(a: Account): CalendarProvider | null {
  switch (a.kind) {
    case "gmail":
      return new GoogleCalendarProvider(a.id);
    case "m365":
      return new OutlookCalendarProvider(a.id);
    default:
      return null;
  }
}

export const newAccountId = (kind: Account["kind"]) => `${kind}-${crypto.randomUUID().slice(0, 8)}`;
