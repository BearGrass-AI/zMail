// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readerDate, recipientNames } from "@/components/meta";

const now = new Date(2026, 9, 11, 1, 0); // Oct 11 2026, 1:00 AM local
const at = (y: number, m: number, d: number, h = 15, min = 9) => new Date(y, m, d, h, min).toISOString();

describe("readerDate", () => {
  it("says Today for the same calendar day", () => expect(readerDate(at(2026, 9, 11, 0, 30), now)).toMatch(/^Today /));
  it("says Yesterday across midnight even when under 24h ago", () => {
    expect(readerDate(at(2026, 9, 10, 23, 0), now)).toMatch(/^Yesterday /);
  });
  it("uses the weekday within the last week", () => {
    const out = readerDate(at(2026, 9, 8), now);
    expect(out).toMatch(/^\w{3} /);
    expect(out).not.toMatch(/Today|Yesterday|2026/);
  });
  it("omits the year earlier this year", () => {
    const out = readerDate(at(2026, 7, 14), now);
    expect(out).not.toContain("2026");
    expect(out).toContain(",");
  });
  it("includes the year for earlier years", () => expect(readerDate(at(2025, 9, 3), now)).toContain("2025"));
});

describe("recipientNames", () => {
  const list = [
    { name: "Me Myself", address: "Alex@Example.org" },
    { name: "", address: "a@b.com" },
    { name: "Anne Grant", address: "anne@x.org" },
  ];
  it("maps own address to me, case-insensitively", () => {
    expect(recipientNames(list, ["alex@example.org"])[0]).toEqual({ label: "me", address: "Alex@Example.org" });
  });
  it("falls back to the address for empty names", () => expect(recipientNames(list, [])[1].label).toBe("a@b.com"));
  it("keeps names otherwise", () => expect(recipientNames(list, [])[2].label).toBe("Anne Grant"));
});
