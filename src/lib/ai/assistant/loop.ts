// src/lib/ai/assistant/loop.ts
// One user message → model turns and tool runs until the model answers in
// text, at most MAX_STEPS model calls. Tool results always follow their tool
// calls in history, so the conversation stays valid for both API formats.

import type { GenerativeProvider } from "@/lib/ai/generative";
import type { AgentMessage, ToolCall } from "@/lib/ai/tool-chat";
import { assistantProvider } from "@/lib/ai/providers";
import { allInboxesUnread, folderUnread, useMail } from "@/lib/store";
import { localDate } from "@/lib/ai/dates";
import { useAssistant, withoutRaw, type Card, type Item } from "./state";
import { TOOLS, executeTool, type ToolDeps } from "./tools";
import { PASSAGES_TOOL, passagesReady } from "./modules/passages";
import { systemPrompt } from "./prompts";
import { realDeps } from "./deps";
import { useSettings } from "@/lib/settings";
import { currentChoiceKey } from "./model-choices";
import { useModelHealth } from "./model-health";
import { withMentions, type MentionRef } from "./mentions";

export const MAX_STEPS = 8;

function context() {
  const s = useMail.getState();
  const inboxes = s.accounts
    .map((a) => {
      const inbox = s.folders.find((f) => f.accountId === a.id && f.system === "inbox");
      return inbox ? `${a.label ?? a.name} Inbox ${folderUnread(s, inbox).toLocaleString()} unread` : null;
    })
    .filter(Boolean);
  if (inboxes.length > 1) inboxes.unshift(`All Inboxes ${allInboxesUnread(s).toLocaleString()} unread`);
  return { name: s.me.name, today: localDate(new Date()), accounts: s.accounts.map((a) => `${a.label ?? a.name} (${a.address}, id ${a.id})`), inboxes: inboxes.join("; ") };
}

/** Most history messages sent to the model per step, and the longest single tool result. */
export const HISTORY_MAX = 60;
export const TOOL_RESULT_MAX = 12_000;

/**
 * What the model sees: the last HISTORY_MAX messages, starting at a user message (tool results
 * must follow their calls), with oversized tool results cut short.
 */
export function boundHistory(h: AgentMessage[]): AgentMessage[] {
  let start = Math.max(0, h.length - HISTORY_MAX);
  while (start < h.length && h[start].role !== "user") start++;
  // One turn longer than the window still has to start at its user message.
  if (start >= h.length) start = Math.max(0, h.map((m) => m.role === "user").lastIndexOf(true));
  return h.slice(start).map((m) => (m.role === "tool" && m.content.length > TOOL_RESULT_MAX ? { ...m, content: `${m.content.slice(0, TOOL_RESULT_MAX)}… (truncated)` } : m));
}

const shortArgs = (args: ToolCall["args"]) => {
  const s = JSON.stringify(args ?? {});
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

/**
 * Cut off a trailing assistant turn whose tool calls weren't all answered (Stop, a redirect, or
 * zMail closing mid-loop). Calls in it that did run are noted, so the model doesn't repeat them.
 */
function repairHistory() {
  let ran: string[] = [];
  useAssistant.setState((s) => {
    const h = s.history;
    const i = h.map((m) => m.role === "assistant" && !!m.toolCalls?.length).lastIndexOf(true);
    if (i < 0) return {};
    const calls = (h[i] as { toolCalls: ToolCall[] }).toolCalls;
    const results = new Map(h.slice(i + 1).flatMap((m) => (m.role === "tool" ? [[m.toolCallId, m.content] as const] : [])));
    if (calls.every((c) => results.has(c.id))) return {};
    ran = calls.filter((c) => results.has(c.id) && !failed(results.get(c.id)!)).map((c) => `${c.name} ${shortArgs(c.args)}`);
    return { history: h.slice(0, i) };
  });
  if (ran.length) useAssistant.getState().note(`Before stopping, these already ran: ${ran.join("; ")}`);
}

/** A tool result that reports an error (nothing happened). */
function failed(content: string): boolean {
  try {
    const v = JSON.parse(content) as unknown;
    return !!v && typeof v === "object" && "error" in v;
  } catch {
    return false;
  }
}

export async function ask(text: string, deps: ToolDeps = realDeps(), provider: GenerativeProvider = assistantProvider(), opts: { retrying?: boolean; display?: { command: string; text: string }; userId?: string; modelKey?: string | null; mentions?: MentionRef[] } = {}) {
  const st = useAssistant.getState();
  if (st.busy || st.clearing || !text.trim()) return;
  // Each user message gets a fresh DIRECT_LIMIT-email budget for unconfirmed actions. Retry re-runs the same
  // message (only the latest error offers it), so what that message already changed still counts.
  useAssistant.setState((s) => ({ busy: true, directThisTurn: opts.retrying ? s.directThisTurn : 0, progress: null }));
  const chat = st.chatId;
  const turnAt = st.turnId;
  const stale = () => {
    const now = useAssistant.getState();
    return now.chatId !== chat || now.turnId !== turnAt;
  };
  repairHistory();
  // A retry keeps its user message (retry() already put it back, followed by any cards the failed turn made).
  const userId = opts.retrying ? opts.userId : st.push({ kind: "user", text, ...(opts.display ? { display: opts.display } : {}), ...(opts.mentions?.length ? { mentions: opts.mentions } : {}) });
  const notes = st.drainNotes();
  const sent = withMentions(text, opts.mentions);
  st.pushHistory({ role: "user", content: notes.length ? `${notes.map((n) => `[zMail: ${n}]`).join("\n")}\n\n${sent}` : sent });
  const modelKey = opts.modelKey ?? currentChoiceKey(useSettings.getState());
  // Steps in a row where every tool call was malformed. Calls that fail because something is missing
  // (a folder, a stale id) aren't malformed, so a model working against a gap in zMail isn't blamed.
  let struggling = 0;
  // Web search: Claude's built-in server tool with Anthropic models, else the search_web tool when a service is set up.
  const ws = useSettings.getState().webSearch;
  // Re-read each step: the provider drops the built-in search for good once an org turns it off.
  // find_passages only while meaning-based search is ready (checked once per message, locally).
  const passages = await passagesReady();
  const searchSetup = () => {
    const builtin = ws.builtin && provider.builtinWebSearch === true;
    const offered = (name: string) => (name === "search_web" ? !builtin && ws.service !== "none" : name !== PASSAGES_TOOL || passages);
    return { builtin, tools: TOOLS.filter((t) => offered(t.name)) };
  };
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const { builtin, tools } = searchSetup();
      const turn = await provider.chat(systemPrompt(context()), boundHistory(useAssistant.getState().history), tools, { webSearch: builtin });
      if (stale()) return;
      if (turn.searchUnavailable)
        st.push({ kind: "step", text: `Claude's web search is turned off for this account; ${ws.service !== "none" ? "using the search service" : "no web search available"}` });
      for (const q of turn.web?.queries ?? []) st.push({ kind: "step", text: `Searched the web · "${q}"` });
      if (turn.paused) {
        // A long search turn was paused: send it back unchanged and the API carries on. Its partial text
        // isn't shown; the continuation is.
        st.pushHistory({ role: "assistant", content: turn.text, raw: turn.raw });
        continue;
      }
      if (!turn.text && !turn.toolCalls.length) {
        // Anthropic rejects empty assistant content, so never store one.
        st.push({ kind: "error", text: "The model returned an empty reply.", retry: userId });
        return;
      }
      st.pushHistory({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined, ...(turn.raw ? { raw: turn.raw } : {}) });
      if (turn.text) st.push({ kind: "assistant", text: turn.text, ...(turn.web?.sources.length ? { webSources: turn.web.sources } : {}) });
      if (!turn.toolCalls.length) return;
      let malformed = 0;
      let succeeded = 0;
      for (const call of turn.toolCalls) {
        const res = await executeTool(call, deps);
        if (stale()) return;
        const content = JSON.stringify(res.content);
        st.pushHistory({ role: "tool", toolCallId: call.id, name: call.name, content });
        if (res.malformed) malformed++;
        else if (!failed(content)) succeeded++;
      }
      struggling = malformed === turn.toolCalls.length ? struggling + 1 : 0;
      if (struggling >= 2) {
        if (modelKey) useModelHealth.getState().mark(modelKey, "struggled");
        st.push({ kind: "error", text: "This model isn't handling zMail's tools well.", retry: userId, toolTrouble: true });
        return;
      }
      if (succeeded && modelKey) useModelHealth.getState().mark(modelKey, "ok");
    }
    st.push({ kind: "error", text: `Stopped after ${MAX_STEPS} steps without finishing. Try asking in smaller pieces.` });
  } catch (err) {
    if (stale()) return;
    st.push({ kind: "error", text: err instanceof Error ? err.message : String(err), retry: userId });
  } finally {
    // Compact: raw server-tool blocks only matter inside this turn. A stopped turn compacts too, unless a
    // newer turn is already running (it compacts when it ends).
    if (!stale() || !useAssistant.getState().busy) {
      const h = useAssistant.getState().history;
      const compact = withoutRaw(h);
      if (compact !== h) useAssistant.setState({ history: compact });
    }
    if (!stale()) useAssistant.setState({ busy: false, progress: null });
  }
}

/** How a card kept by retry is described to the model: something that happened, or a card still waiting. */
function cardState(c: Card): { done?: string; waiting?: string } {
  switch (c.type) {
    case "bulk":
      return c.status === "done" || c.status === "partial" ? { done: c.title } : c.status === "pending" ? { waiting: c.title } : {};
    case "confirm":
      return c.status === "done" ? { done: c.result ? `${c.title} (${c.result})` : c.title } : c.status === "pending" ? { waiting: c.title } : {};
    case "event":
      return c.status === "added" ? { done: `Added “${c.event.title}” to the calendar` } : c.status === "pending" ? { waiting: `Add “${c.event.title}”` } : {};
    case "rule":
      return c.status === "saved" ? { done: `Saved a rule for ${c.from}` } : c.status === "pending" ? { waiting: `Rule for ${c.from}` } : {};
    case "unsubscribe":
      return c.status === "done" ? { done: `Unsubscribed from ${c.from}` } : c.status === "pending" ? { waiting: `Unsubscribe from ${c.from}` } : {};
    case "draft":
      return { done: c.summary };
  }
}

/**
 * Ask again after a model error: restart that turn cleanly, dropping the unanswered message and anything it
 * produced, except cards. Those changed mail, opened drafts, or are waiting on (or in the middle of) the
 * user's OK, so they stay right after the message, and the model is told so it doesn't make them again.
 * `key` is the user item's id; old saved conversations stored the message text, so that still matches.
 */
export async function retry(key: string, deps?: ToolDeps, provider?: GenerativeProvider) {
  if (useAssistant.getState().busy) return;
  const done: string[] = [];
  const waiting: string[] = [];
  let again: Extract<Item, { kind: "user" }> | undefined;
  useAssistant.setState((s) => {
    let ii = s.items.findIndex((i) => i.kind === "user" && i.id === key);
    if (ii < 0) ii = s.items.map((i) => i.kind === "user" && i.text === key).lastIndexOf(true);
    const user = ii >= 0 ? (s.items[ii] as Extract<Item, { kind: "user" }>) : undefined;
    const text = user ? user.text : key;
    const hi = s.history.map((m) => m.role === "user" && m.content.endsWith(withMentions(text, user?.mentions))).lastIndexOf(true);
    const history = hi >= 0 ? s.history.slice(0, hi) : s.history;
    if (!user) return { history, items: s.items.filter((i) => !(i.kind === "error" && i.retry === key)) };
    again = user;
    const kept = s.items.slice(ii + 1).filter((i) => i.kind === "card");
    for (const i of kept) {
      if (i.kind !== "card") continue;
      const st = cardState(i.card);
      if (st.done) done.push(st.done);
      if (st.waiting) waiting.push(st.waiting);
    }
    return { history, items: [...s.items.slice(0, ii + 1), ...kept] };
  });
  if (done.length) useAssistant.getState().note(`Already done before the error: ${done.join("; ")}`);
  if (waiting.length) useAssistant.getState().note(`Cards already showing, awaiting the user's confirmation (don't make them again): ${waiting.join("; ")}`);
  if (again) return ask(again.text, deps, provider, { retrying: true, display: again.display, userId: again.id, mentions: again.mentions });
  return ask(key, deps, provider, { retrying: true });
}
