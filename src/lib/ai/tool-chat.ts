// Tool calling for the assistant: one conversation format inside zMail, mapped
// to Anthropic's Messages API (tool_use / tool_result blocks) and to
// OpenAI-style /v1/chat/completions (tool_calls / role "tool"), which Ollama
// and custom servers also speak.

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments, or null when the model sent something that isn't a JSON object. */
  args: Record<string, unknown> | null;
}

export type AgentMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      /** Anthropic content blocks exactly as received, kept only while the turn that made
       *  them is running (server-tool blocks must go back verbatim). */
      raw?: Record<string, unknown>[];
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/**
 * History without Anthropic's raw server-tool blocks (encrypted search results are large and only
 * needed inside the turn that made them; later turns send the plain text, which the API accepts).
 * A paused turn left with no text and no tool calls is dropped: assistant content must not be empty.
 */
export function withoutRaw(h: AgentMessage[]): AgentMessage[] {
  if (!h.some((m) => m.role === "assistant" && m.raw)) return h;
  return h.flatMap((m) => {
    if (m.role !== "assistant" || !m.raw) return [m];
    const { raw: _raw, ...plain } = m;
    return plain.content || plain.toolCalls?.length ? [plain] : [];
  });
}

export interface AgentTurn {
  text: string;
  toolCalls: ToolCall[];
  /** Anthropic content blocks as received; set when the turn used a server tool or paused. */
  raw?: Record<string, unknown>[];
  /** Anthropic paused a long server-tool turn (pause_turn); sending `raw` back continues it. */
  paused?: boolean;
  /** What Claude's built-in web search looked up and cited this turn. */
  web?: { queries: string[]; sources: { url: string; title: string }[] };
  /** Claude's web search was refused for this account and the turn was answered without it. */
  searchUnavailable?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

type AnthropicBlock = { type: string; [k: string]: unknown };

export function anthropicBody(
  model: string,
  system: string,
  messages: AgentMessage[],
  tools: ToolDef[],
  maxTokens: number,
  serverTools: Record<string, unknown>[] = [],
) {
  const out: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    // Server-tool blocks (encrypted search results, citations) must go back exactly as received.
    else if (m.role === "assistant" && m.raw) out.push({ role: "assistant", content: m.raw as AnthropicBlock[] });
    else if (m.role === "assistant")
      out.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} })),
        ],
      });
    else {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out.at(-1);
      // Results for one assistant turn go back together in a single user message.
      if (last?.role === "user" && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return {
    model,
    max_tokens: maxTokens,
    system,
    tools: [...tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })), ...serverTools],
    messages: out,
  };
}

type AnthropicResBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown; content?: unknown; citations?: unknown };

export function fromAnthropic(res: { content: AnthropicResBlock[]; stop_reason?: string }): AgentTurn {
  if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
  const paused = res.stop_reason === "pause_turn";
  const server = res.content.some((b) => b.type === "server_tool_use" || b.type === "web_search_tool_result");
  const queries = res.content
    .filter((b) => b.type === "server_tool_use" && b.name === "web_search")
    .map((b) => (isObject(b.input) ? b.input.query : undefined))
    .filter((q): q is string => typeof q === "string");
  // Cited pages, de-duplicated by url in order of first citation.
  const sources: { url: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const b of res.content) {
    if (b.type !== "text" || !Array.isArray(b.citations)) continue;
    for (const c of b.citations as unknown[]) {
      if (!isObject(c) || c.type !== "web_search_result_location" || typeof c.url !== "string" || seen.has(c.url)) continue;
      seen.add(c.url);
      sources.push({ url: c.url, title: typeof c.title === "string" && c.title ? c.title : c.url });
    }
  }
  return {
    // Shallow copies: the blocks must go back to the API unmodified.
    ...(server || paused ? { raw: res.content.map((b) => ({ ...b })) } : {}),
    ...(paused ? { paused: true } : {}),
    ...(queries.length || sources.length ? { web: { queries, sources } } : {}),
    text: res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim(),
    toolCalls: res.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", args: isObject(b.input) ? b.input : null })),
  };
}

// Ignores assistant `raw` blocks: only Anthropic makes them, and the plain content stands in.
export function openaiBody(provider: string, model: string, system: string, messages: AgentMessage[], tools: ToolDef[], maxTokens: number) {
  return {
    model,
    messages: [
      { role: "system", content: system },
      ...messages.map((m) =>
        m.role === "user"
          ? { role: "user", content: m.content }
          : m.role === "assistant"
            ? {
                role: "assistant",
                content: m.content || null,
                ...(m.toolCalls?.length
                  ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }
                  : {}),
              }
            : { role: "tool", tool_call_id: m.toolCallId, content: m.content },
      ),
    ],
    tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    // OpenAI's reasoning models only accept max_completion_tokens.
    ...(provider === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
  };
}

function parseArgs(raw: string | undefined) {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

export function fromOpenAI(res: {
  choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments?: string } }[] } }[];
}): AgentTurn {
  const msg = res.choices[0]?.message;
  return {
    text: msg?.content?.trim() ?? "",
    toolCalls: (msg?.tool_calls ?? []).map((c, i) => ({ id: c.id || `call_${i}`, name: c.function.name, args: parseArgs(c.function.arguments) })),
  };
}
