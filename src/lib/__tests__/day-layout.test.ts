// The week grid: one busy hour narrows only the events in it, long blocks become bands, and the header names the week.
import { describe, expect, it } from "vitest";
import { layoutDay } from "@/lib/calendar/day-layout";
import { isoWeek, weekLabel } from "@/lib/calendar/week-label";
import type { CalEvent } from "@/lib/types";

const day = new Date(2026, 9, 13);
const at = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(2026, 9, 13, h, m).toISOString();
};
const ev = (id: string, start: string, end: string): CalEvent => ({ id, calendarId: "c", title: id, start: at(start), end: at(end), attendees: [] });
const byId = (l: ReturnType<typeof layoutDay>) => Object.fromEntries(l.placed.map((p) => [p.e.id, p]));

describe("layoutDay", () => {
  it("keeps an event full width when nothing overlaps it, even if another hour is busy", () => {
    const l = byId(layoutDay([ev("nine", "9:00", "10:00"), ev("a", "11:00", "12:00"), ev("b", "11:00", "12:00"), ev("c", "11:00", "12:00")], day));
    expect(l.nine).toMatchObject({ lane: 0, span: 1, lanes: 1 });
    expect(l.b).toMatchObject({ lane: 1, span: 1, lanes: 3 });
  });

  it("stretches an event into lanes nothing beside it uses", () => {
    // 12:00 and 12:45 both overlap Lunch, but not each other's lanes after 13:00.
    const l = byId(layoutDay([ev("lunch", "12:00", "13:00"), ev("sync", "12:00", "13:00"), ev("trail", "12:45", "13:45"), ev("late", "13:00", "13:30")], day));
    expect(l.lunch.lanes).toBe(3);
    expect(l.late).toMatchObject({ lane: 0, span: 2 });
  });

  it("draws blocks of five hours or more as bands that take no lane", () => {
    const l = layoutDay([ev("conference", "8:00", "17:00"), ev("session", "10:00", "11:00")], day);
    expect(l.bands.map((b) => b.e.id)).toEqual(["conference"]);
    expect(byId(l).session).toMatchObject({ lane: 0, span: 1, lanes: 1 });
  });

  it("gives back-to-back events their own full width", () => {
    const l = byId(layoutDay([ev("a", "9:00", "10:00"), ev("b", "10:00", "11:00")], day));
    expect(l.a.lanes).toBe(1);
    expect(l.b.lanes).toBe(1);
  });

  it("lays a very short event out as tall as it draws, so the next one sits beside it", () => {
    const l = byId(layoutDay([ev("blip", "9:00", "9:05"), ev("next", "9:10", "9:40")], day));
    expect(l.next.lane).toBe(1);
  });

  it("clips an event that runs past midnight to the day", () => {
    const late = { ...ev("late", "22:00", "23:00"), end: new Date(2026, 9, 14, 2, 0).toISOString() };
    const [p] = layoutDay([late], day).placed;
    expect(p.start).toBe(22);
    expect(p.end).toBe(24);
  });

  it("skips an event whose start can't be read", () => {
    expect(layoutDay([{ ...ev("bad", "9:00", "10:00"), start: "not a date" }], day).placed).toEqual([]);
  });
});

describe("weekLabel", () => {
  const week = (y: number, m: number, d: number, n: number) => Array.from({ length: n }, (_, i) => new Date(y, m, d + i));
  it("names the ISO week and the dates shown", () => {
    expect(weekLabel(week(2026, 9, 12, 7))).toMatch(/^Week 42 · Oct 12\s*–\s*18$/);
  });
  it("shows both months when the week crosses one", () => {
    expect(weekLabel(week(2026, 8, 28, 7))).toMatch(/^Week 40 · Sep 28\s*–\s*Oct 4$/);
  });
  it("counts the days before the year's first Thursday as last year's final week", () => {
    expect(isoWeek(new Date(2027, 0, 1))).toBe(53);
  });
});
