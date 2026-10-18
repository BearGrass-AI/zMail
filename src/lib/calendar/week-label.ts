/** ISO 8601 week number: weeks start on Monday, and week 1 holds the year's first Thursday. */
export function isoWeek(day: Date): number {
  const d = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

/** "Week 42 · Oct 12 – 18" for the days the week view shows. */
export function weekLabel(days: readonly Date[]): string {
  const first = days[0];
  const last = days[days.length - 1] ?? first;
  const range = new Intl.DateTimeFormat([], { month: "short", day: "numeric" }).formatRange(first, last);
  return `Week ${isoWeek(first)} · ${range}`;
}
