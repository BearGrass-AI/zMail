// src/lib/ai/assistant/mock-agent.ts
// The offline demo agent behind MockGenerativeProvider.chat: enough tool use
// to show the assistant in the browser preview and tests without a model.
// It understands "from <sender>", "how many … orders", trash/archive/read,
// "add this to my calendar", "reply/forward" and "unsubscribe me from <sender>",
// and routes the slash-command prompts (/find, /summarize, /schedule, /reply)
// by their intent before looking for a sender.

import type { AgentMessage, AgentTurn } from "@/lib/ai/tool-chat";

const call = (name: string, args: Record<string, unknown>): AgentTurn => ({ text: "", toolCalls: [{ id: `mock_${name}_${Math.random().toString(36).slice(2, 7)}`, name, args }] });
const say = (text: string): AgentTurn => ({ text, toolCalls: [] });

function results(messages: AgentMessage[]) {
  return messages.filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool").map((m) => ({ name: m.name, data: JSON.parse(m.content) as Record<string, unknown> }));
}

const STOP = new Set(
  "a an and any are at be by can did do does for from had has have how i in is it its me my of on or our so than that the their them then there these this those to was we were what when where which who why will with would you your".split(" "),
);

/** The content words of a /find question, for a words search. */
function questionWords(q: string): string {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 3).join(" ");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ymd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};

/** The first date written in the text (2026-11-14, Nov 14[, 2026], 11/14/2026), as YYYY-MM-DD. */
export function findDate(text: string, now = new Date()): string | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return ymd(+iso[1], +iso[2], +iso[3]);
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(20\d{2}))?/i.exec(text);
  if (named) {
    const m = MONTHS.indexOf(named[1].toLowerCase()) + 1;
    const d = +named[2];
    if (named[3]) return ymd(+named[3], m, d);
    // No year: the next time that date comes round.
    const y = now.getFullYear();
    const thisYear = ymd(y, m, d);
    return thisYear && thisYear >= now.toISOString().slice(0, 10) ? thisYear : ymd(y + 1, m, d);
  }
  const us = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(text);
  return us ? ymd(+us[3], +us[1], +us[2]) : null;
}

// The mock has no profile; sign drafts with a stand-in first name.
const SIGN = "Alex";
const draftBody = (request: string) => `Hi,\n\n${request.replace(/[.!?]+$/, "")}.\n\nThanks,\n${SIGN}`;
const draftSubject = (request: string) => {
  const s = request.replace(/\s+/g, " ").trim().slice(0, 60);
  return s ? s[0].toUpperCase() + s.slice(1) : "Hello";
};
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "fix X to Y in the draft", "replace X with Y", "X → Y": the pair to swap, or null. */
function replacement(text: string): { from: string; to: string } | null {
  const m = /(?:(?:fix|change|replace)\s+)?["“']?([^"“”'→]+?)["”']?\s*(?:→|->|\bto\b|\bwith\b)\s*["“']?([^"“”']+?)["”']?(?:\s+in the draft)?\s*[.!]?\s*$/i.exec(text.trim());
  return m ? { from: m[1].trim(), to: m[2].trim() } : null;
}

export function mockAgentTurn(messages: AgentMessage[]): AgentTurn {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const raw = (messages[lastUserIdx] as { content: string }).content.replace(/^\[zMail:.*\]\n\n/s, "");
  const user = raw.toLowerCase();
  // Slash-command prompts, by intent: /find, and the ones about "the email I have open".
  const find = /^answer from my email:\s*(.*)/i.exec(raw)?.[1];
  const openEmail = /the email i have open/.test(user);
  const wants = openEmail ? (/^summarize/.test(user) ? "summarize" : /^draft a reply/.test(user) ? "reply" : /create_event/.test(user) ? "schedule" : "open") : null;
  const sinceUser = results(messages.slice(lastUserIdx));
  const all = results(messages);
  const last = sinceUser.at(-1);
  const lastBreakdown = [...all].reverse().find((r) => r.name === "break_down")?.data as { groups?: { label: string; count: number; set_id: string }[] } | undefined;
  const lastSearch = [...all].reverse().find((r) => r.name === "search_mail")?.data as { set_id?: string; count?: number; label?: string } | undefined;

  // The composer's Draft-with-AI request (see draft-request.ts).
  const editDraft = /\b(fix|change|replace)\b.*\bdraft\b|\bin the draft\b/i.test(raw);
  const newDraft = /^Draft a new email\./.test(raw);
  const reworkDraft = /^Rewrite the draft open in compose\b/.test(raw);
  const replyDraft = /^Draft a (reply|reply-all|forward) (?:of|to) email id (\S+) /.exec(raw);
  const request = /^Request:\s*(.*)$/m.exec(raw)?.[1].trim() ?? "";
  const addrs = (line: string) => [...(new RegExp(`^${line}:\\s*(.*)$`, "m").exec(raw)?.[1] ?? "").matchAll(/<([^>]+)>/g)].map((m) => m[1]).join(", ");

  if (last) {
    if (last.data.error) return say(`I couldn't do that: ${String(last.data.error)}`);
    if (newDraft && last.name === "search_mail") {
      const top = (last.data.sample as { subject?: string }[] | undefined)?.[0];
      const to = addrs("To");
      const cc = addrs("Cc");
      return call("draft", { kind: "new", ...(to ? { to } : {}), ...(cc ? { cc } : {}), subject: draftSubject(request), body: draftBody(request), instructions: top?.subject ? `${request} (related email: ${top.subject})` : request });
    }
    if (find !== undefined && last.name === "search_mail") {
      const top = (last.data.sample as { id: string }[] | undefined)?.[0];
      if (!last.data.count || !top) return say("Nothing I found in your mail supports an answer to that.");
      return call("read_email", { id: top.id });
    }
    if (find !== undefined && last.name === "read_email") {
      const sender = String(last.data.from ?? "").replace(/\s*<.*>$/, "");
      return say(`The best match is “${String(last.data.subject)}” from ${sender}, sent ${String(last.data.date).slice(0, 10)} [${String(last.data.ref)}].`);
    }
    if (last.name === "search_mail") {
      if (last.data.too_many) return say("That matches too much mail. Can you narrow it down by sender or date?");
      if (/how many|order|deliver|kind|break/.test(user)) return call("break_down", { set_id: last.data.set_id, by: "kind" });
      return say(`Found ${last.data.count} emails (${last.data.label}). They're in your list when you click the chip.`);
    }
    if (last.name === "break_down") {
      if (/use act to propose/.test(user) && lastSearch?.set_id) return call("act", { set_id: lastSearch.set_id, op: "trash" });
      const groups = (last.data.groups as { label: string; count: number; examples?: string[] }[]) ?? [];
      const rows = groups.map((g) => `| ${g.label} | ${g.count} | ${(g.examples ?? []).join("; ").replace(/\|/g, "/") || "-"} |`);
      return say(["| Group | Count | What's in it |", "|---|---:|---|", ...rows].join("\n") + `\n\n${groups.map((g) => `${g.count} ${g.label.toLowerCase()}`).join(", ")}.`);
    }
    if (last.name === "current_view" && editDraft && !wants) {
      const c = last.data.compose as { subject: string; body: string } | null;
      if (!c) return say("There's no draft open in compose to change.");
      const r = replacement(raw.replace(/^[\s\S]*?(?=\b(?:fix|change|replace)\b)/i, ""));
      if (!r) return say("Tell me what to replace, like “replace X with Y in the draft”.");
      const re = new RegExp(escapeRe(r.from), "g");
      if (!re.test(c.body) && !re.test(c.subject)) return say(`I couldn't find “${r.from}” in the draft.`);
      const swap = (t: string) => t.replace(new RegExp(escapeRe(r.from), "g"), r.to);
      return call("edit_draft", { ...(new RegExp(escapeRe(r.from)).test(c.subject) ? { subject: swap(c.subject) } : {}), body: swap(c.body) });
    }
    if (last.name === "current_view") {
      const open = last.data.open_email as { id: string } | null;
      if (!open) return say("Which email do you mean? Open it or check it, then ask again.");
      if (wants === "reply" || (!wants && /reply|forward/.test(user))) {
        const instructions = /instructions:\s*([\s\S]*)$/i.exec(raw)?.[1].trim() || raw;
        return call("draft", { kind: /forward/.test(user) ? "forward" : "reply", email_id: open.id, body: draftBody(instructions), instructions });
      }
      return call("read_email", { id: open.id });
    }
    if (last.name === "read_email") {
      const ref = String(last.data.ref ?? "");
      const cite = ref ? ` [${ref}]` : "";
      if (wants === "summarize" || (!wants && /summar/.test(user))) {
        const body = String(last.data.email_text ?? "").replace(/\s+/g, " ").trim();
        const first = (/^.*?[.!?](?=\s|$)/.exec(body)?.[0] ?? body).slice(0, 200);
        const sender = String(last.data.from ?? "").replace(/\s*<.*>$/, "");
        return say(`**${String(last.data.subject)}** from ${sender}: ${first || "it's empty."}${cite}`);
      }
      const date = findDate(`${String(last.data.subject)}\n${String(last.data.email_text ?? "")}`);
      if (!date) return say(`I couldn't find a date in that email, so there's nothing to add to your calendar.${cite}`);
      return call("create_event", { title: String(last.data.subject), start: date, all_day: true, email_id: last.data.id });
    }
    if (last.name === "check_unsubscribe")
      return say(last.data.available === "none" ? "I couldn't find a way to unsubscribe from that sender in its newest email." : "Check the Unsubscribe card. Nothing happens until you click it.");
    if (last.data.status === "awaiting_confirmation") return say("Check the card to confirm.");
    if (last.data.status === "edited") return say("I've updated the draft in compose.");
    if (last.data.status === "opened_in_compose") return say("It's open in compose. Review it and send when you're ready.");
    if (typeof last.data.done === "number") return say(`Done: ${last.data.done}.`);
  }

  if (reworkDraft) return call("edit_draft", { body: draftBody(request) });
  if (newDraft) {
    const words = questionWords(request);
    return words ? call("search_mail", { query: { words } }) : call("draft", { kind: "new", subject: draftSubject(request), body: draftBody(request), instructions: request });
  }
  if (replyDraft) {
    const kind = replyDraft[1] === "reply-all" ? "reply_all" : replyDraft[1] === "forward" ? "forward" : "reply";
    const to = addrs("To");
    return call("draft", { kind, email_id: replyDraft[2], ...(kind === "forward" && to ? { to } : {}), body: draftBody(request), instructions: request });
  }
  if (find !== undefined) {
    const words = questionWords(find.split("\n")[0]);
    return words ? call("search_mail", { query: { words } }) : say("What should I look for in your mail?");
  }
  if (openEmail) return call("current_view", {});
  if (editDraft) return call("current_view", {});

  // Slash prompts say "matching: <sender>"; plain chat says "from <sender>".
  const from = /matching:\s*([\w.@-]*[\w@])/.exec(user)?.[1] ?? /from\s+([\w.@-]+\.\w+|[\w-]+)/.exec(user)?.[1];
  if (from && /unsubscribe me/.test(user)) return call("check_unsubscribe", { from });
  if (from) return call("search_mail", { query: { from } });
  const op = /delete|trash/.test(user) ? "trash" : /archive/.test(user) ? "archive" : /mark (them |those |these )?read/.test(user) ? "mark_read" : null;
  if (op) {
    const match = lastBreakdown?.groups?.find((g) => /order|deliver/.test(g.label.toLowerCase())) ?? lastBreakdown?.groups?.[0];
    const setId = match?.set_id ?? lastSearch?.set_id;
    if (setId) return call("act", { set_id: setId, op });
  }
  if (/calendar|reply|forward|this|these/.test(user)) return call("current_view", {});
  return say("In the offline demo I can search by sender (\"emails from amazon.com\"), break mail down, and act on it. Set up a model in Settings → AI providers, then pick it in Settings → AI Assistant, for everything else.");
}
