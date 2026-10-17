// Shared local-date helpers: formats, strict parsing and DST edges.
import { describe, expect, it } from "vitest";
import { localDate, localIso, localMinute, pad2, parseLocal } from "@/lib/dates/local";

describe("local date helpers", () => {
  const d = new Date(2026, 0, 5, 7, 4, 9);

  it("pads to two digits", () => {
    expect(pad2(3)).toBe("03");
    expect(pad2(12)).toBe("12");
  });

  it("formats date, minute and second precision in local time", () => {
    expect(localDate(d)).toBe("2026-01-05");
    expect(localMinute(d)).toBe("2026-01-05T07:04");
    expect(localIso(d)).toBe("2026-01-05T07:04:09");
  });

  it("parses minute and second forms as local time", () => {
    expect(parseLocal("2026-10-14T14:30")).toBe(new Date(2026, 9, 14, 14, 30).getTime());
    expect(parseLocal("2026-10-14T14:30:15")).toBe(new Date(2026, 9, 14, 14, 30, 15).getTime());
  });

  it("round-trips its own output", () => {
    expect(parseLocal(localMinute(d))).toBe(new Date(2026, 0, 5, 7, 4).getTime());
    expect(parseLocal(localIso(d))).toBe(d.getTime());
  });

  it("rejects wrong shapes and rollovers", () => {
    expect(parseLocal("2026-02-30T10:00")).toBeUndefined();
    expect(parseLocal("2026-10-14T25:00")).toBeUndefined();
    expect(parseLocal("2026-10-14T10:61")).toBeUndefined();
    expect(parseLocal("2026-10-14T10:00:61")).toBeUndefined();
    expect(parseLocal("2026-10-14 10:00")).toBeUndefined();
    expect(parseLocal("2026-10-14")).toBeUndefined();
    expect(parseLocal("2026-10-14T10:00Z")).toBeUndefined();
    expect(parseLocal("")).toBeUndefined();
  });

  it("handles a spring-forward local time without drifting", () => {
    // 2026-03-08 02:30 doesn't exist in US zones (it rolls and is rejected); zones without DST keep it.
    const probe = new Date(2026, 2, 8, 2, 30);
    if (probe.getHours() === 2) expect(parseLocal("2026-03-08T02:30")).toBe(probe.getTime());
    else expect(parseLocal("2026-03-08T02:30")).toBeUndefined();
    // 03:30 exists everywhere and formats back to itself.
    const after = new Date(2026, 2, 8, 3, 30);
    expect(localMinute(after)).toBe("2026-03-08T03:30");
    expect(parseLocal("2026-03-08T03:30")).toBe(after.getTime());
  });
});
