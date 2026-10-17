// Offline stand-in for the generative model. Recognizes zMail's own prompts
// and returns plausible text so the UI works without a configured provider.

import type { ChatMessage, GenerativeProvider } from "./generative";
import { mockAgentTurn } from "./assistant/mock-agent";
import type { AgentMessage, AgentTurn, ToolDef } from "./tool-chat";

const sentences = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((x) => x.length > 20);

export class MockGenerativeProvider implements GenerativeProvider {
  readonly name = "mock-llm";

  async complete(messages: ChatMessage[]): Promise<string> {
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 450));
    const prompt = messages[messages.length - 1]?.content ?? "";

    if (prompt.startsWith("In one line")) {
      const body = prompt.split("\n\n").slice(2).join(" ");
      const all = sentences(body);
      const ask = all.find((x) => x.includes("?")) ?? all[0] ?? body;
      const line = capitalize(ask.replace(/^(hi|hey|hello)[^,]*,\s*/i, "").replace(/^\w+ — /, "").trim());
      return line.length > 110 ? line.slice(0, 107).trimEnd() + "…" : line;
    }

    if (prompt.startsWith("Summarize")) {
      const from = /From: (.+?) </.exec(prompt)?.[1] ?? "The sender";
      const body = prompt.split("\n\n").slice(2).join(" ");
      const lead = sentences(body).slice(0, 2).join(" ");
      return `${from} writes: ${lead || "a short note with no clear request."}`;
    }

    if (prompt.includes("were grouped as")) {
      const senders = [...prompt.matchAll(/^- (.+?):/gm)].map((m) => m[1]);
      const unique = [...new Set(senders)];
      const named = unique.slice(0, 3).join(", ");
      const more = unique.length > 3 ? ` and ${unique.length - 3} more` : "";
      const n = senders.length;
      return `${n} ${n === 1 ? "message" : "messages"} from ${named}${more}, grouped by sender and intent.`;
    }

    if (prompt.includes("Write an email")) {
      const ask = /Instruction: (.+)/.exec(prompt)?.[1] ?? "";
      const sign = /signed "(.+?)"/.exec(prompt)?.[1] ?? "Z";
      const to = (/^- To: (.+)/m.exec(prompt)?.[1] ?? /From: (.+)/.exec(prompt)?.[1])?.split(" ")[0];
      const m = /^ask (\w+) (?:for|to) (.+)/i.exec(ask.trim());
      const name = to ?? (m ? capitalize(m[1]) : undefined);
      const body = m
        ? `Could you send over ${m[2].replace(/\.$/, "")}? Happy to help pull anything together if that's useful.`
        : `${capitalize(ask.replace(/\.$/, ""))}. Let me know what works on your end.`;
      const text = `${name ? `Hi ${name},` : "Hi,"}\n\n${body}\n\nThanks,\n${sign}`;
      if (!prompt.includes('"Subject:')) return text;
      const subject = m ? capitalize(m[2].replace(/\s+by\s+.+$/i, "").replace(/^(the|my|your)\s+/i, "").replace(/\.$/, "")) : "Quick note";
      return `Subject: ${subject}\n\n${text}`;
    }

    if (prompt.includes("List the dates in it")) return JSON.stringify(mockDates(prompt));

    if (prompt.includes("Label each email with one kind")) return JSON.stringify(mockKinds(prompt));

    return "…";
  }

  async chat(_system: string, messages: AgentMessage[], _tools: ToolDef[]): Promise<AgentTurn> {
    await new Promise((r) => setTimeout(r, 200));
    return mockAgentTurn(messages);
  }
}

const KIND_RULES: [RegExp, string][] = [
  [/order|shipped|delivered|delivery|arriving|package/, "order_delivery"],
  [/receipt|invoice|statement|payment|bill|charged/, "receipt_bill"],
  [/deal|sale|% off|review your|recommended|offer/, "promotion"],
  [/newsletter|digest|weekly|monthly/, "newsletter"],
  [/security|sign-in|password|verify/, "security"],
];

/** Numbered "N. sender | subject" lines → { N: kind }, by keyword, so kinds work offline. */
function mockKinds(prompt: string) {
  const out: Record<string, string> = {};
  for (const m of prompt.matchAll(/^(\d+)\. (.*)$/gm)) {
    const text = m[2].toLowerCase();
    out[m[1]] = KIND_RULES.find(([re]) => re.test(text))?.[1] ?? "other";
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "October 24" / "Oct 24 at 3 PM" → date finds, so sections work offline. */
function mockDates(prompt: string) {
  const today = /Today is \w+, (\d{4}-\d{2}-\d{2})/.exec(prompt)?.[1] ?? new Date().toISOString().slice(0, 10);
  const subject = /^Subject: (.+)$/m.exec(prompt)?.[1] ?? "Reminder";
  const body = prompt.split(/^Subject: .+$/m)[1] ?? "";
  const re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/gi;
  const out: { title: string; date: string; time: string | null; kind: string; quote: string }[] = [];
  for (const m of body.matchAll(re)) {
    let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    const mm = String(MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1).padStart(2, "0");
    let date = `${year}-${mm}-${m[2].padStart(2, "0")}`;
    if (!m[3] && date < today) date = `${++year}-${mm}-${m[2].padStart(2, "0")}`;
    const near = body.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + m[0].length + 20).toLowerCase();
    const kind = /due|pay|balance|amount/.test(near) ? "due" : /by|deadline|before|return|sign/.test(near) ? "deadline" : "event";
    const h = m[4] ? (Number(m[4]) % 12) + (m[6]?.toLowerCase() === "pm" ? 12 : 0) : null;
    out.push({
      title: kind === "due" ? `Payment due: ${subject}` : subject,
      date,
      time: h === null ? null : `${String(h).padStart(2, "0")}:${m[5] ?? "00"}`,
      kind,
      quote: m[0],
    });
  }
  return out.slice(0, 3);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
