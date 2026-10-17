// Local-time date helpers shared by the assistant, mail and calendar code.

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" in local time. */
export const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** "YYYY-MM-DDTHH:mm" in local time (a datetime-local input's value). */
export const localMinute = (d: Date) => `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** "YYYY-MM-DDTHH:mm:ss" in local time. */
export const localIso = (d: Date) => `${localMinute(d)}:${pad2(d.getSeconds())}`;

/** Local "YYYY-MM-DDTHH:mm" (":ss" optional) to epoch ms; undefined when it isn't that shape or isn't a real time. */
export function parseLocal(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const sec = m[6] ? Number(m[6]) : 0;
  const date = new Date(y, mo - 1, d, h, mi, sec);
  // Reject rollovers like Feb 30 or 25:00.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== sec) return undefined;
  return date.getTime();
}
