// Automatic replies (out of office): from standard headers, else the subject prefixes mail servers use.
import type { Email, Triage } from "@/lib/types";

const PREFIX = /^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office( reply| autoreply)?|abwesenheitsnotiz|automatische antwort|réponse automatique|respuesta automática|risposta automatica|automatisch antwoord|resposta automática)\s*:/i;

export function isAutoReply(e: Pick<Email, "autoReply" | "subject">): boolean {
  return !!e.autoReply || PREFIX.test(e.subject);
}

export const AUTO_REPLY_MODEL = "zmail:auto-reply";

/** Filed under Ready to archive by rule, with no folder suggestion. */
export function autoReplyTriage(emailId: string): Triage {
  return {
    emailId,
    bucket: "ready_archive",
    bucketProbs: { needs_you: 0, worth_skim: 0, ready_archive: 1 },
    category: "updates",
    urgency: 0,
    needsReply: 0,
    model: AUTO_REPLY_MODEL,
  };
}
