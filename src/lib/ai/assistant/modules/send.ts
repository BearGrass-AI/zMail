// Send: short replies sent only after the user presses Send on a confirm card.
import type { Email } from "@/lib/types";
import type { InlineImage } from "@/lib/signature";
import type { SendRequest } from "@/lib/mail/provider";
import { inlineDataImages, htmlToText, sizeSignatureImages } from "@/lib/signature";
import { composeRichHtml, composeRichText, markdownToBodyHtml } from "@/lib/mail/compose-html";
import { replyRecipients } from "@/lib/mail/compose-text";
import { useMail } from "@/lib/store";
import { longWhen, validSendAt, whenLabel } from "@/lib/mail/scheduled";
import { pushConfirmCard } from "./confirm";
import { refOf } from "./ids";
import { extOf, type ToolModule } from "./types";
import { parseLocal } from "@/lib/dates/local";

export const MAX_REPLY_CHARS = 1500;

export interface SendDeps {
  /** The reply signature (HTML) the user set for this account, if any. */
  signatureFor(accountId: string): string | undefined;
  /** Addresses of the user's own accounts (dropped from reply-all recipients). */
  ownAddresses(): string[];
  /** Sizes signature images and turns data: images into inline parts. */
  finishHtml(html: string): Promise<{ html: string; inline: InlineImage[] }>;
  send(accountId: string, msg: SendRequest): Promise<void>;
  /** Save the reply as a draft and send it at `sendAt`. */
  schedule(accountId: string, msg: SendRequest, sendAt: number): Promise<unknown>;
}

interface Payload {
  emailId: string;
  accountId: string;
  body: string;
  replyAll: boolean;
  /** Send later at this time (ms), set by send_at or the card's Send later menu. */
  sendAt?: number;
}

const replySubject = (s: string) => (/^re:/i.test(s.trim()) ? s : `Re: ${s}`);

/** Local "YYYY-MM-DDTHH:MM" from the model; null when malformed or not a real date. */
function parseLocalArg(s: unknown): number | null {
  return typeof s === "string" ? (parseLocal(s.trim()) ?? null) : null;
}

export const sendModule: ToolModule = {
  id: "send",
  prompt: [
    "- You can send short replies to existing emails with send_reply. It only shows a card with the exact email; it is sent only when the user presses Send. Never say a reply was sent unless the card says so.",
    "- For new emails, forwards, long replies, or anything the user wants to edit first, use draft instead.",
    "- When the user asks to reply the same way to several emails, call send_reply once per email.",
    "- To send a reply later (\"reply tomorrow at 8\"), pass send_at to send_reply; the card schedules it. The user can also pick a time on the card.",
  ],
  tools: [
    {
      name: "send_reply",
      description: "Show a confirm card for a short reply (Markdown, up to 1,500 characters) to an email. The reply is sent only when the user presses Send on the card.",
      parameters: {
        type: "object",
        properties: {
          email_id: { type: "string", description: "Id of the email to reply to, from an earlier tool result" },
          body: { type: "string", description: "The reply text in Markdown, short; the user's signature is added automatically" },
          reply_all: { type: "boolean", description: "Reply to everyone on the email (default false)" },
          send_at: { type: "string", description: "Send later at this local time, YYYY-MM-DDTHH:mm (omit to send when the user confirms)" },
        },
        required: ["email_id", "body"],
      },
    },
  ],
  handlers: {
    send_reply: async (args, deps) => {
      const d = extOf<SendDeps>(deps, "send");
      const ref = refOf(args.email_id);
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!body) throw new Error("bad_query: send_reply needs body");
      if (body.length > MAX_REPLY_CHARS) return { error: "Too long for a quick reply: use draft" };
      const replyAll = args.reply_all === true;
      let sendAt: number | undefined;
      if (args.send_at !== undefined && args.send_at !== null && args.send_at !== "") {
        const at = parseLocalArg(args.send_at);
        if (at === null || !validSendAt(at, Date.now())) throw new Error("bad_query: send_at must be a future local time like 2026-10-14T08:00");
        sendAt = at;
      }
      const email = await deps.getEmail(ref);
      const { to, cc } = replyRecipients(email, d.ownAddresses(), replyAll);
      if (!to.length) return { error: "No one to reply to" };
      const sig = d.signatureFor(email.accountId);
      const subject = replySubject(email.subject);
      pushConfirmCard({
        module: "send",
        action: "send_reply",
        title: `${sendAt === undefined ? "Reply" : "Schedule reply"} to ${email.from.name || email.from.address}`,
        detail: subject,
        preview: {
          fields: [
            { label: "To", value: to.join(", ") },
            ...(cc.length ? [{ label: "Cc", value: cc.join(", ") }] : []),
            { label: "Subject", value: subject },
            ...(sendAt === undefined ? [] : [{ label: "When", value: longWhen(sendAt) }]),
          ],
          body: sig ? `${body}\n\n${htmlToText(sig)}` : body,
        },
        payload: { emailId: email.id, accountId: email.accountId, body, replyAll, ...(sendAt === undefined ? {} : { sendAt }) } satisfies Payload,
        confirmLabel: sendAt === undefined ? "Send" : `Schedule · ${whenLabel(sendAt)}`,
        later: true,
      });
      return { status: "awaiting_confirmation", note: "A card is waiting for the user's OK. Nothing has been sent yet." };
    },
  },
  confirm: {
    send_reply: async (payload, deps) => {
      const d = extOf<SendDeps>(deps, "send");
      const p = payload as Payload;
      const email: Email = await deps.getEmail({ id: p.emailId, accountId: p.accountId });
      const { to, cc } = replyRecipients(email, d.ownAddresses(), p.replyAll);
      if (!to.length) throw new Error("No one to reply to");
      const sig = d.signatureFor(email.accountId);
      const bodyHtml = markdownToBodyHtml(p.body);
      const { html, inline } = await d.finishHtml(composeRichHtml(bodyHtml, sig));
      const msg: SendRequest = {
        to,
        ...(cc.length ? { cc } : {}),
        subject: replySubject(email.subject),
        text: composeRichText(bodyHtml, sig),
        html,
        inline,
        replyTo: email,
      };
      if (p.sendAt !== undefined) {
        await d.schedule(email.accountId, msg, p.sendAt);
        return "Scheduled for " + whenLabel(p.sendAt);
      }
      await d.send(email.accountId, msg);
      const who = to.map((a) => (email.from.address.toLowerCase() === a.toLowerCase() ? email.from.name || a : a));
      return `Sent to ${who.join(", ")}`;
    },
  },
  realDeps: (): SendDeps => ({
    signatureFor: (accountId) => {
      const { signatures, signatureDefaults } = useMail.getState();
      return signatures.find((x) => x.id === signatureDefaults[accountId]?.reply)?.html;
    },
    ownAddresses: () => useMail.getState().accounts.map((a) => a.address),
    finishHtml: async (html) => inlineDataImages(await sizeSignatureImages(html)),
    send: (accountId, msg) => useMail.getState().send(accountId, msg),
    schedule: (accountId, msg, sendAt) => useMail.getState().scheduleMessage(accountId, msg, sendAt),
  }),
};
