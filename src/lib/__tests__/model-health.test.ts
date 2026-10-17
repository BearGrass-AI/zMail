// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useModelHealth } from "@/lib/ai/assistant/model-health";

beforeEach(() => useModelHealth.setState({ health: {} }));

describe("model health", () => {
  it("marks and overwrites", () => {
    useModelHealth.getState().mark("a", "struggled");
    expect(useModelHealth.getState().health.a).toBe("struggled");
    useModelHealth.getState().mark("a", "ok");
    expect(useModelHealth.getState().health.a).toBe("ok");
  });
  it("drops struggled marks saved before version 1 and keeps the ok ones", async () => {
    const saved = { state: { health: { a: "struggled", b: "ok" } }, version: 0 };
    localStorage.setItem("zmail.model-health", JSON.stringify(saved));
    await useModelHealth.persist.rehydrate();
    expect(useModelHealth.getState().health).toEqual({ b: "ok" });
    localStorage.setItem("zmail.model-health", JSON.stringify({ state: { health: { a: "struggled" } }, version: 1 }));
    await useModelHealth.persist.rehydrate();
    expect(useModelHealth.getState().health).toEqual({ a: "struggled" });
  });
  it("keeps other models' entries", () => {
    useModelHealth.getState().mark("a", "ok");
    useModelHealth.getState().mark("b", "struggled");
    expect(useModelHealth.getState().health).toEqual({ a: "ok", b: "struggled" });
  });
});
