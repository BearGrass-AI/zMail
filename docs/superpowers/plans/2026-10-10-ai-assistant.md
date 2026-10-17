# AI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a side-panel assistant to zMail. It searches the whole mailbox, breaks result sets down, reads emails, and proposes or runs actions (archive, trash, move, mark read, sections, calendar events, drafts) behind an approval gate. It never sends mail.

**Architecture:** A tool-using loop (`src/lib/ai/assistant/loop.ts`) sends the conversation and zMail's tool schemas to the assistant model through a new `chat()` on the model client. That client speaks Anthropic `tool_use` and OpenAI `tool_calls`. Tools run locally against injectable `ToolDeps` (`deps.ts` wires the real store and mail providers). Mail providers gain server search, light header rows and batch edits. A small zustand store holds the conversation, result sets and cards. The panel and the "assistant set" mail list read from it.

**Tech Stack:** Tauri 2, React 19, TypeScript, Zustand v5, Tailwind v4, shadcn (Base UI), Motion, Vitest (jsdom), Gmail API, Microsoft Graph.

**Spec:** `docs/superpowers/specs/2026-10-10-ai-assistant-design.md`

## Global Constraints

- The assistant has **no send tool**. Drafts open in compose and the user presses Send.
- Approval gate: `archive`, `mark_read`, `mark_unread`, `star`, `unstar` and `move_to_section` on **25 emails or fewer** run directly with Undo. Everything else (trash, spam, move to folder, any action on **more than 25** emails, calendar events) shows a confirm card first.
- Bulk actions only take **set ids** produced by `search_mail` or `break_down`, or **email ids the assistant was shown** in a tool result. The model can't act on ids it made up.
- Result sets are capped at **10,000** emails.
- `read_email` returns at most **6,000** characters of body. Search samples are at most **20** rows. Kind labelling sends sender and subject only, in batches of **200**.
- At most **8** tool steps per user message. **2** malformed tool calls in a row end the turn with the "isn't handling zMail's tools well" message.
- API keys live in the macOS Keychain (`setSecret`), never in localStorage.
- Never use Gmail tabs or `CATEGORY_*` labels, or Outlook Focused, as signals for kinds or sorting.
- Never mention the user's personal server or its hostname in UI, defaults, comments or docs.
- Tests and the browser preview use mock providers only. Never the user's Jev key, Anthropic or OpenAI keys, or Ollama server.
- Zustand v5: selectors must not return new objects or arrays. Derive in `useMemo`.
- Base UI menus: put labels inside a Group; use `closeOnClick` on radio items.
- Two deliberate refinements of the spec:
  - **Kind breakdowns** map only zMail categories that mean one thing; `transactions` and `updates` mail is labelled by the model (Task 9).
  - **With no model configured**, the panel runs an offline demo agent with a note pointing to Settings, instead of only a setup prompt. That keeps the browser preview usable (Tasks 11–12).
- Only change the UI the spec names: the sidebar ✦ button, the new panel, the assistant-set list, the Settings "Assistant model" group, and an optional callback on `SuggestionCard`.
- Typecheck with `npx tsc --noEmit -p .`. Test with `npx vitest run`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Sets that span accounts** (Gmail plus Outlook): bulk actions split per account, and a folder target from one account must not be applied to the other account's mail. Those emails are reported as failed with a clear reason. *Test: Task 7, "move to a folder only moves that folder's account".*
2. **Relaunch in the middle of a bulk action:** a card saved while running comes back as **interrupted**, with Resume. It never stays spinning forever. *Test: Task 8, "running cards load as interrupted".*
3. **Quotes and apostrophes in query values** (`O'Reilly`, `"budget"`): Gmail `q` and Graph `$search`/`$filter` strings stay well-formed. *Test: Task 3, "quotes and apostrophes don't break the query".*
4. **"This" pointing at a row that isn't loaded yet** (a search header row): `read_email` and `draft` fetch the full message first. *Test: Task 10, "read_email loads a header-only email in full".*
5. **New chat while a bulk action is running:** the action finishes, and updating a card that no longer exists is a harmless no-op. *Test: Task 8, "patchCard on a missing item does nothing".*

---

### Task 1: Tool calling in the model client

**Files:**
- Create: `src/lib/ai/tool-chat.ts`
- Modify: `src/lib/ai/generative.ts` (the interface plus `HttpGenerativeProvider.chat`)
- Modify: `src/lib/ai/mock-generative.ts` (a temporary `chat` that explains it's offline; Task 11 replaces it)
- Test: `src/lib/__tests__/tool-chat.test.ts`

**Interfaces:**
- Produces:
  - `ToolDef {name, description, parameters}`
  - `ToolCall {id, name, args: Record<string, unknown> | null}`
  - `AgentMessage` (user / assistant with `toolCalls?` / tool)
  - `AgentTurn {text, toolCalls}`
  - `anthropicBody`, `fromAnthropic`, `openaiBody`, `fromOpenAI`
  - `GenerativeProvider.chat(system: string, messages: AgentMessage[], tools: ToolDef[], opts?: {maxTokens?: number}): Promise<AgentTurn>`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/tool-chat.test.ts
import { describe, expect, it } from "vitest";
import { anthropicBody, fromAnthropic, fromOpenAI, openaiBody, type AgentMessage, type ToolDef } from "@/lib/ai/tool-chat";

const tools: ToolDef[] = [{ name: "search_mail", description: "Find mail", parameters: { type: "object", properties: { from: { type: "string" } } } }];
const convo: AgentMessage[] = [
  { role: "user", content: "amazon emails" },
  { role: "assistant", content: "Looking.", toolCalls: [{ id: "c1", name: "search_mail", args: { from: "amazon.com" } }, { id: "c2", name: "current_view", args: {} }] },
  { role: "tool", toolCallId: "c1", name: "search_mail", content: '{"count":3}' },
  { role: "tool", toolCallId: "c2", name: "current_view", content: "{}" },
];

describe("Anthropic tool format", () => {
  it("sends tools as input_schema and groups tool results into one user message", () => {
    const body = anthropicBody("claude-x", "sys", convo, tools, 1000);
    expect(body.system).toBe("sys");
    expect(body.tools[0]).toEqual({ name: "search_mail", description: "Find mail", input_schema: tools[0].parameters });
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "c1", name: "search_mail", input: { from: "amazon.com" } },
      { type: "tool_use", id: "c2", name: "current_view", input: {} },
    ]);
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: '{"count":3}' },
        { type: "tool_result", tool_use_id: "c2", content: "{}" },
      ],
    });
  });

  it("reads text and tool_use blocks back", () => {
    const turn = fromAnthropic({ content: [{ type: "text", text: " Found 3. " }, { type: "tool_use", id: "t9", name: "break_down", input: { set_id: "s1", by: "kind" } }] });
    expect(turn).toEqual({ text: "Found 3.", toolCalls: [{ id: "t9", name: "break_down", args: { set_id: "s1", by: "kind" } }] });
  });

  it("throws on refusal", () => {
    expect(() => fromAnthropic({ content: [], stop_reason: "refusal" })).toThrow(/declined/);
  });
});

describe("OpenAI tool format", () => {
  it("sends function tools, assistant tool_calls with JSON arguments, and role tool results", () => {
    const body = openaiBody("openai", "gpt-x", "sys", convo, tools, 1000);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "Looking.",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "search_mail", arguments: '{"from":"amazon.com"}' } },
        { id: "c2", type: "function", function: { name: "current_view", arguments: "{}" } },
      ],
    });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"count":3}' });
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "search_mail", description: "Find mail", parameters: tools[0].parameters } });
    expect(body).toHaveProperty("max_completion_tokens", 1000);
    expect(openaiBody("ollama", "qwen3", "sys", convo, tools, 1000)).toHaveProperty("max_tokens", 1000);
  });

  it("parses tool_calls, marking bad JSON arguments as null", () => {
    const turn = fromOpenAI({
      choices: [{ message: { content: null, tool_calls: [{ id: "a", function: { name: "act", arguments: '{"op":"trash"}' } }, { id: "", function: { name: "act", arguments: "{oops" } }] } }],
    });
    expect(turn.text).toBe("");
    expect(turn.toolCalls).toEqual([
      { id: "a", name: "act", args: { op: "trash" } },
      { id: "call_1", name: "act", args: null },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/tool-chat.test.ts`
Expected: FAIL, "Failed to resolve import @/lib/ai/tool-chat".

- [ ] **Step 3: Write `tool-chat.ts`**

```ts
// src/lib/ai/tool-chat.ts
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
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface AgentTurn {
  text: string;
  toolCalls: ToolCall[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

type AnthropicBlock = { type: string; [k: string]: unknown };

export function anthropicBody(model: string, system: string, messages: AgentMessage[], tools: ToolDef[], maxTokens: number) {
  const out: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: [{ type: "text", text: m.content }] });
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
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    messages: out,
  };
}

export function fromAnthropic(res: { content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; stop_reason?: string }): AgentTurn {
  if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
  return {
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
```

- [ ] **Step 4: Add `chat` to the interface and the HTTP provider**

In `src/lib/ai/generative.ts`, extend the imports and the interface:

```ts
import { anthropicBody, fromAnthropic, fromOpenAI, openaiBody, type AgentMessage, type AgentTurn, type ToolDef } from "./tool-chat";

export interface GenerativeProvider {
  readonly name: string;
  complete(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<string>;
  /** One assistant turn with tools: text, tool calls, or both. */
  chat(system: string, messages: AgentMessage[], tools: ToolDef[], opts?: { maxTokens?: number }): Promise<AgentTurn>;
}
```

Add this method to `HttpGenerativeProvider` after `complete`:

```ts
  async chat(system: string, messages: AgentMessage[], tools: ToolDef[], opts?: { maxTokens?: number }): Promise<AgentTurn> {
    const base = normalizeBase(this.cfg.baseUrl);
    const maxTokens = opts?.maxTokens ?? 2048;
    if (this.cfg.provider === "anthropic") {
      const res = await request<Parameters<typeof fromAnthropic>[0]>("POST", `${base}/v1/messages`, {
        headers: { "x-api-key": this.cfg.apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION },
        body: anthropicBody(this.cfg.model, system, messages, tools, maxTokens),
      });
      return fromAnthropic(res);
    }
    const res = await request<Parameters<typeof fromOpenAI>[0]>("POST", `${base}/v1/chat/completions`, {
      headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
      body: openaiBody(this.cfg.provider, this.cfg.model, system, messages, tools, maxTokens),
    });
    return fromOpenAI(res);
  }
```

In `src/lib/ai/mock-generative.ts`, add the import and a method to `MockGenerativeProvider` (Task 11 replaces it):

```ts
import type { AgentMessage, AgentTurn, ToolDef } from "./tool-chat";

  async chat(_system: string, _messages: AgentMessage[], _tools: ToolDef[]): Promise<AgentTurn> {
    return { text: "The offline mock can't run the assistant yet. Choose an assistant model in Settings → AI Models.", toolCalls: [] };
  }
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run src/lib/__tests__/tool-chat.test.ts && npx tsc --noEmit -p .`
Expected: PASS, no type errors. If any other test file defines a `GenerativeProvider` object literal, add a `chat` that returns `{ text: "", toolCalls: [] }` there.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/tool-chat.ts src/lib/ai/generative.ts src/lib/ai/mock-generative.ts src/lib/__tests__/tool-chat.test.ts
git commit -m "Assistant: tool calling for Anthropic and OpenAI-style models

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Assistant model setting

**Files:**
- Modify: `src/lib/settings.ts` (the `assistant` endpoint, key handling)
- Modify: `src/lib/ai/providers.ts` (`assistantProvider`, `assistantModelName`)
- Modify: `src/components/settings/settings-dialog.tsx` (`EndpointGroup` accepts `"assistant"`; new group in `Models()`)
- Test: `src/lib/__tests__/assistant-provider.test.ts`

**Interfaces:**
- Consumes: `HttpGenerativeProvider`, `MockGenerativeProvider` (Task 1).
- Produces:
  - `Settings.assistant: ModelEndpoint`
  - `type EndpointWhich = "decision" | "generative" | "assistant"`
  - `assistantProvider(): GenerativeProvider` (the assistant endpoint, else the writing model, else the mock)
  - `assistantModelName(): string`
  - `assistantIsOffline(): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/assistant-provider.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "@/lib/settings";
import { assistantIsOffline, assistantModelName, assistantProvider } from "@/lib/ai/providers";
import { HttpGenerativeProvider } from "@/lib/ai/generative";
import { MockGenerativeProvider } from "@/lib/ai/mock-generative";

const ep = (provider: string, model: string) => ({ provider: provider as never, baseUrl: provider === "mock" ? "" : "https://api.example.com", model, apiKey: "k", models: [] });

beforeEach(() => useSettings.setState({ assistant: ep("mock", ""), generative: ep("mock", "") }));

describe("assistant model", () => {
  it("uses its own setting when configured", () => {
    useSettings.setState({ assistant: ep("anthropic", "claude-sonnet"), generative: ep("ollama", "qwen3") });
    expect(assistantProvider()).toBeInstanceOf(HttpGenerativeProvider);
    expect(assistantModelName()).toBe("claude-sonnet");
    expect(assistantIsOffline()).toBe(false);
  });

  it("falls back to the writing model when unset", () => {
    useSettings.setState({ generative: ep("ollama", "qwen3") });
    expect(assistantProvider().name).toBe("qwen3");
    expect(assistantModelName()).toBe("qwen3");
  });

  it("is the offline mock when neither is set", () => {
    expect(assistantProvider()).toBeInstanceOf(MockGenerativeProvider);
    expect(assistantIsOffline()).toBe(true);
    expect(assistantModelName()).toBe("Offline demo");
  });

  it("never writes the assistant key to localStorage", () => {
    useSettings.getState().setEndpoint("assistant", { apiKey: "secret-key" });
    expect(localStorage.getItem("zmail.settings") ?? "").not.toContain("secret-key");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/assistant-provider.test.ts`
Expected: FAIL, `assistantProvider` is not exported.

- [ ] **Step 3: Add the endpoint to settings**

In `src/lib/settings.ts`:

```ts
export type EndpointWhich = "decision" | "generative" | "assistant";

export interface Settings {
  theme: ThemeMode;
  palette: PaletteId;
  hues: Partial<Record<Tinted, number>>;
  decision: ModelEndpoint;
  generative: ModelEndpoint;
  /** The ✦ Assistant's model; when unset the assistant uses the writing model. */
  assistant: ModelEndpoint;
  suggestThreshold: number;
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  setEndpoint: (which: EndpointWhich, patch: Partial<ModelEndpoint>) => void;
  setHue: (key: Tinted, hue: number | undefined) => void;
}
```

In the initial state add `assistant: blank(),` after `generative: blank(),`. In `partialize` add `assistant: { ...rest.assistant, apiKey: "" },`. Change `keyName`, `saveKeySoon` and the `hydrateApiKeys` loop to use `EndpointWhich`, with the loop over `["decision", "generative", "assistant"] as const`. No persist version bump is needed: zustand merges the missing `assistant` from the initial state.

- [ ] **Step 4: Add the resolvers in `src/lib/ai/providers.ts`**

```ts
import type { ModelEndpoint } from "@/lib/settings";

const isReal = (e: ModelEndpoint) => e.provider !== "mock" && !!e.baseUrl && !!e.model;

function httpWriter(e: ModelEndpoint) {
  return new HttpGenerativeProvider({ provider: e.provider as "anthropic" | "openai" | "ollama" | "custom", baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey });
}

/** The assistant's model: its own setting, else the writing model, else the offline mock. */
export function assistantProvider(): GenerativeProvider {
  const { assistant, generative } = useSettings.getState();
  if (isReal(assistant)) return httpWriter(assistant);
  if (isReal(generative)) return httpWriter(generative);
  return new MockGenerativeProvider();
}

export function assistantIsOffline() {
  const { assistant, generative } = useSettings.getState();
  return !isReal(assistant) && !isReal(generative);
}

export function assistantModelName() {
  const { assistant, generative } = useSettings.getState();
  return isReal(assistant) ? assistant.model : isReal(generative) ? generative.model : "Offline demo";
}
```

Make `generativeProvider()` use `httpWriter(g)` for its HTTP branch so the construction lives in one place.

- [ ] **Step 5: Add the Settings group**

In `src/components/settings/settings-dialog.tsx`, change the `EndpointGroup` signature to `{ which: EndpointWhich; ... }` (import `EndpointWhich` from `@/lib/settings`). The `kind` line stays: `const kind = which === "decision" ? "decision" : "writing";`. In `Models()`, add after the writing model group:

```tsx
      <EndpointGroup
        which="assistant"
        title="Assistant model"
        footer="Runs the ✦ Assistant: it searches, reads and acts on your mail using tools, so pick a model that supports tool calling (Claude, GPT, qwen3…). Left on Offline mock, the assistant uses your writing model. It sends your messages, short previews of search results, and an email's full text only when it opens that email."
      />
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run src/lib/__tests__/assistant-provider.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/settings.ts src/lib/ai/providers.ts src/components/settings/settings-dialog.tsx src/lib/__tests__/assistant-provider.test.ts
git commit -m "Assistant: its own model setting, falling back to the writing model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Structured mail queries

**Files:**
- Create: `src/lib/ai/assistant/query.ts`
- Test: `src/lib/__tests__/assistant-query.test.ts`

**Interfaces:**
- Produces:
  - `MailQuery` (fields below)
  - `cleanQuery(raw: unknown): MailQuery` (throws `Error("bad_query: …")`)
  - `resolveFolder(q, accountId, folders): Folder | undefined`
  - `gmailQuery(q, folder: Folder | undefined, folders: Folder[]): string`
  - `graphQuery(q): { search?: string; filter?: string; local: (e: Email) => boolean }`
  - `LocalCtx`
  - `matchesLocal(e, q, ctx: LocalCtx): boolean`
  - `describeQuery(q, names?: { folder?: string; section?: string }): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/assistant-query.test.ts
import { describe, expect, it } from "vitest";
import type { Email, Folder } from "@/lib/types";
import { cleanQuery, describeQuery, gmailQuery, graphQuery, matchesLocal, resolveFolder } from "@/lib/ai/assistant/query";

const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:ARCHIVE", accountId: "g", name: "All Mail", system: "archive" },
  { id: "g:path:Finance", accountId: "g", name: "Finance" },
  { id: "g:Label_7", accountId: "g", name: "Taxes 2025", parentId: "g:path:Finance" },
];
const mail = (over: Partial<Email> = {}): Email =>
  ({ id: "e1", accountId: "g", threadId: "e1", folderId: "g:INBOX", from: { name: "Amazon.com", address: "shipment-tracking@amazon.com" }, to: [{ name: "Z", address: "z@x.com" }], subject: "Your package was delivered", snippet: "", text: "Delivered to your porch.", date: "2025-03-04T10:00:00Z", unread: true, starred: false, labels: [], ...over }) as Email;

describe("cleanQuery", () => {
  it("keeps known fields, trims, and drops unknown ones", () => {
    expect(cleanQuery({ from: " amazon.com ", unread: true, color: "red", after: "2024-01-01" })).toEqual({ from: "amazon.com", unread: true, after: "2024-01-01" });
  });
  it("rejects malformed dates and wrong types", () => {
    expect(() => cleanQuery({ after: "last week" })).toThrow(/bad_query/);
    expect(() => cleanQuery({ unread: "yes" })).toThrow(/bad_query/);
    expect(() => cleanQuery("amazon")).toThrow(/bad_query/);
  });
});

describe("Gmail q", () => {
  it("builds sender, words, dates and flags", () => {
    const q = cleanQuery({ from: "amazon.com", words: "order", after: "2024-01-01", before: "2025-01-01", unread: true, hasAttachment: true });
    expect(gmailQuery(q, undefined, folders)).toBe("from:amazon.com order after:2024/01/01 before:2025/01/01 is:unread has:attachment");
  });
  it("maps folders to in: terms and nested labels to their full name", () => {
    expect(gmailQuery({ folder: "inbox" }, resolveFolder({ folder: "inbox" }, "g", folders), folders)).toBe("in:inbox");
    expect(gmailQuery({ folder: "g:Label_7" }, resolveFolder({ folder: "g:Label_7" }, "g", folders), folders)).toBe("label:finance-taxes-2025");
  });
  it("quotes and apostrophes don't break the query", () => {
    expect(gmailQuery({ from: "O'Reilly Media", subject: 'the "budget" (final)' }, undefined, folders)).toBe(`from:"O'Reilly Media" subject:(the budget final)`);
  });
});

describe("Graph query", () => {
  it("uses KQL $search when there are sender/word terms, and filters flags locally", () => {
    const g = graphQuery({ from: "amazon.com", words: "order", after: "2024-01-01", unread: true });
    expect(g.search).toBe("from:amazon.com order received>=2024-01-01");
    expect(g.filter).toBeUndefined();
    expect(g.local(mail({ unread: true }))).toBe(true);
    expect(g.local(mail({ unread: false }))).toBe(false);
  });
  it("uses $filter with a receivedDateTime lead when there are no search terms", () => {
    const g = graphQuery({ unread: true, starred: true, before: "2025-01-01" });
    expect(g.search).toBeUndefined();
    expect(g.filter).toBe("receivedDateTime ge 1900-01-01T00:00:00Z and receivedDateTime lt 2025-01-01T00:00:00Z and isRead eq false and flag/flagStatus eq 'flagged'");
  });
  it("strips quotes from KQL values", () => {
    expect(graphQuery({ subject: 'say "hi"' }).search).toBe("subject:say subject:hi");
  });
});

describe("matchesLocal", () => {
  const ctx = { folderId: undefined, categoryOf: () => "transactions" as const, sectionOf: () => undefined };
  it("matches domain senders, subject words, dates and zMail fields", () => {
    expect(matchesLocal(mail(), { from: "amazon.com" }, ctx)).toBe(true);
    expect(matchesLocal(mail(), { from: "ebay.com" }, ctx)).toBe(false);
    expect(matchesLocal(mail(), { subject: "package delivered" }, ctx)).toBe(true);
    expect(matchesLocal(mail(), { after: "2025-03-05" }, ctx)).toBe(false);
    expect(matchesLocal(mail(), { category: "transactions" }, ctx)).toBe(true);
    expect(matchesLocal(mail(), { category: "promotions" }, ctx)).toBe(false);
  });
});

describe("describeQuery", () => {
  it("reads like a label", () => {
    expect(describeQuery({ from: "amazon.com", unread: true, after: "2024-01-01" })).toBe("From amazon.com · unread · since Jan 1, 2024");
    expect(describeQuery({})).toBe("All mail");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/assistant-query.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `query.ts`**

```ts
// src/lib/ai/assistant/query.ts
// The assistant's structured mail query and its translations: a Gmail search
// string, a Graph $search (KQL) or $filter, and a local matcher for the mock
// provider and for zMail-only fields (category, section).

import type { Category, Email, Folder } from "@/lib/types";
import { CATEGORIES } from "@/lib/types";

export interface MailQuery {
  /** Address, domain or name. */
  from?: string;
  to?: string;
  /** Words that must all appear in the subject. */
  subject?: string;
  /** Words anywhere in the email. */
  words?: string;
  /** YYYY-MM-DD, inclusive. */
  after?: string;
  /** YYYY-MM-DD, exclusive. */
  before?: string;
  /** System kind (inbox, archive, sent, spam, trash, drafts) or a folder id. */
  folder?: string;
  unread?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  /** zMail's category; only mail zMail has sorted has one. */
  category?: Category;
  /** One of the user's section ids. */
  section?: string;
  /** Limit to one account id. */
  account?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STRINGS = ["from", "to", "subject", "words", "folder", "section", "account"] as const;
const BOOLS = ["unread", "starred", "hasAttachment"] as const;
const SYSTEM_KINDS = ["inbox", "archive", "sent", "spam", "trash", "drafts"];

export function cleanQuery(raw: unknown): MailQuery {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("bad_query: query must be an object");
  const r = raw as Record<string, unknown>;
  const q: MailQuery = {};
  for (const k of STRINGS) {
    if (r[k] === undefined || r[k] === null || r[k] === "") continue;
    if (typeof r[k] !== "string") throw new Error(`bad_query: ${k} must be a string`);
    const v = (r[k] as string).trim();
    if (v) q[k] = v;
  }
  for (const k of BOOLS) {
    if (r[k] === undefined || r[k] === null) continue;
    if (typeof r[k] !== "boolean") throw new Error(`bad_query: ${k} must be true or false`);
    q[k] = r[k] as boolean;
  }
  for (const k of ["after", "before"] as const) {
    if (r[k] === undefined || r[k] === null || r[k] === "") continue;
    if (typeof r[k] !== "string" || !DATE.test(r[k] as string)) throw new Error(`bad_query: ${k} must be YYYY-MM-DD`);
    q[k] = r[k] as string;
  }
  if (r.category !== undefined && r.category !== null) {
    if (!CATEGORIES.includes(r.category as Category)) throw new Error(`bad_query: category must be one of ${CATEGORIES.join(", ")}`);
    q.category = r.category as Category;
  }
  return q;
}

export function resolveFolder(q: MailQuery, accountId: string, folders: Folder[]): Folder | undefined {
  if (!q.folder) return undefined;
  if (SYSTEM_KINDS.includes(q.folder)) return folders.find((f) => f.accountId === accountId && f.system === q.folder);
  return folders.find((f) => f.accountId === accountId && f.id === q.folder);
}

const clean = (s: string) => s.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();

export function gmailQuery(q: MailQuery, folder: Folder | undefined, folders: Folder[]): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s.replace(/"/g, "")}"` : s.replace(/"/g, ""));
  const parts: string[] = [];
  if (q.from) parts.push(`from:${quote(q.from)}`);
  if (q.to) parts.push(`to:${quote(q.to)}`);
  if (q.subject) parts.push(`subject:(${clean(q.subject)})`);
  if (q.words) parts.push(clean(q.words));
  if (q.after) parts.push(`after:${q.after.replace(/-/g, "/")}`);
  if (q.before) parts.push(`before:${q.before.replace(/-/g, "/")}`);
  if (q.unread !== undefined) parts.push(q.unread ? "is:unread" : "-is:unread");
  if (q.starred !== undefined) parts.push(q.starred ? "is:starred" : "-is:starred");
  if (q.hasAttachment) parts.push("has:attachment");
  if (folder) parts.push(gmailFolderTerm(folder, folders));
  return parts.join(" ");
}

function gmailFolderTerm(f: Folder, folders: Folder[]) {
  switch (f.system) {
    case "inbox":
      return "in:inbox";
    case "sent":
      return "in:sent";
    case "spam":
      return "in:spam";
    case "trash":
      return "in:trash";
    case "drafts":
      return "in:drafts";
    case "archive":
      return "-in:inbox -in:spam -in:trash -in:sent -in:drafts";
  }
  // Gmail searches nested labels by their full name, with spaces and slashes as hyphens.
  const names: string[] = [];
  for (let cur: Folder | undefined = f; cur; cur = folders.find((x) => x.id === cur!.parentId)) names.unshift(cur.name);
  return `label:${names.join("-").toLowerCase().replace(/[\s/&]+/g, "-")}`;
}

export function graphQuery(q: MailQuery): { search?: string; filter?: string; local: (e: Email) => boolean } {
  const kql = (s: string) => s.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  const terms: string[] = [];
  if (q.from) terms.push(`from:${kql(q.from).replace(/\s+/g, "")}`);
  if (q.to) terms.push(`to:${kql(q.to).replace(/\s+/g, "")}`);
  if (q.subject) terms.push(...kql(q.subject).split(" ").map((w) => `subject:${w}`));
  if (q.words) terms.push(kql(q.words));
  if (terms.length) {
    // $search can't be combined with $filter, so dates go into KQL and flags are checked locally.
    if (q.after) terms.push(`received>=${q.after}`);
    if (q.before) terms.push(`received<${q.before}`);
    if (q.hasAttachment) terms.push("hasattachments:true");
    return {
      search: terms.join(" "),
      local: (e) => (q.unread === undefined || e.unread === q.unread) && (q.starred === undefined || e.starred === q.starred),
    };
  }
  // Graph rejects $orderby on a property that doesn't lead the $filter.
  const f = [`receivedDateTime ge ${q.after ?? "1900-01-01"}T00:00:00Z`];
  if (q.before) f.push(`receivedDateTime lt ${q.before}T00:00:00Z`);
  if (q.unread !== undefined) f.push(`isRead eq ${!q.unread}`);
  if (q.starred !== undefined) f.push(q.starred ? "flag/flagStatus eq 'flagged'" : "flag/flagStatus ne 'flagged'");
  if (q.hasAttachment) f.push("hasAttachments eq true");
  return { filter: f.join(" and "), local: () => true };
}

export interface LocalCtx {
  /** Resolved folder id when the query names a folder. */
  folderId?: string;
  categoryOf: (id: string) => Category | undefined;
  sectionOf: (e: Email) => string | undefined;
}

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);
const day = (iso: string) => iso.slice(0, 10);

export function matchesLocal(e: Email, q: MailQuery, ctx: LocalCtx): boolean {
  const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
  if (q.from && !has(`${e.from.name} ${e.from.address}`, q.from)) return false;
  if (q.to && !e.to.some((c) => has(`${c.name} ${c.address}`, q.to!))) return false;
  if (q.subject && !words(q.subject).every((w) => has(e.subject, w))) return false;
  if (q.words && !words(q.words).every((w) => has(`${e.from.name} ${e.subject} ${e.text}`, w))) return false;
  if (q.after && day(e.date) < q.after) return false;
  if (q.before && day(e.date) >= q.before) return false;
  if (ctx.folderId && e.folderId !== ctx.folderId) return false;
  if (q.unread !== undefined && e.unread !== q.unread) return false;
  if (q.starred !== undefined && e.starred !== q.starred) return false;
  if (q.hasAttachment && !e.attachments?.length) return false;
  if (q.category && ctx.categoryOf(e.id) !== q.category) return false;
  if (q.section && ctx.sectionOf(e) !== q.section) return false;
  if (q.account && e.accountId !== q.account) return false;
  return true;
}

const human = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function describeQuery(q: MailQuery, names: { folder?: string; section?: string } = {}): string {
  const parts: string[] = [];
  if (q.from) parts.push(`From ${q.from}`);
  if (q.to) parts.push(`to ${q.to}`);
  if (q.subject) parts.push(`subject "${q.subject}"`);
  if (q.words) parts.push(`"${q.words}"`);
  if (q.folder) parts.push(`in ${names.folder ?? q.folder}`);
  if (q.section) parts.push(`in ${names.section ?? "section"}`);
  if (q.category) parts.push(q.category);
  if (q.unread) parts.push("unread");
  if (q.starred) parts.push("starred");
  if (q.hasAttachment) parts.push("with attachments");
  if (q.after) parts.push(`since ${human(q.after)}`);
  if (q.before) parts.push(`before ${human(q.before)}`);
  if (!parts.length) return "All mail";
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/assistant-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/assistant/query.ts src/lib/__tests__/assistant-query.test.ts
git commit -m "Assistant: structured mail queries for Gmail, Graph and local mail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Gmail search, header rows and batch edits

**Files:**
- Modify: `src/lib/mail/provider.ts` (new types and methods)
- Modify: `src/lib/types.ts` (`Email.partial?`)
- Modify: `src/lib/transport.ts` (`requestText`)
- Modify: `src/lib/google/gmail-map.ts` (`parseBatchResponse`)
- Modify: `src/lib/google/quota.ts` (`batchModify` cost)
- Modify: `src/lib/google/gmail.ts` (`search`, `headers`, `getMessage`, `batchSize`, `batchMove`, `batchSetRead`, `batchSetStarred`)
- Modify: `src/lib/microsoft/graph.ts` and `src/lib/mail/mock-provider.ts`, with stub methods that throw `"not yet"` so the typecheck passes until Tasks 5 and 6
- Test: `src/lib/__tests__/gmail-search.test.ts`

**Interfaces:**
- Consumes: `MailQuery`, `gmailQuery`, `resolveFolder` (Task 3).
- Produces, on `MailProvider`:
  - `search(q: MailQuery, folders: Folder[], page?: string): Promise<SearchPage>`
  - `headers(ids: string[]): Promise<Email[]>` (at most 100 ids per call; the rows have `partial: true`)
  - `getMessage(id: string): Promise<Email>`
  - `readonly batchSize: number`
  - `batchMove(emails: Email[], folderId: string): Promise<BatchOutcome>`
  - `batchSetRead(ids: string[], read: boolean): Promise<BatchOutcome>`
  - `batchSetStarred(ids: string[], starred: boolean): Promise<BatchOutcome>`
- Produces types:
  - `SearchPage {ids: string[]; headers?: Email[]; next?: string; estimate?: number}`
  - `BatchOutcome {skipped: string[]; failed: string[]}`
  - `requestText(method, url, {headers?, body?: string}): Promise<string>`
  - `parseBatchResponse<T>(text): {status: number; body?: T}[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/gmail-search.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const calls: { method: string; url: string; body?: unknown }[] = [];
let routes: Record<string, unknown> = {};
let batchReply = "";

vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/db", () => ({
  cachePutMessages: async () => undefined,
  cacheListMessages: async () => [],
  cacheDeleteMessages: async () => undefined,
  cachePutFolders: async () => undefined,
  syncGet: async () => null,
  syncSet: async () => undefined,
}));
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    request: async (method: string, url: string, opts: { body?: unknown } = {}) => {
      calls.push({ method, url, body: opts.body });
      const path = url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "");
      const key = Object.keys(routes).find((k) => path === k || path.startsWith(k + "?"));
      if (!key) throw new real.HttpError(404, `no route for ${method} ${path}`);
      return routes[key];
    },
    requestText: async (method: string, url: string, opts: { body?: string } = {}) => {
      calls.push({ method, url, body: opts.body });
      return batchReply;
    },
  };
});

const { GmailProvider } = await import("@/lib/google/gmail");
const account = { id: "g", kind: "gmail" as const, name: "Gmail", address: "me@gmail.com" };
const folders: Folder[] = [{ id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" }];

const part = (id: string, subject: string, labels: string[]) =>
  `--batch_abc\r\nContent-Type: application/http\r\nContent-ID: <response-m>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n` +
  JSON.stringify({ id, threadId: id, labelIds: labels, snippet: `${subject}…`, internalDate: "1700000000000", payload: { mimeType: "text/plain", body: { size: 0 }, headers: [{ name: "From", value: "Amazon <ship@amazon.com>" }, { name: "Subject", value: subject }] } }) +
  "\r\n";

beforeEach(() => {
  calls.length = 0;
  routes = {};
});

describe("Gmail search", () => {
  it("lists ids for the query, excluding chats, 500 per page", async () => {
    routes = { "/messages": { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2", resultSizeEstimate: 812 } };
    const page = await new GmailProvider(account).search({ from: "amazon.com", folder: "inbox" }, folders);
    expect(page).toEqual({ ids: ["a", "b"], next: "p2", estimate: 812 });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("q")).toBe("from:amazon.com in:inbox -in:chats");
    expect(url.searchParams.get("maxResults")).toBe("500");
  });

  it("fetches header rows through one batch request and marks them partial", async () => {
    batchReply = part("a", "Your package was delivered", ["INBOX", "UNREAD"]) + part("b", "Shipped: rain boots", ["CATEGORY_UPDATES"]) + "--batch_abc--";
    const rows = await new GmailProvider(account).headers(["a", "b"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gmail.googleapis.com/batch/gmail/v1");
    expect(String(calls[0].body)).toContain("GET /gmail/v1/users/me/messages/a?format=metadata");
    expect(rows.map((r) => [r.id, r.subject, r.folderId, r.unread, r.partial])).toEqual([
      ["a", "Your package was delivered", "g:INBOX", true, true],
      ["b", "Shipped: rain boots", "g:ARCHIVE", false, true],
    ]);
  });

  it("moves in batchModify calls grouped by label change, at most 1000 ids each", async () => {
    routes = { "/messages/batchModify": undefined };
    const p = new GmailProvider(account);
    const inbox = (id: string) => ({ id, labels: ["INBOX"] }) as Email;
    const ids = Array.from({ length: 1001 }, (_, i) => inbox(`m${i}`));
    const out = await p.batchMove(ids, "g:TRASH");
    expect(out).toEqual({ skipped: [], failed: [] });
    const bodies = calls.map((c) => c.body as { ids: string[]; addLabelIds: string[]; removeLabelIds: string[] });
    expect(bodies.map((b) => b.ids.length)).toEqual([1000, 1]);
    expect(bodies[0].addLabelIds).toEqual(["TRASH"]);
    expect(bodies[0].removeLabelIds).toEqual(["INBOX"]);
  });

  it("marks read with one batchModify", async () => {
    routes = { "/messages/batchModify": undefined };
    await new GmailProvider(account).batchSetRead(["a", "b"], true);
    expect(calls[0].body).toEqual({ ids: ["a", "b"], addLabelIds: [], removeLabelIds: ["UNREAD"] });
  });
});

const { parseBatchResponse } = await import("@/lib/google/gmail-map");

describe("parseBatchResponse", () => {
  it("returns status and JSON per part, skipping the closing boundary", () => {
    const text = part("a", "One", []) + "--batch_abc\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 404 Not Found\r\n\r\n{\"error\":{}}\r\n--batch_abc--";
    expect(parseBatchResponse<{ id: string }>(text).map((p) => [p.status, p.body && "id" in p.body ? p.body.id : null])).toEqual([
      [200, "a"],
      [404, null],
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/gmail-search.test.ts`
Expected: FAIL, because `search`, `headers` and `parseBatchResponse` don't exist.

- [ ] **Step 3: Add the shared types**

In `src/lib/types.ts`, add to `Email`:

```ts
  /** Header row from an assistant search: no body yet. Open it with ensureEmail. */
  partial?: boolean;
```

In `src/lib/mail/provider.ts`, import `MailQuery` and add:

```ts
import type { MailQuery } from "@/lib/ai/assistant/query";

export interface SearchPage {
  ids: string[];
  /** Header rows when the backend returns them with the search (Graph, mock). */
  headers?: Email[];
  next?: string;
  /** Server's total estimate, when it gives one (Gmail). */
  estimate?: number;
}

/** Per-batch result: ids that no longer exist, and ids the server refused. */
export interface BatchOutcome {
  skipped: string[];
  failed: string[];
}
```

Add these methods to the `MailProvider` interface:

```ts
  /** Server-side search across the whole mailbox (spam and trash only when the query names them). */
  search(q: MailQuery, folders: Folder[], page?: string): Promise<SearchPage>;
  /** Light rows (partial: true, no body) for up to 100 ids. Missing ids are left out. */
  headers(ids: string[]): Promise<Email[]>;
  /** One message in full; also cached locally. */
  getMessage(id: string): Promise<Email>;
  /** Most ids one batch call can take. */
  readonly batchSize: number;
  batchMove(emails: Email[], folderId: string): Promise<BatchOutcome>;
  batchSetRead(ids: string[], read: boolean): Promise<BatchOutcome>;
  batchSetStarred(ids: string[], starred: boolean): Promise<BatchOutcome>;
```

- [ ] **Step 4: Add `requestText` to `src/lib/transport.ts`**

Move the send half of `request` into a helper, and keep `request`'s behavior the same:

```ts
async function send(method: Method, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  if (isTauri()) {
    const res = await invoke<{ status: number; body: string }>("http_request", { method, url, headers, body: body ?? null });
    return { status: res.status, text: res.body };
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch {
    throw new Error("The browser preview can't reach model providers (CORS). Use the zMail app — it sends requests from Rust.");
  }
  return { status: res.status, text: await res.text() };
}

export async function request<T>(method: Method, url: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...opts.headers };
  const { status, text } = await send(method, url, headers, opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  if (status < 200 || status >= 300) throw new HttpError(status, text);
  // 204 No Content (DELETE, some PATCH/POST actions).
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  }
}

/** A raw request (e.g. a multipart batch); returns the body text. */
export async function requestText(method: Method, url: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<string> {
  const { status, text } = await send(method, url, opts.headers ?? {}, opts.body);
  if (status < 200 || status >= 300) throw new HttpError(status, text);
  return text;
}
```

- [ ] **Step 5: Add `parseBatchResponse` to `src/lib/google/gmail-map.ts`**

```ts
/** Split a Gmail batch response (multipart/mixed of HTTP responses) into status + JSON body per part, in order. */
export function parseBatchResponse<T>(text: string): { status: number; body?: T }[] {
  const boundary = /^--([^\r\n]+)/m.exec(text)?.[1];
  if (!boundary) return [];
  return text
    .split(`--${boundary}`)
    .slice(1)
    .filter((p) => !p.startsWith("--"))
    .map((part) => {
      const status = Number(/HTTP\/[\d.]+ (\d{3})/.exec(part)?.[1] ?? 0);
      const start = part.indexOf("{");
      const end = part.lastIndexOf("}");
      let body: T | undefined;
      if (start >= 0 && end > start) {
        try {
          body = JSON.parse(part.slice(start, end + 1)) as T;
        } catch {
          body = undefined;
        }
      }
      return { status, body };
    });
}
```

In `src/lib/google/quota.ts`, `gmailCost`, add a first line: `if (path.startsWith("/messages/batchModify")) return 50;`

- [ ] **Step 6: Implement the methods in `GmailProvider`**

Add the imports `requestText` (from transport), `parseBatchResponse` (from `./gmail-map`), `gmailQuery`, `resolveFolder`, `type MailQuery` (from `@/lib/ai/assistant/query`), `type BatchOutcome`, `type SearchPage` (from the provider), and `type Folder`. Then add:

```ts
  readonly batchSize = 1000;

  async search(q: MailQuery, folders: Folder[], page?: string): Promise<SearchPage> {
    const folder = resolveFolder(q, this.account.id, folders);
    const params = new URLSearchParams({ q: `${gmailQuery(q, folder, folders)} -in:chats`.trim(), maxResults: "500" });
    if (page) params.set("pageToken", page);
    const res = await this.api<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>("GET", `/messages?${params}`);
    return { ids: (res.messages ?? []).map((m) => m.id), next: res.nextPageToken, estimate: res.resultSizeEstimate };
  }

  /** Metadata for up to 100 messages in one HTTP batch request (one 429 retry for parts Google throttled). */
  async headers(ids: string[], retry = true): Promise<Email[]> {
    if (!ids.length) return [];
    const boundary = "zmail_batch";
    const meta = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
    const body =
      ids.map((id, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <m${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?${meta}\r\n\r\n`).join("") +
      `--${boundary}--`;
    const text = await withQuota(limiterFor(this.account.id), 5 * ids.length, async () => {
      const token = await accessToken(this.account.id);
      return requestText("POST", "https://gmail.googleapis.com/batch/gmail/v1", {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/mixed; boundary=${boundary}` },
        body,
      });
    });
    const parts = parseBatchResponse<GMessage>(text);
    const rows = parts.filter((p) => p.status === 200 && p.body?.id).map((p) => ({ ...this.toEmail(p.body!), partial: true }));
    const got = new Set(rows.map((r) => r.id));
    const throttled = parts.some((p) => p.status === 429);
    if (retry && throttled) {
      await new Promise((r) => setTimeout(r, 1000));
      rows.push(...(await this.headers(ids.filter((id) => !got.has(id)), false)));
    }
    return rows;
  }

  async getMessage(id: string): Promise<Email> {
    const [e] = await this.fetchMessages([id]);
    if (!e) throw new HttpError(404, "That email no longer exists.");
    await this.save([e]);
    return e;
  }

  private async batchModify(ids: string[], add: string[], remove: string[]) {
    for (let i = 0; i < ids.length; i += 1000) {
      const part = ids.slice(i, i + 1000);
      await this.api("POST", "/messages/batchModify", { ids: part, addLabelIds: add, removeLabelIds: remove });
      for (const id of part) {
        const cur = new Set(this.labelsByMessage.get(id) ?? []);
        add.forEach((l) => cur.add(l));
        remove.forEach((l) => cur.delete(l));
        this.labelsByMessage.set(id, [...cur]);
      }
    }
  }

  async batchMove(emails: Email[], folderId: string): Promise<BatchOutcome> {
    const groups = new Map<string, { add: string[]; remove: string[]; ids: string[] }>();
    for (const e of emails) {
      const ch = labelChangesForMove(this.account.id, this.labelsByMessage.get(e.id) ?? e.labels ?? [], folderId);
      const key = JSON.stringify(ch);
      const g = groups.get(key) ?? { ...ch, ids: [] };
      g.ids.push(e.id);
      groups.set(key, g);
    }
    for (const g of groups.values()) await this.batchModify(g.ids, g.add, g.remove);
    return { skipped: [], failed: [] };
  }

  async batchSetRead(ids: string[], read: boolean): Promise<BatchOutcome> {
    await this.batchModify(ids, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []);
    return { skipped: [], failed: [] };
  }

  async batchSetStarred(ids: string[], starred: boolean): Promise<BatchOutcome> {
    await this.batchModify(ids, starred ? ["STARRED"] : [], starred ? [] : ["STARRED"]);
    return { skipped: [], failed: [] };
  }
```

In `GraphProvider` and `MockMailProvider`, add temporary members so the typecheck passes. Tasks 5 and 6 replace them:

```ts
  readonly batchSize = 20; // MockMailProvider: 100
  async search(): Promise<SearchPage> { throw new Error("not yet"); }
  async headers(): Promise<Email[]> { throw new Error("not yet"); }
  async getMessage(): Promise<Email> { throw new Error("not yet"); }
  async batchMove(): Promise<BatchOutcome> { throw new Error("not yet"); }
  async batchSetRead(): Promise<BatchOutcome> { throw new Error("not yet"); }
  async batchSetStarred(): Promise<BatchOutcome> { throw new Error("not yet"); }
```

- [ ] **Step 7: Run the tests and the typecheck**

Run: `npx vitest run src/lib/__tests__/gmail-search.test.ts src/lib/__tests__/gmail-provider.test.ts && npx tsc --noEmit -p .`
Expected: PASS. If other test files build fake `MailProvider` objects (for example `sections-store.test.ts`), cast them with `as unknown as MailProvider`, or add the six members there with `vi.fn()`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/types.ts src/lib/mail/provider.ts src/lib/transport.ts src/lib/google src/lib/microsoft/graph.ts src/lib/mail/mock-provider.ts src/lib/__tests__/gmail-search.test.ts
git commit -m "Gmail: server search, batched header rows and batchModify edits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Graph search, header rows and batch edits

**Files:**
- Modify: `src/lib/microsoft/graph.ts`
- Test: `src/lib/__tests__/graph-search.test.ts`

**Interfaces:**
- Consumes: `graphQuery`, `resolveFolder` (Task 3); `SearchPage`, `BatchOutcome` (Task 4).
- Produces: the `GraphProvider` implementations of the Task 4 methods, with `batchSize = 20`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/graph-search.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const calls: { method: string; url: string; body?: unknown; headers?: Record<string, string> }[] = [];
let reply: (method: string, url: string, body: unknown) => unknown = () => ({});

vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/db", () => ({ cachePutMessages: async () => undefined, cacheListMessages: async () => [], cachePutFolders: async () => undefined, syncGet: async () => null, syncSet: async () => undefined }));
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    request: async (method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) => {
      calls.push({ method, url, body: opts.body, headers: opts.headers });
      return reply(method, url, opts.body);
    },
  };
});

const { GraphProvider } = await import("@/lib/microsoft/graph");
const account = { id: "o", kind: "m365" as const, name: "Work", address: "z@example.org" };
const folders: Folder[] = [{ id: "o:AAinbox", accountId: "o", name: "Inbox", system: "inbox" }];
const msg = (id: string, isRead: boolean, parent = "AAinbox") => ({ id, subject: `S ${id}`, from: { emailAddress: { name: "Amazon", address: "a@amazon.com" } }, receivedDateTime: "2025-01-02T00:00:00Z", isRead, parentFolderId: parent, bodyPreview: "p" });

beforeEach(() => (calls.length = 0));

describe("Graph search", () => {
  it("uses $search for sender terms, returns header rows, and applies flags locally", async () => {
    reply = () => ({ value: [msg("1", false), msg("2", true)], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" });
    const page = await new GraphProvider(account).search({ from: "amazon.com", unread: true }, folders);
    expect(decodeURIComponent(calls[0].url)).toContain('/me/messages?$search="from:amazon.com"');
    expect(page.ids).toEqual(["1"]);
    expect(page.headers?.[0]).toMatchObject({ id: "1", partial: true, unread: true, folderId: "o:AAinbox" });
    expect(page.next).toBe("https://graph.microsoft.com/v1.0/next");
  });

  it("searches inside a folder and pages with nextLink", async () => {
    reply = () => ({ value: [] });
    const p = new GraphProvider(account);
    await p.search({ folder: "inbox", unread: true }, folders);
    expect(decodeURIComponent(calls[0].url)).toContain("/me/mailFolders/AAinbox/messages?$filter=receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false");
    await p.search({ folder: "inbox" }, folders, "https://graph.microsoft.com/v1.0/next");
    expect(calls[1].url).toBe("https://graph.microsoft.com/v1.0/next");
  });

  it("moves through $batch with immutable ids and reports 404s as skipped, other errors as failed", async () => {
    reply = (_m, url, body) => {
      if (!url.endsWith("/$batch")) return {};
      const reqs = (body as { requests: { id: string }[] }).requests;
      return { responses: reqs.map((r) => ({ id: r.id, status: r.id === "1" ? 404 : r.id === "2" ? 429 : 201 })) };
    };
    const out = await new GraphProvider(account).batchMove([{ id: "a" }, { id: "b" }, { id: "c" }] as Email[], "o:AAdeleted");
    const reqs = (calls[0].body as { requests: { method: string; url: string; body: unknown; headers: Record<string, string> }[] }).requests;
    expect(reqs[0]).toMatchObject({ method: "POST", url: "/me/messages/a/move", body: { destinationId: "AAdeleted" } });
    expect(reqs[0].headers.Prefer).toBe('IdType="ImmutableId"');
    expect(out).toEqual({ skipped: ["b"], failed: ["c"] });
  });

  it("marks read with PATCH requests in $batch", async () => {
    reply = (_m, _u, body) => ({ responses: (body as { requests: { id: string }[] }).requests.map((r) => ({ id: r.id, status: 200 })) });
    await new GraphProvider(account).batchSetRead(["a"], true);
    expect((calls[0].body as { requests: unknown[] }).requests[0]).toMatchObject({ method: "PATCH", url: "/me/messages/a", body: { isRead: true } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/graph-search.test.ts`
Expected: FAIL with "not yet".

- [ ] **Step 3: Implement the methods in `GraphProvider`**

Replace the Task 4 stubs with:

```ts
  readonly batchSize = 20;
  private headerCache = new Map<string, Email>();

  async search(q: MailQuery, folders: Folder[], page?: string): Promise<SearchPage> {
    const folder = resolveFolder(q, this.account.id, folders);
    const base = folder ? `/me/mailFolders/${folder.id.slice(this.account.id.length + 1)}/messages` : "/me/messages";
    const { search, filter, local } = graphQuery(q);
    const url =
      page ??
      (search
        ? `${base}?$search=${encodeURIComponent(`"${search}"`)}&$select=${HEADER_FIELDS}&$top=250`
        : `${base}?$filter=${encodeURIComponent(filter!)}&$orderby=receivedDateTime desc&$select=${HEADER_FIELDS}&$top=250`);
    const res = await this.api<Page<GMsg>>("GET", url);
    // Without a folder, /me/messages includes Deleted Items and Junk; leave them out like Gmail does.
    const hidden = folder ? new Set<string>() : new Set([this.systemFolderId("trash"), this.systemFolderId("spam")].filter(Boolean) as string[]);
    const rows = res.value
      .map((m) => ({ ...messageToEmail(this.account.id, m), partial: true }))
      .filter((e) => local(e) && !hidden.has(e.folderId));
    for (const r of rows) this.headerCache.set(r.id, r);
    return { ids: rows.map((r) => r.id), headers: rows, next: res["@odata.nextLink"] };
  }

  async headers(ids: string[]): Promise<Email[]> {
    const have = ids.map((id) => this.headerCache.get(id)).filter((e): e is Email => !!e);
    const missing = ids.filter((id) => !this.headerCache.has(id));
    for (let i = 0; i < missing.length; i += 20) {
      const part = missing.slice(i, i + 20);
      const res = await this.batch(part.map((id) => ({ method: "GET", url: `/me/messages/${id}?$select=${HEADER_FIELDS}` })));
      for (const r of res)
        if (r.status === 200 && r.body) {
          const row = { ...messageToEmail(this.account.id, r.body as GMsg), partial: true };
          this.headerCache.set(row.id, row);
          have.push(row);
        }
    }
    return have;
  }

  async getMessage(id: string): Promise<Email> {
    const m = await this.api<GMsg>("GET", `/me/messages/${id}?$select=${MSG_FIELDS}`);
    const [e] = await this.toEmails([m]);
    await cachePutMessages(this.account.id, [{ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) }]);
    return e;
  }

  private async batch(reqs: { method: string; url: string; body?: unknown }[]) {
    const res = await this.api<{ responses: { id: string; status: number; body?: unknown }[] }>("POST", "/$batch", {
      requests: reqs.map((r, i) => ({
        id: String(i),
        method: r.method,
        url: r.url,
        headers: { "Content-Type": "application/json", Prefer: 'IdType="ImmutableId"' },
        ...(r.body !== undefined ? { body: r.body } : {}),
      })),
    });
    return [...res.responses].sort((a, b) => Number(a.id) - Number(b.id));
  }

  private outcome(ids: string[], responses: { id: string; status: number }[]): BatchOutcome {
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const r of responses) {
      if (r.status === 404) skipped.push(ids[Number(r.id)]);
      else if (r.status >= 400) failed.push(ids[Number(r.id)]);
    }
    return { skipped, failed };
  }

  async batchMove(emails: Email[], folderId: string): Promise<BatchOutcome> {
    const dest = folderId.slice(this.account.id.length + 1);
    const ids = emails.map((e) => e.id);
    return this.outcome(ids, await this.batch(ids.map((id) => ({ method: "POST", url: `/me/messages/${id}/move`, body: { destinationId: dest } }))));
  }

  async batchSetRead(ids: string[], read: boolean): Promise<BatchOutcome> {
    return this.outcome(ids, await this.batch(ids.map((id) => ({ method: "PATCH", url: `/me/messages/${id}`, body: { isRead: read } }))));
  }

  async batchSetStarred(ids: string[], starred: boolean): Promise<BatchOutcome> {
    const flag = { flagStatus: starred ? "flagged" : "notFlagged" };
    return this.outcome(ids, await this.batch(ids.map((id) => ({ method: "PATCH", url: `/me/messages/${id}`, body: { flag } }))));
  }
```

At the top of the file, next to `MSG_FIELDS`:

```ts
const HEADER_FIELDS = "id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,flag,bodyPreview,parentFolderId,hasAttachments,categories";
```

Also add the imports `graphQuery`, `resolveFolder`, `type MailQuery`, `type BatchOutcome`, `type SearchPage`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/lib/__tests__/graph-search.test.ts src/lib/__tests__/graph.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/microsoft/graph.ts src/lib/__tests__/graph-search.test.ts
git commit -m "Graph: server search with header rows and \$batch edits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Mock provider and Amazon demo mail

**Files:**
- Modify: `src/lib/mail/mock-provider.ts`
- Modify: `src/lib/mail/mock-data.ts` (add `amazon()` to `seed()`)
- Test: `src/lib/__tests__/mock-search.test.ts`

**Interfaces:**
- Consumes: `matchesLocal`, `resolveFolder` (Task 3).
- Produces: `MockMailProvider` search, header and batch methods with `batchSize = 100` and 500 rows per page (page token = offset). Also adds about 40 Amazon emails to the "personal" mock account.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/mock-search.test.ts
import { describe, expect, it } from "vitest";
import { MockMailProvider } from "@/lib/mail/mock-provider";
import { ACCOUNTS, FOLDERS } from "@/lib/mail/mock-data";

const p = new MockMailProvider(ACCOUNTS[0]);

describe("mock search", () => {
  it("finds the demo Amazon mail, with header rows", async () => {
    const page = await p.search({ from: "amazon.com" }, FOLDERS);
    expect(page.ids.length).toBeGreaterThanOrEqual(35);
    expect(page.headers?.every((h) => h.partial && h.from.address.endsWith("amazon.com"))).toBe(true);
  });

  it("leaves trash and spam out unless asked", async () => {
    const all = await p.search({ from: "amazon.com" }, FOLDERS);
    await p.batchMove([{ id: all.ids[0] } as never], "personal:trash");
    expect((await p.search({ from: "amazon.com" }, FOLDERS)).ids).not.toContain(all.ids[0]);
    expect((await p.search({ from: "amazon.com", folder: "trash" }, FOLDERS)).ids).toContain(all.ids[0]);
    await p.batchMove([{ id: all.ids[0] } as never], "personal:inbox");
  });

  it("skips ids that don't exist", async () => {
    expect(await p.batchSetRead(["nope"], true)).toEqual({ skipped: ["nope"], failed: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/mock-search.test.ts`
Expected: FAIL with "not yet".

- [ ] **Step 3: Add the Amazon mail to `mock-data.ts`**

Add before `seed()`:

```ts
const AMAZON: [string, string] = ["Amazon.com", "shipment-tracking@amazon.com"];
const AMAZON_ORDERS: [string, string] = ["Amazon.com", "auto-confirm@amazon.com"];
const AMAZON_DEALS: [string, string] = ["Amazon", "store-news@amazon.com"];

/** Two years of Amazon mail for the assistant demo: mostly orders and deliveries, some receipts and promos. */
function amazon(): Email[] {
  const items = ["USB-C hub", "Kids' rain boots", "Coffee filters", "Trail running socks", "Golf balls (12)", "Desk lamp", "HDMI cable", "Birthday card"];
  const out: Email[] = [];
  for (let i = 0; i < 30; i++) {
    const item = items[i % items.length];
    const kind = i % 3;
    const [from, subject, text] =
      kind === 0
        ? [AMAZON_ORDERS, `Ordered: "${item}"`, `Thanks for your order. We'll let you know when "${item}" ships.`]
        : kind === 1
          ? [AMAZON, `Shipped: ${item}`, `Your package with ${item} is on the way. Track your package.`]
          : [AMAZON, "Your package was delivered", `Your package was delivered. It was left at the front door.`];
    out.push(mail("personal", i < 4 ? "inbox" : "archive", 20 + i * 560, from, subject, text, { unread: i < 2 }));
  }
  for (let i = 0; i < 6; i++)
    out.push(mail("personal", "receipts", 300 + i * 2400, AMAZON_ORDERS, i % 2 ? "Your Prime Video receipt" : "Your Amazon.com order receipt", "Order total: $24.17. Thank you for shopping with us.", { unread: false }));
  for (let i = 0; i < 4; i++)
    out.push(mail("personal", "inbox", 60 + i * 900, AMAZON_DEALS, i % 2 ? "Deals picked for you" : "Review your recent purchase", "Top deals based on your shopping. Unsubscribe.", { unread: i === 0 }));
  return out;
}
```

Change `seed()` to `return [...history(), ...inbox(), ...amazon()];`.

- [ ] **Step 4: Implement the mock methods**

Replace the stubs in `MockMailProvider`:

```ts
  readonly batchSize = 100;

  async search(q: MailQuery, folders: Folder[], page?: string): Promise<SearchPage> {
    const folder = resolveFolder(q, this.account.id, folders);
    const hidden = new Set(folders.filter((f) => f.accountId === this.account.id && (f.system === "trash" || f.system === "spam")).map((f) => f.id));
    const hits = store.emails
      .filter((e) => e.accountId === this.account.id)
      .filter((e) => (folder ? true : !hidden.has(e.folderId)))
      .filter((e) => matchesLocal(e, q, { folderId: folder?.id, categoryOf: () => undefined, sectionOf: () => undefined }))
      .sort((a, b) => b.date.localeCompare(a.date));
    const start = Number(page ?? 0);
    const slice = hits.slice(start, start + 500);
    return { ids: slice.map((e) => e.id), headers: slice.map((e) => ({ ...e, partial: true })), next: start + 500 < hits.length ? String(start + 500) : undefined };
  }

  async headers(ids: string[]): Promise<Email[]> {
    return store.emails.filter((e) => ids.includes(e.id)).map((e) => ({ ...e, partial: true }));
  }

  async getMessage(id: string): Promise<Email> {
    const e = store.emails.find((x) => x.id === id);
    if (!e) throw new Error("That email no longer exists.");
    return { ...e };
  }

  private each(ids: string[], p: Partial<Email>): BatchOutcome {
    const skipped = ids.filter((id) => !store.emails.some((e) => e.id === id));
    for (const id of ids) this.patch(id, p);
    return { skipped, failed: [] };
  }

  async batchMove(emails: Email[], folderId: string) {
    return this.each(emails.map((e) => e.id), { folderId });
  }
  async batchSetRead(ids: string[], read: boolean) {
    return this.each(ids, { unread: !read });
  }
  async batchSetStarred(ids: string[], starred: boolean) {
    return this.each(ids, { starred });
  }
```

Also import `matchesLocal`, `resolveFolder`, `type MailQuery` from `@/lib/ai/assistant/query`, and `type BatchOutcome`, `type SearchPage` from `./provider`.

- [ ] **Step 5: Run the full suite and the typecheck**

Run: `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS. Existing tests that count seeded mail (`launch.test.ts`, `triage.test.ts`) may need their expected counts raised by 40. Update those numbers. Don't change their behavior.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mail src/lib/__tests__
git commit -m "Mock mail: search, batch edits, and Amazon demo mail for the assistant

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Store: bulk actions with undo, loading full emails, compose prefill

**Files:**
- Create: `src/lib/mail/bulk.ts`
- Create: `src/lib/mail/compose-text.ts`
- Modify: `src/lib/store.ts` (`providerOf` export, `ensureEmail`, `bulkApply`, `bulkUndo`, `Compose.prefill`)
- Modify: `src/components/mail/composer.tsx` (apply `prefill`; use `forwardBody`)
- Test: `src/lib/__tests__/bulk-store.test.ts`

**Interfaces:**
- Consumes: the Task 4 provider methods.
- Produces:
  - `BulkOp`, `UndoEntry`, `BulkResult {done, skipped, failed: Email[], undo: UndoEntry[], error?}`, `BulkOptions {onProgress?, isCancelled?}`
  - `needsConfirm(op, count): boolean`, `opText(op, names?): {verb, past}`, `chunk`
  - `forwardBody(e: Email): string`
  - store: `providerOf(accountId)`, `ensureEmail(ref: {id, accountId}): Promise<Email>`, `bulkApply(emails: Email[], op, opts?): Promise<BulkResult>`, `bulkUndo(undo: UndoEntry[], op): Promise<BulkResult>`
  - `Compose.prefill?: {to?, cc?, subject?, body?}`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/bulk-store.test.ts
// Bulk actions in the store: chunking by the provider's batch size, skipping
// mail that's already there, stopping on failure, resume, undo, and accounts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const outlook = { id: "o", kind: "m365" as const, name: "Work", address: "z@example.org" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:TRASH", accountId: "g", name: "Trash", system: "trash" },
  { id: "g:ARCHIVE", accountId: "g", name: "All Mail", system: "archive" },
  { id: "g:Label_1", accountId: "g", name: "Receipts" },
  { id: "o:inbox", accountId: "o", name: "Inbox", system: "inbox" },
  { id: "o:deleted", accountId: "o", name: "Deleted Items", system: "trash" },
];
const row = (id: string, accountId = "g", over: Partial<Email> = {}) =>
  ({ id, accountId, threadId: id, folderId: `${accountId === "g" ? "g:INBOX" : "o:inbox"}`, from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date: "2026-01-01T00:00:00Z", unread: true, starred: false, labels: ["INBOX"], ...over }) as Email;

const moves: { account: string; ids: string[]; folderId: string }[] = [];
let failOnCall = -1;
let call = 0;
const fake = (account: typeof gmail) => ({
  account,
  batchSize: 2,
  listFolders: async () => folders.filter((f) => f.accountId === account.id),
  listMessages: async () => (account.id === "g" ? [row("c1")] : []),
  batchMove: async (emails: Email[], folderId: string) => {
    if (call++ === failOnCall) throw new Error("network down");
    moves.push({ account: account.id, ids: emails.map((e) => e.id), folderId });
    return { skipped: [], failed: [] };
  },
  batchSetRead: async (ids: string[]) => ({ skipped: ids.filter((id) => id === "gone"), failed: [] }),
  batchSetStarred: async () => ({ skipped: [], failed: [] }),
  getMessage: async (id: string) => row(id, account.id, { text: "full body", partial: undefined }),
});

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail, outlook],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: (a: typeof gmail) => fake(a),
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => {} }));

const { useMail } = await import("@/lib/store");
const { needsConfirm } = await import("@/lib/mail/bulk");

beforeEach(async () => {
  moves.length = 0;
  failOnCall = -1;
  call = 0;
  if (!useMail.getState().accounts.length) await useMail.getState().load();
});

describe("approval rule", () => {
  it("undoable ops on 25 or fewer run directly; everything else confirms", () => {
    expect(needsConfirm({ kind: "archive" }, 25)).toBe(false);
    expect(needsConfirm({ kind: "archive" }, 26)).toBe(true);
    expect(needsConfirm({ kind: "read", read: true }, 3)).toBe(false);
    expect(needsConfirm({ kind: "section", sectionId: "s" }, 3)).toBe(false);
    expect(needsConfirm({ kind: "trash" }, 1)).toBe(true);
    expect(needsConfirm({ kind: "spam" }, 1)).toBe(true);
    expect(needsConfirm({ kind: "move", folderId: "g:Label_1" }, 1)).toBe(true);
  });
});

describe("bulkApply", () => {
  it("trashes in provider-sized chunks, skips mail already there, and records undo", async () => {
    const res = await useMail.getState().bulkApply([row("a"), row("b"), row("c"), row("t", "g", { folderId: "g:TRASH" })], { kind: "trash" });
    expect(moves.map((m) => m.ids)).toEqual([["a", "b"], ["c"]]);
    expect(res).toMatchObject({ done: 3, skipped: 1, failed: [] });
    expect(res.undo.map((u) => [u.id, u.folderId])).toEqual([["a", "g:INBOX"], ["b", "g:INBOX"], ["c", "g:INBOX"]]);
  });

  it("stops at a failed chunk, reports the rest as failed, and resumes", async () => {
    failOnCall = 1;
    const emails = [row("a"), row("b"), row("c"), row("d"), row("e")];
    const res = await useMail.getState().bulkApply(emails, { kind: "trash" });
    expect(res.done).toBe(2);
    expect(res.failed.map((e) => e.id)).toEqual(["c", "d", "e"]);
    expect(res.error).toMatch(/network down/);
    const again = await useMail.getState().bulkApply(res.failed, { kind: "trash" });
    expect(again).toMatchObject({ done: 3, failed: [] });
  });

  it("move to a folder only moves that folder's account", async () => {
    const res = await useMail.getState().bulkApply([row("a"), row("x", "o")], { kind: "move", folderId: "g:Label_1" });
    expect(moves).toEqual([{ account: "g", ids: ["a"], folderId: "g:Label_1" }]);
    expect(res.failed.map((e) => e.id)).toEqual(["x"]);
    expect(res.error).toMatch(/belongs to another account/);
  });

  it("resolves trash per account for mixed sets", async () => {
    await useMail.getState().bulkApply([row("a"), row("x", "o")], { kind: "trash" });
    expect(moves).toEqual([
      { account: "g", ids: ["a"], folderId: "g:TRASH" },
      { account: "o", ids: ["x"], folderId: "o:deleted" },
    ]);
  });

  it("undo moves each email back to where it was", async () => {
    const res = await useMail.getState().bulkApply([row("a"), row("r", "g", { folderId: "g:Label_1" })], { kind: "trash" });
    moves.length = 0;
    await useMail.getState().bulkUndo(res.undo, { kind: "trash" });
    expect(moves).toEqual([
      { account: "g", ids: ["a"], folderId: "g:INBOX" },
      { account: "g", ids: ["r"], folderId: "g:Label_1" },
    ]);
  });

  it("counts ids the server says are gone as skipped", async () => {
    const res = await useMail.getState().bulkApply([row("gone"), row("k")], { kind: "read", read: true });
    expect(res).toMatchObject({ done: 1, skipped: 1 });
  });

  it("updates cached emails in place", async () => {
    await useMail.getState().bulkApply([useMail.getState().emails.find((e) => e.id === "c1")!], { kind: "read", read: true });
    expect(useMail.getState().emails.find((e) => e.id === "c1")?.unread).toBe(false);
  });

  it("puts mail in a section and undoes it", async () => {
    const res = await useMail.getState().bulkApply([row("a")], { kind: "section", sectionId: "sec1" });
    expect(useMail.getState().sectionOverrides.a).toBe("sec1");
    await useMail.getState().bulkUndo(res.undo, { kind: "section", sectionId: "sec1" });
    expect("a" in useMail.getState().sectionOverrides).toBe(false);
  });
});

describe("ensureEmail", () => {
  it("fetches a header-only email in full and adds it to the store", async () => {
    const e = await useMail.getState().ensureEmail({ id: "old1", accountId: "g" });
    expect(e.text).toBe("full body");
    expect(useMail.getState().emails.some((x) => x.id === "old1" && !x.partial)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/bulk-store.test.ts`
Expected: FAIL, `@/lib/mail/bulk` is not found.

- [ ] **Step 3: Write `bulk.ts` and `compose-text.ts`**

```ts
// src/lib/mail/bulk.ts
// Bulk actions on many emails (the assistant's act tool, and anything else
// that needs to edit hundreds at once): types, the approval rule, and labels.

import type { Email } from "@/lib/types";

export type BulkOp =
  | { kind: "archive" }
  | { kind: "trash" }
  | { kind: "spam" }
  | { kind: "move"; folderId: string }
  | { kind: "read"; read: boolean }
  | { kind: "star"; starred: boolean }
  | { kind: "section"; sectionId: string | null };

/** How an email was before a bulk action, so Undo can put it back. */
export interface UndoEntry {
  id: string;
  accountId: string;
  folderId: string;
  unread: boolean;
  starred: boolean;
  /** Previous section override; undefined = none. */
  section?: string | null;
}

export interface BulkResult {
  done: number;
  skipped: number;
  /** Emails not processed because a batch failed or the action was stopped (Resume retries these). */
  failed: Email[];
  undo: UndoEntry[];
  error?: string;
}

export interface BulkOptions {
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export const DIRECT_LIMIT = 25;
const UNDOABLE: BulkOp["kind"][] = ["archive", "read", "star", "section"];

/** Undoable ops on up to 25 emails run directly; everything else shows a confirm card. */
export function needsConfirm(op: BulkOp, count: number) {
  return !UNDOABLE.includes(op.kind) || count > DIRECT_LIMIT;
}

export function opText(op: BulkOp, names: { folder?: string; section?: string } = {}): { verb: string; past: string } {
  switch (op.kind) {
    case "archive":
      return { verb: "Archive", past: "Archived" };
    case "trash":
      return { verb: "Move to Trash", past: "Moved to Trash" };
    case "spam":
      return { verb: "Mark as spam", past: "Marked as spam" };
    case "move":
      return { verb: `Move to ${names.folder ?? "folder"}`, past: `Moved to ${names.folder ?? "folder"}` };
    case "read":
      return op.read ? { verb: "Mark read", past: "Marked read" } : { verb: "Mark unread", past: "Marked unread" };
    case "star":
      return op.starred ? { verb: "Star", past: "Starred" } : { verb: "Unstar", past: "Unstarred" };
    case "section":
      return op.sectionId ? { verb: `Put in ${names.section ?? "section"}`, past: `Put in ${names.section ?? "section"}` } : { verb: "Take out of sections", past: "Taken out of sections" };
  }
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
```

```ts
// src/lib/mail/compose-text.ts
import type { Email } from "@/lib/types";

/** The quoted block under a forward. */
export function forwardBody(e: Email) {
  return `\n\n---------- Forwarded message ----------\nFrom: ${e.from.name} <${e.from.address}>\nSubject: ${e.subject}\n\n${e.text}`;
}
```

- [ ] **Step 4: Add the store actions**

In `src/lib/store.ts`:

1. Change `Compose`:

```ts
export type Compose = {
  mode: "blank" | "ai";
  replyTo?: string;
  forward?: boolean;
  /** Fields filled in up front (the assistant's drafts). */
  prefill?: { to?: string; cc?: string; subject?: string; body?: string };
};
```

2. Export the provider lookup under the existing `providerFor`: `export const providerOf = (accountId: string) => providerFor(accountId);`

3. Add to `MailState`:

```ts
  ensureEmail: (ref: { id: string; accountId: string }) => Promise<Email>;
  bulkApply: (emails: Email[], op: BulkOp, opts?: BulkOptions) => Promise<BulkResult>;
  bulkUndo: (undo: UndoEntry[], op: BulkOp) => Promise<BulkResult>;
```

4. Add a module-level runner above `export const useMail`:

```ts
interface BulkJob {
  accountId: string;
  emails: Email[];
  run: (p: MailProvider, emails: Email[]) => Promise<BatchOutcome>;
}

/** Run jobs in order; stop at the first failure and hand back everything not done. */
async function runBulk(jobs: BulkJob[], total: number, opts: BulkOptions, onDone: (e: Email) => void) {
  const res = { done: 0, skipped: 0, failed: [] as Email[], error: undefined as string | undefined };
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (opts.isCancelled?.()) {
      res.failed.push(...jobs.slice(i).flatMap((j) => j.emails));
      res.error = "Stopped.";
      break;
    }
    let o: BatchOutcome;
    try {
      o = await job.run(providerFor(job.accountId), job.emails);
    } catch (err) {
      res.failed.push(...jobs.slice(i).flatMap((j) => j.emails));
      res.error = err instanceof Error ? err.message : String(err);
      break;
    }
    const skipped = new Set(o.skipped);
    const failed = new Set(o.failed);
    for (const e of job.emails) {
      if (skipped.has(e.id)) res.skipped++;
      else if (failed.has(e.id)) res.failed.push(e);
      else {
        res.done++;
        onDone(e);
      }
    }
    opts.onProgress?.(res.done + res.skipped, total);
    if (failed.size) {
      res.failed.push(...jobs.slice(i + 1).flatMap((j) => j.emails));
      res.error = `${failed.size} couldn't be changed.`;
      break;
    }
  }
  return res;
}

const groupBy = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};
```

5. Add the actions inside the store object (next to `trash`):

```ts
    async ensureEmail(ref) {
      const have = get().emails.find((e) => e.id === ref.id && !e.partial);
      if (have) return have;
      const full = await providerFor(ref.accountId).getMessage(ref.id);
      set((s) => ({ emails: s.emails.some((e) => e.id === full.id) ? s.emails.map((e) => (e.id === full.id ? full : e)) : [...s.emails, full] }));
      return full;
    },

    async bulkApply(emails, op, opts = {}) {
      const s = get();
      const entry = (e: Email): UndoEntry => ({ id: e.id, accountId: e.accountId, folderId: e.folderId, unread: e.unread, starred: e.starred });
      if (op.kind === "section") {
        const undo = emails.map((e) => ({ ...entry(e), section: e.id in s.sectionOverrides ? s.sectionOverrides[e.id] : undefined }));
        get().setSection(emails.map((e) => e.id), op.sectionId);
        opts.onProgress?.(emails.length, emails.length);
        return { done: emails.length, skipped: 0, failed: [], undo };
      }
      const failed: Email[] = [];
      let error: string | undefined;
      let skipped = 0;
      const jobs: BulkJob[] = [];
      for (const [accountId, list] of groupBy(emails, (e) => e.accountId)) {
        const p = providers.get(accountId);
        let target: string | undefined;
        if (op.kind === "move") {
          const f = s.folders.find((x) => x.id === op.folderId);
          if (!f || f.accountId !== accountId) {
            failed.push(...list);
            error = "That folder belongs to another account, so those emails weren't moved.";
            continue;
          }
          target = f.id;
        } else if (op.kind === "archive" || op.kind === "trash" || op.kind === "spam") {
          target = sysFolder(s.folders, accountId, op.kind)?.id;
          if (!target) {
            failed.push(...list);
            error = `No ${op.kind} folder for ${accountId}.`;
            continue;
          }
        }
        if (!p) {
          failed.push(...list);
          error = `Account ${accountId} isn't connected.`;
          continue;
        }
        const pending = list.filter((e) =>
          op.kind === "read" ? e.unread === op.read : op.kind === "star" ? e.starred !== op.starred : e.folderId !== target,
        );
        skipped += list.length - pending.length;
        for (const part of chunk(pending, p.batchSize))
          jobs.push({
            accountId,
            emails: part,
            run: (prov, es) =>
              op.kind === "read"
                ? prov.batchSetRead(es.map((e) => e.id), op.read)
                : op.kind === "star"
                  ? prov.batchSetStarred(es.map((e) => e.id), op.starred)
                  : prov.batchMove(es, target!),
          });
      }
      const undo: UndoEntry[] = [];
      const patch = new Map<string, Partial<Email>>();
      const res = await runBulk(jobs, emails.length, opts, (e) => {
        undo.push(entry(e));
        const target = op.kind === "move" ? op.folderId : op.kind === "read" || op.kind === "star" ? undefined : sysFolder(get().folders, e.accountId, op.kind)?.id;
        patch.set(e.id, op.kind === "read" ? { unread: !op.read } : op.kind === "star" ? { starred: op.starred } : { folderId: target });
      });
      applyPatches(patch);
      return { done: res.done, skipped: skipped + res.skipped, failed: [...failed, ...res.failed], undo, error: res.error ?? error };
    },

    async bulkUndo(undo, op) {
      if (op.kind === "section") {
        set((s) => {
          const next = { ...s.sectionOverrides };
          for (const u of undo) {
            if (u.section === undefined) delete next[u.id];
            else next[u.id] = u.section;
          }
          return { sectionOverrides: next };
        });
        return { done: undo.length, skipped: 0, failed: [], undo: [] };
      }
      const stub = (u: UndoEntry): Email => get().emails.find((e) => e.id === u.id) ?? ({ id: u.id, accountId: u.accountId, folderId: "", labels: [] } as unknown as Email);
      const jobs: BulkJob[] = [];
      for (const [key, list] of groupBy(undo, (u) => (op.kind === "read" || op.kind === "star" ? u.accountId : `${u.accountId}|${u.folderId}`))) {
        const accountId = list[0].accountId;
        const p = providers.get(accountId);
        if (!p) continue;
        const folderId = key.split("|")[1];
        for (const part of chunk(list.map(stub), p.batchSize))
          jobs.push({
            accountId,
            emails: part,
            run: (prov, es) =>
              op.kind === "read"
                ? prov.batchSetRead(es.map((e) => e.id), !op.read)
                : op.kind === "star"
                  ? prov.batchSetStarred(es.map((e) => e.id), !op.starred)
                  : prov.batchMove(es, folderId),
          });
      }
      const byId = new Map(undo.map((u) => [u.id, u]));
      const patch = new Map<string, Partial<Email>>();
      const res = await runBulk(jobs, undo.length, {}, (e) => {
        const u = byId.get(e.id)!;
        patch.set(e.id, { folderId: u.folderId, unread: u.unread, starred: u.starred });
      });
      applyPatches(patch);
      return { ...res, undo: [] };
    },
```

6. Add `applyPatches` as a module-level helper after `useMail` is created. It updates cached emails, drops moved ones from the selection and checked rows, and re-caches:

```ts
function applyPatches(patch: Map<string, Partial<Email>>) {
  if (!patch.size) return;
  const ids = [...patch.keys()];
  useMail.setState((s) => ({
    emails: s.emails.map((e) => (patch.has(e.id) ? { ...e, ...patch.get(e.id) } : e)),
    selectedId: s.selectedId && patch.get(s.selectedId)?.folderId ? null : s.selectedId,
    checked: new Set([...s.checked].filter((id) => !patch.get(id)?.folderId)),
  }));
  recache(ids.filter((id) => useMail.getState().emails.some((e) => e.id === id)));
}
```

Import `chunk`, `type BulkOp`, `type BulkOptions`, `type BulkResult`, `type UndoEntry` from `@/lib/mail/bulk`, and `type BatchOutcome` from `@/lib/mail/provider`. `recache` and `sysFolder` already exist in `store.ts`; check that `recache` is defined at module scope, and hoist it if it's declared inside the store factory.

- [ ] **Step 5: Apply the prefill in the composer**

In `src/components/mail/composer.tsx`, replace the body of the reset effect after `setFiles([])` with:

```ts
    if (compose.mode === "ai") return setDoc(null);
    const base = !replyTo
      ? { to: "", cc: "", subject: "", body: "" }
      : compose.forward
        ? { to: "", cc: "", subject: `Fwd: ${replyTo.subject}`, body: forwardBody(replyTo) }
        : { to: replyTo.from.address, cc: "", subject: `Re: ${replyTo.subject}`, body: "" };
    const p = compose.prefill;
    if (p?.cc) setShowCc(true);
    setDoc(p ? { ...base, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } : base);
```

Import `forwardBody` from `@/lib/mail/compose-text`.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mail/bulk.ts src/lib/mail/compose-text.ts src/lib/store.ts src/components/mail/composer.tsx src/lib/__tests__/bulk-store.test.ts
git commit -m "Store: chunked bulk actions with resume and undo, full-email loading, compose prefill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Assistant state, result sets and persistence

**Files:**
- Create: `src/lib/ai/assistant/state.ts`
- Test: `src/lib/__tests__/assistant-state.test.ts`

**Interfaces:**
- Consumes: `AgentMessage` (Task 1), `MailQuery` (Task 3), `BulkOp`, `UndoEntry` (Task 7), `Compose` (Task 7).
- Produces:
  - `Ref {id, accountId}`
  - `ResultSet {id, label, query?, refs, parentId?, groups?}`
  - `Card` (`bulk` / `event` / `draft`)
  - `Item` (`user` / `assistant` / `step` / `set` / `card` / `error`)
  - `useAssistant` with state `open`, `busy`, `items`, `history`, `sets`, `headers`, `known`, `notes`, `activeSetId`, and actions `toggle(open?)`, `newChat()`, `push(item) → id`, `patchCard(id, patch)`, `pushHistory(m)`, `popHistoryIf(pred)`, `addSet(s) → ResultSet`, `patchSet(id, patch)`, `addHeaders(es)`, `remember(refs)`, `note(text)`, `drainNotes() → string[]`, `showSet(id | null)`
  - `assistantSnapshot(state)`, `restoreAssistant(snap)`, `loadAssistant()`, `startAssistantAutosave()`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/assistant-state.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
const { useAssistant, assistantSnapshot, restoreAssistant } = await import("@/lib/ai/assistant/state");

beforeEach(() => useAssistant.getState().newChat());

describe("assistant state", () => {
  it("adds sets, remembers ids, and queues notes for the next message", () => {
    const st = useAssistant.getState();
    const set = st.addSet({ label: "From amazon.com", refs: [{ id: "a", accountId: "g" }] });
    st.remember([{ id: "a", accountId: "g" }]);
    st.note("The user confirmed the trash.");
    const now = useAssistant.getState();
    expect(now.sets[set.id].refs).toHaveLength(1);
    expect(now.known.a).toEqual({ id: "a", accountId: "g" });
    expect(now.drainNotes()).toEqual(["The user confirmed the trash."]);
    expect(useAssistant.getState().notes).toEqual([]);
  });

  it("patches cards by item id", () => {
    const id = useAssistant.getState().push({ kind: "card", card: { type: "event", event: { title: "Flight", start: "2026-11-02T08:00:00", end: "2026-11-02T09:00:00", allDay: false }, status: "pending" } });
    useAssistant.getState().patchCard(id, { status: "added" });
    const item = useAssistant.getState().items.find((i) => i.id === id);
    expect(item?.kind === "card" && item.card.status).toBe("added");
  });

  it("patchCard on a missing item does nothing", () => {
    useAssistant.getState().newChat();
    expect(() => useAssistant.getState().patchCard("gone", { status: "done" })).not.toThrow();
    expect(useAssistant.getState().items).toEqual([]);
  });

  it("new chat clears the conversation and sets but keeps the panel open", () => {
    const st = useAssistant.getState();
    st.toggle(true);
    st.push({ kind: "user", text: "hi" });
    st.addSet({ label: "x", refs: [] });
    st.newChat();
    const now = useAssistant.getState();
    expect([now.items.length, Object.keys(now.sets).length, now.open]).toEqual([0, 0, true]);
  });

  it("saves the conversation without sets, trimmed to the newest 200 items and 40 messages", () => {
    const st = useAssistant.getState();
    for (let i = 0; i < 230; i++) st.push({ kind: "step", text: `s${i}` });
    for (let i = 0; i < 50; i++) st.pushHistory({ role: "user", content: `m${i}` });
    st.addSet({ label: "x", refs: [] });
    const snap = assistantSnapshot(useAssistant.getState());
    expect(snap.items).toHaveLength(200);
    expect(snap.history).toHaveLength(40);
    expect(snap.history[0]).toEqual({ role: "user", content: "m10" });
    expect(snap).not.toHaveProperty("sets");
  });

  it("running cards load as interrupted, with their emails kept for Resume", () => {
    restoreAssistant({
      items: [{ id: "c", kind: "card", card: { type: "bulk", op: { kind: "trash" }, refs: [{ id: "a", accountId: "g" }], title: "Move 1 to Trash", detail: "", status: "running", done: 0, total: 1 } }],
      history: [],
    });
    const item = useAssistant.getState().items[0];
    expect(item.kind === "card" && item.card.type === "bulk" && item.card.status).toBe("partial");
    expect(item.kind === "card" && item.card.type === "bulk" && item.card.failedRefs).toEqual([{ id: "a", accountId: "g" }]);
  });

  it("drops a saved history that starts with tool results (it can't be replayed)", () => {
    restoreAssistant({ items: [], history: [{ role: "tool", toolCallId: "x", name: "act", content: "{}" }, { role: "user", content: "hi" }] });
    expect(useAssistant.getState().history).toEqual([{ role: "user", content: "hi" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/assistant-state.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `state.ts`**

```ts
// src/lib/ai/assistant/state.ts
// The assistant panel's state: what's on screen (items), what the model has
// seen (history), result sets, header rows, and ids the model may act on.
// The conversation is saved locally; sets are not (old set chips re-run
// their search when clicked).

import { create } from "zustand";
import type { Email } from "@/lib/types";
import type { AgentMessage } from "@/lib/ai/tool-chat";
import type { MailQuery } from "./query";
import type { BulkOp, UndoEntry } from "@/lib/mail/bulk";
import type { Compose } from "@/lib/store";
import { kvGet, kvSet } from "@/lib/db";

export interface Ref {
  id: string;
  accountId: string;
}

export interface ResultSet {
  id: string;
  label: string;
  /** The search behind the set (breakdown groups inherit their parent's). */
  query?: MailQuery;
  refs: Ref[];
  parentId?: string;
  /** Breakdown groups, shown as tabs above the mail list. */
  groups?: { label: string; count: number; setId: string }[];
}

export interface EventDraft {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  emailId?: string;
}

export type Card =
  | {
      type: "bulk";
      op: BulkOp;
      setId?: string;
      refs: Ref[];
      title: string;
      detail: string;
      /** partial = stopped or failed partway (Resume retries failedRefs). */
      status: "pending" | "running" | "done" | "partial" | "cancelled" | "undone";
      done: number;
      total: number;
      failedRefs?: Ref[];
      undo?: UndoEntry[];
      error?: string;
    }
  | { type: "event"; event: EventDraft; status: "pending" | "added" | "dismissed" }
  | { type: "draft"; summary: string; compose: Compose };

type CardPatch = Partial<Extract<Card, { type: "bulk" }>> | Partial<Extract<Card, { type: "event" }>>;

export type Item =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "step"; text: string }
  | { id: string; kind: "set"; setId: string; label: string; count: number; query?: MailQuery; groups?: { label: string; count: number; setId: string }[] }
  | { id: string; kind: "card"; card: Card }
  | { id: string; kind: "error"; text: string; retry?: string };

type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

interface AssistantState {
  open: boolean;
  busy: boolean;
  items: Item[];
  history: AgentMessage[];
  sets: Record<string, ResultSet>;
  headers: Record<string, Email>;
  known: Record<string, Ref>;
  notes: string[];
  /** Set shown in the mail list, if any. */
  activeSetId: string | null;
  toggle: (open?: boolean) => void;
  newChat: () => void;
  push: (item: NewItem) => string;
  patchCard: (id: string, patch: CardPatch) => void;
  pushHistory: (m: AgentMessage) => void;
  /** Remove the last history message if it matches (used by Retry). */
  popHistoryIf: (pred: (m: AgentMessage) => boolean) => void;
  addSet: (s: Omit<ResultSet, "id">) => ResultSet;
  patchSet: (id: string, patch: Partial<ResultSet>) => void;
  addHeaders: (rows: Email[]) => void;
  remember: (refs: Ref[]) => void;
  note: (text: string) => void;
  drainNotes: () => string[];
  showSet: (id: string | null) => void;
}

const newId = () => Math.random().toString(36).slice(2, 10);

export const useAssistant = create<AssistantState>()((set, get) => ({
  open: false,
  busy: false,
  items: [],
  history: [],
  sets: {},
  headers: {},
  known: {},
  notes: [],
  activeSetId: null,
  toggle: (open) => set((s) => ({ open: open ?? !s.open })),
  newChat: () => set({ items: [], history: [], sets: {}, known: {}, notes: [], activeSetId: null, busy: false }),
  push: (item) => {
    const id = newId();
    set((s) => ({ items: [...s.items, { ...item, id } as Item] }));
    return id;
  },
  patchCard: (id, patch) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id && i.kind === "card" ? { ...i, card: { ...i.card, ...patch } as Card } : i)) })),
  pushHistory: (m) => set((s) => ({ history: [...s.history, m] })),
  popHistoryIf: (pred) => set((s) => (s.history.length && pred(s.history[s.history.length - 1]) ? { history: s.history.slice(0, -1) } : {})),
  addSet: (input) => {
    const rs: ResultSet = { ...input, id: `set_${newId()}` };
    set((s) => ({ sets: { ...s.sets, [rs.id]: rs } }));
    return rs;
  },
  patchSet: (id, patch) => set((s) => (s.sets[id] ? { sets: { ...s.sets, [id]: { ...s.sets[id], ...patch } } } : {})),
  addHeaders: (rows) => set((s) => ({ headers: { ...s.headers, ...Object.fromEntries(rows.map((r) => [r.id, r])) } })),
  remember: (refs) => set((s) => ({ known: { ...s.known, ...Object.fromEntries(refs.map((r) => [r.id, r])) } })),
  note: (text) => set((s) => ({ notes: [...s.notes, text] })),
  drainNotes: () => {
    const notes = get().notes;
    set({ notes: [] });
    return notes;
  },
  showSet: (activeSetId) => set({ activeSetId }),
}));

// ---- persistence ----------------------------------------------------------------

const KEY = "assistant.v1";

export interface AssistantSnapshot {
  items: Item[];
  history: AgentMessage[];
}

export function assistantSnapshot(s: Pick<AssistantState, "items" | "history">): AssistantSnapshot {
  return { items: s.items.slice(-200), history: s.history.slice(-40) };
}

export function restoreAssistant(snap: AssistantSnapshot) {
  // A trimmed history must not start with tool results: their tool calls were cut off.
  let history = snap.history ?? [];
  while (history.length && history[0].role !== "user") history = history.slice(1);
  const items = (snap.items ?? []).map((i): Item =>
    i.kind === "card" && i.card.type === "bulk" && i.card.status === "running"
      ? { ...i, card: { ...i.card, status: "partial", error: "Interrupted when zMail closed.", failedRefs: i.card.failedRefs ?? i.card.refs } }
      : i,
  );
  useAssistant.setState({ items, history });
}

export async function loadAssistant() {
  const snap = await kvGet<AssistantSnapshot>(KEY).catch(() => null);
  if (snap) restoreAssistant(snap);
}

let saving = false;
export function startAssistantAutosave() {
  if (saving) return;
  saving = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: AssistantSnapshot | null = null;
  useAssistant.subscribe((s) => {
    if (last && s.items === last.items && s.history === last.history) return;
    last = { items: s.items, history: s.history };
    clearTimeout(timer);
    timer = setTimeout(() => kvSet(KEY, assistantSnapshot(useAssistant.getState())).catch((err) => console.error("[assistant] save failed", err)), 600);
  });
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/assistant-state.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/assistant/state.ts src/lib/__tests__/assistant-state.test.ts
git commit -m "Assistant: conversation state, result sets and local persistence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Kind labels for breakdowns

**Files:**
- Create: `src/lib/ai/assistant/kinds.ts`
- Test: `src/lib/__tests__/assistant-kinds.test.ts`

**Interfaces:**
- Consumes: `GenerativeProvider.complete` (existing).
- Produces:
  - `KINDS`, `type Kind`, `KIND_LABELS: Record<Kind, string>`
  - `kindFromCategory(c?: Category): Kind | undefined`
  - `labelKinds(p, rows: Email[]): Promise<Record<string, Kind>>` (one model call per 200 rows)
  - `kindsFor(rows, deps: {categoryOf, cache: Record<string, Kind>, provider, onProgress?}): Promise<{kinds: Record<string, Kind>; learned: Record<string, Kind>}>`

The spec says sorted mail "uses its category". zMail's `transactions` and `updates` categories mix orders, receipts and statements, so they can't answer "how many are orders/delivery". Only the unambiguous categories map directly (promotions, newsletters, social, security, primary). Mail in `transactions` and `updates` is labelled by the model like unsorted mail.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/assistant-kinds.test.ts
import { describe, expect, it } from "vitest";
import type { Email } from "@/lib/types";
import type { GenerativeProvider } from "@/lib/ai/generative";
import { kindFromCategory, kindsFor, labelKinds } from "@/lib/ai/assistant/kinds";

const row = (id: string, subject: string) => ({ id, accountId: "g", from: { name: "Amazon.com", address: "ship@amazon.com" }, subject }) as Email;
const prompts: string[] = [];
const provider = (reply: (prompt: string) => string): GenerativeProvider => ({
  name: "fake",
  complete: async (m) => {
    prompts.push(m.at(-1)!.content);
    return reply(m.at(-1)!.content);
  },
  chat: async () => ({ text: "", toolCalls: [] }),
});

describe("kinds", () => {
  it("maps only unambiguous zMail categories", () => {
    expect(kindFromCategory("promotions")).toBe("promotion");
    expect(kindFromCategory("transactions")).toBeUndefined();
    expect(kindFromCategory("updates")).toBeUndefined();
  });

  it("labels sender + subject lines in one call per 200, tolerating fences and unknown labels", async () => {
    prompts.length = 0;
    const rows = Array.from({ length: 201 }, (_, i) => row(`m${i}`, i % 2 ? "Shipped: socks" : "Your receipt"));
    const out = await labelKinds(
      provider((p) => "```json\n" + JSON.stringify(Object.fromEntries([...p.matchAll(/^(\d+)\. .*?\| (.*)$/gm)].map((m) => [m[1], m[2].startsWith("Shipped") ? "order_delivery" : "banana"]))) + "\n```"),
      rows,
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("text");
    expect(out.m1).toBe("order_delivery");
    expect(out.m0).toBe("other");
  });

  it("uses categories and the cache first, and only asks about the rest", async () => {
    prompts.length = 0;
    const res = await kindsFor([row("a", "Deal!"), row("b", "Shipped: hub"), row("c", "Delivered")], {
      categoryOf: (id) => (id === "a" ? "promotions" : undefined),
      cache: { b: "order_delivery" },
      provider: provider(() => '{"1":"order_delivery"}'),
    });
    expect(res.kinds).toEqual({ a: "promotion", b: "order_delivery", c: "order_delivery" });
    expect(res.learned).toEqual({ c: "order_delivery" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Delivered");
    expect(prompts[0]).not.toContain("Shipped: hub");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/assistant-kinds.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `kinds.ts`**

```ts
// src/lib/ai/assistant/kinds.ts
// "What kind of email is this?" for breakdowns ("how many are just orders and
// deliveries?"). Clear zMail categories map directly; everything else is
// labelled by the assistant model from sender and subject only, never bodies.
// Provider tabs/labels (Gmail CATEGORY_*, Outlook Focused) are never used.

import type { Category, Email } from "@/lib/types";
import type { GenerativeProvider } from "@/lib/ai/generative";

export const KINDS = ["order_delivery", "receipt_bill", "promotion", "newsletter", "account_notice", "security", "social", "personal", "other"] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABELS: Record<Kind, string> = {
  order_delivery: "Order & delivery",
  receipt_bill: "Receipts & bills",
  promotion: "Promos",
  newsletter: "Newsletters",
  account_notice: "Account notices",
  security: "Security",
  social: "Social",
  personal: "Personal",
  other: "Other",
};

const FROM_CATEGORY: Partial<Record<Category, Kind>> = {
  promotions: "promotion",
  newsletters: "newsletter",
  social: "social",
  security: "security",
  primary: "personal",
};

export function kindFromCategory(c: Category | undefined): Kind | undefined {
  return c ? FROM_CATEGORY[c] : undefined;
}

const BATCH = 200;

function parseKinds(raw: string): Record<string, string> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function labelKinds(p: GenerativeProvider, rows: Email[], onProgress?: (n: number) => void): Promise<Record<string, Kind>> {
  const out: Record<string, Kind> = {};
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH);
    const lines = part.map((e, j) => `${j + 1}. ${e.from.name} <${e.from.address}> | ${e.subject.replace(/\s+/g, " ").slice(0, 140)}`).join("\n");
    const raw = await p.complete(
      [
        { role: "system", content: "You label emails by kind from their sender and subject. Answer with JSON only." },
        {
          role: "user",
          content: `Label each email with one kind: ${KINDS.join(", ")}.\norder_delivery = order confirmations, shipping and delivery updates. receipt_bill = receipts, invoices, statements, payments due. account_notice = factual notices about the user's accounts.\nReturn a JSON object mapping each number to its kind.\n\n${lines}`,
        },
      ],
      { maxTokens: 12 * part.length + 50 },
    );
    const got = parseKinds(raw);
    part.forEach((e, j) => {
      const k = got[String(j + 1)] as Kind | undefined;
      out[e.id] = k && KINDS.includes(k) ? k : "other";
    });
    onProgress?.(Math.min(i + BATCH, rows.length));
  }
  return out;
}

export async function kindsFor(
  rows: Email[],
  deps: { categoryOf: (id: string) => Category | undefined; cache: Record<string, Kind>; provider: GenerativeProvider; onProgress?: (n: number) => void },
): Promise<{ kinds: Record<string, Kind>; learned: Record<string, Kind> }> {
  const kinds: Record<string, Kind> = {};
  const ask: Email[] = [];
  for (const e of rows) {
    const k = kindFromCategory(deps.categoryOf(e.id)) ?? deps.cache[e.id];
    if (k) kinds[e.id] = k;
    else ask.push(e);
  }
  const learned = ask.length ? await labelKinds(deps.provider, ask, deps.onProgress) : {};
  return { kinds: { ...kinds, ...learned }, learned };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/assistant-kinds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/assistant/kinds.ts src/lib/__tests__/assistant-kinds.test.ts
git commit -m "Assistant: kind labels for breakdowns from sender and subject

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Tools, the approval gate, and the real wiring

**Files:**
- Create: `src/lib/ai/assistant/tools.ts` (schemas, executors, `ToolDeps`)
- Create: `src/lib/ai/assistant/deps.ts` (`realDeps()`)
- Create: `src/lib/ai/assistant/cards.ts` (confirm, stop, resume, undo, event add or dismiss, review)
- Test: `src/lib/__tests__/assistant-tools.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 7, 8 and 9.
- Produces:
  - `TOOLS: ToolDef[]`, `SET_CAP = 10000`
  - `ToolDeps`, `DraftArgs`, `ViewInfo`
  - `executeTool(call, deps): Promise<{content: unknown; malformed?: boolean}>` (never throws)
  - `rowFor(e, folders)`
  - `realDeps(): ToolDeps`
  - `confirmBulk(itemId, deps?)`, `stopBulk(itemId)`, `resumeBulk(itemId, deps?)`, `undoBulk(itemId, deps?)`, `cancelCard(itemId)`, `addEvent(itemId, calendarId, deps?)`, `dismissEvent(itemId)`, `reviewSet(setId)`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/assistant-tools.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";

vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
const { useAssistant } = await import("@/lib/ai/assistant/state");
const { executeTool } = await import("@/lib/ai/assistant/tools");
const { confirmBulk, undoBulk } = await import("@/lib/ai/assistant/cards");
import type { ToolDeps } from "@/lib/ai/assistant/tools";

const mk = (i: number, over: Partial<Email> = {}) =>
  ({ id: `m${i}`, accountId: "g", threadId: `m${i}`, folderId: "g:INBOX", from: { name: "Amazon.com", address: "ship@amazon.com" }, to: [], subject: i % 4 ? "Shipped: socks" : "Your receipt", snippet: "snip", text: "body ".repeat(3000), date: "2025-05-01T00:00:00Z", unread: true, starred: false, labels: [], partial: true, ...over }) as Email;
const all = Array.from({ length: 40 }, (_, i) => mk(i));

function fakeDeps(over: Partial<ToolDeps> = {}): ToolDeps & { bulkCalls: unknown[]; opened: unknown[]; fetched: string[] } {
  const bulkCalls: unknown[] = [];
  const opened: unknown[] = [];
  const fetched: string[] = [];
  return {
    bulkCalls,
    opened,
    fetched,
    folders: () => [{ id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" }, { id: "g:Label_1", accountId: "g", name: "Receipts" }],
    sections: () => [{ id: "sec1", name: "Bills", description: "", icon: "credit-card", hue: 1, accountIds: [], dates: false }],
    search: async () => ({ refs: all.map((e) => ({ id: e.id, accountId: "g" })), headers: all, tooMany: false }),
    loadHeaders: async (refs) => refs.map((r) => all.find((e) => e.id === r.id)!),
    getEmail: async (ref) => {
      fetched.push(ref.id);
      return { ...all.find((e) => e.id === ref.id)!, partial: undefined };
    },
    view: () => ({ open: undefined, checked: [], listLabel: "Inbox", setId: null }),
    kinds: async (rows) => Object.fromEntries(rows.map((e) => [e.id, e.subject.startsWith("Shipped") ? "order_delivery" : "receipt_bill"])),
    bulk: async (emails, op) => {
      bulkCalls.push({ ids: emails.map((e) => e.id), op });
      return { done: emails.length, skipped: 0, failed: [], undo: emails.map((e) => ({ id: e.id, accountId: e.accountId, folderId: e.folderId, unread: e.unread, starred: e.starred })) };
    },
    undo: async (u) => ({ done: u.length, skipped: 0, failed: [], undo: [] }),
    draft: async (a) => ({ mode: "blank", replyTo: a.emailId, prefill: { body: `Draft: ${a.instructions}` } }),
    openCompose: (c) => void opened.push(c),
    defaultCalendar: () => "g:primary",
    createEvent: async () => {},
    toast: () => {},
    ...over,
  };
}
const call = (name: string, args: Record<string, unknown> | null) => ({ id: name, name, args });

beforeEach(() => useAssistant.getState().newChat());

describe("search_mail and break_down", () => {
  it("creates a set, returns a 20-row sample, and shows a set chip", async () => {
    const res = (await executeTool(call("search_mail", { query: { from: "amazon.com" } }), fakeDeps())).content as { set_id: string; count: number; sample: unknown[] };
    expect(res.count).toBe(40);
    expect(res.sample).toHaveLength(20);
    expect(useAssistant.getState().items.map((i) => i.kind)).toEqual(["step", "set"]);
    expect(Object.keys(useAssistant.getState().known)).toHaveLength(20);
  });

  it("refuses sets over the cap", async () => {
    const res = (await executeTool(call("search_mail", { query: {} }), fakeDeps({ search: async () => ({ refs: [], headers: [], tooMany: true }) }))).content as { too_many: boolean };
    expect(res.too_many).toBe(true);
  });

  it("breaks a set down by kind into child sets", async () => {
    const deps = fakeDeps();
    const { set_id } = (await executeTool(call("search_mail", { query: { from: "amazon.com" } }), deps)).content as { set_id: string };
    const res = (await executeTool(call("break_down", { set_id, by: "kind" }), deps)).content as { groups: { label: string; count: number; set_id: string }[] };
    expect(res.groups.map((g) => [g.label, g.count])).toEqual([["Order & delivery", 30], ["Receipts & bills", 10]]);
    expect(useAssistant.getState().sets[res.groups[0].set_id].parentId).toBe(set_id);
    expect(useAssistant.getState().sets[set_id].groups).toHaveLength(2);
  });
});

describe("approval gate", () => {
  it("runs a small archive directly", async () => {
    const deps = fakeDeps();
    await executeTool(call("search_mail", { query: { from: "amazon.com" } }), deps);
    const res = (await executeTool(call("act", { ids: ["m0", "m1"], op: "archive" }), deps)).content as { done: number };
    expect(res.done).toBe(2);
    expect(deps.bulkCalls).toHaveLength(1);
  });

  it("confirms an archive of 26 or more, and any trash", async () => {
    const deps = fakeDeps();
    const { set_id } = (await executeTool(call("search_mail", { query: { from: "amazon.com" } }), deps)).content as { set_id: string };
    expect(((await executeTool(call("act", { set_id, op: "archive" }), deps)).content as { status: string }).status).toBe("awaiting_confirmation");
    expect(((await executeTool(call("act", { ids: ["m0"], op: "trash" }), deps)).content as { status: string }).status).toBe("awaiting_confirmation");
    expect(deps.bulkCalls).toHaveLength(0);
    expect(useAssistant.getState().items.filter((i) => i.kind === "card")).toHaveLength(2);
  });

  it("rejects ids the model was never shown", async () => {
    const res = await executeTool(call("act", { ids: ["made-up"], op: "archive" }), fakeDeps());
    expect(res.content).toMatchObject({ error: expect.stringMatching(/unknown/) });
  });

  it("confirming a card runs it, records undo, and tells the model next time", async () => {
    const deps = fakeDeps();
    const { set_id } = (await executeTool(call("search_mail", { query: { from: "amazon.com" } }), deps)).content as { set_id: string };
    await executeTool(call("act", { set_id, op: "trash" }), deps);
    const card = useAssistant.getState().items.find((i) => i.kind === "card")!;
    await confirmBulk(card.id, deps);
    const after = useAssistant.getState().items.find((i) => i.id === card.id)!;
    expect(after.kind === "card" && after.card.type === "bulk" && [after.card.status, after.card.done]).toEqual(["done", 40]);
    expect(useAssistant.getState().notes[0]).toMatch(/confirmed/);
    await undoBulk(card.id, deps);
    const undone = useAssistant.getState().items.find((i) => i.id === card.id)!;
    expect(undone.kind === "card" && undone.card.status).toBe("undone");
  });
});

describe("reading, events and drafts", () => {
  it("read_email loads a header-only email in full and caps the text", async () => {
    const deps = fakeDeps();
    await executeTool(call("search_mail", { query: { from: "amazon.com" } }), deps);
    const res = (await executeTool(call("read_email", { id: "m3" }), deps)).content as { text: string };
    expect(deps.fetched).toEqual(["m3"]);
    expect(res.text.length).toBeLessThanOrEqual(6000);
  });

  it("create_event always shows a card", async () => {
    const res = (await executeTool(call("create_event", { title: "Delta to Denver", start: "2026-11-02T08:15:00", end: "2026-11-02T10:40:00" }), fakeDeps())).content as { status: string };
    expect(res.status).toBe("awaiting_confirmation");
    const card = useAssistant.getState().items.at(-1)!;
    expect(card.kind === "card" && card.card.type).toBe("event");
  });

  it("an all-day event without an end ends the next day", async () => {
    await executeTool(call("create_event", { title: "Field trip", start: "2026-11-05", all_day: true }), fakeDeps());
    const card = useAssistant.getState().items.at(-1)!;
    expect(card.kind === "card" && card.card.type === "event" && [card.card.event.start.slice(0, 10), card.card.event.end.slice(0, 10)]).toEqual(["2026-11-05", "2026-11-06"]);
  });

  it("draft opens compose and never sends", async () => {
    const deps = fakeDeps();
    await executeTool(call("search_mail", { query: { from: "amazon.com" } }), deps);
    const res = (await executeTool(call("draft", { kind: "reply", email_id: "m1", instructions: "say thanks" }), deps)).content as { status: string };
    expect(res.status).toBe("opened_in_compose");
    expect(deps.opened).toHaveLength(1);
  });

  it("there is no send tool", async () => {
    const { TOOLS } = await import("@/lib/ai/assistant/tools");
    expect(TOOLS.map((t) => t.name).sort()).toEqual(["act", "break_down", "create_event", "current_view", "draft", "read_email", "search_mail"]);
    expect(await executeTool(call("send_email", { to: "x" }), fakeDeps())).toMatchObject({ malformed: true });
  });

  it("flags null arguments as malformed", async () => {
    expect(await executeTool(call("search_mail", null), fakeDeps())).toMatchObject({ malformed: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/assistant-tools.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `tools.ts`**

```ts
// src/lib/ai/assistant/tools.ts
// The assistant's tools: JSON schemas for the model, and executors that run
// against ToolDeps (real store/providers in deps.ts, fakes in tests). Actions
// go through the approval gate; there is deliberately no send tool.

import type { Category, Email, Folder } from "@/lib/types";
import type { NewEvent } from "@/lib/calendar/provider";
import type { MailSection } from "@/lib/sections";
import type { Compose } from "@/lib/store";
import type { ToolCall, ToolDef } from "@/lib/ai/tool-chat";
import { needsConfirm, opText, type BulkOp, type BulkOptions, type BulkResult, type UndoEntry } from "@/lib/mail/bulk";
import { cleanQuery, describeQuery, type MailQuery } from "./query";
import { KIND_LABELS, type Kind } from "./kinds";
import { useAssistant, type Ref } from "./state";

export const SET_CAP = 10_000;
const SAMPLE = 20;
const READ_CAP = 6000;

export interface ViewInfo {
  open?: Email;
  checked: Email[];
  listLabel: string;
  setId: string | null;
}

export interface DraftArgs {
  kind: "reply" | "reply_all" | "forward" | "new";
  emailId?: string;
  to?: string;
  instructions: string;
}

export interface ToolDeps {
  folders(): Folder[];
  sections(): MailSection[];
  search(q: MailQuery, cap: number): Promise<{ refs: Ref[]; headers: Email[]; tooMany: boolean }>;
  loadHeaders(refs: Ref[], onProgress?: (n: number) => void): Promise<Email[]>;
  getEmail(ref: Ref): Promise<Email>;
  view(): ViewInfo;
  kinds(rows: Email[], onProgress?: (n: number) => void): Promise<Record<string, Kind>>;
  bulk(emails: Email[], op: BulkOp, opts?: BulkOptions): Promise<BulkResult>;
  undo(entries: UndoEntry[], op: BulkOp): Promise<BulkResult>;
  draft(args: DraftArgs): Promise<Compose>;
  openCompose(c: Compose): void;
  defaultCalendar(): string | undefined;
  createEvent(e: NewEvent): Promise<void>;
  toast(text: string, undo?: () => void): void;
}

const QUERY_SCHEMA = {
  type: "object",
  description: "All fields optional; combine them. Dates are YYYY-MM-DD.",
  properties: {
    from: { type: "string", description: "Sender address, domain (amazon.com) or name" },
    to: { type: "string" },
    subject: { type: "string", description: "Words that must all be in the subject" },
    words: { type: "string", description: "Words anywhere in the email" },
    after: { type: "string", description: "On or after this date" },
    before: { type: "string", description: "Before this date" },
    folder: { type: "string", description: "inbox, archive, sent, spam, trash, drafts, or a folder id" },
    unread: { type: "boolean" },
    starred: { type: "boolean" },
    hasAttachment: { type: "boolean" },
    category: { type: "string", enum: ["primary", "transactions", "updates", "promotions", "social", "newsletters", "security"], description: "zMail's own category. Only covers mail zMail has sorted (recent mail)." },
    section: { type: "string", description: "A section id. Only covers mail zMail has sorted." },
    account: { type: "string", description: "Limit to one account id" },
  },
};

export const TOOLS: ToolDef[] = [
  {
    name: "search_mail",
    description: `Search the user's whole mailbox (not just recent mail). Returns a set_id, the count and up to ${SAMPLE} sample rows. Use the set_id for break_down and act. Spam and trash are left out unless folder names them.`,
    parameters: { type: "object", properties: { query: QUERY_SCHEMA }, required: ["query"] },
  },
  {
    name: "break_down",
    description: "Count a set by sender, month or kind (order & delivery, receipts & bills, promos, newsletters, account notices, security, social, personal, other). Each group becomes its own set_id you can act on.",
    parameters: { type: "object", properties: { set_id: { type: "string" }, by: { type: "string", enum: ["sender", "month", "kind"] } }, required: ["set_id", "by"] },
  },
  {
    name: "read_email",
    description: `Read one email's full text (first ${READ_CAP} characters). Only ids from earlier tool results.`,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "current_view",
    description: "What the user is looking at: the open email, checked emails, and the current list. Use it to resolve 'this', 'these' and 'those'.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "act",
    description:
      "Change emails: a set_id, or ids from earlier tool results. Archive, read/unread, star/unstar and move_to_section on 25 or fewer happen right away (with Undo). Trash, spam, move_to_folder, and anything over 25 show the user a confirm card. Nothing has happened until a tool result says so.",
    parameters: {
      type: "object",
      properties: {
        set_id: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
        op: { type: "string", enum: ["archive", "trash", "spam", "move_to_folder", "mark_read", "mark_unread", "star", "unstar", "move_to_section"] },
        folder: { type: "string", description: "Folder id or name, for move_to_folder" },
        section: { type: "string", description: "Section id or name, or 'none', for move_to_section" },
      },
      required: ["op"],
    },
  },
  {
    name: "create_event",
    description: "Propose a calendar event. The user always confirms on a card. Times are local ISO (2026-11-02T08:15:00); all-day events use a date.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string", description: "Optional; defaults to one hour later, or the next day for all-day" },
        all_day: { type: "boolean" },
        location: { type: "string" },
        notes: { type: "string" },
        email_id: { type: "string", description: "The email it came from" },
      },
      required: ["title", "start"],
    },
  },
  {
    name: "draft",
    description: "Write a reply, reply-all, forward or new email and open it in compose for the user to review and send. You cannot send email.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["reply", "reply_all", "forward", "new"] },
        email_id: { type: "string", description: "Required for reply, reply_all and forward" },
        to: { type: "string", description: "Recipients, comma separated (forward and new)" },
        instructions: { type: "string", description: "What the email should say" },
      },
      required: ["kind", "instructions"],
    },
  },
];

const OPS: Record<string, (a: Record<string, unknown>, deps: ToolDeps) => BulkOp> = {
  archive: () => ({ kind: "archive" }),
  trash: () => ({ kind: "trash" }),
  spam: () => ({ kind: "spam" }),
  mark_read: () => ({ kind: "read", read: true }),
  mark_unread: () => ({ kind: "read", read: false }),
  star: () => ({ kind: "star", starred: true }),
  unstar: () => ({ kind: "star", starred: false }),
  move_to_folder: (a, deps) => {
    const name = String(a.folder ?? "").toLowerCase();
    const f = deps.folders().find((x) => x.id === a.folder || x.name.toLowerCase() === name);
    if (!f) throw new Error(`unknown folder "${a.folder}"`);
    return { kind: "move", folderId: f.id };
  },
  move_to_section: (a, deps) => {
    const v = String(a.section ?? "").toLowerCase();
    if (v === "none") return { kind: "section", sectionId: null };
    const s = deps.sections().find((x) => x.id === a.section || x.name.toLowerCase() === v);
    if (!s) throw new Error(`unknown section "${a.section}"`);
    return { kind: "section", sectionId: s.id };
  },
};

export function rowFor(e: Email, folders: Folder[]) {
  return {
    id: e.id,
    from: `${e.from.name} <${e.from.address}>`,
    subject: e.subject,
    date: e.date.slice(0, 10),
    snippet: e.snippet.slice(0, 120),
    folder: folders.find((f) => f.id === e.folderId)?.name ?? e.folderId,
    unread: e.unread,
  };
}

const bad = (error: string) => ({ content: { error }, malformed: true });
const ref = (e: Email): Ref => ({ id: e.id, accountId: e.accountId });
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

function localIso(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export async function executeTool(call: ToolCall, deps: ToolDeps): Promise<{ content: unknown; malformed?: boolean }> {
  const tool = TOOLS.find((t) => t.name === call.name);
  if (!tool) return bad(`unknown tool "${call.name}". Available: ${TOOLS.map((t) => t.name).join(", ")}`);
  if (!call.args) return bad("arguments must be a JSON object");
  const missing = ((tool.parameters.required as string[] | undefined) ?? []).filter((k) => call.args![k] === undefined);
  if (missing.length) return bad(`missing ${missing.join(", ")}`);
  try {
    return { content: await run(call.name, call.args, deps) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.startsWith("bad_query") || msg.startsWith("unknown") ? bad(msg) : { content: { error: msg } };
  }
}

async function run(name: string, a: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  const st = useAssistant.getState();
  const folders = deps.folders();
  switch (name) {
    case "search_mail": {
      const q = cleanQuery(a.query ?? {});
      const label = describeQuery(q, {
        folder: folders.find((f) => f.id === q.folder)?.name,
        section: deps.sections().find((s) => s.id === q.section)?.name,
      });
      const r = await deps.search(q, SET_CAP);
      if (r.tooMany) {
        st.push({ kind: "step", text: `⌕ Searched all mail · ${label} · over ${SET_CAP.toLocaleString()}` });
        return { too_many: true, message: `More than ${SET_CAP.toLocaleString()} emails match. Ask the user to narrow it (sender, dates or folder).` };
      }
      st.addHeaders(r.headers);
      const set = st.addSet({ label, query: q, refs: r.refs });
      const sampleRefs = r.refs.slice(0, SAMPLE);
      const sample = await deps.loadHeaders(sampleRefs);
      st.addHeaders(sample);
      st.remember(sampleRefs);
      st.push({ kind: "step", text: `⌕ Searched all mail · ${label} · ${r.refs.length.toLocaleString()}` });
      st.push({ kind: "set", setId: set.id, label, count: r.refs.length, query: q });
      return { set_id: set.id, count: r.refs.length, label, sample: sample.map((e) => rowFor(e, folders)) };
    }
    case "break_down": {
      const set = st.sets[String(a.set_id)];
      if (!set) throw new Error(`unknown set_id "${a.set_id}"`);
      const by = String(a.by);
      if (!["sender", "month", "kind"].includes(by)) throw new Error(`unknown breakdown "${by}"`);
      if (set.refs.length > 200) st.push({ kind: "step", text: `Reading ${plural(set.refs.length, "email")}…` });
      const rows = await deps.loadHeaders(set.refs);
      st.addHeaders(rows);
      let keyOf: (e: Email) => string;
      let labelOf: (k: string) => string;
      if (by === "kind") {
        const kinds = await deps.kinds(rows);
        keyOf = (e) => kinds[e.id] ?? "other";
        labelOf = (k) => KIND_LABELS[k as Kind] ?? k;
      } else if (by === "month") {
        keyOf = (e) => e.date.slice(0, 7);
        labelOf = (k) => new Date(`${k}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });
      } else {
        keyOf = (e) => e.from.address.toLowerCase();
        labelOf = (k) => rows.find((e) => e.from.address.toLowerCase() === k)?.from.name || k;
      }
      const buckets = new Map<string, Email[]>();
      for (const e of rows) buckets.set(keyOf(e), [...(buckets.get(keyOf(e)) ?? []), e]);
      let entries = [...buckets.entries()].sort((x, y) => y[1].length - x[1].length);
      if (by !== "kind" && entries.length > 12) entries = [...entries.slice(0, 11), ["others", entries.slice(11).flatMap(([, v]) => v)]];
      const groups = entries.map(([k, list]) => {
        const label = k === "others" ? "Everyone else" : labelOf(k);
        const child = st.addSet({ label: `${label} · ${set.label}`, query: set.query, refs: list.map(ref), parentId: set.id });
        return { label, count: list.length, setId: child.id };
      });
      st.patchSet(set.id, { groups });
      st.push({ kind: "set", setId: set.id, label: set.label, count: set.refs.length, query: set.query, groups });
      return { set_id: set.id, by, groups: groups.map((g) => ({ label: g.label, count: g.count, set_id: g.setId })) };
    }
    case "read_email": {
      const r = st.known[String(a.id)];
      if (!r) throw new Error(`unknown id "${a.id}": only use ids from earlier tool results`);
      const e = await deps.getEmail(r);
      st.push({ kind: "step", text: `Read “${e.subject}”` });
      return {
        id: e.id,
        from: `${e.from.name} <${e.from.address}>`,
        to: e.to.map((c) => c.address).join(", "),
        date: e.date,
        subject: e.subject,
        text: e.text.slice(0, READ_CAP),
        attachments: (e.attachments ?? []).map((x) => x.filename),
      };
    }
    case "current_view": {
      const v = deps.view();
      const refs = [...(v.open ? [v.open] : []), ...v.checked].map(ref);
      st.remember(refs);
      return {
        open_email: v.open ? rowFor(v.open, folders) : null,
        checked: v.checked.slice(0, SAMPLE).map((e) => rowFor(e, folders)),
        checked_count: v.checked.length,
        showing: v.listLabel,
        assistant_set: v.setId,
      };
    }
    case "act": {
      const make = OPS[String(a.op)];
      if (!make) throw new Error(`unknown op "${a.op}"`);
      const op = make(a, deps);
      const set = a.set_id ? st.sets[String(a.set_id)] : undefined;
      if (a.set_id && !set) throw new Error(`unknown set_id "${a.set_id}"`);
      const refs: Ref[] = set
        ? set.refs
        : ((a.ids as unknown[] | undefined) ?? []).map((id) => {
            const r = st.known[String(id)];
            if (!r) throw new Error(`unknown id "${id}": use a set_id or ids from earlier tool results`);
            return r;
          });
      if (!refs.length) throw new Error("unknown target: give a set_id or ids");
      const names = {
        folder: op.kind === "move" ? folders.find((f) => f.id === op.folderId)?.name : undefined,
        section: op.kind === "section" && op.sectionId ? deps.sections().find((s) => s.id === op.sectionId)?.name : undefined,
      };
      const t = opText(op, names);
      if (!needsConfirm(op, refs.length)) {
        const emails = await deps.loadHeaders(refs);
        const res = await deps.bulk(emails, op);
        st.push({ kind: "step", text: `✓ ${t.past} · ${plural(res.done, "email")}` });
        deps.toast(`${t.past} ${plural(res.done, "email")}`, res.undo.length ? () => void deps.undo(res.undo, op) : undefined);
        return { done: res.done, skipped: res.skipped, failed: res.failed.length, ...(res.error ? { error: res.error } : {}) };
      }
      st.push({
        kind: "card",
        card: { type: "bulk", op, setId: set?.id, refs, title: `${t.verb}: ${plural(refs.length, "email")}`, detail: set?.label ?? "Emails you pointed at", status: "pending", done: 0, total: refs.length },
      });
      return { status: "awaiting_confirmation", message: "A confirm card is showing. Nothing has happened yet; don't say it's done." };
    }
    case "create_event": {
      const title = String(a.title).trim();
      const allDay = a.all_day === true || /^\d{4}-\d{2}-\d{2}$/.test(String(a.start));
      const start = new Date(allDay ? `${String(a.start).slice(0, 10)}T00:00:00` : String(a.start));
      if (!title || Number.isNaN(start.getTime())) throw new Error("bad_query: create_event needs a title and a valid start");
      const end = a.end ? new Date(String(a.end)) : new Date(start.getTime() + (allDay ? 864e5 : 36e5));
      if (Number.isNaN(end.getTime()) || end <= start) throw new Error("bad_query: end must be after start");
      const emailId = a.email_id ? String(a.email_id) : undefined;
      st.push({
        kind: "card",
        card: { type: "event", event: { title, start: localIso(start), end: localIso(end), allDay, location: a.location ? String(a.location) : undefined, notes: a.notes ? String(a.notes) : undefined, emailId }, status: "pending" },
      });
      return { status: "awaiting_confirmation", message: "An event card is showing for the user to add. It isn't on the calendar yet." };
    }
    case "draft": {
      const kind = String(a.kind) as DraftArgs["kind"];
      if (!["reply", "reply_all", "forward", "new"].includes(kind)) throw new Error(`unknown draft kind "${a.kind}"`);
      let emailId: string | undefined;
      if (kind !== "new") {
        const r = st.known[String(a.email_id)];
        if (!r) throw new Error(`unknown id "${a.email_id}": reply and forward need an id from an earlier tool result`);
        emailId = (await deps.getEmail(r)).id;
      }
      const compose = await deps.draft({ kind, emailId, to: a.to ? String(a.to) : undefined, instructions: String(a.instructions) });
      deps.openCompose(compose);
      const what = kind === "new" ? "a new email" : kind === "forward" ? "a forward" : "a reply";
      st.push({ kind: "card", card: { type: "draft", summary: `Opened ${what} in compose`, compose } });
      return { status: "opened_in_compose", message: "The draft is open for the user to review and send. You cannot send it." };
    }
  }
  throw new Error(`unknown tool "${name}"`);
}
```

- [ ] **Step 4: Write `cards.ts`**

```ts
// src/lib/ai/assistant/cards.ts
// What the buttons on assistant cards do. Outcomes are queued as notes so the
// model hears about them with the user's next message.

import { useAssistant, type Ref } from "./state";
import type { ToolDeps } from "./tools";
import { realDeps } from "./deps";
import { useMail } from "@/lib/store";

const stopping = new Set<string>();

function bulkCard(itemId: string) {
  const item = useAssistant.getState().items.find((i) => i.id === itemId);
  return item?.kind === "card" && item.card.type === "bulk" ? item.card : undefined;
}

async function runBulk(itemId: string, refs: Ref[], deps: ToolDeps, priorDone = 0) {
  const st = useAssistant.getState();
  const card = bulkCard(itemId);
  if (!card) return;
  st.patchCard(itemId, { status: "running", error: undefined });
  const emails = await deps.loadHeaders(refs);
  const res = await deps.bulk(emails, card.op, {
    onProgress: (n) => useAssistant.getState().patchCard(itemId, { done: priorDone + n }),
    isCancelled: () => stopping.has(itemId),
  });
  stopping.delete(itemId);
  const prev = bulkCard(itemId)?.undo ?? [];
  const failedRefs = res.failed.map((e) => ({ id: e.id, accountId: e.accountId }));
  useAssistant.getState().patchCard(itemId, {
    status: failedRefs.length ? "partial" : "done",
    done: priorDone + res.done + res.skipped,
    undo: [...prev, ...res.undo],
    failedRefs,
    error: res.error,
  });
  useAssistant.getState().note(`The user confirmed "${card.title}": ${res.done} done${res.skipped ? `, ${res.skipped} already done or gone` : ""}${failedRefs.length ? `, ${failedRefs.length} not done (${res.error ?? "failed"})` : ""}.`);
}

export function confirmBulk(itemId: string, deps: ToolDeps = realDeps()) {
  const card = bulkCard(itemId);
  if (!card || card.status !== "pending") return Promise.resolve();
  return runBulk(itemId, card.refs, deps);
}

export function resumeBulk(itemId: string, deps: ToolDeps = realDeps()) {
  const card = bulkCard(itemId);
  if (!card?.failedRefs?.length) return Promise.resolve();
  return runBulk(itemId, card.failedRefs, deps, card.done);
}

export function stopBulk(itemId: string) {
  stopping.add(itemId);
}

export function cancelCard(itemId: string) {
  const card = bulkCard(itemId);
  if (!card || card.status !== "pending") return;
  useAssistant.getState().patchCard(itemId, { status: "cancelled" });
  useAssistant.getState().note(`The user cancelled "${card.title}". Nothing was changed.`);
}

export async function undoBulk(itemId: string, deps: ToolDeps = realDeps()) {
  const card = bulkCard(itemId);
  if (!card?.undo?.length) return;
  const res = await deps.undo(card.undo, card.op);
  useAssistant.getState().patchCard(itemId, { status: "undone", undo: [], error: res.failed.length ? `${res.failed.length} couldn't be put back.` : undefined });
  useAssistant.getState().note(`The user undid "${card.title}".`);
}

export async function addEvent(itemId: string, calendarId: string, deps: ToolDeps = realDeps()) {
  const item = useAssistant.getState().items.find((i) => i.id === itemId);
  if (item?.kind !== "card" || item.card.type !== "event") return;
  const e = item.card.event;
  await deps.createEvent({ calendarId, title: e.title, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(), allDay: e.allDay, location: e.location, description: e.notes });
  useAssistant.getState().patchCard(itemId, { status: "added" });
  useAssistant.getState().note(`The user added "${e.title}" to their calendar.`);
}

export function dismissEvent(itemId: string) {
  useAssistant.getState().patchCard(itemId, { status: "dismissed" });
  useAssistant.getState().note("The user dismissed the event card.");
}

/** Show a set in the mail list (switching to the list layout). */
export function reviewSet(setId: string) {
  // Switch layout first: changing the view clears the active set (see App).
  const v = useMail.getState().view.kind;
  if (v !== "inbox" && v !== "folder" && v !== "starred" && v !== "snoozed") useMail.getState().setView({ kind: "inbox" });
  queueMicrotask(() => useAssistant.getState().showSet(setId));
}
```

- [ ] **Step 5: Write `deps.ts`**

```ts
// src/lib/ai/assistant/deps.ts
// Real ToolDeps: the mail store, mail providers, the writing model for drafts,
// the assistant model for kind labels, and the local kind-label cache.

import { toast } from "sonner";
import type { Email } from "@/lib/types";
import { categoryOf, defaultCalendarFor, providerOf, sectionOf, useMail } from "@/lib/store";
import { kvGet, kvSet } from "@/lib/db";
import { assistantProvider, generativeProvider } from "@/lib/ai/providers";
import { draft as writeDraft } from "@/lib/ai/generative";
import { forwardBody } from "@/lib/mail/compose-text";
import { pool } from "@/lib/google/gmail";
import { matchesLocal } from "./query";
import { kindsFor, type Kind } from "./kinds";
import { useAssistant, type Ref } from "./state";
import type { ToolDeps } from "./tools";

const KINDS_KEY = "assistant.kinds";
let kindCache: Record<string, Kind> | null = null;

async function loadKinds() {
  kindCache ??= (await kvGet<Record<string, Kind>>(KINDS_KEY).catch(() => null)) ?? {};
  return kindCache;
}

async function saveKinds(learned: Record<string, Kind>) {
  const cache = { ...(await loadKinds()), ...learned };
  const ids = Object.keys(cache);
  // Keep the newest 20,000 (insertion order approximates recency).
  kindCache = Object.fromEntries(ids.slice(-20_000).map((id) => [id, cache[id]]));
  await kvSet(KINDS_KEY, kindCache).catch(() => {});
}

export function realDeps(): ToolDeps {
  const mail = () => useMail.getState();
  const ctx = () => ({ categoryOf: (id: string) => categoryOf(mail(), id), sectionOf: (e: Email) => sectionOf(mail(), e)?.id });

  return {
    folders: () => mail().folders,
    sections: () => mail().sections,

    async search(q, cap) {
      const s = mail();
      const accounts = s.accounts.filter((a) => !q.account || a.id === q.account);
      // zMail-only fields exist only on mail zMail has sorted, which lives in the store.
      if (q.category || q.section) {
        const hits = s.emails.filter((e) => accounts.some((a) => a.id === e.accountId) && matchesLocal(e, q, ctx()));
        return { refs: hits.slice(0, cap).map((e) => ({ id: e.id, accountId: e.accountId })), headers: hits.slice(0, cap), tooMany: hits.length > cap };
      }
      const refs: Ref[] = [];
      const headers: Email[] = [];
      for (const a of accounts) {
        const p = providerOf(a.id);
        let page: string | undefined;
        do {
          const r = await p.search(q, s.folders, page);
          if (r.estimate !== undefined && r.estimate > cap * 1.5) return { refs: [], headers: [], tooMany: true };
          refs.push(...r.ids.map((id) => ({ id, accountId: a.id })));
          headers.push(...(r.headers ?? []));
          if (refs.length > cap) return { refs: refs.slice(0, cap), headers, tooMany: true };
          page = r.next;
        } while (page);
      }
      return { refs, headers, tooMany: false };
    },

    async loadHeaders(refs, onProgress) {
      const known = { ...useAssistant.getState().headers };
      for (const e of mail().emails) known[e.id] = e;
      const missing = refs.filter((r) => !known[r.id]);
      const byAccount = new Map<string, string[]>();
      for (const r of missing) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r.id]);
      let n = 0;
      for (const [accountId, ids] of byAccount) {
        const parts: string[][] = [];
        for (let i = 0; i < ids.length; i += 100) parts.push(ids.slice(i, i + 100));
        await pool(parts, 2, async (part) => {
          const rows = await providerOf(accountId).headers(part);
          useAssistant.getState().addHeaders(rows);
          for (const r of rows) known[r.id] = r;
          n += part.length;
          onProgress?.(n);
        });
      }
      return refs.map((r) => known[r.id]).filter((e): e is Email => !!e);
    },

    getEmail: (ref) => mail().ensureEmail(ref),

    view() {
      const s = mail();
      const open = s.selectedId ? s.emails.find((e) => e.id === s.selectedId) : undefined;
      const a = useAssistant.getState();
      return {
        open,
        checked: s.emails.filter((e) => s.checked.has(e.id)),
        listLabel: a.activeSetId ? (a.sets[a.activeSetId]?.label ?? "Assistant set") : s.view.kind === "folder" ? (s.folders.find((f) => f.id === (s.view as { folderId: string }).folderId)?.name ?? "Folder") : s.view.kind,
        setId: a.activeSetId,
      };
    },

    async kinds(rows, onProgress) {
      const { kinds, learned } = await kindsFor(rows, { categoryOf: ctx().categoryOf, cache: await loadKinds(), provider: assistantProvider(), onProgress });
      if (Object.keys(learned).length) await saveKinds(learned);
      return kinds;
    },

    bulk: (emails, op, opts) => mail().bulkApply(emails, op, opts),
    undo: (entries, op) => mail().bulkUndo(entries, op),

    async draft(args) {
      const s = mail();
      const email = args.emailId ? s.emails.find((e) => e.id === args.emailId) : undefined;
      const replying = args.kind === "reply" || args.kind === "reply_all";
      const out = await writeDraft(generativeProvider(), args.instructions, s.me, replying ? email : undefined);
      if (args.kind === "new") return { mode: "blank", prefill: { to: args.to, subject: out.subject, body: out.body } };
      if (args.kind === "forward" && email)
        return { mode: "blank", replyTo: email.id, forward: true, prefill: { to: args.to, body: `${out.body}${forwardBody(email)}` } };
      const cc = args.kind === "reply_all" && email ? [...email.to, ...(email.cc ?? [])].map((c) => c.address).filter((a) => !s.accounts.some((x) => x.address === a)).join(", ") : undefined;
      return { mode: "blank", replyTo: email?.id, prefill: { body: out.body, ...(cc ? { cc } : {}) } };
    },

    openCompose: (c) => mail().openCompose(c),
    defaultCalendar: () => {
      const s = mail();
      return defaultCalendarFor(s, s.accounts.find((a) => a.kind !== "mock")?.id ?? s.accounts[0]?.id ?? "")?.id;
    },
    createEvent: async (e) => void (await mail().createEvent(e)),
    toast: (text, undo) => void toast(text, undo ? { action: { label: "Undo", onClick: undo } } : undefined),
  };
}
```

Check `defaultCalendarFor`'s return shape in `store.ts`. If it returns an id string rather than a `CalendarInfo`, drop the `?.id`.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run src/lib/__tests__/assistant-tools.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/assistant/tools.ts src/lib/ai/assistant/cards.ts src/lib/ai/assistant/deps.ts src/lib/__tests__/assistant-tools.test.ts
git commit -m "Assistant: tools, approval gate and card actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The conversation loop, the system prompt and the offline demo agent

**Files:**
- Create: `src/lib/ai/assistant/prompts.ts`
- Create: `src/lib/ai/assistant/loop.ts`
- Create: `src/lib/ai/assistant/mock-agent.ts`
- Modify: `src/lib/ai/mock-generative.ts` (`chat` delegates to `mockAgentTurn`)
- Test: `src/lib/__tests__/assistant-loop.test.ts`

**Interfaces:**
- Consumes: `TOOLS`, `executeTool`, `ToolDeps` (Task 10); `useAssistant` (Task 8); `assistantProvider` (Task 2).
- Produces:
  - `systemPrompt(ctx: {name: string; today: string; accounts: string[]}): string`
  - `ask(text, deps?, provider?): Promise<void>`
  - `retry(text, deps?, provider?): Promise<void>`
  - `MAX_STEPS = 8`
  - `mockAgentTurn(messages: AgentMessage[]): AgentTurn`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/assistant-loop.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";
import type { GenerativeProvider } from "@/lib/ai/generative";
import type { AgentMessage, AgentTurn } from "@/lib/ai/tool-chat";

vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/store", () => ({ useMail: { getState: () => ({ me: { name: "Alex Rivera" }, accounts: [{ id: "personal", name: "Personal", address: "z@x.com" }] }) } }));
const { useAssistant } = await import("@/lib/ai/assistant/state");
const { ask, retry, MAX_STEPS } = await import("@/lib/ai/assistant/loop");
const { MockGenerativeProvider } = await import("@/lib/ai/mock-generative");
import type { ToolDeps } from "@/lib/ai/assistant/tools";

const mk = (i: number) => ({ id: `m${i}`, accountId: "personal", threadId: `m${i}`, folderId: "personal:inbox", from: { name: "Amazon.com", address: "ship@amazon.com" }, to: [], subject: i < 30 ? "Shipped: socks" : "Your receipt", snippet: "", text: "Arriving Nov 4.", date: "2025-05-01T00:00:00Z", unread: false, starred: false, labels: [] }) as Email;
const all = Array.from({ length: 36 }, (_, i) => mk(i));
const deps = {
  folders: () => [],
  sections: () => [],
  search: async () => ({ refs: all.map((e) => ({ id: e.id, accountId: e.accountId })), headers: all, tooMany: false }),
  loadHeaders: async (refs: { id: string }[]) => refs.map((r) => all.find((e) => e.id === r.id)!),
  getEmail: async (r: { id: string }) => all.find((e) => e.id === r.id)!,
  view: () => ({ open: all[0], checked: [], listLabel: "Inbox", setId: null }),
  kinds: async (rows: Email[]) => Object.fromEntries(rows.map((e) => [e.id, e.subject.startsWith("Shipped") ? "order_delivery" : "receipt_bill"])),
  bulk: async () => ({ done: 0, skipped: 0, failed: [], undo: [] }),
  undo: async () => ({ done: 0, skipped: 0, failed: [], undo: [] }),
  draft: async () => ({ mode: "blank" as const }),
  openCompose: () => {},
  defaultCalendar: () => "c",
  createEvent: async () => {},
  toast: () => {},
} as unknown as ToolDeps;

const scripted = (turns: (AgentTurn | ((h: AgentMessage[]) => AgentTurn))[]): GenerativeProvider & { seen: AgentMessage[][] } => {
  const seen: AgentMessage[][] = [];
  let i = 0;
  return {
    name: "scripted",
    seen,
    complete: async () => "",
    chat: async (_s, messages) => {
      seen.push([...messages]);
      const t = turns[Math.min(i++, turns.length - 1)];
      return typeof t === "function" ? t(messages) : t;
    },
  };
};
const tool = (name: string, args: Record<string, unknown> | null, id = name): AgentTurn => ({ text: "", toolCalls: [{ id, name, args }] });

beforeEach(() => useAssistant.getState().newChat());

describe("loop", () => {
  it("runs search → break_down → trash card, then answers", async () => {
    const p = scripted([
      tool("search_mail", { query: { from: "amazon.com" } }),
      (h) => tool("break_down", { set_id: JSON.parse((h.at(-1) as { content: string }).content).set_id, by: "kind" }),
      (h) => tool("act", { set_id: JSON.parse((h.at(-1) as { content: string }).content).groups[0].set_id, op: "trash" }),
      { text: "30 are orders and deliveries. Confirm the card to trash them.", toolCalls: [] },
    ]);
    await ask("pull up amazon, how many are orders? trash those", deps, p);
    const kinds = useAssistant.getState().items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "step", "set", "set", "card", "assistant"]);
    expect(useAssistant.getState().busy).toBe(false);
  });

  it("sends queued card notes with the next message", async () => {
    useAssistant.getState().note("The user confirmed the trash.");
    const p = scripted([{ text: "Done.", toolCalls: [] }]);
    await ask("thanks", deps, p);
    expect((p.seen[0].at(-1) as { content: string }).content).toBe("[zMail: The user confirmed the trash.]\n\nthanks");
  });

  it("stops after two malformed tool calls in a row", async () => {
    const p = scripted([tool("search_mail", null, "a"), tool("nope", {}, "b"), { text: "never", toolCalls: [] }]);
    await ask("hi", deps, p);
    expect(useAssistant.getState().items.at(-1)).toMatchObject({ kind: "error", text: expect.stringMatching(/isn't handling zMail's tools well/) });
  });

  it(`stops after ${MAX_STEPS} tool steps`, async () => {
    const p = scripted([tool("current_view", {})]);
    await ask("loop forever", deps, p);
    expect(p.seen).toHaveLength(MAX_STEPS);
    expect(useAssistant.getState().items.at(-1)).toMatchObject({ kind: "error", text: expect.stringMatching(/Stopped after 8 steps/) });
  });

  it("runs several tool calls from one turn in order, answering each", async () => {
    const p = scripted([{ text: "", toolCalls: [{ id: "1", name: "current_view", args: {} }, { id: "2", name: "search_mail", args: { query: { from: "amazon.com" } } }] }, { text: "ok", toolCalls: [] }]);
    await ask("go", deps, p);
    const h = useAssistant.getState().history;
    expect(h.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["1", "2"]);
  });

  it("shows model errors with Retry, and retry doesn't duplicate the message", async () => {
    const failing: GenerativeProvider = { name: "x", complete: async () => "", chat: async () => Promise.reject(new Error("timeout")) };
    await ask("hello", deps, failing);
    expect(useAssistant.getState().items.at(-1)).toMatchObject({ kind: "error", retry: "hello" });
    await retry("hello", deps, scripted([{ text: "hi", toolCalls: [] }]));
    expect(useAssistant.getState().history.filter((m) => m.role === "user")).toHaveLength(1);
    expect(useAssistant.getState().items.some((i) => i.kind === "error")).toBe(false);
  });
});

describe("offline demo agent", () => {
  it("handles the Amazon flow end to end", async () => {
    await ask("pull up all of my emails from amazon.com - how many are just orders/delivery?", deps, new MockGenerativeProvider());
    const items = useAssistant.getState().items;
    expect(items.filter((i) => i.kind === "set")).toHaveLength(2);
    expect(items.at(-1)).toMatchObject({ kind: "assistant", text: expect.stringMatching(/30.*order/i) });
    await ask("ok delete them all", deps, new MockGenerativeProvider());
    const card = useAssistant.getState().items.find((i) => i.kind === "card");
    expect(card?.kind === "card" && card.card.type === "bulk" && card.card.total).toBe(30);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/assistant-loop.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `prompts.ts`**

```ts
// src/lib/ai/assistant/prompts.ts

export function systemPrompt(ctx: { name: string; today: string; accounts: string[] }) {
  return `You are zMail's assistant, working inside ${ctx.name}'s mail app. Today is ${ctx.today}. Accounts: ${ctx.accounts.join("; ")}.

Use the tools to answer and to act. Rules:
- Search with search_mail before answering questions about mail. It covers the whole mailbox.
- To act on many emails, act on a set_id from search_mail or break_down. Never invent ids; only use ids from tool results.
- "This", "these" and "those" mean what the user is looking at: call current_view. If nothing is open or checked and it's unclear, ask which email.
- Never say something was done unless a tool result says it was done. When a tool says a card is awaiting confirmation, tell the user to check the card.
- You cannot send email. Use draft to open a reply, forward or new email for the user to review and send.
- Use create_event for calendar requests; read the email first if the details are in it.
- Be brief and plain. Give counts as numbers. Don't list more than a few emails in text; the user can see the set in their mail list.`;
}
```

- [ ] **Step 4: Write `loop.ts`**

```ts
// src/lib/ai/assistant/loop.ts
// One user message → model turns and tool runs until the model answers in
// text, at most MAX_STEPS model calls. Tool results always follow their tool
// calls in history, so the conversation stays valid for both API formats.

import type { GenerativeProvider } from "@/lib/ai/generative";
import { assistantProvider } from "@/lib/ai/providers";
import { useMail } from "@/lib/store";
import { localDate } from "@/lib/ai/dates";
import { useAssistant } from "./state";
import { TOOLS, executeTool, type ToolDeps } from "./tools";
import { systemPrompt } from "./prompts";
import { realDeps } from "./deps";

export const MAX_STEPS = 8;

function context() {
  const s = useMail.getState();
  return { name: s.me.name, today: localDate(new Date()), accounts: s.accounts.map((a) => `${a.label ?? a.name} (${a.address}, id ${a.id})`) };
}

export async function ask(text: string, deps: ToolDeps = realDeps(), provider: GenerativeProvider = assistantProvider()) {
  const st = useAssistant.getState();
  if (st.busy || !text.trim()) return;
  useAssistant.setState({ busy: true });
  st.push({ kind: "user", text });
  const notes = st.drainNotes();
  st.pushHistory({ role: "user", content: notes.length ? `${notes.map((n) => `[zMail: ${n}]`).join("\n")}\n\n${text}` : text });
  let malformed = 0;
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const turn = await provider.chat(systemPrompt(context()), useAssistant.getState().history, TOOLS);
      st.pushHistory({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined });
      if (turn.text) st.push({ kind: "assistant", text: turn.text });
      if (!turn.toolCalls.length) return;
      for (const call of turn.toolCalls) {
        const res = await executeTool(call, deps);
        st.pushHistory({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(res.content) });
        malformed = res.malformed ? malformed + 1 : 0;
      }
      if (malformed >= 2) {
        st.push({ kind: "error", text: "This model isn't handling zMail's tools well. Try a stronger assistant model in Settings → AI Models." });
        return;
      }
    }
    st.push({ kind: "error", text: `Stopped after ${MAX_STEPS} steps without finishing. Try asking in smaller pieces.` });
  } catch (err) {
    st.push({ kind: "error", text: err instanceof Error ? err.message : String(err), retry: text });
  } finally {
    useAssistant.setState({ busy: false });
  }
}

/** Ask again after a model error, without repeating the unanswered message. */
export async function retry(text: string, deps?: ToolDeps, provider?: GenerativeProvider) {
  useAssistant.setState((s) => ({ items: s.items.filter((i) => !(i.kind === "error" && i.retry === text)) }));
  useAssistant.setState((s) => {
    const items = [...s.items];
    const lastUser = items.map((i) => i.kind).lastIndexOf("user");
    if (lastUser >= 0 && items[lastUser].kind === "user" && (items[lastUser] as { text: string }).text === text) items.splice(lastUser, 1);
    return { items };
  });
  useAssistant.getState().popHistoryIf((m) => m.role === "user" && m.content.endsWith(text));
  return ask(text, deps, provider);
}
```

- [ ] **Step 5: Write `mock-agent.ts` and wire it into the mock provider**

```ts
// src/lib/ai/assistant/mock-agent.ts
// The offline demo agent behind MockGenerativeProvider.chat: enough tool use
// to show the assistant in the browser preview and tests without a model.
// It understands "from <sender>", "how many … orders", trash/archive/read,
// "add this to my calendar" and "reply/forward".

import type { AgentMessage, AgentTurn } from "@/lib/ai/tool-chat";

const call = (name: string, args: Record<string, unknown>): AgentTurn => ({ text: "", toolCalls: [{ id: `mock_${name}_${Math.random().toString(36).slice(2, 7)}`, name, args }] });
const say = (text: string): AgentTurn => ({ text, toolCalls: [] });

function results(messages: AgentMessage[]) {
  return messages.filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool").map((m) => ({ name: m.name, data: JSON.parse(m.content) as Record<string, unknown> }));
}

export function mockAgentTurn(messages: AgentMessage[]): AgentTurn {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const user = (messages[lastUserIdx] as { content: string }).content.replace(/^\[zMail:.*\]\n\n/s, "").toLowerCase();
  const sinceUser = results(messages.slice(lastUserIdx));
  const all = results(messages);
  const last = sinceUser.at(-1);
  const lastBreakdown = [...all].reverse().find((r) => r.name === "break_down")?.data as { groups?: { label: string; count: number; set_id: string }[] } | undefined;
  const lastSearch = [...all].reverse().find((r) => r.name === "search_mail")?.data as { set_id?: string; count?: number; label?: string } | undefined;

  if (last) {
    if (last.data.error) return say(`I couldn't do that: ${String(last.data.error)}`);
    if (last.name === "search_mail") {
      if (last.data.too_many) return say("That matches too much mail. Can you narrow it down by sender or date?");
      if (/how many|order|deliver|kind|break/.test(user)) return call("break_down", { set_id: last.data.set_id, by: "kind" });
      return say(`Found ${last.data.count} emails (${last.data.label}). They're in your list when you click the chip.`);
    }
    if (last.name === "break_down") {
      const groups = (last.data.groups as { label: string; count: number }[]) ?? [];
      return say(groups.map((g) => `${g.count} ${g.label.toLowerCase()}`).join(", ") + ".");
    }
    if (last.name === "current_view") {
      const open = last.data.open_email as { id: string } | null;
      if (!open) return say("Which email do you mean? Open it or check it, then ask again.");
      if (/reply|forward/.test(user)) return call("draft", { kind: /forward/.test(user) ? "forward" : "reply", email_id: open.id, instructions: user });
      return call("read_email", { id: open.id });
    }
    if (last.name === "read_email") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return call("create_event", { title: String(last.data.subject), start: d.toISOString().slice(0, 10), all_day: true, email_id: last.data.id });
    }
    if (last.data.status === "awaiting_confirmation") return say("Check the card to confirm.");
    if (last.data.status === "opened_in_compose") return say("It's open in compose. Review it and send when you're ready.");
    if (typeof last.data.done === "number") return say(`Done: ${last.data.done}.`);
  }

  const from = /from\s+([\w.@-]+\.\w+|[\w-]+)/.exec(user)?.[1];
  if (from) return call("search_mail", { query: { from } });
  const op = /delete|trash/.test(user) ? "trash" : /archive/.test(user) ? "archive" : /mark (them |those |these )?read/.test(user) ? "mark_read" : null;
  if (op) {
    const match = lastBreakdown?.groups?.find((g) => /order|deliver/.test(g.label.toLowerCase())) ?? lastBreakdown?.groups?.[0];
    const setId = match?.set_id ?? lastSearch?.set_id;
    if (setId) return call("act", { set_id: setId, op });
  }
  if (/calendar|reply|forward|this|these/.test(user)) return call("current_view", {});
  return say("In the offline demo I can search by sender (\"emails from amazon.com\"), break mail down, and act on it. Set up an assistant model in Settings → AI Models for everything else.");
}
```

In `src/lib/ai/mock-generative.ts`, replace the Task 1 `chat` with:

```ts
  async chat(_system: string, messages: AgentMessage[], _tools: ToolDef[]): Promise<AgentTurn> {
    await new Promise((r) => setTimeout(r, 200));
    return mockAgentTurn(messages);
  }
```

and import `mockAgentTurn` from `./assistant/mock-agent`.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run src/lib/__tests__/assistant-loop.test.ts && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/assistant/prompts.ts src/lib/ai/assistant/loop.ts src/lib/ai/assistant/mock-agent.ts src/lib/ai/mock-generative.ts src/lib/__tests__/assistant-loop.test.ts
git commit -m "Assistant: conversation loop, system prompt and offline demo agent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The assistant panel

**Files:**
- Create: `src/components/assistant/assistant-panel.tsx`
- Create: `src/components/assistant/message-item.tsx`
- Create: `src/components/assistant/bulk-card.tsx`
- Modify: `src/components/suggestion-card.tsx` (optional `onAccept` / `onDismiss` props)
- Modify: `src/components/sidebar.tsx` (the ✦ button toggles the assistant)
- Modify: `src/App.tsx` (render the panel; ⌘J; load and autosave assistant state)

**Interfaces:**
- Consumes: `useAssistant` (Task 8); `ask`, `retry` (Task 11); the `cards.ts` actions (Task 10); `assistantModelName`, `assistantIsOffline` (Task 2).
- Produces: `<AssistantPanel />`, and `SuggestionCard` props `{ sug; onAccept?: (calendarId: string) => Promise<void>; onDismiss?: () => void }`.

- [ ] **Step 1: Let `SuggestionCard` take callbacks**

In `src/components/suggestion-card.tsx`, change the signature to:

```tsx
export function SuggestionCard({ sug, onAccept, onDismiss }: { sug: CalSuggestion; onAccept?: (calendarId: string) => Promise<void>; onDismiss?: () => void }) {
```

In `accept`, replace `await s.acceptCalSuggestion(sug.id, r, calendarId);` with:

```tsx
      if (onAccept) await onAccept(calendarId);
      else await s.acceptCalSuggestion(sug.id, r, calendarId);
```

Find the non-invite "Not now" button's `onClick` and call `onDismiss` when it's given: `onClick={() => (onDismiss ? onDismiss() : s.dismissCalSuggestion(sug.id))}`.

- [ ] **Step 2: Write `bulk-card.tsx`**

```tsx
// src/components/assistant/bulk-card.tsx
import { Loader2 } from "lucide-react";
import type { Card } from "@/lib/ai/assistant/state";
import { cancelCard, confirmBulk, resumeBulk, reviewSet, stopBulk, undoBulk } from "@/lib/ai/assistant/cards";
import { cn } from "@/lib/utils";

type Bulk = Extract<Card, { type: "bulk" }>;
const btn = "h-7 rounded-lg px-2.5 text-[12px] font-semibold whitespace-nowrap";

export function BulkCard({ id, card }: { id: string; card: Bulk }) {
  const destructive = card.op.kind === "trash" || card.op.kind === "spam";
  const pct = card.total ? Math.round((card.done / card.total) * 100) : 0;
  return (
    <div className="rounded-xl bg-pane-2 p-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
      <div className="text-[13px] font-semibold">{card.title}</div>
      <div className="mt-0.5 text-[11.5px] text-foreground/50">{card.detail}</div>
      {(card.status === "running" || card.status === "partial") && (
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]">
          <div className={cn("h-full rounded-full transition-[width]", destructive ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="mt-1.5 text-[11.5px] text-foreground/55">
        {card.status === "running" && `Working… ${card.done.toLocaleString()} / ${card.total.toLocaleString()}`}
        {card.status === "done" && `✓ Done · ${card.done.toLocaleString()} emails`}
        {card.status === "partial" && `${card.done.toLocaleString()} of ${card.total.toLocaleString()} done${card.error ? ` · ${card.error}` : ""}`}
        {card.status === "cancelled" && "Cancelled. Nothing was changed."}
        {card.status === "undone" && `Undone${card.error ? ` · ${card.error}` : ""}`}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {card.status === "pending" && (
          <>
            <button onClick={() => void confirmBulk(id)} className={cn(btn, destructive ? "bg-destructive text-white" : "bg-primary text-primary-foreground")}>
              {card.title.split(":")[0]}
            </button>
            {card.setId && (
              <button onClick={() => reviewSet(card.setId!)} className={cn(btn, "bg-foreground/[0.07] hover:bg-foreground/10")}>
                Review
              </button>
            )}
            <button onClick={() => cancelCard(id)} className={cn(btn, "text-foreground/55 hover:bg-foreground/[0.07]")}>
              Cancel
            </button>
          </>
        )}
        {card.status === "running" && (
          <button onClick={() => stopBulk(id)} className={cn(btn, "bg-foreground/[0.07] hover:bg-foreground/10")}>
            <Loader2 className="mr-1 inline size-3 animate-spin" /> Stop
          </button>
        )}
        {card.status === "partial" && !!card.failedRefs?.length && (
          <button onClick={() => void resumeBulk(id)} className={cn(btn, "bg-primary text-primary-foreground")}>
            Resume
          </button>
        )}
        {(card.status === "done" || card.status === "partial") && !!card.undo?.length && (
          <button onClick={() => void undoBulk(id)} className={cn(btn, "bg-foreground/[0.07] hover:bg-foreground/10")}>
            {card.status === "partial" ? "Undo what was done" : "Undo"}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `message-item.tsx`**

```tsx
// src/components/assistant/message-item.tsx
import { AlertCircle, PenLine } from "lucide-react";
import type { Item } from "@/lib/ai/assistant/state";
import { useAssistant } from "@/lib/ai/assistant/state";
import { addEvent, dismissEvent, reviewSet } from "@/lib/ai/assistant/cards";
import { retry } from "@/lib/ai/assistant/loop";
import { useMail } from "@/lib/store";
import { SuggestionCard } from "@/components/suggestion-card";
import { BulkCard } from "./bulk-card";
import { realDeps } from "@/lib/ai/assistant/deps";

function SetChip({ setId, label, count }: { setId: string; label: string; count: number }) {
  const exists = useAssistant((s) => !!s.sets[setId]);
  return (
    <button
      disabled={!exists}
      title={exists ? "Show in your mail list" : "From an earlier session. Ask again to see these."}
      onClick={() => reviewSet(setId)}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[11.5px] font-semibold text-primary disabled:opacity-50"
    >
      <span className="truncate">{label}</span> · {count.toLocaleString()}
    </button>
  );
}

export function MessageItem({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return <div className="ml-8 self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[13px] whitespace-pre-wrap text-primary-foreground">{item.text}</div>;
    case "assistant":
      return <div className="text-[13px] leading-relaxed whitespace-pre-wrap">{item.text}</div>;
    case "step":
      return <div className="text-[11px] text-foreground/40">{item.text}</div>;
    case "set": {
      const max = Math.max(1, ...(item.groups ?? []).map((g) => g.count));
      return (
        <div className="space-y-1.5">
          <SetChip setId={item.setId} label={item.label} count={item.count} />
          {item.groups && (
            <div className="space-y-1">
              {item.groups.map((g) => (
                <button key={g.setId} onClick={() => reviewSet(g.setId)} className="flex w-full items-center gap-2 text-left text-[11.5px] hover:opacity-80">
                  <span className="w-32 truncate text-foreground/60">{g.label}</span>
                  <span className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.max(4, (g.count / max) * 110)}px` }} />
                  <span className="tabular-nums">{g.count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }
    case "card": {
      const c = item.card;
      if (c.type === "bulk") return <BulkCard id={item.id} card={c} />;
      if (c.type === "draft")
        return (
          <button onClick={() => useMail.getState().openCompose(c.compose)} className="flex items-center gap-2 rounded-xl bg-pane-2 px-3 py-2 text-left text-[12.5px] shadow-[inset_0_0_0_1px_var(--hairline)]">
            <PenLine className="size-3.5 text-primary" /> {c.summary} <span className="text-foreground/40">· Open</span>
          </button>
        );
      if (c.status !== "pending") return <div className="text-[11.5px] text-foreground/45">{c.status === "added" ? `✓ Added “${c.event.title}” to your calendar` : `Dismissed “${c.event.title}”`}</div>;
      return (
        <SuggestionCard
          sug={{ id: item.id, kind: "extracted", title: c.event.title, detail: c.event.location ?? c.event.notes ?? "", start: c.event.start, end: c.event.end, allDay: c.event.allDay, calendarId: realDeps().defaultCalendar() ?? "", emailId: c.event.emailId, label: "event" }}
          onAccept={(calendarId) => addEvent(item.id, calendarId)}
          onDismiss={() => dismissEvent(item.id)}
        />
      );
    }
    case "error":
      return (
        <div className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px]">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">{item.text}</div>
          {item.retry && (
            <button onClick={() => void retry(item.retry!)} className="shrink-0 text-[12px] font-semibold text-primary">
              Retry
            </button>
          )}
        </div>
      );
  }
}
```

- [ ] **Step 4: Write `assistant-panel.tsx`**

```tsx
// src/components/assistant/assistant-panel.tsx
// The ✦ Assistant side panel: conversation, cards, and the input with a chip
// showing what "this / these" means right now.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2, Plus, Sparkles, X } from "lucide-react";
import { useAssistant } from "@/lib/ai/assistant/state";
import { ask } from "@/lib/ai/assistant/loop";
import { assistantIsOffline, assistantModelName } from "@/lib/ai/providers";
import { useSettings } from "@/lib/settings";
import { useMail } from "@/lib/store";
import { MessageItem } from "./message-item";

function useContextLabel() {
  const selectedId = useMail((s) => s.selectedId);
  const checkedCount = useMail((s) => s.checked.size);
  const subject = useMail((s) => (s.selectedId ? s.emails.find((e) => e.id === s.selectedId)?.subject : undefined));
  const setLabel = useAssistant((s) => (s.activeSetId ? s.sets[s.activeSetId]?.label : undefined));
  const setCount = useAssistant((s) => (s.activeSetId ? s.sets[s.activeSetId]?.refs.length : undefined));
  if (checkedCount) return `${checkedCount} checked`;
  if (selectedId && subject) return `Viewing: ${subject}`;
  if (setLabel) return `Viewing: ${setLabel} · ${setCount}`;
  return null;
}

export function AssistantPanel() {
  const items = useAssistant((s) => s.items);
  const busy = useAssistant((s) => s.busy);
  const toggle = useAssistant((s) => s.toggle);
  const newChat = useAssistant((s) => s.newChat);
  // Re-read the model label when settings change.
  const settingsTick = useSettings((s) => `${s.assistant.model}|${s.generative.model}|${s.assistant.provider}|${s.generative.provider}`);
  const model = useMemo(() => assistantModelName(), [settingsTick]);
  const offline = useMemo(() => assistantIsOffline(), [settingsTick]);
  const context = useContextLabel();
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [items.length, busy]);

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    void ask(t);
  };

  return (
    <aside className="pane ml-2 flex h-full w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
        <Sparkles className="size-4 text-primary" />
        <span className="text-[13px] font-semibold">Assistant</span>
        <span className="truncate rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] text-foreground/50">{model}</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={newChat} title="New chat" aria-label="New chat" className="grid size-7 place-items-center rounded-lg text-foreground/50 hover:bg-foreground/[0.07]">
            <Plus className="size-4" />
          </button>
          <button onClick={() => toggle(false)} title="Close (⌘J)" aria-label="Close assistant" className="grid size-7 place-items-center rounded-lg text-foreground/50 hover:bg-foreground/[0.07]">
            <X className="size-4" />
          </button>
        </div>
      </div>
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3">
        {offline && (
          <div className="rounded-xl bg-foreground/[0.05] px-3 py-2 text-[11.5px] text-foreground/55">
            Offline demo. Set up an assistant model in Settings → AI Models to use it on your real mail.
          </div>
        )}
        {!items.length && (
          <div className="mt-6 space-y-1.5 text-center text-[12.5px] text-foreground/45">
            <p>Ask about your mail, or tell zMail what to do.</p>
            <p className="text-foreground/35">"Pull up my Amazon emails. How many are orders?"</p>
          </div>
        )}
        {items.map((it) => (
          <MessageItem key={it.id} item={it} />
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 text-[11.5px] text-foreground/40">
            <Loader2 className="size-3 animate-spin" /> Working…
          </div>
        )}
      </div>
      <div className="m-2.5 rounded-xl bg-pane-2 p-2 shadow-[inset_0_0_0_1px_var(--hairline)]">
        {context && <div className="mb-1 inline-flex max-w-full truncate rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] text-foreground/55">◉ {context}</div>}
        <div className="flex items-end gap-2">
          <textarea
            ref={input}
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask about your mail, or tell zMail what to do…"
            className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-foreground/35"
          />
          <button onClick={send} disabled={!text.trim() || busy} aria-label="Send" className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40">
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 5: Wire the panel into the sidebar and the App**

In `src/components/sidebar.tsx`, the ✦ button (currently `onClick={() => openCompose({ mode: "ai" })}`, `aria-label="Draft with AI"`):
- Import `useAssistant` from `@/lib/ai/assistant/state`.
- Set `onClick={() => useAssistant.getState().toggle()}`, `aria-label="Assistant (⌘J)"`, and change the tooltip text to `Assistant ⌘J`.
- Add `aria-pressed` from `const assistantOpen = useAssistant((s) => s.open);`. When it's open, add `bg-primary/15` to the button's classes.

In `src/App.tsx`:
1. Import `AssistantPanel`, `useAssistant`, `loadAssistant` and `startAssistantAutosave`.
2. In `useShortcuts`'s `onKey`, after the ⌘K branch:

```ts
      if (mod && e.key === "j") {
        e.preventDefault();
        return useAssistant.getState().toggle();
      }
```

3. In the load effect: `void hydrateApiKeys().then(() => load()).then(() => loadAssistant()).then(() => startAssistantAutosave());`
4. In the component: `const assistantOpen = useAssistant((s) => s.open);`. Inside `<div className="flex h-full">`, after `</main>`, render it with the same spring as the reader:

```tsx
        <AnimatePresence initial={false}>
          {assistantOpen && (
            <motion.div
              key="assistant"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 348, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 42 }}
              className="shrink-0 overflow-hidden py-2 pr-2"
            >
              <AssistantPanel />
            </motion.div>
          )}
        </AnimatePresence>
```

Then remove `ml-2` from the panel's `<aside>` if it double-spaces next to `main`'s `pr-2`; check it in the preview in Task 14.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p . && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/assistant src/components/suggestion-card.tsx src/components/sidebar.tsx src/App.tsx
git commit -m "Assistant: side panel with cards, set chips and ⌘J

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Assistant sets in the mail list

**Files:**
- Create: `src/components/assistant/set-view.tsx` (banner, tabs and list)
- Modify: `src/App.tsx` (list column shows `SetView` when a set is active)
- Modify: `src/lib/store.ts` (`setView` clears the active assistant set when leaving list views; that happens in App, see Step 3)

**Interfaces:**
- Consumes: `useAssistant`, `ResultSet` (Task 8); `realDeps` (Task 10); `ensureEmail`, `bulkApply` (Task 7); `InboxRow` (existing).
- Produces: `<SetView />`.

- [ ] **Step 1: Write `set-view.tsx`**

```tsx
// src/components/assistant/set-view.tsx
// An assistant set shown in the mail list: banner with "Back to Inbox",
// breakdown tabs, and rows. Mail zMail has loaded uses the normal InboxRow;
// header-only rows (older mail from a search) open by loading the full email
// and have their own quick actions.

import { useEffect, useMemo, useState } from "react";
import { Archive, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { Email } from "@/lib/types";
import { useAssistant, type ResultSet } from "@/lib/ai/assistant/state";
import { realDeps } from "@/lib/ai/assistant/deps";
import { useMail } from "@/lib/store";
import { InboxRow } from "@/components/mail/email-row";
import { cn } from "@/lib/utils";

const PAGE = 100;

function HeaderRow({ email }: { email: Email }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const full = await useMail.getState().ensureEmail(email);
      useMail.getState().select(full.id);
    } catch (err) {
      toast.error("Couldn't open it", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const act = async (kind: "archive" | "trash") => {
    const res = await useMail.getState().bulkApply([email], { kind });
    toast(kind === "trash" ? "Moved to Trash" : "Archived", { action: { label: "Undo", onClick: () => void useMail.getState().bulkUndo(res.undo, { kind }) } });
  };
  return (
    <div onClick={() => void open()} className={cn("group flex cursor-default items-center gap-2 rounded-lg px-3 py-2 hover:bg-foreground/[0.04]", busy && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("truncate text-[13px]", email.unread && "font-semibold")}>{email.from.name || email.from.address}</span>
          <span className="ml-auto shrink-0 text-[11px] text-foreground/40">{new Date(email.date).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" })}</span>
        </div>
        <div className="truncate text-[12.5px] text-foreground/60">{email.subject}</div>
      </div>
      <div className="hidden shrink-0 gap-0.5 group-hover:flex">
        <button onClick={(e) => (e.stopPropagation(), void act("archive"))} aria-label="Archive" className="grid size-7 place-items-center rounded-md text-foreground/50 hover:bg-foreground/[0.08]">
          <Archive className="size-3.5" />
        </button>
        <button onClick={(e) => (e.stopPropagation(), void act("trash"))} aria-label="Move to Trash" className="grid size-7 place-items-center rounded-md text-foreground/50 hover:bg-foreground/[0.08]">
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function SetView() {
  const activeSetId = useAssistant((s) => s.activeSetId);
  const sets = useAssistant((s) => s.sets);
  const headers = useAssistant((s) => s.headers);
  const emails = useMail((s) => s.emails);
  const [shown, setShown] = useState(PAGE);
  const set: ResultSet | undefined = activeSetId ? sets[activeSetId] : undefined;
  const root: ResultSet | undefined = set?.parentId ? sets[set.parentId] : set;

  useEffect(() => setShown(PAGE), [activeSetId]);
  useEffect(() => {
    if (set) void realDeps().loadHeaders(set.refs.slice(0, shown));
  }, [set, shown]);

  const rows = useMemo(() => {
    if (!set) return [];
    const loaded = new Map(emails.filter((e) => !e.partial).map((e) => [e.id, e]));
    return set.refs
      .slice(0, shown)
      .map((r) => loaded.get(r.id) ?? headers[r.id])
      .filter((e): e is Email => !!e);
  }, [set, shown, emails, headers]);

  if (!set || !root) return null;
  // Rows that left this mailbox state (moved by an action) still show until the set is re-run; that's expected.
  return (
    <div className="flex h-full flex-col">
      <div className="mx-2 mt-1 flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2 text-[12px]">
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate">
          Assistant set: <b className="text-primary">{set.label}</b> · {set.refs.length.toLocaleString()}
        </span>
        <button onClick={() => useAssistant.getState().showSet(null)} className="ml-auto flex shrink-0 items-center gap-1 text-foreground/50 hover:text-foreground">
          Back to Inbox <X className="size-3.5" />
        </button>
      </div>
      {root.groups && (
        <div className="mx-2 mt-1.5 flex flex-wrap gap-1">
          {root.groups.map((g) => (
            <button
              key={g.setId}
              onClick={() => useAssistant.getState().showSet(g.setId)}
              className={cn("rounded-full px-2.5 py-0.5 text-[11px]", activeSetId === g.setId ? "bg-foreground text-background" : "bg-foreground/[0.06] text-foreground/60 hover:bg-foreground/10")}
            >
              {g.count.toLocaleString()} {g.label.toLowerCase()}
            </button>
          ))}
          <button
            onClick={() => useAssistant.getState().showSet(root.id)}
            className={cn("rounded-full px-2.5 py-0.5 text-[11px]", activeSetId === root.id ? "bg-foreground text-background" : "bg-foreground/[0.06] text-foreground/60 hover:bg-foreground/10")}
          >
            All {root.refs.length.toLocaleString()}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-16">
        {rows.map((e) => (e.partial ? <HeaderRow key={e.id} email={e} /> : <InboxRow key={e.id} email={e} />))}
        {shown < set.refs.length && (
          <button onClick={() => setShown((n) => n + PAGE)} className="w-full py-3 text-center text-[12px] text-foreground/45 hover:text-foreground">
            Show {Math.min(PAGE, set.refs.length - shown)} more of {(set.refs.length - shown).toLocaleString()}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Show it in the list column**

In `src/App.tsx`: `const activeSetId = useAssistant((s) => s.activeSetId);`. In the `isList` branch, replace `<MailList />` with `{activeSetId ? <SetView /> : <MailList />}` and import `SetView`.

- [ ] **Step 3: Leave the set when the user navigates away**

In `src/App.tsx`, add an effect so choosing a sidebar view clears the set:

```tsx
  const viewKey = useMail((s) => (s.view.kind === "folder" ? `folder:${s.view.folderId}` : s.view.kind));
  const firstView = useRef(viewKey);
  useEffect(() => {
    if (viewKey !== firstView.current) useAssistant.getState().showSet(null);
    firstView.current = viewKey;
  }, [viewKey]);
```

`reviewSet` (Task 10) changes the view first and sets the active set in a microtask. The effect runs after render, though, so check in the preview (Task 14) that clicking a set chip from Today lands on the set and isn't cleared. If it is, make the effect skip when `useAssistant.getState().activeSetId` changed in the same tick: keep the previous `activeSetId` in a ref and only clear when it's unchanged.

- [ ] **Step 4: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p . && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/assistant/set-view.tsx src/App.tsx src/lib/ai/assistant/cards.ts
git commit -m "Assistant: show sets in the mail list with breakdown tabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Browser preview run-through

**Files:**
- No new files. Fix whatever the run-through finds, in the files it points to.

- [ ] **Step 1: Start the preview and confirm it's on mock providers**

The dev server may already be running (`pnpm tauri dev` serves `http://localhost:1420`). If not, run `pnpm dev`. In the browser, open `http://localhost:1420`. In the console, check `JSON.parse(localStorage.getItem("zmail.settings")).state.assistant.provider` is `"mock"` and `generative.provider` is `"mock"`. If either isn't `"mock"`, stop. Don't run the preview against real providers.

- [ ] **Step 2: Walk through the Amazon flow**

1. Click ✦ in the sidebar. The panel opens with the "Offline demo" note. Press ⌘J; it closes. Press ⌘J again; it opens with the input focused.
2. Type `pull up all of my emails from amazon.com - how many are just orders/delivery?` and press Enter. Expect a step line, a set chip of about 40, breakdown bars with "Order & delivery 30", and an answer.
3. Click the "Order & delivery" bar. The list shows the banner "Assistant set: Order & delivery · …", tabs, and rows.
4. Type `ok delete them all`. A red "Move to Trash: 30 emails" card appears. Click **Review**; the set shows. Click the red button; progress runs, then "✓ Done · 30 emails". Click **Undo**; the status reads "Undone".
5. Click a header-only row in the set. The reader opens the full email.
6. Open any email, then type `add this to my calendar`. An event card appears with a calendar picker. Click Add; the card turns into "✓ Added …".
7. With an email open, type `reply saying thanks`. Compose opens with a drafted body. Nothing is sent.
8. Click **Back to Inbox**. The normal list returns.
9. Reload the page. The conversation is still there.

- [ ] **Step 3: Check the Settings group**

Open Settings → AI Models. Check that "Assistant model" appears under "Writing model" with its footer text, and that no key field leaks a value.

- [ ] **Step 4: Fix anything found, then run everything**

Run: `npx tsc --noEmit -p . && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A src
git commit -m "Assistant: fixes from the preview run-through

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip this commit if the run-through found nothing.
