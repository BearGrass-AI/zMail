// Each connected account's mail and calendar provider, by account id.

import type { MailProvider } from "@/lib/mail/provider";
import type { CalendarProvider } from "@/lib/calendar/provider";

export const providers = new Map<string, MailProvider>();
export const calProviders = new Map<string, CalendarProvider>();
export const providerFor = (accountId: string) => {
  const p = providers.get(accountId);
  if (!p) throw new Error(`No provider for account ${accountId}`);
  return p;
};
export const providerOf = (accountId: string) => providerFor(accountId);

export function calendarProvider(accountId: string) {
  return calProviders.get(accountId);
}
