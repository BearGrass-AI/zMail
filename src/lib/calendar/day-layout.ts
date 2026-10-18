// Where one day's timed events go in the week and day views.

import type { CalEvent } from "@/lib/types";

const HOUR_MS = 36e5;
/** Events this long or longer draw as a band behind the day instead of taking a lane. */
export const BAND_HOURS = 5;
/** Shorter events still draw this tall, so they're laid out as if they were this long. */
const MIN_MINUTES = 25;

/** An event's hours from the day's midnight, clipped to the day. */
export interface Span {
  e: CalEvent;
  start: number;
  end: number;
}

export interface Placed extends Span {
  /** The lane it starts in, how many lanes it stretches across, and how many its group has. */
  lane: number;
  span: number;
  lanes: number;
}

export interface DayLayout {
  bands: Span[];
  placed: Placed[];
}

/**
 * Lanes are counted per group of events that overlap each other, so one busy hour narrows only
 * the events in it, and an event stretches right into lanes nothing beside it uses. Events of
 * BAND_HOURS or more become bands, so the meetings inside a conference day keep their width.
 */
export function layoutDay(events: readonly CalEvent[], day: Date): DayLayout {
  const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const spans: Span[] = [];
  for (const e of events) {
    const s = Date.parse(e.start);
    if (!Number.isFinite(s)) continue;
    const parsed = Date.parse(e.end);
    const start = Math.max(0, (s - midnight) / HOUR_MS);
    const end = Math.min(24, ((Number.isFinite(parsed) ? parsed : s) - midnight) / HOUR_MS);
    if (start >= 24) continue;
    spans.push({ e, start, end: Math.max(start, end) });
  }

  const bands = spans.filter((x) => x.end - x.start >= BAND_HOURS);
  const rest = spans
    .filter((x) => x.end - x.start < BAND_HOURS)
    .map((x) => ({ x, until: Math.max(x.end, x.start + MIN_MINUTES / 60) }))
    .sort((a, b) => a.x.start - b.x.start || b.until - a.until);

  const placed: Placed[] = [];
  let group: { x: Span; until: number; lane: number }[] = [];
  let lanes: number[] = [];
  const flush = () => {
    for (const p of group) {
      let span = 1;
      while (p.lane + span < lanes.length && !group.some((q) => q.lane === p.lane + span && q.x.start < p.until && q.until > p.x.start)) span++;
      placed.push({ ...p.x, lane: p.lane, span, lanes: lanes.length });
    }
    group = [];
    lanes = [];
  };
  let groupEnd = -Infinity;
  for (const r of rest) {
    if (r.x.start >= groupEnd) flush();
    let lane = lanes.findIndex((until) => until <= r.x.start);
    if (lane === -1) lane = lanes.length;
    lanes[lane] = r.until;
    group.push({ ...r, lane });
    groupEnd = Math.max(groupEnd, r.until);
  }
  flush();
  return { bands, placed };
}
