// @vitest-environment jsdom
// Autosave: writes state.v1 only when saved data changed, and never waits longer than 2s.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const mock = { id: "m", kind: "mock" as const, name: "Demo", address: "demo@example.com" };

const kvSet = vi.hoisted(() => vi.fn(async (_k: string, _v: unknown) => {}));
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: () => ({
    account: gmail,
    batchSize: 50,
    listFolders: async () => [],
    listMessages: async () => [],
    batchMove: async () => ({ skipped: [], failed: [] }),
    batchSetRead: async () => ({ skipped: [], failed: [] }),
    batchSetStarred: async () => ({ skipped: [], failed: [] }),
  }),
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

const { useMail } = await import("@/lib/store");
const stateSaves = () => kvSet.mock.calls.filter((c) => c[0] === "state.v1").length;

beforeAll(async () => {
  // load() starts the autosave subscription.
  await useMail.getState().load();
});
beforeEach(async () => {
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(5000); // flush anything pending from setup
  kvSet.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("autosave", () => {
  it("ignores changes to unsaved state", async () => {
    useMail.setState({ selectedId: "x" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(stateSaves()).toBe(0);
  });

  it("saves once, 600ms after saved data changes", async () => {
    useMail.setState({ triage: { a: { category: "fyi" } } as never });
    await vi.advanceTimersByTimeAsync(599);
    expect(stateSaves()).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(stateSaves()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(stateSaves()).toBe(1);
  });

  it("saves within 2s during a steady stream of changes", async () => {
    for (let i = 0; i < 10; i++) {
      useMail.setState({ triage: { [`k${i}`]: { category: "fyi" } } as never });
      await vi.advanceTimersByTimeAsync(300);
    }
    // 3s of changes every 300ms: settle never fires, so only the max wait can have saved.
    expect(stateSaves()).toBeGreaterThanOrEqual(1);
  });

  it("tracks emails only when a demo account exists", async () => {
    useMail.setState({ emails: [...useMail.getState().emails] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(stateSaves()).toBe(0);

    useMail.setState({ accounts: [...useMail.getState().accounts, mock] });
    await vi.advanceTimersByTimeAsync(5000);
    kvSet.mockClear();
    useMail.setState({ emails: [...useMail.getState().emails] });
    await vi.advanceTimersByTimeAsync(700);
    expect(stateSaves()).toBe(1);
  });
});
