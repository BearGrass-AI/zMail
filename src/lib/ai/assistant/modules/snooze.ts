// Snooze: snoozing and unsnoozing mail from the assistant.
import type { Email } from "@/lib/types";
import { useMail } from "@/lib/store";
import { DIRECT_LIMIT } from "@/lib/mail/bulk";
import { useAssistant } from "../state";
import type { ToolModule } from "./types";
import { extOf } from "./types";
import { pushConfirmCard } from "./confirm";
import { refsFrom } from "./ids";
import { takeDirect } from "./budget";
import { heldForConfirm } from "@/lib/ropeline-security";
import { parseLocal } from "@/lib/dates/local";

export interface SnoozeDeps {
  emails(): Email[];
  snoozed(): Record<string, number>;
  snooze(ids: string[], until: number): void;
  unsnooze(ids: string[]): void;
  /** Put snooze times back as they were: a time snoozes again, undefined removes the snooze. */
  restore(prev: Record<string, number | undefined>): void;
}

const LIST_MAX = 30;
const DAY_MS = 24 * 3600 * 1000;
const YEAR_MS = 366 * DAY_MS;
/** Longer snoozes always ask first: they hide mail for a long time. */
const DIRECT_MAX_MS = 7 * DAY_MS;
/** Emails named on a card; the rest are counted. */
const CARD_LINES = 20;

/** Local "YYYY-MM-DDTHH:MM" from the model; null when malformed or not a real date. */
function parseLocalArg(s: unknown): number | null {
  return typeof s === "string" ? (parseLocal(s.trim()) ?? null) : null;
}

function whenText(t: number): string {
  return new Date(t).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The emails named by ids and/or a set_id. */
function resolve(a: Record<string, unknown>, d: SnoozeDeps): Email[] {
  const want = new Set(refsFrom(a).map((r) => r.id));
  return d.emails().filter((e) => want.has(e.id));
}

/** Each id's snooze time right now (undefined = not snoozed), so Undo can put it back. */
function before(ids: string[], d: SnoozeDeps): Record<string, number | undefined> {
  const snoozed = d.snoozed();
  return Object.fromEntries(ids.map((id) => [id, Object.hasOwn(snoozed, id) ? snoozed[id] : undefined]));
}

const plural = (n: number) => `${n} email${n === 1 ? "" : "s"}`;

/** One line per email ("Sender · Subject"), for a card to show which mail it changes. */
function emailLines(emails: Email[]): string {
  const lines = emails.slice(0, CARD_LINES).map((e) => `${e.from.name || e.from.address} · ${e.subject}`);
  if (emails.length > CARD_LINES) lines.push(`and ${(emails.length - CARD_LINES).toLocaleString()} more`);
  return lines.join("\n");
}

/** The subjects of a few emails, for a step line. */
const subjects = (emails: Email[]) => emails.map((e) => `“${e.subject}”`).join(", ");
const AWAIT = "A card is waiting for the user's OK. Nothing has happened yet.";

export const snoozeModule: ToolModule = {
  id: "snooze",
  prompt: [
    '- For "snooze until …", turn the user\'s words into a local date-time (default 8:00 AM when only a day is given) and call snooze. Say a snooze happened only after the tool result says so.',
  ],
  tools: [
    {
      name: "snooze",
      description: `Hide emails from the inbox until a time, then they return. Give ids or a set_id. Snoozes of up to 7 days happen right away (with Undo) while they total ${DIRECT_LIMIT} emails or fewer in this user message; longer snoozes, and anything past that, the user confirms on a card.`,
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          set_id: { type: "string" },
          until: { type: "string", description: "Local date-time YYYY-MM-DDTHH:MM, in the future and within a year" },
        },
        required: ["until"],
      },
    },
    {
      name: "unsnooze",
      description: `Bring snoozed emails back to the inbox now. Give ids or a set_id. Past ${DIRECT_LIMIT} emails in this user message, the user confirms on a card.`,
      parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, set_id: { type: "string" } } },
    },
    {
      name: "list_snoozed",
      description: `List currently snoozed emails (up to ${LIST_MAX}) with when each returns.`,
      parameters: { type: "object", properties: {} },
    },
  ],
  handlers: {
    snooze: async (a, deps) => {
      const d = extOf<SnoozeDeps>(deps, "snooze");
      const until = parseLocalArg(a.until);
      if (until === null) throw new Error("bad_query: until must be a local date-time like 2026-10-14T08:00");
      const now = Date.now();
      if (until <= now) return { error: "That time is in the past. Pick a future time." };
      if (until - now > YEAR_MS) return { error: "Snooze can't go more than a year out." };
      const emails = resolve(a, d);
      if (!emails.length) return { error: "None of those emails were found." };
      const ids = emails.map((e) => e.id);
      const when = whenText(until);
      if (until - now <= DIRECT_MAX_MS && !emails.some((e) => heldForConfirm(e)) && takeDirect(ids.length)) {
        // Undo puts back an earlier snooze time instead of dropping it.
        const prev = before(ids, d);
        d.snooze(ids, until);
        useAssistant.getState().push({ kind: "step", text: `Snoozed ${subjects(emails)} until ${when}` });
        deps.toast(`Snoozed ${ids.length} until ${when}`, () => d.restore(prev));
        return { status: "snoozed", count: ids.length, until: a.until };
      }
      pushConfirmCard({
        module: "snooze",
        action: "snooze",
        title: `Snooze ${plural(ids.length)}`,
        detail: `Until ${when}`,
        preview: { fields: [{ label: "Emails", value: String(ids.length) }, { label: "Until", value: when }], body: emailLines(emails) },
        payload: { ids, until },
        confirmLabel: `Snooze ${ids.length}`,
      });
      return { status: "awaiting_confirmation", count: ids.length, note: AWAIT };
    },
    unsnooze: async (a, deps) => {
      const d = extOf<SnoozeDeps>(deps, "snooze");
      const emails = resolve(a, d);
      const snoozed = d.snoozed();
      const back = emails.filter((e) => e.id in snoozed);
      const ids = back.map((e) => e.id);
      if (!ids.length) return { status: "none_snoozed", count: 0 };
      if (back.some((e) => heldForConfirm(e)) || !takeDirect(ids.length)) {
        pushConfirmCard({
          module: "snooze",
          action: "unsnooze",
          title: `Unsnooze ${plural(ids.length)}`,
          detail: "They come back to the inbox now.",
          preview: { body: emailLines(back) },
          payload: { ids },
          confirmLabel: `Unsnooze ${ids.length}`,
        });
        return { status: "awaiting_confirmation", count: ids.length, note: AWAIT };
      }
      const prev = before(ids, d);
      d.unsnooze(ids);
      useAssistant.getState().push({ kind: "step", text: `Unsnoozed ${plural(ids.length)}` });
      deps.toast(`Unsnoozed ${ids.length}`, () => d.restore(prev));
      return { status: "unsnoozed", count: ids.length };
    },
    list_snoozed: async (_a, deps) => {
      const d = extOf<SnoozeDeps>(deps, "snooze");
      const st = useAssistant.getState();
      const snoozed = d.snoozed();
      const now = Date.now();
      const rows = d
        .emails()
        .filter((e) => (snoozed[e.id] ?? 0) > now)
        .sort((x, y) => snoozed[x.id] - snoozed[y.id]);
      const shown = rows.slice(0, LIST_MAX);
      st.remember(shown.map((e) => ({ id: e.id, accountId: e.accountId })));
      st.push({ kind: "step", text: "Listed snoozed mail" });
      return {
        total: rows.length,
        emails: shown.map((e) => ({ id: e.id, ref: st.refFor(e), from: e.from.name || e.from.address, subject: e.subject, until: whenText(snoozed[e.id]) })),
      };
    },
  },
  confirm: {
    snooze: async (payload, deps) => {
      const d = extOf<SnoozeDeps>(deps, "snooze");
      const p = payload as { ids: string[]; until: number };
      if (p.until <= Date.now()) throw new Error("That time has passed.");
      d.snooze(p.ids, p.until);
      return `Snoozed ${p.ids.length} until ${whenText(p.until)}`;
    },
    unsnooze: async (payload, deps) => {
      const d = extOf<SnoozeDeps>(deps, "snooze");
      const snoozed = d.snoozed();
      const ids = (payload as { ids: string[] }).ids.filter((id) => Object.hasOwn(snoozed, id));
      d.unsnooze(ids);
      return `Unsnoozed ${plural(ids.length)}`;
    },
  },
  realDeps: (): SnoozeDeps => ({
    emails: () => useMail.getState().emails,
    snoozed: () => useMail.getState().snoozed,
    snooze: (ids, until) => useMail.getState().snooze(ids, until),
    unsnooze: (ids) => useMail.getState().unsnooze(ids),
    restore: (prev) =>
      useMail.setState((s) => {
        const snoozed = { ...s.snoozed };
        for (const [id, t] of Object.entries(prev)) {
          if (t === undefined) delete snoozed[id];
          else snoozed[id] = t;
        }
        return { snoozed };
      }),
  }),
};
