// @vitest-environment jsdom
// Which calendar a date found in an email goes to by default.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

import { defaultCalendarFor } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { calendarToInfo as googleCal } from "@/lib/google/calendar-map";
import { calendarToInfo as outlookCal } from "@/lib/microsoft/graph-map";
import type { Account, CalendarInfo } from "@/lib/types";

const accounts = [{ id: "g", address: "me@gmail.com" }, { id: "m", address: "me@school.edu" }] as Account[];
const cal = (id: string, accountId: string, name: string, primary = false): CalendarInfo => ({ id, accountId, name, source: "google", hue: 1, ...(primary ? { primary } : {}) });

beforeEach(() => useSettings.setState({ defaultCalendars: {} }));

describe("defaultCalendarFor", () => {
  it("uses the account's primary calendar over an earlier one (Gmail with a 'Work' calendar)", () => {
    const s = { accounts, hiddenCalendars: new Set<string>(), calendars: [cal("g:work", "g", "Work"), cal("g:primary", "g", "Calendar", true)] };
    expect(defaultCalendarFor(s, "g")).toBe("g:primary");
  });
  it("prefers the calendar you picked last for that account", () => {
    useSettings.setState({ defaultCalendars: { g: "g:work" } });
    const s = { accounts, hiddenCalendars: new Set<string>(), calendars: [cal("g:work", "g", "Work"), cal("g:primary", "g", "Calendar", true)] };
    expect(defaultCalendarFor(s, "g")).toBe("g:work");
  });
  it("ignores a remembered calendar that's hidden or gone", () => {
    useSettings.setState({ defaultCalendars: { g: "g:work" } });
    const s = { accounts, hiddenCalendars: new Set(["g:work"]), calendars: [cal("g:work", "g", "Work"), cal("g:primary", "g", "Calendar", true)] };
    expect(defaultCalendarFor(s, "g")).toBe("g:primary");
  });
  it("still finds one without a primary flag (named after the address, then first visible)", () => {
    const s = { accounts, hiddenCalendars: new Set<string>(), calendars: [cal("g:a", "g", "Family"), cal("g:me", "g", "me@gmail.com")] };
    expect(defaultCalendarFor(s, "g")).toBe("g:me");
  });
});

describe("calendar mappers", () => {
  it("carry the provider's main-calendar flag", () => {
    expect(googleCal("g", { id: "primary", summary: "Calendar", primary: true }).primary).toBe(true);
    expect(googleCal("g", { id: "x", summary: "Work" }).primary).toBeUndefined();
    expect(outlookCal("m", { id: "c1", name: "Calendar", isDefaultCalendar: true }).primary).toBe(true);
  });
});
