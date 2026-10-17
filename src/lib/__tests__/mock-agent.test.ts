import { describe, expect, it } from "vitest";
import { mockAgentTurn } from "@/lib/ai/assistant/mock-agent";
import { findCommand } from "@/lib/ai/assistant/commands";
import type { AgentMessage } from "@/lib/ai/tool-chat";

const tool = (name: string, data: unknown): AgentMessage => ({ role: "tool", toolCallId: "t", name, content: JSON.stringify(data) });

describe("mock agent with slash prompts", () => {
  const breakdown = findCommand("breakdown")!.expand("amazon.com");
  const cleanup = findCommand("cleanup")!.expand("amazon.com");

  it("searches for the sender after /breakdown and /cleanup", () => {
    for (const p of [breakdown, cleanup]) {
      const t = mockAgentTurn([{ role: "user", content: p }]);
      expect(t.toolCalls[0]).toMatchObject({ name: "search_mail", args: { query: { from: "amazon.com" } } });
    }
  });

  it("breaks down, then /cleanup proposes trash", () => {
    const search = tool("search_mail", { set_id: "s1", count: 40, label: "amazon.com" });
    const bd = tool("break_down", { groups: [{ label: "Orders", count: 3 }] });
    const user: AgentMessage = { role: "user", content: cleanup };
    expect(mockAgentTurn([user, search]).toolCalls[0].name).toBe("break_down");
    expect(mockAgentTurn([user, search, bd]).toolCalls[0]).toMatchObject({ name: "act", args: { set_id: "s1", op: "trash" } });
    const u2: AgentMessage = { role: "user", content: breakdown };
    expect(mockAgentTurn([u2, search, bd]).text).toContain("| Group |");
  });
});

describe("mock agent /unsubscribe", () => {
  const prompt = findCommand("unsubscribe")!.expand("superhuman.com");
  it("checks how to unsubscribe, then points at the card", () => {
    const user: AgentMessage = { role: "user", content: prompt };
    expect(mockAgentTurn([user]).toolCalls[0]).toMatchObject({ name: "check_unsubscribe", args: { from: "superhuman.com" } });
    expect(mockAgentTurn([user, tool("check_unsubscribe", { available: "one_click", from: "superhuman.com" })]).text).toMatch(/card/);
    expect(mockAgentTurn([user, tool("check_unsubscribe", { available: "none", from: "superhuman.com" })]).text).toMatch(/couldn't find/i);
  });
  it("leaves /cleanup searching first", () => {
    const t = mockAgentTurn([{ role: "user", content: findCommand("cleanup")!.expand("superhuman.com") }]);
    expect(t.toolCalls[0].name).toBe("search_mail");
  });
});

describe("mock agent routes slash commands by intent", () => {
  const open = tool("current_view", { open_email: { id: "e1", ref: "m1" }, checked: [] });
  const read = (text: string, subject = "Team offsite") =>
    tool("read_email", { id: "e1", ref: "m1", from: "Jen Park <jen@example.org>", subject, date: "2026-10-01T10:00:00Z", email_text: text });

  it("/find searches the question's words, reads the top hit and answers citing it", () => {
    const user: AgentMessage = { role: "user", content: findCommand("find")!.expand("when does the parking permit expire?") };
    const first = mockAgentTurn([user]).toolCalls[0];
    expect(first.name).toBe("search_mail");
    const words = String((first.args as { query: { words: string } }).query.words);
    expect(words).toMatch(/parking/);
    expect(words).not.toMatch(/\b(my|when|does|the)\b/);
    expect((first.args as { query: Record<string, unknown> }).query.from).toBeUndefined();
    const found = tool("search_mail", { set_id: "s1", count: 2, label: "parking", sample: [{ id: "e1", ref: "m1" }, { id: "e2", ref: "m2" }] });
    expect(mockAgentTurn([user, found]).toolCalls[0]).toMatchObject({ name: "read_email", args: { id: "e1" } });
    const answer = mockAgentTurn([user, found, read("Your parking permit expires on 2026-12-31.", "Parking permit")]);
    expect(answer.toolCalls).toEqual([]);
    expect(answer.text).toContain("[m1]");
    expect(answer.text.split(/(?<=\.)\s/).length).toBe(1);
    const none = mockAgentTurn([user, tool("search_mail", { set_id: "s2", count: 0, label: "parking", sample: [] })]);
    expect(none.text).toMatch(/nothing/i);
    expect(none.text).not.toContain("[m");
  });

  it("/summarize reads the open email and summarizes it with its ref", () => {
    const user: AgentMessage = { role: "user", content: findCommand("summarize")!.expand("") };
    expect(mockAgentTurn([user]).toolCalls[0].name).toBe("current_view");
    expect(mockAgentTurn([user, open]).toolCalls[0]).toMatchObject({ name: "read_email", args: { id: "e1" } });
    const t = mockAgentTurn([user, open, read("We're meeting off campus next week. Please bring your laptop.")]);
    expect(t.toolCalls).toEqual([]);
    expect(t.text).toContain("[m1]");
    expect(t.text).toMatch(/meeting off campus/);
  });

  it("/schedule proposes an event on the date in the email, or says there isn't one", () => {
    const user: AgentMessage = { role: "user", content: findCommand("schedule")!.expand("") };
    expect(mockAgentTurn([user]).toolCalls[0].name).toBe("current_view");
    expect(mockAgentTurn([user, open]).toolCalls[0]).toMatchObject({ name: "read_email", args: { id: "e1" } });
    expect(mockAgentTurn([user, open, read("The offsite is on November 14, 2026 at the lodge.")]).toolCalls[0]).toMatchObject({
      name: "create_event",
      args: { title: "Team offsite", start: "2026-11-14", all_day: true, email_id: "e1" },
    });
    expect(mockAgentTurn([user, open, read("See you then.", "Dentist 2026-03-05")]).toolCalls[0]).toMatchObject({ name: "create_event", args: { start: "2026-03-05" } });
    expect(mockAgentTurn([user, open, read("Agenda moved to 3/7/2027.")]).toolCalls[0]).toMatchObject({ name: "create_event", args: { start: "2027-03-07" } });
    const none = mockAgentTurn([user, open, read("Thanks for coming by.")]);
    expect(none.toolCalls).toEqual([]);
    expect(none.text).toMatch(/couldn't find a date/i);
  });

  it("/reply still drafts a reply to the open email with the instructions", () => {
    const user: AgentMessage = { role: "user", content: findCommand("reply")!.expand("say yes, from my phone") };
    expect(mockAgentTurn([user]).toolCalls[0].name).toBe("current_view");
    expect(mockAgentTurn([user, open]).toolCalls[0]).toMatchObject({ name: "draft", args: { kind: "reply", email_id: "e1", instructions: "say yes, from my phone." } });
  });

  it("/unsubscribe still checks the sender", () => {
    const t = mockAgentTurn([{ role: "user", content: findCommand("unsubscribe")!.expand("news.example.com") }]);
    expect(t.toolCalls[0]).toMatchObject({ name: "check_unsubscribe", args: { from: "news.example.com" } });
  });

  it("ignores queued notes in front of the prompt", () => {
    const t = mockAgentTurn([{ role: "user", content: `[zMail: Rule saved: Trash new mail from amazon.com]\n\n${findCommand("summarize")!.expand("")}` }]);
    expect(t.toolCalls[0].name).toBe("current_view");
  });
});

describe("mock agent with Draft-with-AI requests", () => {
  const text = [
    "Draft a new email.",
    "To: Anne Grant <anne@example.org>",
    "Cc: Antony Jo <antony@example.org>",
    "Request: ask about the NSF final annual report",
    "If it mentions other emails, find and read them first. Ask me if anything is unclear; otherwise open the draft.",
  ].join("\n");
  const user: AgentMessage = { role: "user", content: text };

  it("searches first, then drafts a new email to the To and Cc addresses", () => {
    expect(mockAgentTurn([user]).toolCalls[0]).toMatchObject({ name: "search_mail", args: { query: { words: expect.stringContaining("nsf") } } });
    const search = tool("search_mail", { set_id: "s1", count: 1, label: "x", sample: [{ id: "e1", subject: "NSF final outcomes due" }] });
    const t = mockAgentTurn([user, search]);
    expect(t.toolCalls[0]).toMatchObject({ name: "draft", args: { kind: "new", to: "anne@example.org", cc: "antony@example.org" } });
    expect(String(t.toolCalls[0].args?.instructions)).toContain("NSF final outcomes due");
  });

  it("drafts a reply or reply-all to the named email", () => {
    const reply = mockAgentTurn([{ role: "user", content: 'Draft a reply to email id e9 (from Jen Park, subject "Hi").\nRequest: say yes' }]);
    expect(reply.toolCalls[0]).toMatchObject({ name: "draft", args: { kind: "reply", email_id: "e9", instructions: "say yes" } });
    const all = mockAgentTurn([{ role: "user", content: 'Draft a reply-all to email id e9 (from Jen Park, subject "Hi").\nRequest: say yes' }]);
    expect(all.toolCalls[0]).toMatchObject({ name: "draft", args: { kind: "reply_all", email_id: "e9" } });
  });
});

describe("mock agent draft bodies and edits", () => {
  it("a new draft carries a body and subject", () => {
    const t = mockAgentTurn([{ role: "user", content: "Draft a new email.\nRequest: go on" }]);
    expect(t.toolCalls[0]).toMatchObject({ name: "draft", args: { kind: "new", subject: expect.any(String), body: expect.stringContaining("go on") } });
  });

  it("fix X to Y in the draft reads the draft, then edits it", () => {
    const user: AgentMessage = { role: "user", content: "fix NHS to NSF in the draft" };
    expect(mockAgentTurn([user]).toolCalls[0].name).toBe("current_view");
    const view = tool("current_view", { open_email: null, compose: { to: "", cc: "", subject: "NHS report", body: "The NHS report is due." } });
    expect(mockAgentTurn([user, view]).toolCalls[0]).toMatchObject({ name: "edit_draft", args: { subject: "NSF report", body: "The NSF report is due." } });
    const none = mockAgentTurn([user, tool("current_view", { open_email: null, compose: null })]);
    expect(none.toolCalls).toEqual([]);
  });
});
