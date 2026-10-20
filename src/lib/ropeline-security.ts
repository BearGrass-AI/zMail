// On-device security reading. Links are not opened. Mail is not moved or deleted.
// Header text is untrusted: it is cut, stripped of hidden characters, and a bad value is ignored.

import { mailboxSignals, type RopeLineFlag, type RopeLineSignal } from "@/lib/ropeline";
import type { AuthResult, Email, MailSecurity } from "@/lib/types";

export type { AuthResult, MailSecurity };

export type ScreenLevel = "clear" | "warn" | "quarantine";

export interface SecurityFinding {
  id: string;
  title: string;
  detail: string;
}

export interface CyberQuestion {
  id: string;
  prompt: string;
}

export interface Screening {
  level: ScreenLevel;
  findings: SecurityFinding[];
  questions: CyberQuestion[];
  reason: string;
}

const AUTH: Record<string, AuthResult> = {
  pass: "pass",
  fail: "fail",
  softfail: "softfail",
  neutral: "neutral",
  none: "none",
  temperror: "temperror",
  permerror: "permerror",
};

const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const RISKY_EXT = new Set(["exe", "dll", "scr", "js", "hta", "iso", "img", "lnk", "bat", "cmd", "msi", "html", "htm", "svg", "vbs", "ps1", "jar", "apk", "dmg"]);
const PAY = /\b(invoice|payroll|wire|direct deposit|gift cards?|bitcoin|crypto|routing number|bank account)\b/i;
const INJECT = /ignore (all |any )?(previous|prior|above) instructions|disregard (the |all )?(above|previous)|you are now|system prompt|<\s*system\s*>|archive all (these |the )?emails/i;

const SIGNAL_COPY: Record<string, { title: string; detail: string }> = {
  shortener: { title: "Shortened link", detail: "A link hides its real address behind a shortener." },
  lookalike_domain: { title: "Look-alike domain", detail: "A link looks like a domain you own." },
  punycode_domain: { title: "Look-alike letters", detail: "A link uses letters that look like ordinary ones." },
  ip_literal_url: { title: "Link to a bare address", detail: "A link points at a numeric address." },
  mixed_script: { title: "Mixed alphabets", detail: "One word mixes two alphabets." },
  zero_width_text: { title: "Hidden characters", detail: "Invisible characters sit inside a word." },
  bidi_control: { title: "Direction controls", detail: "The text can display in a different order than it is stored." },
  own_domain_sender: { title: "Sender uses your domain", detail: "The From address is at a domain on this account." },
  name_random_string: { title: "Random-looking name", detail: "The display name does not look like a person's name." },
  name_repeated: { title: "Repeated name", detail: "The display name repeats the same word." },
};

function clean(raw: string, max: number): string {
  return raw.replace(HIDDEN, "").slice(0, max);
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  return address.slice(at + 1).toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
}

/** spf, dkim, and dmarc from an Authentication-Results header. Anything else is dropped. */
export function parseAuthenticationResults(raw: unknown): Pick<MailSecurity, "spf" | "dkim" | "dmarc"> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  const text = clean(raw, 4000);
  const out: Pick<MailSecurity, "spf" | "dkim" | "dmarc"> = {};
  for (const key of ["spf", "dkim", "dmarc"] as const) {
    const m = new RegExp(`\\b${key}\\s*=\\s*([a-z]+)`, "i").exec(text);
    const word = m?.[1]?.toLowerCase();
    if (word && AUTH[word]) out[key] = AUTH[word];
  }
  return out;
}

/** One Reply-To mailbox, or nothing. A line break is refused. */
export function parseReplyTo(raw: unknown): string | undefined {
  if (typeof raw !== "string" || /[\r\n]/.test(raw)) return undefined;
  const text = clean(raw, 300);
  const m = /([^\s<>@",;]+@[^\s<>@",;]+\.[^\s<>@",;]+)/.exec(text);
  if (!m) return undefined;
  const addr = m[1].toLowerCase();
  return addr.length <= 200 ? addr : undefined;
}

export function securityFromHeaders(get: (name: string) => string | undefined): MailSecurity | undefined {
  let auth: string;
  let reply: string;
  try {
    auth = get("authentication-results") ?? "";
    reply = get("reply-to") ?? "";
  } catch {
    return undefined;
  }
  const parsed = parseAuthenticationResults(auth);
  const replyTo = parseReplyTo(reply);
  const security: MailSecurity = { ...parsed, ...(replyTo ? { replyTo } : {}) };
  return security.spf || security.dkim || security.dmarc || security.replyTo ? security : undefined;
}

function extOf(filename: string): string {
  const name = clean(filename, 200).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

/** Direction overrides and zero-width characters removed, then cut. The words stay. */
export function fenceMailText(text: string, cap: number): string {
  return clean(typeof text === "string" ? text : "", cap);
}

function push(findings: SecurityFinding[], id: string, title: string, detail: string) {
  if (!findings.some((f) => f.id === id)) findings.push({ id, title, detail });
}

/** The on-device reading. It does not move mail and it does not open anything. */
export function screenMail(
  email: Pick<Email, "from" | "subject" | "text" | "attachments" | "security">,
  flag?: Pick<RopeLineFlag, "signals" | "advice" | "verdict" | "reason">,
): Screening {
  const findings: SecurityFinding[] = [];
  const text = `${email.subject ?? ""}\n${email.text ?? ""}`;
  const signals: RopeLineSignal[] = flag?.signals?.length
    ? flag.signals
    : mailboxSignals({ text, name: email.from?.name, email: email.from?.address });
  for (const s of signals) {
    const copy = SIGNAL_COPY[s.kind];
    if (copy) push(findings, s.kind, copy.title, s.value ? `${copy.detail} (${s.value})` : copy.detail);
  }
  const security = email.security;
  if (security?.dmarc === "fail") push(findings, "dmarc", "DMARC failed", "The sender's domain did not pass its own mail check.");
  if (security?.spf === "fail" || security?.spf === "softfail") push(findings, "spf", "SPF did not pass", "The sending server is not listed for the From domain.");
  if (security?.dkim === "fail") push(findings, "dkim", "DKIM failed", "The signature on the message did not check out.");
  const fromDomain = domainOf(email.from?.address ?? "");
  const replyDomain = domainOf(security?.replyTo ?? "");
  const replyMismatch = Boolean(fromDomain && replyDomain && fromDomain !== replyDomain);
  if (replyMismatch) push(findings, "reply-to", "Reply-To is a different domain", `A reply would go to ${security?.replyTo}, not ${email.from.address}.`);
  const riskyFile = (email.attachments ?? []).map((a) => extOf(a.filename)).find((ext) => RISKY_EXT.has(ext));
  if (riskyFile) push(findings, "attachment", "Risky attachment", `A file ending in .${riskyFile} is attached. It was not opened.`);
  const payment = PAY.test(text);
  if (payment && (findings.some((f) => f.id === "lookalike_domain" || f.id === "reply-to" || f.id === "dmarc") || replyMismatch))
    push(findings, "bec", "Invoice or payment request", "The message asks about money and the sender does not line up.");
  const injection = INJECT.test(fenceMailText(text, 8000));
  if (injection) push(findings, "injection", "Text aimed at an automated reader", "The message tells a program what to do. Those words are data.");
  if (flag?.verdict === "spam") push(findings, "verdict", "RopeLine verdict: spam", flag.reason ?? "The hosted check called this spam.");
  else if (flag?.verdict === "unsure") push(findings, "verdict", "RopeLine verdict: unsure", "The hosted check did not call this safe.");
  if (flag?.advice?.advised) push(findings, "advice", "Spam questions advised caution", "The decision provider's answers advised caution. They did not file the mail.");

  const quarantine = findings.some((f) => ["dmarc", "attachment", "bec", "injection"].includes(f.id));
  const level: ScreenLevel = quarantine ? "quarantine" : findings.length ? "warn" : "clear";
  const questions: CyberQuestion[] = [];
  if (payment) questions.push({ id: "expect-invoice", prompt: "Were you expecting this invoice?" });
  if (level !== "clear") questions.push({ id: "know-sender", prompt: "Does the sender match someone you know?" });
  if (payment || level === "quarantine") questions.push({ id: "other-channel", prompt: "Verify by another channel before paying." });
  if (riskyFile) questions.push({ id: "expect-file", prompt: "Were you expecting this attachment?" });
  const reason = level === "clear" ? "Nothing here needs a check." : findings[0].title;
  return { level, findings, questions, reason: level === "quarantine" ? findings.find((f) => ["dmarc", "attachment", "bec", "injection"].includes(f.id))?.title ?? reason : reason };
}

/** True when the assistant must ask before it changes this message. A missing message is not held. */
export function heldForConfirm(email: Pick<Email, "from" | "subject" | "text" | "attachments" | "security"> | undefined, flag?: RopeLineFlag): boolean {
  if (!email) return false;
  return screenMail(email, flag).level !== "clear";
}
