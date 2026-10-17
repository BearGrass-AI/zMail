import { startOfWeek } from "@/lib/calendar/mock-calendar";

/** The month containing today + `offset` months, as whole Monday-first weeks. */
export function monthGrid(offset: number) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const start = startOfWeek(first);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const weeks = Math.ceil((Math.round((last.getTime() - start.getTime()) / 864e5) + 1) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  return { first, weeks, days };
}
