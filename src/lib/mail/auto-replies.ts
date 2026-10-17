// Automatic replies (out of office): one shape for Outlook and Gmail, and the mapping to each API.

import { HttpError } from "@/lib/transport";
import { textToHtml } from "@/lib/signature";
import { localMinute, parseLocal } from "@/lib/dates/local";

export type AutoReplyAudience = "all" | "contactsOnly" | "none";

export interface AutoReply {
  enabled: boolean;
  /** Epoch ms. Both or neither: replies only between them. */
  start?: number;
  end?: number;
  /** HTML. Gmail: the reply. Outlook: the reply inside the organization (and outside too unless externalMessage). */
  message: string;
  /** Outlook only: a different reply for people outside the organization. */
  externalMessage?: string;
  /** Who outside the organization (Outlook) / outside your contacts (Gmail) gets a reply. */
  audience: AutoReplyAudience;
  /** Gmail only: the subject line set in Gmail, kept so a save here doesn't clear it. */
  subject?: string;
}

/** The account's token lacks the permission; the user must sign in again once. */
export class NeedsPermissionError extends Error {
  constructor() {
    super("zMail needs permission to manage automatic replies. Sign in to this account again.");
    this.name = "NeedsPermissionError";
  }
}

type GraphDateTime = { dateTime: string; timeZone: string };

export interface GraphAutoReplySetting {
  status?: "disabled" | "alwaysEnabled" | "scheduled";
  externalAudience?: AutoReplyAudience;
  internalReplyMessage?: string;
  externalReplyMessage?: string;
  scheduledStartDateTime?: GraphDateTime;
  scheduledEndDateTime?: GraphDateTime;
}

export interface GmailVacation {
  enableAutoReply?: boolean;
  responseSubject?: string;
  responseBodyHtml?: string;
  responseBodyPlainText?: string;
  restrictToContacts?: boolean;
  restrictToDomain?: boolean;
  /** Epoch ms as a string. */
  startTime?: string;
  endTime?: string;
}

const graphTime = (ms: number): GraphDateTime => ({ dateTime: new Date(ms).toISOString().slice(0, 19), timeZone: "UTC" });

export function toGraphSetting(r: AutoReply): GraphAutoReplySetting {
  const scheduled = r.enabled && !!r.start && !!r.end;
  return {
    status: !r.enabled ? "disabled" : scheduled ? "scheduled" : "alwaysEnabled",
    externalAudience: r.audience,
    internalReplyMessage: r.message,
    externalReplyMessage: r.externalMessage ?? r.message,
    ...(scheduled ? { scheduledStartDateTime: graphTime(r.start!), scheduledEndDateTime: graphTime(r.end!) } : {}),
  };
}

function parseGraphTime(t: GraphDateTime | undefined): number | undefined {
  if (!t?.dateTime) return undefined;
  // Windows zone names aren't converted: a non-UTC time is assumed to be in this Mac's zone.
  const ms = t.timeZone === "UTC" ? Date.parse(t.dateTime.replace(/Z?$/, "Z")) : new Date(t.dateTime).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

export function fromGraphSetting(s: GraphAutoReplySetting): AutoReply {
  const status = s.status ?? "disabled";
  const message = s.internalReplyMessage ?? "";
  const external = s.externalReplyMessage;
  const r: AutoReply = {
    enabled: status !== "disabled",
    message,
    audience: s.externalAudience ?? "all",
  };
  if (status === "scheduled") {
    const start = parseGraphTime(s.scheduledStartDateTime);
    const end = parseGraphTime(s.scheduledEndDateTime);
    if (start !== undefined) r.start = start;
    if (end !== undefined) r.end = end;
  }
  if (external !== undefined && external.trim() !== message.trim()) r.externalMessage = external;
  return r;
}

export function toGmailVacation(r: AutoReply): GmailVacation {
  return {
    enableAutoReply: r.enabled,
    ...(r.subject !== undefined ? { responseSubject: r.subject } : {}),
    responseBodyHtml: r.message,
    restrictToContacts: r.audience === "contactsOnly",
    restrictToDomain: r.audience === "none",
    ...(r.start ? { startTime: String(r.start) } : {}),
    ...(r.end ? { endTime: String(r.end) } : {}),
  };
}

/** The audience choices for a Gmail account. "Only my organization" appears only when already set, since we can't tell Workspace from consumer Gmail. */
export function gmailAudienceOptions(loaded: AutoReplyAudience): { value: AutoReplyAudience; label: string }[] {
  return [
    { value: "all", label: "Everyone" },
    { value: "contactsOnly", label: "Only my contacts" },
    ...(loaded === "none" ? [{ value: "none" as const, label: "Only people in my organization" }] : []),
  ];
}

export function fromGmailVacation(v: GmailVacation): AutoReply {
  const r: AutoReply = {
    enabled: !!v.enableAutoReply,
    message: v.responseBodyHtml ?? (v.responseBodyPlainText ? textToHtml(v.responseBodyPlainText) : ""),
    audience: v.restrictToDomain ? "none" : v.restrictToContacts ? "contactsOnly" : "all",
  };
  if (v.responseSubject !== undefined) r.subject = v.responseSubject;
  const start = v.startTime ? Number(v.startTime) : NaN;
  const end = v.endTime ? Number(v.endTime) : NaN;
  if (start > 0) r.start = start;
  if (end > 0) r.end = end;
  return r;
}

/** A 403 because the token was granted before the settings scope was added. */
export function isPermissionError(e: unknown): boolean {
  return e instanceof HttpError && e.status === 403 && /ErrorAccessDenied|Access is denied|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient/i.test(e.body);
}

export function activeNow(r: AutoReply, now = Date.now()): boolean {
  return r.enabled && (!r.start || r.start <= now) && (!r.end || r.end > now);
}

export function upcoming(r: AutoReply, now = Date.now()): boolean {
  return r.enabled && !!r.start && r.start > now;
}

const DAY = 86_400_000;

/** A weekday within the next 6 days, else a short date. */
function when(ms: number, now: number): string {
  return ms - now < 6 * DAY ? new Date(ms).toLocaleDateString([], { weekday: "short" }) : new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The sidebar reminder, or null when nothing is on or coming. */
export function stripText(r: AutoReply, now = Date.now()): string | null {
  if (activeNow(r, now)) return r.end ? `Auto-replies on until ${when(r.end, now)}` : "Auto-replies on";
  if (upcoming(r, now)) return `Auto-replies start ${when(r.start!, now)}`;
  return null;
}

/** Epoch ms as local "YYYY-MM-DDTHH:mm" (a datetime-local input's value). */
export function toLocalInput(ms: number): string {
  return localMinute(new Date(ms));
}

/** Local "YYYY-MM-DDTHH:mm" to epoch ms; undefined when it isn't exactly that shape or isn't a real time. */
export function fromLocalInput(s: string): number | undefined {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? parseLocal(s) : undefined;
}
