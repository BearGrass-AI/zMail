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

  it("keeps web search blocks verbatim and reads the queries and cited sources", () => {
    const content = [
      { type: "text", text: "I'll look that up." },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "claude shannon birth date" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{ type: "web_search_result", url: "https://en.wikipedia.org/wiki/Claude_Shannon", title: "Claude Shannon", encrypted_content: "EqgfCi", page_age: "April 30, 2025" }],
      },
      {
        type: "text",
        text: " Claude Shannon was born on April 30, 1916.",
        citations: [
          { type: "web_search_result_location", url: "https://en.wikipedia.org/wiki/Claude_Shannon", title: "Claude Shannon", cited_text: "born April 30, 1916", encrypted_index: "Eo8B" },
          { type: "web_search_result_location", url: "https://en.wikipedia.org/wiki/Claude_Shannon", title: "Claude Shannon", cited_text: "Petoskey", encrypted_index: "Eo8C" },
          { type: "web_search_result_location", url: "https://history.example/shannon", title: "Shannon bio", cited_text: "1916", encrypted_index: "Eo8D" },
        ],
      },
    ];
    const turn = fromAnthropic({ content, stop_reason: "end_turn" });
    expect(turn.raw).toEqual(content);
    expect(turn.web).toEqual({
      queries: ["claude shannon birth date"],
      sources: [
        { url: "https://en.wikipedia.org/wiki/Claude_Shannon", title: "Claude Shannon" },
        { url: "https://history.example/shannon", title: "Shannon bio" },
      ],
    });
    expect(turn.text).toBe("I'll look that up. Claude Shannon was born on April 30, 1916.");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.paused).toBeUndefined();
  });

  it("marks a pause_turn as paused and keeps its blocks", () => {
    const content = [{ type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "q" } }];
    const turn = fromAnthropic({ content, stop_reason: "pause_turn" });
    expect(turn.paused).toBe(true);
    expect(turn.raw).toEqual(content);
  });

  it("sets no raw or web for a plain response", () => {
    const turn = fromAnthropic({ content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn" });
    expect(turn).toEqual({ text: "Hi", toolCalls: [] });
  });

  it("sends an assistant message's raw blocks unchanged and appends server tools after client tools", () => {
    const raw = [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }, { type: "text", text: "x", citations: [] }];
    const server = { type: "web_search_20250305", name: "web_search", max_uses: 5 };
    const body = anthropicBody("claude-x", "sys", [{ role: "user", content: "hi" }, { role: "assistant", content: "x", raw }], tools, 1000, [server]);
    expect(body.messages[1]).toEqual({ role: "assistant", content: raw });
    expect(body.tools).toHaveLength(2);
    expect(body.tools[1]).toEqual(server);
    expect(anthropicBody("claude-x", "sys", convo, tools, 1000).tools).toEqual([{ name: "search_mail", description: "Find mail", input_schema: tools[0].parameters }]);
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
