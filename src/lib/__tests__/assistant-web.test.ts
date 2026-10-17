// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const secrets: Record<string, string> = {};
vi.mock("@/lib/secrets", () => ({ getSecret: async (n: string) => secrets[n] ?? null, setSecret: async () => {}, deleteSecret: async () => {} }));
const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
let respond: () => unknown = () => ({});
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    request: async (method: string, url: string, opts?: { headers?: Record<string, string>; body?: unknown }) => {
      calls.push({ method, url, headers: opts?.headers ?? {}, body: opts?.body });
      return respond();
    },
  };
});

const { executeTool } = await import("@/lib/ai/assistant/tools");
const { useAssistant } = await import("@/lib/ai/assistant/state");
const { useSettings } = await import("@/lib/settings");
const { parseBrave, parseTavily, webModule } = await import("@/lib/ai/assistant/modules/web");
const { HttpError } = await import("@/lib/transport");
import type { ToolDeps } from "@/lib/ai/assistant/tools";
import type { WebDeps } from "@/lib/ai/assistant/modules/web";

const run = (args: Record<string, unknown>, deps: ToolDeps) => executeTool({ id: "c1", name: "search_web", args }, deps);
const fakeDeps = (search: WebDeps["search"]) => ({ ext: { web: { search } } }) as unknown as ToolDeps;
const steps = () => useAssistant.getState().items.filter((i) => i.kind === "step").map((i) => (i as { text: string }).text);

beforeEach(() => {
  useAssistant.setState({ items: [] });
  useSettings.setState({ webSearch: { builtin: true, service: "none" } });
  calls.length = 0;
  respond = () => ({});
  for (const k of Object.keys(secrets)) delete secrets[k];
});

describe("search_web", () => {
  it("returns the results and shows a step", async () => {
    const queries: string[] = [];
    const r = await run({ query: " Lake Placid weather " }, fakeDeps(async (q) => (queries.push(q), [{ title: "W", url: "https://w.example", snippet: "Rain" }])));
    expect(r.content).toEqual({ results: [{ title: "W", url: "https://w.example", snippet: "Rain" }] });
    expect(queries).toEqual(["Lake Placid weather"]);
    expect(steps()).toEqual(['Searched the web · "Lake Placid weather"']);
  });

  it("rejects an empty or overlong query as malformed", async () => {
    const deps = fakeDeps(async () => []);
    expect((await run({ query: "  " }, deps)).malformed).toBe(true);
    expect((await run({ query: 7 }, deps)).malformed).toBe(true);
    expect((await run({ query: "x".repeat(301) }, deps)).malformed).toBe(true);
    expect(steps()).toEqual([]);
  });
});

describe("parsers", () => {
  it("reads Brave results, stripping tags, skipping non-http urls and capping at 5", () => {
    const results = [
      { title: "A", url: "https://a.example", description: "It's <strong>sunny</strong> today" },
      { title: "Bad", url: "javascript:alert(1)", description: "x" },
      { title: "Long", url: "http://long.example", description: "y".repeat(400) },
      ...["c", "d", "e", "f"].map((s) => ({ title: s, url: `https://${s}.example`, description: s })),
    ];
    const out = parseBrave({ web: { results } });
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ title: "A", url: "https://a.example", snippet: "It's sunny today" });
    expect(out.map((r) => r.title)).not.toContain("Bad");
    expect(out[1].snippet).toHaveLength(300);
    expect(parseBrave({})).toEqual([]);
    expect(parseBrave(null)).toEqual([]);
  });

  it("reads Tavily results", () => {
    expect(parseTavily({ results: [{ title: "T", url: "https://t.example", content: "Road open" }, { title: "No url" }] })).toEqual([
      { title: "T", url: "https://t.example", snippet: "Road open" },
    ]);
  });
});

describe("real search", () => {
  const search = (q: string) => (webModule.realDeps!() as WebDeps).search(q);

  it("says when no service is set up", async () => {
    await expect(search("x")).rejects.toThrow(/isn't set up/);
    expect(calls).toHaveLength(0);
  });

  it("says when the service has no key", async () => {
    useSettings.setState({ webSearch: { builtin: true, service: "tavily" } });
    await expect(search("x")).rejects.toThrow("No API key saved for Tavily.");
    expect(calls).toHaveLength(0);
  });

  it("calls Brave with the key from the Keychain", async () => {
    useSettings.setState({ webSearch: { builtin: false, service: "brave" } });
    secrets["apikey.websearch.brave"] = "brave-secret";
    respond = () => ({ web: { results: [{ title: "A", url: "https://a.example", description: "a" }] } });
    expect(await search("glacier park roads")).toEqual([{ title: "A", url: "https://a.example", snippet: "a" }]);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.search.brave.com/res/v1/web/search?q=glacier%20park%20roads&count=5");
    expect(calls[0].headers).toEqual({ "X-Subscription-Token": "brave-secret", Accept: "application/json" });
  });

  it("calls Tavily with a bearer key", async () => {
    useSettings.setState({ webSearch: { builtin: true, service: "tavily" } });
    secrets["apikey.websearch.tavily"] = "tvly-secret";
    respond = () => ({ results: [{ title: "T", url: "https://t.example", content: "t" }] });
    expect(await search("q")).toEqual([{ title: "T", url: "https://t.example", snippet: "t" }]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.tavily.com/search",
      headers: { Authorization: "Bearer tvly-secret" },
      body: { query: "q", max_results: 5, search_depth: "basic" },
    });
  });

  it("never puts the key in an error", async () => {
    useSettings.setState({ webSearch: { builtin: true, service: "brave" } });
    secrets["apikey.websearch.brave"] = "brave-secret";
    respond = () => {
      throw new HttpError(401, "bad token brave-secret");
    };
    const err = await search("q").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Brave Search returned an error (401).");
    respond = () => {
      throw new Error("network failed for brave-secret");
    };
    expect(((await search("q").catch((e: Error) => e)) as Error).message).not.toContain("brave-secret");
  });
});
