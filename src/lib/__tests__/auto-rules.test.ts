import { describe, expect, it } from "vitest";
import type { Email } from "@/lib/types";
import { describeRule, laneFor, normalizeFrom, planRuleRun, ruleMatches, ruleOp, type AutoRule } from "@/lib/rules";

const mail = (over: Partial<Email> = {}) =>
  ({ id: "1", accountId: "a", threadId: "1", folderId: "inbox", from: { name: "A", address: "ship@mail.amazon.com" }, to: [], subject: "Your Order shipped", snippet: "", text: "", date: "2026-02-01T00:00:00Z", unread: true, starred: false, labels: [], ...over }) as Email;
const rule = (over: Partial<AutoRule> = {}): AutoRule => ({ id: "r", match: { from: "amazon.com" }, action: "trash", createdAt: "2026-01-01T00:00:00Z", enabled: true, hits: 0, ...over });
const inbox = () => true;

describe("ruleMatches", () => {
  it("matches an exact address only", () => {
    const r = rule({ match: { from: "ship@mail.amazon.com" } });
    expect(ruleMatches(r, mail(), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ from: { name: "", address: "SHIP@mail.amazon.com.evil.io" } }), inbox)).toBe(false);
    expect(ruleMatches(r, mail({ from: { name: "", address: "other@mail.amazon.com" } }), inbox)).toBe(false);
  });
  it("matches a domain and its subdomains, not look-alikes", () => {
    const r = rule();
    expect(ruleMatches(r, mail({ from: { name: "", address: "a@amazon.com" } }), inbox)).toBe(true);
    expect(ruleMatches(r, mail(), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ from: { name: "", address: "a@notamazon.com" } }), inbox)).toBe(false);
    expect(ruleMatches(r, mail({ from: { name: "", address: "a@amazon.com.evil.io" } }), inbox)).toBe(false);
  });
  it("subjectAny is case-insensitive", () => {
    const r = rule({ match: { from: "amazon.com", subjectAny: ["ORDER", "delivered"] } });
    expect(ruleMatches(r, mail(), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ subject: "Hello" }), inbox)).toBe(false);
  });
  it("subjectAny matches whole words and phrases only", () => {
    const r = rule({ match: { from: "amazon.com", subjectAny: ["order"] } });
    expect(ruleMatches(r, mail({ subject: "Your order has shipped" }), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ subject: "Order #123" }), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ subject: "(order)" }), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ subject: "Border crossing" }), inbox)).toBe(false);
    expect(ruleMatches(r, mail({ subject: "Reordered items" }), inbox)).toBe(false);
    expect(ruleMatches(r, mail({ subject: "orders" }), inbox)).toBe(false);
    const phrase = rule({ match: { from: "amazon.com", subjectAny: ["has shipped"] } });
    expect(ruleMatches(phrase, mail({ subject: "Your order HAS SHIPPED today" }), inbox)).toBe(true);
    expect(ruleMatches(phrase, mail({ subject: "Shipped: socks" }), inbox)).toBe(false);
  });
  it("subjectAny escapes regex characters", () => {
    const r = rule({ match: { from: "amazon.com", subjectAny: ["c++", "50% off", "a.b", "(x"] } });
    expect(ruleMatches(r, mail({ subject: "Learn C++ today" }), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ subject: "Now 50% off everything" }), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ subject: "see a.b now" }), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ subject: "about (x)" }), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ subject: "axb and cxx" }), inbox)).toBe(false);
  });
  it("never touches mail from before the rule", () => {
    expect(ruleMatches(rule(), mail({ date: "2025-12-31T23:59:59Z" }), inbox)).toBe(false);
    expect(ruleMatches(rule(), mail({ date: "2026-01-01T00:00:00Z" }), inbox)).toBe(true);
  });
  it("a move rule only matches mail from the folder's own account", () => {
    const r = rule({ action: { moveTo: "a:Label_1" } });
    expect(ruleMatches(r, mail({ accountId: "a" }), inbox)).toBe(true);
    expect(ruleMatches(r, mail({ accountId: "b" }), inbox)).toBe(false);
    expect(ruleMatches(r, mail({ accountId: "a:x" }), inbox)).toBe(false);
  });
  it("skips non-inbox, partial and disabled", () => {
    expect(ruleMatches(rule(), mail(), () => false)).toBe(false);
    expect(ruleMatches(rule(), mail({ partial: true }), inbox)).toBe(false);
    expect(ruleMatches(rule({ enabled: false }), mail(), inbox)).toBe(false);
  });
});

describe("planRuleRun", () => {
  it("first enabled match wins", () => {
    const a = rule({ id: "a", match: { from: "amazon.com", subjectAny: ["order"] } });
    const b = rule({ id: "b", action: "archive" });
    const off = rule({ id: "off", enabled: false });
    const plan = planRuleRun([off, a, b], [mail({ id: "1" }), mail({ id: "2", subject: "Sale" })], inbox);
    expect(plan.map((p) => [p.rule.id, p.emails.map((e) => e.id)])).toEqual([["a", ["1"]], ["b", ["2"]]]);
  });
});

describe("normalizeFrom", () => {
  it("handles addresses, domains and junk", () => {
    expect(normalizeFrom("  Bob@Example.COM ")).toBe("bob@example.com");
    expect(normalizeFrom("Example.com")).toBe("example.com");
    expect(normalizeFrom("@Example.com")).toBe("example.com");
    expect(normalizeFrom("localhost")).toBeNull();
    expect(normalizeFrom("")).toBeNull();
    expect(normalizeFrom("a b@x.com")).toBeNull();
    expect(normalizeFrom("a@b")).toBeNull();
    expect(normalizeFrom("a@@x.com")).toBeNull();
    expect(normalizeFrom("@")).toBeNull();
  });
});

describe("ruleOp and describeRule", () => {
  it("maps actions to bulk ops", () => {
    expect(ruleOp("trash")).toEqual({ kind: "trash" });
    expect(ruleOp("archive")).toEqual({ kind: "archive" });
    expect(ruleOp("mark_read")).toEqual({ kind: "read", read: true });
    expect(ruleOp({ moveTo: "f" })).toEqual({ kind: "move", folderId: "f" });
  });
  it("describes each action", () => {
    const terms = { from: "amazon.com", subjectAny: ["order", "shipped", "delivered"] };
    expect(describeRule(rule({ match: terms }))).toBe("Trash new mail from amazon.com with “order”, “shipped” or “delivered” in the subject");
    expect(describeRule(rule({ action: "archive" }))).toBe("Archive new mail from amazon.com");
    expect(describeRule(rule({ action: "mark_read", match: { from: "a@b.co", subjectAny: ["x"] } }))).toBe("Mark as read new mail from a@b.co with “x” in the subject");
    expect(describeRule(rule({ action: { moveTo: "f" }, match: { from: "a.com", subjectAny: ["x", "y"] } }), () => "Receipts")).toBe("Move new mail from a.com with “x” or “y” in the subject to Receipts");
    expect(describeRule(rule({ action: { moveTo: "f" } }), () => "Receipts")).toBe("Move new mail from amazon.com to Receipts");
    expect(describeRule(rule({ action: { moveTo: "f" } }))).toBe("Move new mail from amazon.com to a folder");
  });
});

describe("lane rules", () => {
  const lane = (over: Partial<AutoRule> = {}) => rule({ action: { lane: "needs_you" }, ...over });
  it("match mail older than createdAt, by address, domain and subject", () => {
    const old = mail({ date: "2020-01-01T00:00:00Z" });
    expect(ruleMatches(lane(), old, inbox)).toBe(true);
    expect(ruleMatches(rule(), old, inbox)).toBe(false);
    expect(ruleMatches(lane({ match: { from: "ship@mail.amazon.com" } }), old, inbox)).toBe(true);
    expect(ruleMatches(lane({ match: { from: "other@mail.amazon.com" } }), old, inbox)).toBe(false);
    expect(ruleMatches(lane({ match: { from: "amazon.com", subjectAny: ["order"] } }), old, inbox)).toBe(true);
    expect(ruleMatches(lane({ match: { from: "amazon.com", subjectAny: ["refund"] } }), old, inbox)).toBe(false);
    expect(ruleMatches(lane(), old, () => false)).toBe(false);
  });
  it("a lane rule matches a partial email; a trash rule does not", () => {
    const p = mail({ partial: true });
    expect(ruleMatches(lane(), p, inbox)).toBe(true);
    expect(ruleMatches(rule(), p, inbox)).toBe(false);
  });
  it("a disabled lane rule is ignored", () => {
    expect(ruleMatches(lane({ enabled: false }), mail(), inbox)).toBe(false);
    expect(laneFor([lane({ enabled: false })], mail(), inbox)).toBeUndefined();
  });
  it("planRuleRun skips lane rules", () => {
    expect(planRuleRun([lane()], [mail()], inbox)).toEqual([]);
    const plan = planRuleRun([lane(), rule({ id: "t" })], [mail()], inbox);
    expect(plan.map((p) => p.rule.id)).toEqual(["t"]);
  });
  it("describeRule words it", () => {
    expect(describeRule(lane({ match: { from: "jbs@example.org" } }))).toBe("Always put mail from jbs@example.org in Needs you");
    expect(describeRule(lane({ action: { lane: "ready_archive" }, match: { from: "a.com", subjectAny: ["x", "y"] } }))).toBe("Always put mail from a.com with “x” or “y” in the subject in Ready to archive");
  });
  it("laneFor: first matching rule wins", () => {
    const rules = [lane({ id: "1", match: { from: "amazon.com" }, action: { lane: "worth_skim" } }), lane({ id: "2" }), rule({ id: "3" })];
    expect(laneFor(rules, mail(), inbox)).toBe("worth_skim");
    expect(laneFor(rules, mail({ from: { name: "", address: "a@x.com" } }), inbox)).toBeUndefined();
  });
});
