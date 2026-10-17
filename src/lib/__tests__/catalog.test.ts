import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
let respond: (url: string) => unknown = () => ({});
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    request: async (method: string, url: string, opts?: { headers?: Record<string, string>; body?: unknown }) => {
      calls.push({ method, url, headers: opts?.headers ?? {}, body: opts?.body });
      return respond(url);
    },
  };
});

const { PROVIDER_TYPES, apiBase, listModels, providerType, providerTypes } = await import("@/lib/ai/catalog");
const { HttpGenerativeProvider } = await import("@/lib/ai/generative");

beforeEach(() => {
  calls.length = 0;
  respond = () => ({});
});

describe("provider types", () => {
  it("has the LLM and decision groups from the table", () => {
    expect(providerTypes("llm").map((t) => t.id)).toEqual(["ollama", "vllm", "openai", "anthropic", "gemini", "xai", "perplexity", "openrouter", "custom"]);
    expect(providerTypes("decision").map((t) => t.id)).toEqual(["jev", "ollama", "custom"]);
    expect(providerType("decision", "ollama")?.maxChoiceOptions).toBe(26);
    expect(providerType("llm", "jev")).toBeUndefined();
  });
  it("defaults are public URLs or localhost", () => {
    for (const t of PROVIDER_TYPES) if (t.baseUrl) expect(t.baseUrl).toMatch(/^(https:\/\/[a-z.]+\.(com|ai)(\/|$)|http:\/\/localhost:11434$)/);
  });
});

describe("apiBase", () => {
  it("appends /v1 for most types", () => {
    expect(apiBase("openai", "https://api.openai.com/")).toBe("https://api.openai.com/v1");
    expect(apiBase("anthropic", "https://api.anthropic.com")).toBe("https://api.anthropic.com/v1");
    expect(apiBase("ollama", "http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(apiBase("xai", "https://api.x.ai")).toBe("https://api.x.ai/v1");
    expect(apiBase("openrouter", "https://openrouter.ai/api")).toBe("https://openrouter.ai/api/v1");
    expect(apiBase("vllm", "http://localhost:8000")).toBe("http://localhost:8000/v1");
    expect(apiBase("custom", "http://localhost:1234")).toBe("http://localhost:1234/v1");
  });
  it("uses the base itself for Gemini and Perplexity", () => {
    expect(apiBase("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(apiBase("perplexity", "https://api.perplexity.ai")).toBe("https://api.perplexity.ai");
  });
});

describe("listModels", () => {
  it("lists each model once when a server repeats one", async () => {
    respond = () => ({ models: [{ name: "qwen3.6:latest" }, { name: "gemma4:e4b" }, { name: "qwen3.6:latest" }] });
    expect((await listModels("llm", "ollama", "http://localhost:11434", "")).map((m) => m.id)).toEqual(["qwen3.6:latest", "gemma4:e4b"]);
  });
  it("labels Anthropic models with display names", async () => {
    respond = () => ({ data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }] });
    expect(await listModels("llm", "anthropic", "https://api.anthropic.com", "k")).toEqual([{ id: "claude-opus-5", label: "Claude Opus 5" }]);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(calls[0].headers["x-api-key"]).toBe("k");
  });
  it("hides Ollama decision models for LLMs and puts them first for decisions", async () => {
    respond = () => ({ models: [{ name: "qwen3:8b" }, { name: "clef:latest" }] });
    expect(await listModels("llm", "ollama", "http://localhost:11434", "")).toEqual([{ id: "qwen3:8b", tag: undefined }]);
    expect(calls[0].url).toBe("http://localhost:11434/api/tags");
    const d = await listModels("decision", "ollama", "http://localhost:11434", "");
    expect(d.map((m) => [m.id, m.tag])).toEqual([["clef:latest", "decision"], ["qwen3:8b", undefined]]);
  });
  it("filters OpenAI to chat models", async () => {
    respond = () => ({ data: [{ id: "gpt-5.1" }, { id: "text-embedding-3" }, { id: "o4-mini" }, { id: "dall-e-3" }] });
    expect((await listModels("llm", "openai", "https://api.openai.com", "k")).map((m) => m.id)).toEqual(["o4-mini", "gpt-5.1"]);
    expect(calls[0].url).toBe("https://api.openai.com/v1/models");
    expect(calls[0].headers.Authorization).toBe("Bearer k");
  });
  it("strips Gemini's models/ prefix", async () => {
    respond = () => ({ data: [{ id: "models/gemini-2.5-pro" }, { id: "gemini-2.5-flash" }] });
    const base = "https://generativelanguage.googleapis.com/v1beta/openai";
    expect((await listModels("llm", "gemini", base, "k")).map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(calls[0].url).toBe(`${base}/models`);
  });
  it("returns Perplexity's fixed list without a request", async () => {
    expect((await listModels("llm", "perplexity", "https://api.perplexity.ai", "k")).map((m) => m.id)).toEqual(["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro"]);
    expect(calls).toHaveLength(0);
  });
  it("lists OpenRouter, xAI, vLLM and custom from /v1/models", async () => {
    respond = () => ({ data: [{ id: "a/b", name: "A: B" }] });
    expect(await listModels("llm", "openrouter", "https://openrouter.ai/api", "k")).toEqual([{ id: "a/b", label: "A: B" }]);
    expect(await listModels("llm", "xai", "https://api.x.ai", "k")).toEqual([{ id: "a/b" }]);
    expect(await listModels("llm", "vllm", "http://localhost:8000", "")).toEqual([{ id: "a/b" }]);
    expect(await listModels("llm", "custom", "http://localhost:1234/v1", "")).toEqual([{ id: "a/b" }]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://openrouter.ai/api/v1/models",
      "https://api.x.ai/v1/models",
      "http://localhost:8000/v1/models",
      "http://localhost:1234/v1/models",
    ]);
    expect(calls[2].headers.Authorization).toBeUndefined();
  });
  it("lists Jev and custom SystemOne models from /v1/models", async () => {
    respond = () => ({ data: [{ id: "jev-1" }] });
    expect(await listModels("decision", "jev", "https://api.typesafe.ai", "k")).toEqual([{ id: "jev-1" }]);
    expect(await listModels("decision", "custom", "http://localhost:9000", "")).toEqual([{ id: "jev-1" }]);
    expect(calls.map((c) => c.url)).toEqual(["https://api.typesafe.ai/v1/models", "http://localhost:9000/v1/models"]);
  });
  it("needs an endpoint", async () => {
    await expect(listModels("llm", "vllm", " ", "")).rejects.toThrow(/endpoint/);
  });
});

describe("chat URLs", () => {
  const cases: [Parameters<typeof apiBase>[0], string, string][] = [
    ["anthropic", "https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
    ["openai", "https://api.openai.com", "https://api.openai.com/v1/chat/completions"],
    ["ollama", "http://localhost:11434", "http://localhost:11434/v1/chat/completions"],
    ["vllm", "http://localhost:8000", "http://localhost:8000/v1/chat/completions"],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
    ["xai", "https://api.x.ai", "https://api.x.ai/v1/chat/completions"],
    ["perplexity", "https://api.perplexity.ai", "https://api.perplexity.ai/chat/completions"],
    ["openrouter", "https://openrouter.ai/api", "https://openrouter.ai/api/v1/chat/completions"],
    ["custom", "http://localhost:1234", "http://localhost:1234/v1/chat/completions"],
  ];
  it.each(cases)("%s complete() posts to the right URL", async (provider, baseUrl, url) => {
    respond = () => (provider === "anthropic" ? { content: [{ type: "text", text: "hi" }] } : { choices: [{ message: { content: "hi" } }] });
    await new HttpGenerativeProvider({ provider: provider as never, baseUrl, model: "m", apiKey: "k" }).complete([{ role: "user", content: "x" }]);
    expect(calls[0].url).toBe(url);
  });
  it.each(cases)("%s chat() posts to the right URL", async (provider, baseUrl, url) => {
    respond = () => (provider === "anthropic" ? { content: [] } : { choices: [{ message: { content: "" } }] });
    await new HttpGenerativeProvider({ provider: provider as never, baseUrl, model: "m", apiKey: "k" }).chat("s", [{ role: "user", content: "x" }], []);
    expect(calls[0].url).toBe(url);
  });
  describe("web search", () => {
    const msgs = [{ role: "user" as const, content: "x" }];
    const anthropic = () => new HttpGenerativeProvider({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", apiKey: "k" });
    const toolsOf = (i: number) => (calls[i].body as { tools: { type?: string; name: string }[] }).tools;

    it("adds Anthropic's web_search server tool when asked", async () => {
      respond = () => ({ content: [] });
      expect(anthropic().builtinWebSearch).toBe(true);
      await anthropic().chat("s", msgs, [{ name: "t", description: "d", parameters: {} }], { webSearch: true });
      expect(toolsOf(0).map((t) => t.name)).toEqual(["t", "web_search"]);
      expect(toolsOf(0)[1]).toMatchObject({ type: "web_search_20250305", max_uses: 5, user_location: { type: "approximate" } });
    });

    it("never adds it for other providers or when not asked", async () => {
      respond = (url) => (url.endsWith("/messages") ? { content: [] } : { choices: [{ message: { content: "" } }] });
      const openai = new HttpGenerativeProvider({ provider: "openai", baseUrl: "https://api.openai.com", model: "m", apiKey: "k" });
      expect(openai.builtinWebSearch).toBe(false);
      await openai.chat("s", msgs, [], { webSearch: true });
      await anthropic().chat("s", msgs, [], { webSearch: false });
      await anthropic().chat("s", msgs, []);
      expect(JSON.stringify(calls.map((c) => c.body))).not.toContain("web_search");
    });

    it("retries once without it when the org has web search turned off", async () => {
      const { HttpError } = await import("@/lib/transport");
      let n = 0;
      respond = () => {
        if (n++ === 0) throw new HttpError(400, '{"type":"error","error":{"type":"invalid_request_error","message":"web search is not enabled for this organization"}}');
        return { content: [{ type: "text", text: "Answer without search" }] };
      };
      const turn = await anthropic().chat("s", msgs, [], { webSearch: true });
      expect(turn.text).toBe("Answer without search");
      expect(calls).toHaveLength(2);
      expect(toolsOf(0).map((t) => t.name)).toEqual(["web_search"]);
      expect(toolsOf(1)).toEqual([]);
    });

    it("remembers it and strips raw server-tool blocks from the fallback", async () => {
      const { HttpError } = await import("@/lib/transport");
      const p = new HttpGenerativeProvider({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "remember-me", apiKey: "k" });
      let n = 0;
      respond = () => {
        if (n++ === 0) throw new HttpError(400, "web search is not enabled for this organization");
        return { content: [{ type: "text", text: "ok" }] };
      };
      const history = [
        { role: "user" as const, content: "x" },
        { role: "assistant" as const, content: "Rain.", raw: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }, { type: "text", text: "Rain." }] },
        { role: "user" as const, content: "and tomorrow?" },
      ];
      const first = await p.chat("s", history, [], { webSearch: true });
      expect(first.searchUnavailable).toBe(true);
      expect(p.builtinWebSearch).toBe(false);
      expect(JSON.stringify(calls[1].body)).not.toContain("server_tool_use");
      const second = await p.chat("s", msgs, [], { webSearch: true });
      expect(second.searchUnavailable).toBeUndefined();
      expect(calls).toHaveLength(3);
      expect(toolsOf(2)).toEqual([]);
    });

    it("doesn't retry other 400s", async () => {
      const { HttpError } = await import("@/lib/transport");
      respond = () => {
        throw new HttpError(400, "max_tokens too large");
      };
      await expect(anthropic().chat("s", msgs, [], { webSearch: true })).rejects.toThrow(/max_tokens/);
      expect(calls).toHaveLength(1);
    });
  });

  it("keeps the OpenAI and Ollama quirks", async () => {
    respond = () => ({ choices: [{ message: { content: "hi" } }] });
    await new HttpGenerativeProvider({ provider: "openai", baseUrl: "https://api.openai.com", model: "m" }).complete([{ role: "user", content: "x" }], { maxTokens: 9 });
    await new HttpGenerativeProvider({ provider: "ollama", baseUrl: "http://localhost:11434", model: "m" }).complete([{ role: "user", content: "x" }], { maxTokens: 9 });
    await new HttpGenerativeProvider({ provider: "xai", baseUrl: "https://api.x.ai", model: "m" }).complete([{ role: "user", content: "x" }], { maxTokens: 9 });
    expect(calls[0].body).toMatchObject({ max_completion_tokens: 9 });
    expect(calls[1].body).toMatchObject({ max_tokens: 9, reasoning_effort: "none" });
    expect(calls[2].body).toMatchObject({ max_tokens: 9 });
    expect(calls[2].body).not.toHaveProperty("reasoning_effort");
  });
});
