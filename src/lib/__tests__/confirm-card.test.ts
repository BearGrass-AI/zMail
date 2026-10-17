// @vitest-environment jsdom
// The generic confirm card: pushing, running once, failing, retrying, Confirm all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistant } from "@/lib/ai/assistant/state";
import { confirmAll, dismissConfirm, pushConfirmCard, runConfirm } from "@/lib/ai/assistant/modules/confirm";
import type { ToolModule } from "@/lib/ai/assistant/modules/types";
import type { ToolDeps } from "@/lib/ai/assistant/tools";
import type { GenerativeProvider } from "@/lib/ai/generative";
import type { AgentMessage } from "@/lib/ai/tool-chat";
import { ask } from "@/lib/ai/assistant/loop";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const deps = { ext: {} } as unknown as ToolDeps;
const log: string[] = [];
let release: (() => void) | null = null;

const mod: ToolModule = {
  id: "t",
  tools: [],
  handlers: {},
  confirm: {
    ok: async (p) => (log.push(String(p)), `did ${p}`),
    boom: async () => {
      throw new Error("nope");
    },
    slow: async (p) => {
      log.push(String(p));
      await new Promise<void>((r) => (release = r));
      return "slow done";
    },
  },
};
const mods = [mod];

const push = (action: string, payload: unknown = action) => pushConfirmCard({ module: "t", action, title: "T", payload, confirmLabel: "Go" });
const card = (id: string) => {
  const it = useAssistant.getState().items.find((i) => i.id === id);
  if (it?.kind !== "card" || it.card.type !== "confirm") throw new Error("no confirm card");
  return it.card;
};

beforeEach(() => {
  useAssistant.getState().newChat();
  log.length = 0;
  release = null;
});

describe("confirm card", () => {
  it("pushes a pending card", () => {
    const id = push("ok");
    expect(card(id).status).toBe("pending");
  });

  it("runs the action once and stores the result", async () => {
    const id = push("ok", "A");
    await runConfirm(id, deps, mods);
    await runConfirm(id, deps, mods);
    expect(log).toEqual(["A"]);
    expect(card(id)).toMatchObject({ status: "done", result: "did A" });
  });

  it("stores the error when the action throws, and can retry", async () => {
    const id = push("boom");
    await runConfirm(id, deps, mods);
    expect(card(id)).toMatchObject({ status: "failed", error: "nope" });
    mod.confirm!.boom = async () => "fixed";
    await runConfirm(id, deps, mods);
    expect(card(id)).toMatchObject({ status: "done", result: "fixed", error: undefined });
  });

  it("fails an unknown action with a plain message", async () => {
    const id = push("gone");
    await runConfirm(id, deps, mods);
    expect(card(id)).toMatchObject({ status: "failed", error: "This action is no longer available." });
  });

  it("runs once when confirmed twice while running", async () => {
    const id = push("slow", "S");
    const first = runConfirm(id, deps, mods);
    const second = runConfirm(id, deps, mods);
    expect(card(id).status).toBe("running");
    release!();
    await Promise.all([first, second]);
    expect(log).toEqual(["S"]);
    expect(card(id).status).toBe("done");
  });

  it("confirmAll runs only pending cards, in order", async () => {
    const a = push("ok", "1");
    const b = push("ok", "2");
    const c = push("ok", "3");
    dismissConfirm(b);
    await confirmAll([a, b, c], deps, mods);
    expect(log).toEqual(["1", "3"]);
    expect(card(b).status).toBe("dismissed");
    expect(card(c).status).toBe("done");
  });

  it("dismiss sets dismissed and blocks a later run", async () => {
    const id = push("ok");
    dismissConfirm(id);
    await runConfirm(id, deps, mods);
    expect(log).toEqual([]);
    expect(card(id).status).toBe("dismissed");
  });

  // The model only hears about a card through notes, so each outcome must reach its next request.
  describe("outcomes reach the next model request", () => {
    const nextUserMessage = async (text: string) => {
      const seen: AgentMessage[][] = [];
      const p: GenerativeProvider = { name: "s", complete: async () => "", chat: async (_s, m) => (seen.push([...m]), { text: "ok", toolCalls: [] }) };
      await ask(text, deps, p);
      return (seen[0].at(-1) as { content: string }).content;
    };

    it("done, with the action's result", async () => {
      await runConfirm(push("ok", "A"), deps, mods);
      expect(await nextUserMessage("thanks")).toBe('[zMail: The user confirmed "T": did A]\n\nthanks');
    });

    it("failed, with the error", async () => {
      mod.confirm!.boom = async () => {
        throw new Error("nope");
      };
      await runConfirm(push("boom"), deps, mods);
      expect(await nextUserMessage("why")).toBe('[zMail: The user confirmed "T" but it failed: nope]\n\nwhy');
    });

    it("dismissed", async () => {
      dismissConfirm(push("ok"));
      expect(await nextUserMessage("hm")).toBe('[zMail: The user dismissed "T". Nothing was done.]\n\nhm');
    });

    it("a chat cleared while the action runs gets nothing", async () => {
      const running = runConfirm(push("slow", "S"), deps, mods);
      useAssistant.getState().newChat();
      release!();
      await running;
      expect(await nextUserMessage("hi")).toBe("hi");
    });
  });
});
