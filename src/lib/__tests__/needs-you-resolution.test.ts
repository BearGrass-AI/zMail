// @vitest-environment jsdom
// What leaves Needs you without leaving the inbox: a section that keeps its urgent mail,
// Done, aging out, and replying (from zMail or from anywhere else).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";
import type { MailSection } from "@/lib/sections";
import type { DateFind } from "@/lib/ai/dates";
import type { SendRequest } from "@/lib/mail/provider";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:SENT", accountId: "g", name: "Sent", system: "sent" },
  { id: "g:DRAFT", accountId: "g", name: "Drafts", system: "drafts" },
];
const DAY = 864e5;
const row = (id: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date: new Date().toISOString(), unread: true, starred: false, labels: ["INBOX"], ...over }) as Email;
const needs = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { emailId: id, bucket: "needs_you" } as Triage]));
const bills: MailSection = { id: "sec-bills", name: "Bills", description: "Bills", icon: "credit-card", hue: 150, accountIds: [], dates: true };

const sent: SendRequest[] = [];
const reads: { ids: string[]; read: boolean }[] = [];
const fake = {
  account: gmail,
  batchSize: 50,
  listFolders: async () => folders,
  listMessages: async () => [] as Email[],
  batchSetRead: async (ids: string[], read: boolean) => (reads.push({ ids, read }), { skipped: [], failed: [] }),
  getMessage: async (id: string) => row(id),
  send: async (msg: SendRequest) => void sent.push(msg),
};

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: () => fake,
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ai/triage")>()), triageAll: async () => ({ done: 0, failed: 0 }) }));
const toasts: { title: string; opts?: { action?: { onClick: () => void } } }[] = [];
vi.mock("sonner", () => {
  const t = (title: string, opts?: object) => (toasts.push({ title, opts }), toasts.length);
  t.error = t;
  t.success = t;
  return { toast: t };
});

const { ageOutIds, homeGroups, inNeedsYou, repliedIds, selectHome, snapshot, useMail } = await import("@/lib/store");
const { RESULTS_CAP, restore } = await import("@/lib/store/persistence");
const { emailActions } = await import("@/components/email-actions");
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A plain state for the pure helpers. */
const base = (emails: Email[], over: object = {}) => ({
  emails,
  folders,
  snoozed: {},
  triage: needs(...emails.map((e) => e.id)),
  overrides: {},
  resolved: {},
  sections: [] as MailSection[],
  sectionOverrides: {},
  dateFinds: {} as Record<string, DateFind[]>,
  accounts: [gmail],
  ...over,
});

describe("inNeedsYou", () => {
  const e = row("a");
  it("is false for section mail when the section's switch is off, true when it's on", () => {
    expect(inNeedsYou(base([e], { sections: [bills], sectionOverrides: { a: "sec-bills" } }), e)).toBe(false);
    expect(inNeedsYou(base([e], { sections: [{ ...bills, urgentInNeedsYou: true }], sectionOverrides: { a: "sec-bills" } }), e)).toBe(true);
  });

  it("is false once resolved, and true for urgent mail in no section", () => {
    expect(inNeedsYou(base([e], { resolved: { a: { at: 1, why: "done" } } }), e)).toBe(false);
    expect(inNeedsYou(base([e]), e)).toBe(true);
    expect(inNeedsYou(base([e], { triage: {}, overrides: { a: "worth_skim" } }), e)).toBe(false);
  });
});

describe("ageOutIds", () => {
  const now = new Date(2026, 9, 13, 12).getTime();
  const due = (date: string, kind: DateFind["kind"] = "due"): DateFind[] => [{ title: "Payment", date, kind, quote: "" }];
  const ago = (days: number) => new Date(now - days * DAY).toISOString();

  it("takes due-date mail out the day after its date, the rest after 14 days", () => {
    const emails = [row("yesterday"), row("today"), row("old", { date: ago(15) }), row("recent", { date: ago(13) }), row("deadline", { date: ago(20) }), row("done", { date: ago(15) })];
    const s = base(emails, {
      dateFinds: { yesterday: due("2026-10-12"), today: due("2026-10-13"), deadline: [...due("2026-10-01"), ...due("2026-10-20", "deadline")] },
      resolved: { done: { at: 1, why: "done" } },
    });
    expect(ageOutIds(s, now)).toEqual(["yesterday", "old"]);
  });

  it("goes by arrival when the only date found is an event", () => {
    const s = base([row("party", { date: ago(15) })], { dateFinds: { party: due("2026-10-30", "event") } });
    expect(ageOutIds(s, now)).toEqual(["party"]);
  });
});

describe("repliedIds", () => {
  const t = (d: number) => new Date(Date.now() - d * DAY).toISOString();

  it("finds Needs-you mail whose thread's newest message is yours", () => {
    const s = base([
      row("asked", { threadId: "t1", date: t(3) }),
      row("mine", { threadId: "t1", date: t(1), folderId: "g:SENT", from: { name: "Z", address: "Z@gmail.com" } }),
      row("other", { threadId: "t2", date: t(3) }),
      row("their-reply", { threadId: "t2", date: t(1) }),
      row("drafted", { threadId: "t3", date: t(3) }),
      row("draft", { threadId: "t3", date: t(1), folderId: "g:DRAFT", from: { name: "Z", address: "z@gmail.com" } }),
    ]);
    expect(repliedIds(s)).toEqual(["asked"]);
  });

  // The From header is the sender's to write: only mail the provider filed as sent counts as your reply.
  it("ignores a newer message that claims to be from you but wasn't sent from your account", () => {
    const spoof = { name: "Z", address: "z@gmail.com" };
    const s = base([
      row("asked", { threadId: "t1", date: t(3) }),
      row("spoof-inbox", { threadId: "t1", date: t(1), from: spoof }),
      row("asked2", { threadId: "t2", date: t(3) }),
      row("spoof-spam", { threadId: "t2", date: t(1), folderId: "g:SPAM", labels: ["SPAM"], from: spoof }),
    ]);
    expect(repliedIds(s)).toEqual([]);
  });

  it("counts a Gmail reply by its SENT label even when it's filed under another label", () => {
    const s = base([row("asked", { threadId: "t1", date: t(3) }), row("mine", { threadId: "t1", date: t(1), folderId: "g:Label_1", labels: ["SENT", "Label_1"], from: { name: "Z", address: "z@gmail.com" } })]);
    expect(repliedIds(s)).toEqual(["asked"]);
  });

  it("does not trust a SENT label on an Outlook message (categories come from mail)", () => {
    const outlook = { id: "o", kind: "m365" as const, name: "Outlook", address: "z@example.org" };
    const of: Folder[] = [...folders, { id: "o:INBOX", accountId: "o", name: "Inbox", system: "inbox" }, { id: "o:SENT", accountId: "o", name: "Sent Items", system: "sent" }];
    const me = { name: "Z", address: "z@example.org" };
    const s = base(
      [
        row("asked", { accountId: "o", threadId: "t1", folderId: "o:INBOX", date: t(3) }),
        row("fake", { accountId: "o", threadId: "t1", folderId: "o:INBOX", labels: ["SENT"], date: t(1), from: me }),
        row("asked2", { accountId: "o", threadId: "t2", folderId: "o:INBOX", date: t(3) }),
        row("mine", { accountId: "o", threadId: "t2", folderId: "o:SENT", labels: [], date: t(1), from: me }),
      ],
      { folders: of, accounts: [gmail, outlook] },
    );
    expect(repliedIds(s)).toEqual(["asked2"]);
  });
});

beforeEach(async () => {
  if (!useMail.getState().accounts.length) await useMail.getState().load();
  sent.length = 0;
  reads.length = 0;
  toasts.length = 0;
  useMail.setState({ folders, emails: [row("a"), row("b")], triage: needs("a", "b"), overrides: {}, resolved: {}, sections: [], sectionOverrides: {}, lessons: [], checked: new Set() });
});

const needsIds = () => homeGroups(selectHome(useMail.getState())).needs.map((e) => e.id);

describe("Done", () => {
  it("takes it out of Needs you, marks it read, teaches nothing, and Undo puts it back", async () => {
    emailActions().done(["a"]);
    const s = useMail.getState();
    expect(s.resolved.a.why).toBe("done");
    expect(needsIds()).toEqual(["b"]);
    expect(s.emails.find((e) => e.id === "a")!.unread).toBe(false);
    await flush();
    expect(reads).toEqual([{ ids: ["a"], read: true }]);
    expect(s.lessons).toEqual([]);
    expect(s.overrides).toEqual({});
    expect(toasts.at(-1)!.title).toBe("Done");
    toasts.at(-1)!.opts!.action!.onClick();
    expect(useMail.getState().resolved).toEqual({});
    expect(needsIds()).toEqual(["a", "b"]);
  });

  it("says how many, and a re-sort that calls it urgent again doesn't bring it back", () => {
    emailActions().done(["a", "b"]);
    expect(toasts.at(-1)!.title).toBe("Done · 2");
    useMail.setState({ triage: { a: { emailId: "a", bucket: "needs_you", urgency: 1 } as Triage, b: { emailId: "b", bucket: "needs_you" } as Triage } });
    expect(needsIds()).toEqual([]);
    expect(homeGroups(selectHome(useMail.getState())).skim.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("replying", () => {
  it("resolves the email and earlier Needs-you mail in its thread, not newer mail", async () => {
    const t = (d: number) => new Date(Date.now() + d * DAY).toISOString();
    const emails = [
      row("later", { threadId: "t", date: t(1) }),
      row("asked", { threadId: "t", date: t(-1) }),
      row("earlier", { threadId: "t", date: t(-2) }),
      row("elsewhere", { threadId: "u", date: t(-2) }),
    ];
    useMail.setState({ emails, triage: needs("later", "asked", "earlier", "elsewhere") });
    await useMail.getState().send("g", { to: ["a@x.com"], subject: "Re: asked", text: "Yes", replyTo: emails[1] });
    expect(sent).toHaveLength(1);
    const r = useMail.getState().resolved;
    expect(Object.keys(r).sort()).toEqual(["asked", "earlier"]);
    expect(r.asked.why).toBe("replied");
    expect(needsIds().sort()).toEqual(["elsewhere", "later"]);
    // Replying marks nothing read.
    expect(reads).toEqual([]);
  });

  it("a send without replyTo resolves nothing", async () => {
    await useMail.getState().send("g", { to: ["a@x.com"], subject: "Hi", text: "Hi" });
    expect(useMail.getState().resolved).toEqual({});
  });
});

describe("persistence", () => {
  // Real ids name no account: Gmail's are hex, Graph's long base64.
  const gmailId = (n: number) => `18f3a2b4c5d${n.toString(16).padStart(5, "0")}`;
  const graphId = "AAMkAGI2NGVhZTVlLTI1OGMtNDI4My1iZmE5LTA1OGI2NjQ3ZDlmNQBGAAAAAAC7BXHQwz9vQ6bLtd6WsxYgBwBkU3bMTmV1Sp9t4lZvYcvGAAAm3Xj1AAA=";

  it("round-trips resolved through the snapshot, keeping results for mail that isn't loaded", () => {
    const resolved = { [gmailId(1)]: { at: 5, why: "aged" as const }, [gmailId(2)]: { at: 6, why: "done" as const }, [graphId]: { at: 7, why: "replied" as const } };
    useMail.setState({ emails: [row(gmailId(1))], resolved });
    const snap = snapshot(useMail.getState());
    expect(snap.resolved).toEqual(resolved);
    useMail.setState({ resolved: {} });
    restore(snap, new Map());
    expect(useMail.getState().resolved).toEqual(resolved);
  });

  it("keeps saved triage and resolved bounded: loaded mail, plus the most recent of the rest", () => {
    const loaded = gmailId(0);
    const others = Array.from({ length: RESULTS_CAP + 50 }, (_, i) => gmailId(i + 1));
    useMail.setState({
      emails: [row(loaded)],
      // The loaded one first (oldest): kept anyway.
      resolved: Object.fromEntries([loaded, ...others].map((id, at) => [id, { at, why: "done" as const }])),
      triage: needs(loaded, ...others),
    });
    const snap = snapshot(useMail.getState());
    for (const kept of [snap.resolved, snap.triage]) {
      expect(Object.keys(kept)).toEqual([loaded, ...others.slice(-RESULTS_CAP)]);
    }
  });
});
