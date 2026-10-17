// Automatic rules: deterministic sender/subject rules that act on NEW inbox mail.
// Pure helpers; the store runs them (applyAutoRules) before each triage pass.

import type { Bucket, Email } from "@/lib/types";
import type { BulkOp } from "@/lib/mail/bulk";

export type RuleAction = "trash" | "archive" | "mark_read" | { moveTo: string } | { lane: Bucket };

export const LANE_LABEL: Record<Bucket, string> = { needs_you: "Needs you", worth_skim: "Worth a skim", ready_archive: "Ready to archive" };

export interface AutoRule {
  id: string;
  match: { from: string; subjectAny?: string[] };
  action: RuleAction;
  createdAt: string;
  enabled: boolean;
  hits: number;
  lastHitAt?: string;
}

/** Rules that file mail into one of zMail's lanes instead of acting on the server. */
export const isLaneRule = (r: AutoRule): r is AutoRule & { action: { lane: Bucket } } => typeof r.action === "object" && "lane" in r.action;

/** A lowercased address or bare domain; null if it is neither. */
export function normalizeFrom(v: string): string | null {
  const t = v.trim().toLowerCase();
  const domain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  const at = t.indexOf("@");
  if (at < 0) return domain.test(t) ? t : null;
  if (at === 0) {
    const d = t.slice(1);
    return domain.test(d) ? d : null;
  }
  const [local, d, ...rest] = t.split("@");
  if (rest.length || !local || /\s/.test(local) || !domain.test(d ?? "")) return null;
  return t;
}

/**
 * The folder an always-file rule sends mail from `address` to. Keys are addresses or bare domains; a domain
 * also covers its subdomains, as in ruleMatches, and an address rule wins over a domain rule.
 */
export function filingRuleFor(rules: Record<string, string>, address: string): string | undefined {
  const addr = address.toLowerCase();
  if (Object.hasOwn(rules, addr)) return rules[addr];
  let domain = addr.slice(addr.lastIndexOf("@") + 1);
  while (domain.includes(".")) {
    if (Object.hasOwn(rules, domain)) return rules[domain];
    domain = domain.slice(domain.indexOf(".") + 1);
  }
  return undefined;
}

export function ruleMatches(rule: AutoRule, e: Email, isInbox: (e: Email) => boolean): boolean {
  // Lane rules only need from/subject, which header-only (partial) mail has.
  if (!rule.enabled || (e.partial && !isLaneRule(rule)) || !isInbox(e)) return false;
  // Folder ids are `<accountId>:<id>`: a move rule only applies to mail in the folder's own account.
  // Lane rules also cover mail that is already here, so they skip the folder-account and createdAt checks.
  if (!isLaneRule(rule)) {
    if (typeof rule.action === "object" && "moveTo" in rule.action && !rule.action.moveTo.startsWith(`${e.accountId}:`)) return false;
    const sent = Date.parse(e.date);
    if (!(sent >= Date.parse(rule.createdAt))) return false;
  }
  const from = rule.match.from.toLowerCase();
  const addr = e.from.address.toLowerCase();
  if (from.includes("@")) {
    if (addr !== from) return false;
  } else {
    const domain = addr.slice(addr.lastIndexOf("@") + 1);
    if (!(domain === from || domain.endsWith("." + from))) return false;
  }
  const terms = rule.match.subjectAny?.filter((t) => t.trim()) ?? [];
  if (terms.length && !terms.some((t) => subjectHas(e.subject, t))) return false;
  return true;
}

/** A word or phrase on word boundaries, case-insensitive: "order" matches "Your order shipped", not "Border". */
export function subjectHas(subject: string, term: string): boolean {
  const t = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Lookarounds, not \b, so terms that start or end with punctuation ("c++", "50% off") still work.
  return new RegExp(`(?<![\\p{L}\\p{N}_])${t}(?![\\p{L}\\p{N}_])`, "iu").test(subject);
}

export function ruleOp(action: Exclude<RuleAction, { lane: Bucket }>): BulkOp {
  if (action === "trash") return { kind: "trash" };
  if (action === "archive") return { kind: "archive" };
  if (action === "mark_read") return { kind: "read", read: true };
  return { kind: "move", folderId: action.moveTo };
}

export function describeRule(rule: AutoRule, folderName?: (id: string) => string | undefined): string {
  const a = rule.action;
  const terms = (rule.match.subjectAny ?? []).filter((t) => t.trim()).map((t) => `“${t.trim()}”`);
  const list = terms.length > 1 ? `${terms.slice(0, -1).join(", ")} or ${terms[terms.length - 1]}` : terms[0];
  if (typeof a === "object" && "lane" in a)
    return `Always put mail from ${rule.match.from}${list ? ` with ${list} in the subject` : ""} in ${LANE_LABEL[a.lane]}`;
  const verb = a === "trash" ? "Trash" : a === "archive" ? "Archive" : a === "mark_read" ? "Mark as read" : "Move";
  const to = typeof a === "object" ? ` to ${folderName?.(a.moveTo) ?? "a folder"}` : "";
  return `${verb} new mail from ${rule.match.from}${list ? ` with ${list} in the subject` : ""}${to}`;
}

/** Group emails by the first enabled rule that matches each; later rules never see them. */
export function planRuleRun(rules: AutoRule[], emails: Email[], isInbox: (e: Email) => boolean): { rule: AutoRule; emails: Email[] }[] {
  const out = new Map<string, { rule: AutoRule; emails: Email[] }>();
  for (const e of emails) {
    const rule = rules.find((r) => !isLaneRule(r) && ruleMatches(r, e, isInbox));
    if (!rule) continue;
    const g = out.get(rule.id) ?? { rule, emails: [] };
    g.emails.push(e);
    out.set(rule.id, g);
  }
  return [...out.values()];
}

/** The lane of the first enabled lane rule that matches this email. */
export function laneFor(rules: AutoRule[], e: Email, isInbox: (e: Email) => boolean): Bucket | undefined {
  for (const r of rules) if (isLaneRule(r) && ruleMatches(r, e, isInbox)) return r.action.lane;
  return undefined;
}
