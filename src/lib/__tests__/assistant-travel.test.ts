// @vitest-environment jsdom
// Travel module: travel_time with saved places, the two-pass arrive_by, malformed times, and formatDrive.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import { useAssistant } from "@/lib/ai/assistant/state";
import { formatDrive, type TravelDeps } from "@/lib/ai/assistant/modules/travel";
import type { TravelEta } from "@/lib/maps";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const HOME = "123 Main St, Denver CO";
const WORK = "32 Campus Dr, Denver CO";
const result = (seconds: number, meters = 160934): TravelEta => ({
  from: { name: "123 Main St", address: null },
  to: { name: "The Lakeside Inn", address: "650 E 3rd St, Lake Placid, NY" },
  seconds,
  meters,
});

function make(places = { home: HOME, work: WORK }, ...secs: number[]) {
  const eta = vi.fn(async (_from: string, _to: string, _departMs?: number) => result(secs.shift() ?? 9060));
  const fake = { eta, places: () => places, now: () => new Date("2026-10-14T08:00") } satisfies TravelDeps;
  return { fake, deps: { ext: { travel: fake } } as unknown as ToolDeps };
}
const run = (args: Record<string, unknown>, deps: ToolDeps) => executeTool({ id: "c1", name: "travel_time", args }, deps);
type Out = { content: { from: string; to: string; drive: string; minutes: number; miles: number; depart: string; arrive: string; leave_by?: string; source: string; error?: string } };

beforeEach(() => useAssistant.getState().newChat());

describe("travel_time", () => {
  it("starts from home by default", async () => {
    const { fake, deps } = make();
    const r = (await run({ to: "The Lakeside, Lake Placid" }, deps)) as Out;
    expect(fake.eta).toHaveBeenCalledWith(HOME, "The Lakeside, Lake Placid", Date.parse("2026-10-14T08:00"));
    expect(r.content.drive).toBe("2 h 31 min");
    expect(r.content.minutes).toBe(151);
    expect(r.content.miles).toBe(100);
    expect(r.content.from).toBe(`Home: ${HOME}`);
    expect(r.content.to).toBe("The Lakeside Inn · 650 E 3rd St, Lake Placid, NY");
    expect(r.content.depart).toBe("2026-10-14T08:00");
    expect(r.content.arrive).toBe("2026-10-14T10:31");
    expect(r.content.leave_by).toBeUndefined();
    expect(r.content.source).toBe("Apple Maps estimate with expected traffic");
  });

  it("asks for a home address when none is saved", async () => {
    const { fake, deps } = make({ home: " ", work: WORK });
    const r = (await run({ to: "Lake Placid" }, deps)) as Out;
    expect(r.content).toEqual({ error: "No home address saved. Ask the user where they're starting from, or suggest saving it in Settings → AI Assistant → Places." });
    expect(fake.eta).not.toHaveBeenCalled();
  });

  it("uses the work address", async () => {
    const { fake, deps } = make();
    await run({ to: "Lake Placid", from: " Work " }, deps);
    expect(fake.eta).toHaveBeenCalledWith(WORK, "Lake Placid", expect.any(Number));
  });

  it("works back from arrive_by in two passes", async () => {
    const { fake, deps } = make(undefined, 7200, 7800);
    const r = (await run({ to: "Lake Placid", arrive_by: "2026-10-14T10:00" }, deps)) as Out;
    expect(fake.eta).toHaveBeenCalledTimes(2);
    expect(fake.eta.mock.calls[0][2]).toBe(Date.parse("2026-10-14T10:00"));
    expect(fake.eta.mock.calls[1][2]).toBe(Date.parse("2026-10-14T08:00"));
    expect(r.content.leave_by).toBe("2026-10-14T07:50");
    expect(r.content.depart).toBe("2026-10-14T07:50");
    expect(r.content.arrive).toBe("2026-10-14T10:00");
    expect(r.content.drive).toBe("2 h 10 min");
  });

  it("rejects arrive_by together with depart_at", async () => {
    const { fake, deps } = make();
    const r = await run({ to: "Lake Placid", arrive_by: "2026-10-14T10:00", depart_at: "2026-10-14T07:00" }, deps);
    expect(r.malformed).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/not both/);
    expect(fake.eta).not.toHaveBeenCalled();
  });

  it("rejects a garbage time", async () => {
    const { deps } = make();
    const r = await run({ to: "Lake Placid", depart_at: "after lunch" }, deps);
    expect(r.malformed).toBe(true);
  });

  it("shows a step line", async () => {
    const { deps } = make();
    await run({ to: "Lake Placid" }, deps);
    const steps = useAssistant.getState().items.filter((i) => i.kind === "step");
    expect(steps.map((s) => (s.kind === "step" ? s.text : ""))).toContain("Checked drive time · Home → The Lakeside Inn · 2 h 31 min");
  });

  it("returns Apple Maps errors to the model", async () => {
    const { fake, deps } = make();
    fake.eta.mockRejectedValueOnce(new Error('Apple Maps couldn\'t find "Nowhere"'));
    const r = await run({ to: "Nowhere" }, deps);
    expect(r.malformed).toBeUndefined();
    expect(r.content).toEqual({ error: 'Apple Maps couldn\'t find "Nowhere"' });
  });
});

describe("formatDrive", () => {
  it("formats minutes and hours", () => {
    expect(formatDrive(45 * 60)).toBe("45 min");
    expect(formatDrive(2 * 3600)).toBe("2 h");
    expect(formatDrive(9060)).toBe("2 h 31 min");
  });
});
