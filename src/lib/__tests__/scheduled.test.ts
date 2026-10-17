// Scheduled send: the Send later presets, time labels, which are due, and valid times.
import { describe, expect, it } from "vitest";
import { OUTLOOK_SERVER_HOLD, RETRY_MS, dueNow, longWhen, sendLaterTimes, validSendAt, whenLabel, type ScheduledSend } from "@/lib/mail/scheduled";

// ICU puts a narrow no-break space before AM/PM; compare with plain spaces.
const plain = (s: string) => s.replace(/\s/g, " ");
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const times = (now: Date) => sendLaterTimes(now).map((t) => ({ label: t.label, hint: plain(t.hint), at: t.at.getTime() }));

describe("sendLaterTimes", () => {
  it("Tuesday 1:10 PM: later today at 4:30, tomorrow 8 and 1, and Monday", () => {
    // Oct 13, 2026 is a Tuesday.
    expect(times(at(13, 13, 10))).toEqual([
      { label: "Later today", hint: "4:30 PM", at: at(13, 16, 30).getTime() },
      { label: "Tomorrow morning", hint: "Wed 8:00 AM", at: at(14, 8).getTime() },
      { label: "Tomorrow afternoon", hint: "Wed 1:00 PM", at: at(14, 13).getTime() },
      { label: "Monday morning", hint: "Mon 8:00 AM", at: at(19, 8).getTime() },
    ]);
  });

  it("rounds up to the next half hour, and keeps an exact one", () => {
    expect(times(at(13, 9, 31))[0]).toMatchObject({ label: "Later today", at: at(13, 13).getTime() });
    expect(times(at(13, 9, 30))[0]).toMatchObject({ label: "Later today", at: at(13, 12, 30).getTime() });
  });

  it("Sunday: no Monday entry (it's tomorrow morning)", () => {
    const labels = times(at(18, 10)).map((t) => t.label);
    expect(labels).toEqual(["Later today", "Tomorrow morning", "Tomorrow afternoon"]);
  });

  it("Monday: next Monday, a week out, with a date hint", () => {
    const monday = times(at(19, 10)).find((t) => t.label === "Monday morning");
    expect(monday).toEqual({ label: "Monday morning", hint: "Oct 26, 8:00 AM", at: at(26, 8).getTime() });
  });

  it("7 PM: no Later today (10 PM is past 9)", () => {
    expect(times(at(13, 19)).map((t) => t.label)).not.toContain("Later today");
    // 6 PM + 3 h is exactly 9 PM: still too late.
    expect(times(at(13, 18)).map((t) => t.label)).not.toContain("Later today");
    expect(times(at(13, 17, 20)).map((t) => t.label)).toContain("Later today");
  });
});

describe("whenLabel and longWhen", () => {
  const now = at(13, 13, 10).getTime();
  it("names today, tomorrow, this week, then the date", () => {
    expect(plain(whenLabel(at(13, 16, 30).getTime(), now))).toBe("Today 4:30 PM");
    expect(plain(whenLabel(at(14, 8).getTime(), now))).toBe("Tomorrow 8:00 AM");
    expect(plain(whenLabel(at(16, 8).getTime(), now))).toBe("Fri 8:00 AM");
    expect(plain(whenLabel(at(19, 8).getTime(), now))).toBe("Mon 8:00 AM");
    expect(plain(whenLabel(at(20, 8).getTime(), now))).toBe("Oct 20, 8:00 AM");
  });
  it("long form for the composer strip", () => {
    expect(plain(longWhen(at(14, 8).getTime()))).toBe("Wed, Oct 14 at 8:00 AM");
  });
});

describe("dueNow", () => {
  const rec = (id: string, sendAt: number, over: Partial<ScheduledSend> = {}): ScheduledSend => ({
    id, accountId: "g", draftId: id, messageId: id, sendAt, subject: id, to: [], snippet: "", server: false, createdAt: 0, ...over,
  });
  const now = 1_000_000_000;

  it("returns due local sends, oldest first", () => {
    const list = [rec("b", now - 10), rec("future", now + 10), rec("a", now - 20), rec("exact", now)];
    expect(dueNow(list, now).map((r) => r.id)).toEqual(["a", "b", "exact"]);
  });

  it("skips server-held sends", () => {
    expect(dueNow([rec("s", now - 10, { server: true })], now)).toEqual([]);
  });

  it("waits RETRY_MS after a failed try", () => {
    const failed = rec("f", now - 60_000, { lastTry: now - RETRY_MS + 1, error: "offline" });
    expect(dueNow([failed], now)).toEqual([]);
    expect(dueNow([{ ...failed, lastTry: now - RETRY_MS }], now).map((r) => r.id)).toEqual(["f"]);
  });
});

describe("validSendAt", () => {
  const now = 1_000_000_000;
  it("needs more than a minute out and under a year", () => {
    expect(validSendAt(now + 60_000, now)).toBe(false);
    expect(validSendAt(now + 60_001, now)).toBe(true);
    expect(validSendAt(now - 1, now)).toBe(false);
    expect(validSendAt(now + 366 * 24 * 3600 * 1000 - 1, now)).toBe(true);
    expect(validSendAt(now + 366 * 24 * 3600 * 1000, now)).toBe(false);
  });
});

it("keeps Outlook's server hold off until cancel is verified", () => {
  expect(OUTLOOK_SERVER_HOLD).toBe(false);
});
