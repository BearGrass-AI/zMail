// Slash commands for the assistant input: a curated prompt per command. The chat
// shows the chip and what the user typed; the model gets expand(arg).

import type { Email } from "@/lib/types";
import type { Person } from "@/lib/contacts";

export interface SlashCommand {
  name: string;
  group: "mail" | "email";
  description: string;
  arg: "sender" | "text" | "none";
  placeholder?: string;
  local?: "clear";
  /** The model's prompt. For arg "none" commands, typed text is passed along as "Also: …". */
  expand(arg: string): string;
}

const CITE = "Cite each statement that comes from an email as [mN] using the ref from tool output.";
/** No-argument commands still pass along anything typed after the chip. */
const also = (prompt: string, extra: string) => (extra.trim() ? `${prompt}\nAlso: ${extra.trim()}` : prompt);

export const COMMANDS: SlashCommand[] = [
  {
    name: "breakdown",
    group: "mail",
    description: "Categorize & count",
    arg: "sender",
    placeholder: "sender, topic or folder…",
    expand: (a) =>
      `Break down my email matching: ${a || "my inbox"}. Search for it (the inbox unless I named a folder or said all mail), then break_down by kind, and by sender if there are several senders. Answer with a short table of counts and one sentence with the takeaway.`,
  },
  {
    name: "cleanup",
    group: "mail",
    description: "Find it, then trash or archive",
    arg: "sender",
    placeholder: "sender or kind of email…",
    expand: (a) =>
      `Clean up my email matching: ${a}. Search for it and show a breakdown by kind. If it comes from a bulk sender (newsletters, promotions, notifications), call check_unsubscribe for that sender first. Then use act to propose moving the bulk mail to Trash (archive instead for mail from real people). Optionally, once the user has confirmed, call propose_rule for new mail like it.`,
  },
  {
    name: "unsubscribe",
    group: "mail",
    description: "Stop a sender for good",
    arg: "sender",
    placeholder: "sender…",
    expand: (a) => `Unsubscribe me from ${a}. Call check_unsubscribe for that sender. Then offer to clean up the mail from it that's already here.`,
  },
  {
    name: "find",
    group: "mail",
    description: "Answer with the emails it came from",
    arg: "text",
    placeholder: "a question about your mail…",
    expand: (a) =>
      `Answer from my email: ${a}\nSearch as needed and read the most relevant emails. Answer in one to four sentences. ${CITE} If nothing you read supports an answer, say so plainly instead of guessing.`,
  },
  {
    name: "summarize",
    group: "email",
    description: "Summarize this thread",
    arg: "none",
    expand: (a) => also(`Summarize the email I have open (call current_view, then read_email). Give the key points, anything asked of me, and any dates. ${CITE}`, a),
  },
  {
    name: "reply",
    group: "email",
    description: "Draft a reply",
    arg: "text",
    placeholder: "what to say…",
    expand: (a) => `Draft a reply to the email I have open (call current_view first). Instructions: ${a || "a short, friendly reply"}.`,
  },
  {
    name: "schedule",
    group: "email",
    description: "Add it to my calendar",
    arg: "none",
    expand: (a) => also("Find the meeting, event or date in the email I have open (call current_view, then read_email) and propose it with create_event.", a),
  },
  { name: "clear", group: "mail", description: "Start a new conversation", arg: "none", local: "clear", expand: () => "" },
];

const ALIASES: Record<string, string> = { new: "clear" };

export function findCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  const key = Object.hasOwn(ALIASES, n) ? ALIASES[n] : n;
  return COMMANDS.find((c) => c.name === key);
}

export function matchCommands(prefix: string, ctx: { hasOpenEmail: boolean }): SlashCommand[] {
  const p = prefix.replace(/^\//, "").toLowerCase();
  return COMMANDS.filter((c) => (c.group === "mail" || ctx.hasOpenEmail) && c.name.startsWith(p));
}

/** "/name arg", "/name: arg" or "/name:arg" at the very start. Unknown names are not commands. */
export function parseSlash(text: string): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-z]+)(?::\s*|\s+|$)([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  const command = findCommand(m[1]);
  return command ? { command, arg: m[2].trim() } : null;
}

export interface SenderSuggestion {
  value: string;
  label: string;
  count: number;
  kind: "domain" | "address";
}

/** Senders and domains from local mail matching a prefix of the domain, address or name. Domains rank first. */
export function senderSuggestions(emails: Email[], query: string, limit = 6): SenderSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const domains = new Map<string, number>();
  const addresses = new Map<string, { name: string; count: number }>();
  for (const e of emails) {
    if (e.partial) continue;
    const addr = e.from.address.toLowerCase();
    const domain = addr.split("@")[1];
    if (domain) domains.set(domain, (domains.get(domain) ?? 0) + 1);
    const a = addresses.get(addr);
    if (a) a.count++;
    else addresses.set(addr, { name: e.from.name.trim(), count: 1 });
  }
  const starts = (s: string) => s.toLowerCase().split(/[\s.@]+/).some((w) => w.startsWith(q)) || s.toLowerCase().startsWith(q);
  const d: SenderSuggestion[] = [...domains].filter(([k]) => starts(k)).map(([k, count]) => ({ value: k, label: k, count, kind: "domain" }));
  const a: SenderSuggestion[] = [...addresses]
    .filter(([k, v]) => starts(k) || starts(v.name))
    .map(([k, v]) => ({ value: k, label: v.name || k, count: v.count, kind: "address" }));
  const byCount = (x: SenderSuggestion, y: SenderSuggestion) => y.count - x.count || x.value.localeCompare(y.value);
  return [...d.sort(byCount), ...a.sort(byCount)].slice(0, limit);
}

export type MenuItem = { type: "command"; command: SlashCommand } | { type: "sender"; s: SenderSuggestion } | { type: "person"; p: Person };

export interface InputState {
  chip: SlashCommand | null;
  text: string;
  menu: { items: MenuItem[]; active: number } | null;
  composing: boolean;
}

/** What a key does in the assistant input. "none" lets the textarea handle it. */
export function inputKeyAction(
  key: string,
  st: InputState,
  shift = false,
):
  | { do: "move"; active: number }
  | { do: "pick"; item: MenuItem }
  | { do: "close" }
  | { do: "remove_chip" }
  | { do: "send" }
  | { do: "none" } {
  if (st.composing) return { do: "none" };
  const menu = st.menu;
  if (menu && menu.items.length) {
    const n = menu.items.length;
    if (key === "ArrowDown") return { do: "move", active: (menu.active + 1) % n };
    if (key === "ArrowUp") return { do: "move", active: (menu.active - 1 + n) % n };
    if (key === "Tab" || (key === "Enter" && !shift)) return { do: "pick", item: menu.items[Math.min(menu.active, n - 1)] };
    if (key === "Escape") return { do: "close" };
    return { do: "none" };
  }
  if (key === "Enter" && !shift) return { do: "send" };
  if (key === "Backspace" && st.chip && st.text === "") return { do: "remove_chip" };
  return { do: "none" };
}
