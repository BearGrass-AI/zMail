import { describe, expect, it } from "vitest";
import { buildRequest, candidateFolders, STAY } from "@/lib/ai/triage";
import { computeHabits, recordFiling } from "@/lib/ai/habits";
import type { Email, Folder } from "@/lib/types";

const email = (over: Partial<Email> = {}): Email => ({
  id: "e1", accountId: "a", threadId: "e1", folderId: "a:inbox",
  from: { name: "Dana Whitfield", address: "dana@example.org" }, to: [],
  subject: "HR question about payroll", snippet: "", text: "body", date: new Date().toISOString(),
  unread: true, starred: false, labels: [], ...over,
});

const big: Folder[] = [
  { id: "a:inbox", accountId: "a", name: "Inbox", system: "inbox" },
  { id: "a:depts", accountId: "a", name: "Campus Departments", parentId: "a:inbox" },
  { id: "a:hr", accountId: "a", name: "HR", parentId: "a:depts" },
  { id: "a:payroll", accountId: "a", name: "Payroll", parentId: "a:depts" },
  ...Array.from({ length: 80 }, (_, i) => ({ id: `a:f${i}`, accountId: "a", name: `Project ${i}` })),
];

describe("candidateFolders", () => {
  it("passes small trees through whole", () => {
    const small = big.slice(0, 4);
    expect(candidateFolders(email(), small, undefined).map((f) => f.id)).toEqual(["a:depts", "a:hr", "a:payroll"]);
  });

  it("narrows big trees using filing history and name matches, within the cap", () => {
    const habits = recordFiling(new Map(), "dana@example.org", "a:f7");
    const out = candidateFolders(email(), big, habits.get("dana@example.org"), 25).map((f) => f.id);
    expect(out[0]).toBe("a:f7"); // history wins
    expect(out).toContain("a:payroll"); // subject match
    expect(out.length).toBeLessThanOrEqual(25);
  });
});

describe("buildRequest", () => {
  it("respects the provider's option limit (Ollama: 26) including stay_in_inbox", () => {
    const habits = new Map();
    for (let i = 0; i < 80; i++) recordFiling(habits, "dana@example.org", `a:f${i}`);
    const req = buildRequest(email(), { name: "Z", address: "z@x" }, big, habits.get("dana@example.org"), 26);
    const opts = Object.keys((req.questions.folder as { criteria: Record<string, string> }).criteria);
    expect(opts).toContain(STAY);
    expect(opts.length).toBeLessThanOrEqual(26);
  });
});

describe("computeHabits", () => {
  it("counts filings only in user folders", () => {
    const folders: Folder[] = [
      { id: "a:inbox", accountId: "a", name: "Inbox", system: "inbox" },
      { id: "a:fin", accountId: "a", name: "Finance" },
    ];
    const h = computeHabits([email({ folderId: "a:fin" }), email({ id: "e2", folderId: "a:inbox" })], folders);
    expect(h.get("dana@example.org")).toEqual({ sender: "dana@example.org", total: 1, byFolder: { "a:fin": 1 } });
  });
});
