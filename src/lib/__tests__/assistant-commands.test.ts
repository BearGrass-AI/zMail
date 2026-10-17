// src/lib/__tests__/assistant-commands.test.ts
import { describe, expect, it } from "vitest";
import type { Email } from "@/lib/types";
import { COMMANDS, findCommand, inputKeyAction, type InputState, type MenuItem, matchCommands, parseSlash, senderSuggestions } from "@/lib/ai/assistant/commands";

const mk = (id: string, name: string, address: string, partial = false) =>
  ({ id, accountId: "a", threadId: id, folderId: "a:inbox", from: { name, address }, to: [], subject: "s", snippet: "", text: "", date: "2026-10-01T00:00:00Z", unread: false, starred: false, labels: [], ...(partial ? { partial: true } : {}) }) as Email;

describe("commands", () => {
  it("lists the starting set in menu order", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(["breakdown", "cleanup", "unsubscribe", "find", "summarize", "reply", "schedule", "clear"]);
  });

  it("filters by prefix and hides email commands with nothing open", () => {
    expect(matchCommands("cl", { hasOpenEmail: false }).map((c) => c.name)).toEqual(["cleanup", "clear"]);
    expect(matchCommands("", { hasOpenEmail: false }).some((c) => c.group === "email")).toBe(false);
    expect(matchCommands("su", { hasOpenEmail: true }).map((c) => c.name)).toEqual(["summarize"]);
    expect(matchCommands("/BR", { hasOpenEmail: false }).map((c) => c.name)).toEqual(["breakdown"]);
  });

  it("parses typed commands with or without a colon", () => {
    expect(parseSlash("/breakdown amazon")).toMatchObject({ command: { name: "breakdown" }, arg: "amazon" });
    expect(parseSlash("/breakdown: Amazon.com ")).toMatchObject({ command: { name: "breakdown" }, arg: "Amazon.com" });
    expect(parseSlash("/summarize")).toMatchObject({ command: { name: "summarize" }, arg: "" });
    expect(parseSlash("/nope hi")).toBeNull();
    expect(parseSlash("hello /find x")).toBeNull();
    expect(parseSlash("/new")).toMatchObject({ command: { name: "clear" } });
  });

  it("expands prompts with the user's text and keeps /clear local", () => {
    expect(findCommand("breakdown")!.expand("amazon")).toContain("amazon");
    expect(findCommand("find")!.expand("what did Jen say")).toContain("what did Jen say");
    expect(findCommand("find")!.expand("x")).toContain("[mN]");
    const cleanup = findCommand("cleanup")!.expand("amazon.com");
    expect(cleanup.indexOf("check_unsubscribe")).toBeGreaterThan(-1);
    expect(cleanup.indexOf("check_unsubscribe")).toBeLessThan(cleanup.indexOf("use act"));
    expect(cleanup).toMatch(/Optionally[^.]*propose_rule/);
    for (const n of ["summarize", "schedule"]) {
      expect(findCommand(n)!.expand("")).not.toContain("Also:");
      expect(findCommand(n)!.expand("  ")).not.toContain("Also:");
      expect(findCommand(n)!.expand("only the dates")).toMatch(/\nAlso: only the dates$/);
    }
    expect(findCommand("clear")!.local).toBe("clear");
  });

  it("suggests domains then addresses, with counts, from full emails only", () => {
    const emails = [
      mk("1", "Amazon.com", "ship@amazon.com"),
      mk("2", "Amazon.com", "ship@amazon.com"),
      mk("3", "Amazon Deals", "deals@amazon.com"),
      mk("4", "AWS", "no-reply@aws.amazon.com"),
      mk("5", "Amanda Lee", "amanda@example.org"),
      mk("6", "Ghost", "ghost@amazon.com", true),
    ];
    const s = senderSuggestions(emails, "am");
    expect(s[0]).toEqual({ value: "amazon.com", label: "amazon.com", count: 3, kind: "domain" });
    expect(s.find((x) => x.value === "amanda@example.org")).toMatchObject({ label: "Amanda Lee", count: 1, kind: "address" });
    expect(s.find((x) => x.value === "aws.amazon.com")).toMatchObject({ count: 1, kind: "domain" });
    expect(senderSuggestions(emails, "")).toEqual([]);
    expect(senderSuggestions(emails, "am", 2)).toHaveLength(2);
  });

  it("is safe against prototype names and accepts a colon without a space", () => {
    expect(findCommand("constructor")).toBeUndefined();
    expect(parseSlash("/toString x")).toBeNull();
    expect(parseSlash("/breakdown:amazon")).toMatchObject({ command: { name: "breakdown" }, arg: "amazon" });
    expect(parseSlash("/breakdown: amazon")).toMatchObject({ arg: "amazon" });
  });
});

describe("inputKeyAction", () => {
  const items: MenuItem[] = ["breakdown", "cleanup", "find"].map((n) => ({ type: "command", command: findCommand(n)! }));
  const open = (active = 0): InputState => ({ chip: null, text: "/", menu: { items, active }, composing: false });
  const closed = (over: Partial<InputState> = {}): InputState => ({ chip: null, text: "hi", menu: null, composing: false, ...over });

  it("moves and wraps", () => {
    expect(inputKeyAction("ArrowDown", open(0))).toEqual({ do: "move", active: 1 });
    expect(inputKeyAction("ArrowDown", open(2))).toEqual({ do: "move", active: 0 });
    expect(inputKeyAction("ArrowUp", open(0))).toEqual({ do: "move", active: 2 });
  });
  it("picks on Enter or Tab while the menu is open", () => {
    expect(inputKeyAction("Enter", open(1))).toEqual({ do: "pick", item: items[1] });
    expect(inputKeyAction("Tab", open(2))).toEqual({ do: "pick", item: items[2] });
  });
  it("sends on Enter with the menu closed, not with Shift", () => {
    expect(inputKeyAction("Enter", closed())).toEqual({ do: "send" });
    expect(inputKeyAction("Enter", closed(), true)).toEqual({ do: "none" });
  });
  it("does nothing while composing", () => {
    expect(inputKeyAction("Enter", closed({ composing: true }))).toEqual({ do: "none" });
    expect(inputKeyAction("Enter", { ...open(), composing: true })).toEqual({ do: "none" });
  });
  it("closes on Escape", () => {
    expect(inputKeyAction("Escape", open())).toEqual({ do: "close" });
    expect(inputKeyAction("Escape", closed())).toEqual({ do: "none" });
  });
  it("removes the chip on Backspace only when text is empty", () => {
    const chip = findCommand("find")!;
    expect(inputKeyAction("Backspace", closed({ chip, text: "" }))).toEqual({ do: "remove_chip" });
    expect(inputKeyAction("Backspace", closed({ chip, text: "a" }))).toEqual({ do: "none" });
    expect(inputKeyAction("Backspace", closed({ text: "" }))).toEqual({ do: "none" });
  });
});
