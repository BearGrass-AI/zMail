import { describe, expect, it } from "vitest";
import type { Item } from "@/lib/ai/assistant/state";
import { groupSteps } from "@/lib/ai/assistant/steps";

const step = (id: string, text: string): Item => ({ id, kind: "step", text });
const reads = (n: number, from = 0) => Array.from({ length: n }, (_, i) => step(`r${from + i}`, `Read “Your receipt from Apple.”`));

describe("groupSteps", () => {
  it("collapses 9 consecutive Read steps into one group", () => {
    const out = groupSteps(reads(9));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "steps", id: "r0", label: "Read 9 emails" });
    expect((out[0] as { items: Item[] }).items).toHaveLength(9);
  });

  it("collapses a run of different Read steps", () => {
    const out = groupSteps([step("a", "Read “One”"), step("b", "Read “Two”")]);
    expect(out[0]).toMatchObject({ kind: "steps", label: "Read 2 emails" });
  });

  it("collapses identical non-Read steps with ×N", () => {
    const out = groupSteps([1, 2, 3].map((n) => step(`s${n}`, "⌕ Searched Amazon")));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "steps", label: "⌕ Searched Amazon ×3" });
  });

  it("leaves a single step alone", () => {
    const items = [step("a", "Read “One”")];
    expect(groupSteps(items)).toEqual(items);
  });

  it("groups adjacent sub-runs separately", () => {
    const out = groupSteps([...reads(5), step("s1", "⌕ Searched X"), step("s2", "⌕ Searched X")]);
    expect(out.map((o) => (o as { label: string }).label)).toEqual(["Read 5 emails", "⌕ Searched X ×2"]);
  });

  it("does not group Read followed by different searches", () => {
    const items = [step("a", "Read “One”"), step("b", "⌕ Searched A"), step("c", "⌕ Searched B")];
    expect(groupSteps(items)).toEqual(items);
  });

  it("only treats Read “ steps as read_email steps", () => {
    const items = [step("a", "Read this"), step("b", "Read that")];
    expect(groupSteps(items)).toEqual(items);
  });

  it("splits runs broken by other items and preserves order", () => {
    const items: Item[] = [...reads(2), { id: "m", kind: "assistant", text: "hi" }, ...reads(3, 10), { id: "u", kind: "user", text: "q" }];
    const out = groupSteps(items);
    expect(out.map((o) => ("items" in o ? (o as { label: string }).label : (o as Item).id))).toEqual(["Read 2 emails", "m", "Read 3 emails", "u"]);
  });
});
