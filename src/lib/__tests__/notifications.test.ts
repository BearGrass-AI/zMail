// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { badgeCount, inQuietHours, ownAddresses, planBanners, qualifies, type NotifySlice, type QualifyCtx } from "@/lib/notifications";
import type { NotificationPrefs } from "@/lib/settings";
import type { Bucket, Email, Folder, Triage } from "@/lib/types";

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  level: "needs",
  preview: true,
  skipWhenFocused: true,
  sound: false,
  badge: "needs",
  quiet: { on: false, from: "18:00", to: "07:00", weekends: "all" },
  mutedAccounts: [],
  asked: false,
  ...over,
});

const quiet = (over: Partial<NotificationPrefs["quiet"]> = {}) => ({ on: true, from: "18:00", to: "07:00", weekends: "same" as const, ...over });
/** 2026-10-14 is a Wednesday; 2026-10-17 a Saturday. Local time. */
const at = (hhmm: string, day = 14) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 9, day, h, m);
};

const NOW = Date.parse("2026-10-14T12:00:00Z");
const folders: Folder[] = [
  { id: "a:inbox", accountId: "a", name: "Inbox", system: "inbox" },
  { id: "a:archive", accountId: "a", name: "Archive", system: "archive" },
];
const mail = (id: string, over: Partial<Email> = {}) =>
  ({
    id,
    accountId: "a",
    threadId: id,
    folderId: "a:inbox",
    from: { name: `Sender ${id}`, address: `${id}@example.com` },
    to: [],
    subject: `Subject ${id}`,
    snippet: `Snippet ${id}`,
    text: "",
    date: new Date(NOW).toISOString(),
    unread: true,
    starred: false,
    labels: [],
    ...over,
  }) as Email;
const tri = (id: string, bucket: Bucket) => ({ emailId: id, bucket }) as Triage;
const slice = (emails: Email[], buckets: Record<string, Bucket>, over: Partial<NotifySlice> = {}): NotifySlice => ({
  emails,
  folders,
  snoozed: {},
  overrides: {},
  resolved: {},
  sections: [],
  sectionOverrides: {},
  triage: Object.fromEntries(Object.entries(buckets).map(([id, b]) => [id, tri(id, b)])),
  ...over,
});
const ctx = (s: NotifySlice, over: Partial<QualifyCtx> = {}): QualifyCtx => ({
  s,
  prefs: prefs(),
  own: ownAddresses([{ address: "Me@Example.org" }]),
  since: NOW - 15 * 60_000,
  ...over,
});

describe("inQuietHours", () => {
  it("is never quiet when off", () => {
    expect(inQuietHours(quiet({ on: false }), at("23:00"))).toBe(false);
    expect(inQuietHours(quiet({ on: false, weekends: "all" }), at("12:00", 17))).toBe(false);
  });

  it("wraps midnight for 18:00–07:00", () => {
    const q = quiet();
    expect(inQuietHours(q, at("17:59"))).toBe(false);
    expect(inQuietHours(q, at("18:00"))).toBe(true);
    expect(inQuietHours(q, at("06:59"))).toBe(true);
    expect(inQuietHours(q, at("07:00"))).toBe(false);
  });

  it("handles a same-day range", () => {
    const q = quiet({ from: "12:00", to: "13:30" });
    expect(inQuietHours(q, at("11:59"))).toBe(false);
    expect(inQuietHours(q, at("12:00"))).toBe(true);
    expect(inQuietHours(q, at("13:29"))).toBe(true);
    expect(inQuietHours(q, at("13:30"))).toBe(false);
  });

  it("is quiet all weekend day with weekends: all", () => {
    expect(inQuietHours(quiet({ weekends: "all" }), at("12:00", 17))).toBe(true);
  });

  it("uses the same hours on weekends with weekends: same", () => {
    expect(inQuietHours(quiet({ weekends: "same" }), at("12:00", 17))).toBe(false);
    expect(inQuietHours(quiet({ weekends: "same" }), at("20:00", 17))).toBe(true);
  });

  it("is never quiet when from equals to", () => {
    expect(inQuietHours(quiet({ from: "09:00", to: "09:00" }), at("09:00"))).toBe(false);
  });
});

describe("qualifies", () => {
  it("passes new unread Needs-you inbox mail", () => {
    const e = mail("1");
    expect(qualifies(e, ctx(slice([e], { "1": "needs_you" })))).toBe(true);
  });

  it("rejects read mail", () => {
    const e = mail("1", { unread: false });
    expect(qualifies(e, ctx(slice([e], { "1": "needs_you" })))).toBe(false);
  });

  it("rejects mail outside the inbox", () => {
    const e = mail("1", { folderId: "a:archive" });
    expect(qualifies(e, ctx(slice([e], { "1": "needs_you" })))).toBe(false);
  });

  it("rejects snoozed mail", () => {
    const e = mail("1");
    expect(qualifies(e, ctx(slice([e], { "1": "needs_you" }, { snoozed: { "1": Date.now() + 3_600_000 } })))).toBe(false);
  });

  it("rejects the wrong bucket, and Worth a skim unless widened", () => {
    const e = mail("1");
    expect(qualifies(e, ctx(slice([e], { "1": "ready_archive" })))).toBe(false);
    expect(qualifies(e, ctx(slice([e], { "1": "worth_skim" })))).toBe(false);
    expect(qualifies(e, ctx(slice([e], { "1": "worth_skim" }), { prefs: prefs({ level: "needs_skim" }) }))).toBe(true);
    expect(qualifies(e, ctx(slice([e], {})))).toBe(false);
  });

  it("follows a bucket override", () => {
    const e = mail("1");
    expect(qualifies(e, ctx(slice([e], { "1": "worth_skim" }, { overrides: { "1": "needs_you" } })))).toBe(true);
  });

  it("rejects everything when off", () => {
    const e = mail("1");
    expect(qualifies(e, ctx(slice([e], { "1": "needs_you" }), { prefs: prefs({ level: "off" }) }))).toBe(false);
  });

  it("rejects a muted account", () => {
    const e = mail("1");
    expect(qualifies(e, ctx(slice([e], { "1": "needs_you" }), { prefs: prefs({ mutedAccounts: ["a"] }) }))).toBe(false);
  });

  it("rejects mail from your own address", () => {
    const e = mail("1", { from: { name: "Me", address: "me@EXAMPLE.org" } });
    expect(qualifies(e, ctx(slice([e], { "1": "needs_you" })))).toBe(false);
  });

  it("rejects mail older than the session start", () => {
    const e = mail("1", { date: new Date(NOW - 16 * 60_000).toISOString() });
    expect(qualifies(e, ctx(slice([e], { "1": "needs_you" })))).toBe(false);
    expect(qualifies(mail("2", { date: "not a date" }), ctx(slice([], { "2": "needs_you" })))).toBe(false);
  });

  it("rejects automatic replies", () => {
    const flagged = mail("1", { autoReply: true });
    const prefixed = mail("2", { subject: "Automatic reply: Budget" });
    const s = slice([flagged, prefixed], { "1": "needs_you", "2": "needs_you" });
    expect(qualifies(flagged, ctx(s))).toBe(false);
    expect(qualifies(prefixed, ctx(s))).toBe(false);
  });
});

describe("planBanners", () => {
  it("makes one banner per email with its fields", () => {
    const [n] = planBanners([mail("1")], prefs({ sound: true }));
    expect(n).toEqual({
      id: "1",
      title: "Sender 1",
      subtitle: "Subject 1",
      body: "Snippet 1",
      thread: "a",
      sound: true,
      emailId: "1",
      accountId: "a",
    });
    const [quietNote] = planBanners([mail("1", { subject: "", from: { name: "", address: "x@y.com" } })], prefs({ preview: false }));
    expect(quietNote.body).toBeUndefined();
    expect(quietNote.title).toBe("x@y.com");
    expect(quietNote.subtitle).toBe("(no subject)");
  });

  it("prefixes Worth a skim mail when the level includes it", () => {
    const [n] = planBanners([mail("1")], prefs({ level: "needs_skim" }), new Set(["1"]));
    expect(n.subtitle).toBe("Worth a skim · Subject 1");
  });

  it("makes three banners for three emails", () => {
    const notes = planBanners([mail("1"), mail("2"), mail("3")], prefs());
    expect(notes.map((n) => n.id)).toEqual(["1", "2", "3"]);
  });

  it("makes one summary for four emails", () => {
    const names = ["Sherri Dugan", "Sam Schulz", "Provost's Office", "Dana Lee"];
    const notes = planBanners(names.map((name, i) => mail(String(i), { from: { name, address: `${i}@x.com` } })), prefs());
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toMatch(/^summary-\d+$/);
    expect(notes[0].title).toBe("4 emails need you");
    expect(notes[0].subtitle).toBe("Sherri Dugan, Sam Schulz, Provost's Office and 1 more");
    expect(notes[0].body).toBe("Click to see them in zMail");
    expect(notes[0].emailId).toBeUndefined();
  });

  it("names each sender once", () => {
    const from = (name: string) => ({ from: { name, address: `${name}@x.com` } });
    const notes = planBanners([mail("1", from("Sam")), mail("2", from("Sam")), mail("3", from("Ann")), mail("4", from("Sam"))], prefs());
    expect(notes[0].subtitle).toBe("Sam, Ann");
  });

  it("says new emails when Worth a skim is included", () => {
    const notes = planBanners([mail("1"), mail("2"), mail("3"), mail("4"), mail("5")], prefs({ level: "needs_skim", preview: false }));
    expect(notes[0].title).toBe("5 new emails");
    expect(notes[0].body).toBeUndefined();
  });
});

describe("badgeCount", () => {
  const emails = [mail("1"), mail("2"), mail("3", { unread: false }), mail("4", { folderId: "a:archive" }), mail("5")];
  const s = slice(emails, { "1": "needs_you", "2": "needs_you", "3": "needs_you", "4": "needs_you", "5": "worth_skim" });

  it("is undefined for none", () => {
    expect(badgeCount(s, "none")).toBeUndefined();
  });

  it("counts only unread Needs-you inbox mail", () => {
    expect(badgeCount(s, "needs")).toBe(2);
  });

  it("clears at zero", () => {
    expect(badgeCount(slice([mail("1", { unread: false })], { "1": "needs_you" }), "needs")).toBeUndefined();
  });

  it("counts every unread inbox email in unread mode", () => {
    expect(badgeCount(s, "unread")).toBe(3);
  });

  it("leaves out snoozed mail and follows your bucket corrections", () => {
    const t = slice(emails, { "1": "needs_you", "2": "needs_you", "5": "worth_skim" }, {
      snoozed: { "1": Date.now() + 60_000, "2": Date.now() - 60_000 },
      overrides: { "5": "needs_you" },
    });
    expect(badgeCount(t, "needs")).toBe(2);
    expect(badgeCount(t, "unread")).toBe(2);
  });

  it("leaves out mail that's done, aged out or replied to, and mail its section keeps out of Needs you", () => {
    const bills = { id: "sec-bills", name: "Bills", description: "", icon: "credit-card" as const, hue: 150, accountIds: [], dates: false };
    const t = slice(emails, { "1": "needs_you", "2": "needs_you" }, {
      resolved: { "1": { at: 1, why: "done" } },
      sections: [bills],
      sectionOverrides: { "2": "sec-bills" },
    });
    expect(badgeCount(t, "needs")).toBeUndefined();
    expect(qualifies(mail("1"), ctx(t))).toBe(false);
    expect(qualifies(mail("2"), ctx(t))).toBe(false);
    // The section's switch lets its urgent mail through again.
    const on = { ...t, sections: [{ ...bills, urgentInNeedsYou: true }] };
    expect(badgeCount(on, "needs")).toBe(1);
    expect(qualifies(mail("2"), ctx(on))).toBe(true);
  });
});
