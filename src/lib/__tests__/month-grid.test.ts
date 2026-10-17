// The month view's grid: whole Monday-first weeks covering the month.
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
import { monthGrid } from "@/lib/calendar/month-grid";

afterEach(() => vi.useRealTimers());
const key = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

describe("monthGrid", () => {
  it("covers November 2026 from Monday Oct 26 to Sunday Dec 6", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 13, 12));
    const g = monthGrid(1);
    expect(key(g.first)).toBe("2026-11-1");
    expect(g.weeks).toBe(6);
    expect(key(g.days[0])).toBe("2026-10-26");
    expect(key(g.days.at(-1)!)).toBe("2026-12-6");
    expect(g.days.every((d, i) => d.getDay() === (i + 1) % 7)).toBe(true);
  });

  it("uses five weeks when the month fits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 13, 12));
    // March 2027 starts on a Monday and ends on a Wednesday.
    const g = monthGrid(5);
    expect(key(g.first)).toBe("2027-3-1");
    expect(g.weeks).toBe(5);
    expect(key(g.days[0])).toBe("2027-3-1");
  });
});
