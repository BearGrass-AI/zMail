// Automatic replies: read and set an account's out-of-office reply, always through a confirm card.
import { useMail } from "@/lib/store";
import { htmlToText, textToHtml } from "@/lib/signature";
import { NeedsPermissionError, fromLocalInput, toLocalInput, type AutoReply, type AutoReplyAudience } from "@/lib/mail/auto-replies";
import { useAssistant } from "../state";
import { pushConfirmCard } from "./confirm";
import { extOf, type ToolModule } from "./types";

export interface AutoReplyDeps {
  accounts(): { id: string; address: string; label: string; kind: string }[];
  get(accountId: string): Promise<AutoReply>; // loadAutoReply then read the store; throws NeedsPermissionError
  set(accountId: string, r: AutoReply): Promise<void>;
}

const ID = "autoreply";
const MAX_MESSAGE = 2000;
const MAX_TEXT_OUT = 1000;
const NEEDS_SIGN_IN = "This account needs to sign in again before zMail can change automatic replies (Settings → Accounts → Edit → Sign in again).";
const AUDIENCES: AutoReplyAudience[] = ["all", "contactsOnly", "none"];

type Change = "on" | "off" | "update";
interface Payload {
  accountId: string;
  reply: AutoReply;
  change: Change;
}

const cap = (s: string) => (s.length > MAX_TEXT_OUT ? `${s.slice(0, MAX_TEXT_OUT)}…` : s);

function account(d: AutoReplyDeps, id: unknown) {
  const a = typeof id === "string" ? d.accounts().find((x) => x.id === id) : undefined;
  if (!a) throw new Error(`unknown id "${String(id)}": use an account_id from get_auto_reply`);
  return a;
}

/** "Mon Oct 19, 8:00 AM". */
function moment(ms: number) {
  const d = new Date(ms);
  const weekday = d.toLocaleDateString([], { weekday: "short" });
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${weekday} ${date}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function outside(r: AutoReply) {
  if (r.audience === "none") return "No one";
  if (r.audience === "contactsOnly") return r.externalMessage !== undefined ? "Different reply, only contacts" : "Only contacts";
  return r.externalMessage !== undefined ? "Different reply" : "Same reply, everyone";
}

function parseTime(v: unknown, name: string): number {
  const ms = typeof v === "string" ? fromLocalInput(v.trim()) : undefined;
  if (ms === undefined) throw new Error(`bad_query: ${name} must be a local time like 2026-10-19T08:00`);
  return ms;
}

const domainOf = (address: string) => address.split("@")[1] ?? address;

export const autoreplyModule: ToolModule = {
  id: ID,
  prompt: [
    "- For out-of-office / vacation / automatic replies use get_auto_reply and set_auto_reply. Write the reply yourself from what the user said (dates, who to contact instead), short and friendly, signed with their first name. Default hours: start 8:00 AM, end 5:00 PM local.",
    "- Never say automatic replies are on or off unless a tool result or the card says so.",
  ],
  tools: [
    {
      name: "get_auto_reply",
      description: "Read the automatic replies (out of office) of one account, or of every account when account_id is left out.",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Account id; omit for every account" },
        },
      },
    },
    {
      name: "set_auto_reply",
      description:
        "Turn automatic replies (out of office) on or off, or change them, for one account. Shows a confirm card; nothing changes until the user confirms. Omit start and end for replies until turned off (pass the current dates again to keep them).",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Account id from get_auto_reply" },
          enabled: { type: "boolean", description: "true to send automatic replies, false to stop" },
          start: { type: "string", description: "Local start time, YYYY-MM-DDTHH:mm; give both start and end or neither" },
          end: { type: "string", description: "Local end time, YYYY-MM-DDTHH:mm" },
          message: { type: "string", description: "The reply in plain text (up to 2,000 characters); required when enabled is true" },
          external_message: { type: "string", description: "Outlook only: a different reply for people outside the organization" },
          audience: {
            type: "string",
            enum: AUDIENCES,
            description: "Who outside the organization (Outlook) or outside the contacts (Gmail) gets a reply: all, contactsOnly, or none (Outlook only)",
          },
        },
        required: ["account_id", "enabled"],
      },
    },
  ],
  handlers: {
    get_auto_reply: async (args, deps) => {
      const d = extOf<AutoReplyDeps>(deps, ID);
      const list = args.account_id === undefined || args.account_id === null ? d.accounts() : [account(d, args.account_id)];
      const accounts = await Promise.all(
        list.map(async (a) => {
          try {
            const r = await d.get(a.id);
            return {
              account_id: a.id,
              account: a.address,
              enabled: r.enabled,
              ...(r.start && r.end ? { start: toLocalInput(r.start), end: toLocalInput(r.end) } : {}),
              message_text: cap(htmlToText(r.message)),
              ...(r.externalMessage !== undefined ? { external_text: cap(htmlToText(r.externalMessage)) } : {}),
              audience: r.audience,
            };
          } catch (err) {
            if (err instanceof NeedsPermissionError) return { account_id: a.id, needs_sign_in: true };
            return { account_id: a.id, account: a.address, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      useAssistant.getState().push({ kind: "step", text: "Checked automatic replies" });
      return { accounts };
    },

    set_auto_reply: async (args, deps) => {
      const d = extOf<AutoReplyDeps>(deps, ID);
      const a = account(d, args.account_id);
      const outlook = a.kind === "m365";
      if (typeof args.enabled !== "boolean") throw new Error("bad_query: enabled must be true or false");
      const enabled = args.enabled;

      const hasStart = args.start !== undefined && args.start !== null && args.start !== "";
      const hasEnd = args.end !== undefined && args.end !== null && args.end !== "";
      if (hasStart !== hasEnd) throw new Error("bad_query: give both start and end, or neither");
      let start: number | undefined;
      let end: number | undefined;
      if (hasStart) {
        start = parseTime(args.start, "start");
        end = parseTime(args.end, "end");
        if (end <= start) throw new Error("bad_query: end must be after start");
        if (end <= Date.now()) throw new Error("bad_query: end must be in the future");
      }

      if (args.message !== undefined && typeof args.message !== "string") throw new Error("bad_query: message must be text");
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (enabled && !message) throw new Error("bad_query: set_auto_reply needs message when enabled is true");
      if (message.length > MAX_MESSAGE) throw new Error(`bad_query: message is longer than ${MAX_MESSAGE.toLocaleString("en-US")} characters`);

      if (args.external_message !== undefined && typeof args.external_message !== "string") throw new Error("bad_query: external_message must be text");
      const external = typeof args.external_message === "string" ? args.external_message.trim() : "";
      if (external && !outlook) throw new Error("bad_query: external_message is for Outlook accounts only");
      if (external.length > MAX_MESSAGE) throw new Error(`bad_query: external_message is longer than ${MAX_MESSAGE.toLocaleString("en-US")} characters`);
      const audience = args.audience;
      if (audience !== undefined && !AUDIENCES.includes(audience as AutoReplyAudience)) throw new Error("bad_query: audience must be all, contactsOnly or none");
      if (audience === "none" && !outlook) throw new Error('bad_query: audience "none" is for Outlook accounts only');

      let current: AutoReply;
      try {
        current = await d.get(a.id);
      } catch (err) {
        if (err instanceof NeedsPermissionError) return { error: NEEDS_SIGN_IN };
        throw err;
      }

      // A new message replaces both replies unless a separate outside one is given.
      const reply: AutoReply = {
        enabled,
        ...(start !== undefined && end !== undefined ? { start, end } : {}),
        message: message ? textToHtml(message) : current.message,
        audience: (audience as AutoReplyAudience | undefined) ?? current.audience,
        ...(current.subject !== undefined ? { subject: current.subject } : {}),
      };
      const externalMessage = external ? textToHtml(external) : message ? undefined : outlook ? current.externalMessage : undefined;
      if (externalMessage !== undefined) reply.externalMessage = externalMessage;

      const change: Change = enabled && !current.enabled ? "on" : !enabled && current.enabled ? "off" : "update";
      const bodyText = htmlToText(reply.message);
      pushConfirmCard({
        module: ID,
        action: "set",
        title: change === "on" ? "Turn on automatic replies" : change === "off" ? "Turn off automatic replies" : "Update automatic replies",
        detail: a.address,
        preview: {
          fields: [
            { label: "Account", value: a.address },
            ...(enabled
              ? [
                  { label: "When", value: reply.start && reply.end ? `${moment(reply.start)} – ${moment(reply.end)}` : "Until you turn them off" },
                  { label: "Outside", value: outside(reply) },
                ]
              : []),
          ],
          ...(enabled
            ? { body: reply.externalMessage !== undefined ? `${bodyText}\n\nOutside ${domainOf(a.address)}:\n${htmlToText(reply.externalMessage)}` : bodyText }
            : {}),
        },
        payload: { accountId: a.id, reply, change } satisfies Payload,
        confirmLabel: change === "on" ? "Turn on" : change === "off" ? "Turn off" : "Save",
      });
      return { status: "awaiting_confirmation", note: "A card is waiting for the user's OK. Nothing has changed yet." };
    },
  },
  confirm: {
    set: async (payload, deps) => {
      const d = extOf<AutoReplyDeps>(deps, ID);
      const p = payload as Payload;
      await d.set(p.accountId, p.reply);
      return p.change === "on" ? "Automatic replies on" : p.change === "off" ? "Automatic replies off" : "Automatic replies updated";
    },
  },
  realDeps: (): AutoReplyDeps => ({
    accounts: () => useMail.getState().accounts.map((a) => ({ id: a.id, address: a.address, label: a.label ?? a.name ?? a.address, kind: a.kind })),
    get: async (accountId) => {
      await useMail.getState().loadAutoReply(accountId);
      const v = useMail.getState().autoReplies[accountId];
      if (v === "needs-permission") throw new NeedsPermissionError();
      if (v === undefined || v === "error") throw new Error("Couldn't read automatic replies for this account.");
      return v;
    },
    set: (accountId, r) => useMail.getState().saveAutoReply(accountId, r),
  }),
};
