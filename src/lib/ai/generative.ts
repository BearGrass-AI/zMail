// Generative model client for prose: summaries, drafts, stack explanations.
// Anthropic (Messages API) or any OpenAI-compatible /v1/chat/completions server.

import type { Email } from "@/lib/types";
import { HttpError, request } from "@/lib/transport";
import { ANTHROPIC_VERSION, apiBase, type LlmTypeId } from "./catalog";
import { anthropicBody, fromAnthropic, fromOpenAI, openaiBody, type AgentMessage, type AgentTurn, type ToolDef, withoutRaw } from "./tool-chat";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerativeProvider {
  readonly name: string;
  /** Can run Anthropic's server-side web search. */
  readonly builtinWebSearch?: boolean;
  complete(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<string>;
  /** One assistant turn with tools: text, tool calls, or both. */
  chat(system: string, messages: AgentMessage[], tools: ToolDef[], opts?: { maxTokens?: number; webSearch?: boolean }): Promise<AgentTurn>;
}

/** Anthropic's server-side web search tool. The basic version on purpose: newer ones add
 *  code-execution "dynamic filtering" blocks we don't handle. Each search is billed. */
export function webSearchTool(): Record<string, unknown> {
  return {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 5,
    user_location: { type: "approximate", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  };
}

/** `${baseUrl}|${model}` pairs whose org turned Claude's web search off; remembered for the session
 *  so later steps don't pay a failed request first. */
const builtinSearchOff = new Set<string>();

export interface HttpGenerativeConfig {
  provider: LlmTypeId;
  /** Base URL without /v1. */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/**
 * Anthropic uses the Messages API; every other type uses
 * OpenAI-style chat completions under `apiBase` (/v1 for most, the base itself for
 * Gemini and Perplexity). Requests are sent from Rust (no Anthropic
 * SDK there), so the Messages call is plain HTTP.
 */
export class HttpGenerativeProvider implements GenerativeProvider {
  readonly name: string;
  constructor(private cfg: HttpGenerativeConfig) {
    this.name = cfg.model;
  }

  async complete(messages: ChatMessage[], opts?: { maxTokens?: number }) {
    const api = apiBase(this.cfg.provider, this.cfg.baseUrl);
    const maxTokens = opts?.maxTokens ?? 1024;

    if (this.cfg.provider === "anthropic") {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const res = await request<{ content: { type: string; text?: string }[]; stop_reason?: string }>("POST", `${api}/messages`, {
        headers: { "x-api-key": this.cfg.apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION },
        body: {
          model: this.cfg.model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
        },
      });
      if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
      return res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    }

    const res = await request<{ choices: { message: { content: string | null }; finish_reason?: string }[] }>(
      "POST",
      `${api}/chat/completions`,
      {
        headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
        body: {
          model: this.cfg.model,
          messages,
          // OpenAI's reasoning models only accept max_completion_tokens.
          ...(this.cfg.provider === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
          // Thinking models (qwen3, etc.) would spend zMail's short budgets on
          // reasoning; Ollama's OpenAI endpoint turns it off with "none".
          ...(this.cfg.provider === "ollama" ? { reasoning_effort: "none" } : {}),
        },
      },
    );
    const choice = res.choices[0];
    const text = choice?.message.content?.trim() ?? "";
    if (!text && choice?.finish_reason === "length")
      throw new Error("The model used its whole token budget thinking and returned no text. Try a non-thinking model.");
    return text;
  }

  get builtinWebSearch() {
    return this.cfg.provider === "anthropic" && !builtinSearchOff.has(this.searchKey());
  }

  private searchKey() {
    return `${this.cfg.baseUrl}|${this.cfg.model}`;
  }

  async chat(system: string, messages: AgentMessage[], tools: ToolDef[], opts?: { maxTokens?: number; webSearch?: boolean }): Promise<AgentTurn> {
    const api = apiBase(this.cfg.provider, this.cfg.baseUrl);
    const maxTokens = opts?.maxTokens ?? 2048;
    if (this.cfg.provider === "anthropic") {
      const send = (serverTools: Record<string, unknown>[]) =>
        request<Parameters<typeof fromAnthropic>[0]>("POST", `${api}/messages`, {
          headers: { "x-api-key": this.cfg.apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION },
          body: anthropicBody(this.cfg.model, system, messages, tools, maxTokens, serverTools),
        });
      if (!opts?.webSearch || builtinSearchOff.has(this.searchKey())) return fromAnthropic(await send([]));
      try {
        return fromAnthropic(await send([webSearchTool()]));
      } catch (e) {
        // An org admin can turn web search off; answer without it rather than fail.
        if (e instanceof HttpError && e.status === 400 && /web.?search/i.test(e.body)) {
          builtinSearchOff.add(this.searchKey());
          // History may hold server_tool_use blocks, which the API rejects without the tool.
          messages = withoutRaw(messages);
          return { ...fromAnthropic(await send([])), searchUnavailable: true };
        }
        throw e;
      }
    }
    const res = await request<Parameters<typeof fromOpenAI>[0]>("POST", `${api}/chat/completions`, {
      headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
      body: openaiBody(this.cfg.provider, this.cfg.model, system, messages, tools, maxTokens),
    });
    return fromOpenAI(res);
  }
}

// ---- prompts ---------------------------------------------------------------

const SYSTEM =
  "You are zMail's writing assistant. Be concise, specific and plain-spoken. Never invent facts that are not in the email.";

export function summarize(p: GenerativeProvider, email: Email) {
  return p.complete(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Summarize this email in 2-3 sentences. Lead with what it wants from the reader, if anything.\n\nFrom: ${email.from.name} <${email.from.address}>\nSubject: ${email.subject}\n\n${email.text.slice(0, 6000)}`,
      },
    ],
    { maxTokens: 200 },
  );
}

/** One line of context for list rows: what the email wants, in ≤18 words. */
export function oneLiner(p: GenerativeProvider, email: Email) {
  return p
    .complete(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `In one line (max 18 words, no preamble), say what this email wants from the reader and any deadline.\n\nFrom: ${email.from.name}\nSubject: ${email.subject}\n\n${email.text.slice(0, 3000)}`,
      },
    ],
    { maxTokens: 50 },
    )
    .then((line) => (isRefusal(line) ? "" : line));
}

/** "I can't help with that." and the like: a refusal, not a summary, so it isn't shown. */
export function isRefusal(text: string) {
  return /^\W*(i(?:['’]m| am)? (?:sorry|unable|not able)|i can(?:no|['’])t|as an ai\b)/i.test(text.trim());
}

export interface Draft {
  /** Only for new messages; replies keep "Re: …". */
  subject?: string;
  body: string;
}

/** Split a "Subject: …" first line (models sometimes bold it) from the body. */
export function parseDraft(raw: string): Draft {
  const m = /^\s*(?:\*\*)?subject:(?:\*\*)?\s*(.+?)(?:\*\*)?\s*(?:\r?\n|$)([\s\S]*)$/i.exec(raw);
  if (!m) return { body: raw.trim() };
  return { subject: m[1].trim().replace(/^["']|["']$/g, ""), body: m[2].trim() };
}

export interface DraftRecipient {
  name: string;
  address: string;
  title?: string;
  department?: string;
  role: "to" | "cc";
}

export async function draft(
  p: GenerativeProvider,
  ask: string,
  me: { name: string },
  replyTo?: Email,
  recipients: DraftRecipient[] = [],
): Promise<Draft> {
  const people = recipients.length
    ? `Recipients:\n${recipients
        .map((r) => `- ${r.role === "cc" ? "Cc" : "To"}: ${r.name}${[r.title, r.department].filter(Boolean).length ? ` (${[r.title, r.department].filter(Boolean).join(", ")})` : ""}`)
        .join("\n")}\nAddress the To recipients by first name. Cc recipients are only copied.\n\n`
    : "";
  const context =
    (replyTo ? `You are replying to:\nFrom: ${replyTo.from.name}\nSubject: ${replyTo.subject}\n\n${replyTo.text.slice(0, 4000)}\n\n` : "") + people;
  const shape = replyTo
    ? "Return only the email body"
    : 'Start with one line "Subject: <a short subject a person would write, not the instruction>", then a blank line, then the email body';
  const raw = await p.complete([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `${context}Write an email for ${me.name}. Instruction: ${ask}\n${shape}, signed "${me.name.split(" ")[0]}".`,
    },
  ]);
  const out = parseDraft(raw);
  return replyTo ? { body: out.subject ? out.body : raw.trim() } : out;
}

export function describeStack(p: GenerativeProvider, title: string, emails: Email[]) {
  const lines = emails
    .slice(0, 25)
    .map((e) => `- ${e.from.name}: ${e.subject}`)
    .join("\n");
  return p.complete(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `These emails were grouped as "${title}". In one sentence (max 30 words), say what they have in common and name a few senders.\n\n${lines}`,
      },
    ],
    { maxTokens: 80 },
  );
}
