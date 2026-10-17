// @vitest-environment jsdom
// Assistant modules: registry integrity, handler routing and the system prompt seam.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODULES } from "@/lib/ai/assistant/modules";
import type { ToolModule } from "@/lib/ai/assistant/modules/types";
import { CORE_TOOLS, TOOLS, executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import { systemPrompt } from "@/lib/ai/assistant/prompts";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const ctx = { name: "Alex Rivera", today: "2026-10-12", accounts: ["a@x.com"] };
const deps = { ext: {} } as unknown as ToolDeps;

describe("module registry", () => {
  it("has unique tool names across core and modules", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(CORE_TOOLS.length).toBeGreaterThan(0);
  });

  it("gives every module tool a handler and every handler a tool", () => {
    for (const m of MODULES) {
      expect(m.tools.map((t) => t.name).sort(), m.id).toEqual(Object.keys(m.handlers).sort());
    }
  });

  it("has unique module ids", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("module routing", () => {
  const probe: ToolModule = {
    id: "probe",
    tools: [{ name: "probe_tool", description: "test", parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }],
    handlers: {
      probe_tool: async (a, _d, call) => {
        if (a.x === "boom") throw new Error("kaboom");
        if (a.x === "bad") throw new Error("bad_query: nope");
        return { got: a.x, call: call.name };
      },
    },
  };
  afterEach(() => {
    MODULES.splice(MODULES.indexOf(probe), 1);
    TOOLS.splice(TOOLS.findIndex((t) => t.name === "probe_tool"), 1);
  });
  const install = () => {
    MODULES.push(probe);
    TOOLS.push(...probe.tools);
  };

  it("runs a module handler with parsed args", async () => {
    install();
    expect(await executeTool({ id: "1", name: "probe_tool", args: { x: "hi" } }, deps)).toEqual({ content: { got: "hi", call: "probe_tool" } });
  });

  it("applies the core argument checks to module tools", async () => {
    install();
    expect((await executeTool({ id: "1", name: "probe_tool", args: null }, deps)).malformed).toBe(true);
    expect((await executeTool({ id: "1", name: "probe_tool", args: {} }, deps)).malformed).toBe(true);
  });

  it("wraps module handler errors like core tool errors", async () => {
    install();
    expect(await executeTool({ id: "1", name: "probe_tool", args: { x: "boom" } }, deps)).toEqual({ content: { error: "kaboom" } });
    expect(await executeTool({ id: "1", name: "probe_tool", args: { x: "bad" } }, deps)).toEqual({ content: { error: "bad_query: nope" }, malformed: true });
  });
});

describe("malformed calls", () => {
  const core = { ext: {}, folders: () => [], sections: () => [] } as unknown as ToolDeps;
  it("stale ids and sets are plain errors, not malformed calls (they don't survive a relaunch)", async () => {
    const { useAssistant } = await import("@/lib/ai/assistant/state");
    useAssistant.getState().newChat();
    const r = await executeTool({ id: "1", name: "read_email", args: { id: "old" } }, core);
    expect(r).toEqual({ content: { error: 'unknown id "old": only use ids from earlier tool results' } });
    expect((await executeTool({ id: "1", name: "break_down", args: { set_id: "set_old", by: "sender" } }, core)).malformed).toBeUndefined();
    // Unknown tools and other bad arguments still count.
    expect((await executeTool({ id: "1", name: "no_such_tool", args: {} }, core)).malformed).toBe(true);
    expect((await executeTool({ id: "1", name: "act", args: { op: "explode", ids: [] } }, core)).malformed).toBe(true);
  });
});

describe("shared id helper", () => {
  it("refsFrom merges ids and a set_id, dedupes, caps, and names unknown ids", async () => {
    const { useAssistant } = await import("@/lib/ai/assistant/state");
    const { refOf, refsFrom } = await import("@/lib/ai/assistant/modules/ids");
    const st = useAssistant.getState();
    st.newChat();
    st.remember([{ id: "a", accountId: "g" }, { id: "b", accountId: "g" }]);
    const set = st.addSet({ label: "x", refs: [{ id: "b", accountId: "g" }, { id: "c", accountId: "g" }] });
    expect(refsFrom({ ids: ["a", "b"], set_id: set.id }).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(() => refsFrom({ ids: ["a", "b"], set_id: set.id }, { max: 2 })).toThrow(/^bad_query: at most 2/);
    expect(() => refsFrom({ ids: ["zz"] })).toThrow(/^unknown id "zz"/);
    expect(() => refsFrom({ ids: "a" })).toThrow(/^bad_query: ids must be a list/);
    expect(() => refsFrom({ set_id: "nope" })).toThrow(/^unknown set_id "nope"/);
    expect(() => refsFrom({})).toThrow(/^bad_query: give ids or a set_id/);
    expect(refOf("a")).toEqual({ id: "a", accountId: "g" });
    expect(() => refOf("__proto__")).toThrow(/^unknown id/);
  });
});

describe("systemPrompt", () => {
  it("has no blank line inside the rules while modules add nothing", () => {
    const p = systemPrompt(ctx);
    const rules = p.slice(p.indexOf("Rules:"));
    expect(rules).not.toContain("\n\n");
    expect(rules).toContain("- Be brief and plain.");
  });

  it("puts module lines just before the final rule", () => {
    // The last module's lines come last, right before the final rule, whatever the other modules add.
    const m = MODULES[MODULES.length - 1];
    const saved = m.prompt;
    m.prompt = [...(saved ?? []), "- Probe rule."];
    try {
      expect(systemPrompt(ctx)).toContain("\n- Probe rule.\n- Be brief and plain.");
    } finally {
      m.prompt = saved;
    }
  });

  it("points calendar and rule requests at the right tools", () => {
    const p = systemPrompt(ctx);
    expect(p).toContain("Use create_event for a simple event on the user's own calendar; invite for meetings with attendees or a video link; list_events to answer what's on the calendar.");
    expect(p).not.toContain("Use create_event for calendar requests");
    expect(p).toMatch(/always file a sender's mail into a folder, use always_file\. For other automatic handling of new mail .*use propose_rule/);
    // Every tool the prompt names exists.
    for (const name of ["create_event", "invite", "list_events", "always_file", "propose_rule", "send_reply"]) expect(TOOLS.some((t) => t.name === name), name).toBe(true);
  });
});
