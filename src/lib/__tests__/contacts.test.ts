// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";

const calls: string[] = [];
let respond: (url: string) => unknown = () => ({});
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    request: async (_m: string, url: string) => {
      calls.push(url);
      const out = respond(url);
      if (out instanceof Error) throw out;
      return out;
    },
  };
});

const { displayName, matchScore, mergePeople, peopleFromMail, searchPeople, GraphPeople, GooglePeople } = await import("@/lib/contacts");
const { mentionQuery, activeMentions, stripMentions } = await import("@/components/mail/people-suggest");
const { draft } = await import("@/lib/ai/generative");

beforeEach(() => {
  calls.length = 0;
  respond = () => ({});
});

const scott = { name: "Scott Hollis", address: "scott.hollis@example.org", source: "directory" as const };

describe("names and matching", () => {
  it("turns directory 'Last, First' into 'First Last'", () => {
    expect(displayName("Hollis, Scott")).toBe("Scott Hollis");
    expect(displayName("Scott Hollis")).toBe("Scott Hollis");
  });

  it("matches the way people type names, including 'hollis, scott'", () => {
    expect(matchScore(scott, "holl")).toBeGreaterThan(0);
    expect(matchScore(scott, "hollis, scott")).toBeGreaterThan(0);
    expect(matchScore(scott, "sc ho")).toBeGreaterThan(matchScore(scott, "ho"));
    expect(matchScore(scott, "scott.h")).toBeGreaterThan(0);
    expect(matchScore(scott, "smith")).toBe(0);
  });

  it("merges duplicates by address and ranks directory over mail on a tie", () => {
    const out = mergePeople("sc", [
      [{ name: "Scott H", address: "SCOTT.HOLLIS@example.org", source: "mail" }],
      [{ ...scott, title: "Director" }],
      [{ name: "Scarlett Ng", address: "s.ng@x.com", source: "mail" }],
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ source: "directory", title: "Director" });
  });

  it("collects people from mail by frequency and skips your own and no-reply addresses", () => {
    const e = (from: string, to: string) => ({ from: { name: from, address: `${from.toLowerCase()}@x.com` }, to: [{ name: "Me", address: to }] }) as Email;
    const people = peopleFromMail([e("Jen", "me@x.com"), e("Jen", "me@x.com"), e("Noreply", "me@x.com"), e("Dana", "me@x.com")], new Set(["me@x.com"]));
    expect(people.map((p) => p.name)).toEqual(["Jen", "Dana"]);
  });
});

describe("providers", () => {
  it("searches the M365 People API and maps titles", async () => {
    respond = () => ({ value: [{ displayName: "Hollis, Scott", jobTitle: "Director", department: "IT", scoredEmailAddresses: [{ address: "scott.hollis@example.org" }] }, { displayName: "Room 101" }] });
    const out = await new GraphPeople({ id: "m1", kind: "m365", name: "Work", address: "z@example.org" }).search("holg");
    expect(decodeURIComponent(calls[0])).toContain('/me/people?$search="holg"');
    expect(out).toEqual([{ name: "Scott Hollis", address: "scott.hollis@example.org", title: "Director", department: "IT", source: "directory" }]);
  });

  it("warms up Google search once, then queries contacts and other contacts", async () => {
    respond = (url) =>
      url.includes("query=holg")
        ? { results: [{ person: { names: [{ displayName: "Scott Hollis" }], emailAddresses: [{ value: "scott@gmail.com" }] } }] }
        : {};
    const g = new GooglePeople({ id: "g1", kind: "gmail", name: "Personal", address: "z@gmail.com" });
    const out = await g.search("holg");
    await g.search("holg");
    expect(calls.filter((u) => u.includes("query=&")).length).toBe(2);
    expect(calls.filter((u) => u.includes("query=holg")).length).toBe(4);
    expect(out.map((p) => p.source)).toEqual(["contacts", "mail"]);
  });

  it("reuses one source per account, so Google warms up once across searches", async () => {
    const accounts = [{ id: "g9", kind: "gmail" as const, name: "Personal", address: "z9@gmail.com" }];
    await searchPeople("hol", accounts, []);
    await searchPeople("holg", accounts, []);
    expect(calls.filter((u) => u.includes("query=&")).length).toBe(2);
  });

  it("memoizes people from mail on the emails array", () => {
    const e = { from: { name: "Jen", address: "jen@x.com" }, to: [] } as unknown as Email;
    const emails = [e];
    const own = new Set(["me@x.com"]);
    expect(peopleFromMail(emails, own)).toBe(peopleFromMail(emails, own));
    expect(peopleFromMail([e], own)).not.toBe(peopleFromMail(emails, own));
  });

  it("a failing account doesn't sink the search", async () => {
    respond = () => new Error("401");
    const accounts = [
      { id: "m1", kind: "m365" as const, name: "Work", address: "z@example.org" },
      { id: "d1", kind: "mock" as const, name: "Demo", address: "demo@x.com" },
    ];
    const out = await searchPeople("dana", accounts, []);
    expect(out[0]).toMatchObject({ name: "Dana Whitfield", title: "Associate CIO" });
  });
});

describe("@mentions", () => {
  it("finds the @query before the caret, including 'Last, First'", () => {
    expect(mentionQuery("Draft an email to @hollis, sc", 29)).toEqual({ start: 18, query: "hollis, sc" });
    expect(mentionQuery("email me@x.com", 14)).toBeNull();
    expect(mentionQuery("to @ ", 5)).toBeNull();
  });

  it("keeps only mentions still in the text and strips the @ for the model", () => {
    const m = [
      { ...scott, role: "to" as const },
      { name: "Dana Whitfield", address: "d@x", source: "directory" as const, role: "cc" as const },
    ];
    const text = "Draft an email to @Scott Hollis to fire him, cc @Dana Whitfield";
    expect(activeMentions(text, m).map((x) => x.name)).toEqual(["Scott Hollis", "Dana Whitfield"]);
    expect(activeMentions("Draft an email to Scott", m)).toEqual([]);
    expect(stripMentions(text, m)).toBe("Draft an email to Scott Hollis to fire him, cc Dana Whitfield");
  });

  it("tells the writing model who the recipients are", async () => {
    let prompt = "";
    const p = { name: "x", complete: async (msgs: { content: string }[]) => ((prompt = msgs[1].content), "Subject: Notice\n\nScott,"), chat: async () => ({ text: "", toolCalls: [] }) };
    await draft(p, "Draft an email to Scott Hollis", { name: "Alex Rivera" }, undefined, [
      { ...scott, title: "Director", department: "IT", role: "to" },
      { name: "Dana Whitfield", address: "d@x", role: "cc" },
    ]);
    expect(prompt).toContain("- To: Scott Hollis (Director, IT)\n- Cc: Dana Whitfield\nAddress the To recipients by first name.");
  });
});
