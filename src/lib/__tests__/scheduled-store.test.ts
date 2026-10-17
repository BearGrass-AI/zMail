// @vitest-environment jsdom
// Scheduled send in the store: scheduling saves a draft and persists at once; due mail goes out
// (late ones say so); failures wait 5 minutes; cancel, send now and edit (also mid-run); a draft open
// in the composer waits; removing an account drops its schedules; Outlook's server hold stays off;
// another copy of zMail sharing the saved list can't send the same email; a schedule or cancel that
// can't be saved says so and leaves things as a restart would find them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";
import type { SendRequest } from "@/lib/mail/provider";
import type { ScheduledSend } from "@/lib/mail/scheduled";

const h = vi.hoisted(() => ({
  hold: false,
  kv: new Map<string, unknown>(),
  kvSet: [] as [string, unknown][],
  /** The next scheduled-list save waits for this, then fails if it rejects. */
  nextSet: null as Promise<void> | null,
  toasts: [] as { kind: string; text: string; opts?: { description?: string } }[],
}));

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const outlook = { id: "o", kind: "m365" as const, name: "Work", address: "z@example.org" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:DRAFT", accountId: "g", name: "Drafts", system: "drafts" },
  { id: "o:inbox", accountId: "o", name: "Inbox", system: "inbox" },
];
const row = (id: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "Ann Lee", address: "ann@x.com" }, to: [], subject: id, snippet: "", text: "", date: "2026-01-01T00:00:00Z", unread: false, starred: false, labels: [], ...over }) as Email;

const base = (account: typeof gmail | typeof outlook) => ({
  account,
  batchSize: 50,
  listFolders: async () => folders.filter((f) => f.accountId === account.id),
  listMessages: async () => [] as Email[],
  getAttachment: async () => "",
  forgetDraftQuote: vi.fn(),
});
const gfake = {
  ...base(gmail),
  getMessage: vi.fn(async (id: string) => row(id, { folderId: "g:DRAFT", to: [{ name: "ann@x.com", address: "ann@x.com" }], subject: "Plans", text: "Body" })),
  saveDraft: vi.fn(async (_m: SendRequest, id?: string) => ({ draftId: id ?? "GD1", messageId: "GM1" })),
  sendSavedDraft: vi.fn(async (_id: string) => {}),
  sendDraft: vi.fn(async (_m: SendRequest, _id: string) => {}),
  deleteDraft: vi.fn(async (_id: string) => {}),
  draftIdFor: async (messageId: string) => (messageId === "GM1" ? "GD1" : undefined),
};
const ofake = {
  ...base(outlook),
  getMessage: async (id: string) => row(id, { accountId: "o" }),
  saveDraft: vi.fn(async (_m: SendRequest, id?: string) => ({ draftId: id ?? "OD1", messageId: id ?? "OD1" })),
  sendSavedDraft: vi.fn(async (_id: string) => {}),
  holdOnServer: vi.fn(async (_m: SendRequest, _id: string, _at: number) => {}),
  releaseFromServer: vi.fn(async (_id: string) => {}),
  draftIdFor: async (messageId: string) => messageId,
};

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail, outlook],
  saveRegistry: async () => {},
  calendarProviderFor: (a: { id: string }) => ({ accountId: a.id, nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: (a: { kind: string }) => (a.kind === "gmail" ? gfake : ofake),
}));
vi.mock("@/lib/db", () => ({
  // One saved store, as two copies of zMail would share (copies, like the real database).
  kvGet: async (k: string) => structuredClone(h.kv.get(k) ?? null),
  kvSet: async (k: string, v: unknown) => {
    const gate = h.nextSet;
    h.nextSet = null;
    if (gate) await gate;
    h.kvSet.push([k, v]);
    h.kv.set(k, structuredClone(v));
  },
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
  cacheDeleteAccount: async () => [],
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ai/triage")>()), triageAll: async () => ({ done: 0, failed: 0 }) }));
vi.mock("sonner", () => {
  const t = (text: string, opts?: { description?: string }) => void h.toasts.push({ kind: "plain", text, opts });
  t.error = (text: string, opts?: { description?: string }) => void h.toasts.push({ kind: "error", text, opts });
  t.success = (text: string, opts?: { description?: string }) => void h.toasts.push({ kind: "success", text, opts });
  return { toast: t };
});
// The flag is a constant in the app; here a getter lets one file test both paths.
vi.mock("@/lib/mail/scheduled", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mail/scheduled")>();
  return {
    ...real,
    get OUTLOOK_SERVER_HOLD() {
      return h.hold;
    },
  };
});

// Saved before launch: one for a connected account, one for an account that's gone.
const T0 = new Date(2026, 9, 13, 13, 10).getTime();
const AT8 = new Date(2026, 9, 14, 8, 0).getTime();
const stored = (id: string, accountId: string): ScheduledSend => ({
  id, accountId, draftId: id, messageId: id, sendAt: T0 + 10 * 86_400_000, subject: "Old", to: ["x"], snippet: "", server: false, createdAt: 0,
});
h.kv.set("scheduled.v1", [stored("keep", "g"), stored("gone", "removed-account")]);

const { useMail } = await import("@/lib/store");
const { INSTANCE_ID } = await import("@/lib/mail/scheduled");
const { HttpError } = await import("@/lib/transport");
const msg: SendRequest = { to: ["ann@x.com", "bob@y.com"], subject: "Plans", text: "See you at eight. ".repeat(10) };
const lastSaved = () => h.kvSet.filter(([k]) => k === "scheduled.v1").at(-1)?.[1] as ScheduledSend[] | undefined;
const s = () => useMail.getState();
/** A Gmail record due at 8:00 (draft and message id = `id` unless overridden). */
const due = (id: string, over: Partial<ScheduledSend> = {}): ScheduledSend => ({
  id, accountId: "g", draftId: id, messageId: id, sendAt: AT8, subject: id, to: ["x"], snippet: "", server: false, createdAt: 0, ...over,
});
/** Records in memory and in the saved list, as after launch. */
const put = (scheduled: ScheduledSend[], over: Partial<ReturnType<typeof s>> = {}) => {
  useMail.setState({ scheduled, ...over });
  h.kv.set("scheduled.v1", structuredClone(scheduled));
};
/** A send that finishes when the test says so. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

let restored: ScheduledSend[] = [];
beforeEach(async () => {
  if (!s().accounts.length) {
    await s().load();
    restored = s().scheduled;
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  h.hold = false;
  h.kvSet.length = 0;
  h.nextSet = null;
  h.toasts.length = 0;
  for (const f of [gfake.saveDraft, gfake.sendSavedDraft, gfake.getMessage, ofake.saveDraft, ofake.sendSavedDraft, ofake.holdOnServer, ofake.releaseFromServer]) f.mockClear();
  gfake.sendSavedDraft.mockImplementation(async () => {});
  useMail.setState({ folders, emails: [row("a")], scheduled: [], view: { kind: "inbox" }, compose: null, composeDirty: false, composeCloseAsk: null, selectedId: null });
  h.kv.set("scheduled.v1", []);
});
afterEach(() => vi.useRealTimers());

describe("loading", () => {
  it("restores saved schedules and drops ones whose account is gone", () => {
    expect(restored.map((r) => r.id)).toEqual(["keep"]);
  });
});

describe("scheduleMessage", () => {
  it("saves a draft, builds the record and persists it at once", async () => {
    const r = await s().scheduleMessage("g", msg, AT8);
    expect(gfake.saveDraft).toHaveBeenCalledWith(msg, undefined);
    expect(r).toMatchObject({ id: "GD1", draftId: "GD1", messageId: "GM1", accountId: "g", sendAt: AT8, subject: "Plans", server: false, createdAt: T0 });
    // Names the store's mail knows, else the address.
    expect(r.to).toEqual(["Ann Lee", "bob@y.com"]);
    expect(r.snippet).toBe(msg.text.slice(0, 120));
    expect(s().scheduled).toEqual([r]);
    expect(lastSaved()).toEqual([r]);
  });

  it("reuses the composer's draft and replaces its earlier record", async () => {
    await s().scheduleMessage("g", msg, AT8, { id: "GD1" });
    await s().scheduleMessage("g", { ...msg, subject: "" }, AT8 + 3_600_000, { id: "GD1", emailId: "old-msg" });
    expect(gfake.saveDraft.mock.calls.map((c) => c[1])).toEqual(["GD1", "GD1"]);
    expect(s().scheduled).toHaveLength(1);
    expect(s().scheduled[0]).toMatchObject({ subject: "(no subject)", sendAt: AT8 + 3_600_000 });
  });

  it("refuses a time less than a minute out", async () => {
    await expect(s().scheduleMessage("g", msg, T0 + 30_000)).rejects.toThrow("Pick a time at least a minute from now");
    expect(gfake.saveDraft).not.toHaveBeenCalled();
    expect(s().scheduled).toEqual([]);
  });

  it("OUTLOOK_SERVER_HOLD=false: an Outlook schedule is a local hold", async () => {
    const r = await s().scheduleMessage("o", msg, AT8);
    expect(r.server).toBe(false);
    expect(ofake.holdOnServer).not.toHaveBeenCalled();
  });
});

describe("Outlook server hold (flag forced on: API call shape only, cancel unverified: BACKLOG item 6)", () => {
  it("server hold stays off until BACKLOG item 6 is closed", async () => {
    const real = await vi.importActual<typeof import("@/lib/mail/scheduled")>("@/lib/mail/scheduled");
    expect(real.OUTLOOK_SERVER_HOLD).toBe(false);
  });

  it("calls holdOnServer, leaves the send to the server, and calls releaseFromServer on cancel", async () => {
    h.hold = true;
    const r = await s().scheduleMessage("o", msg, AT8);
    expect(r.server).toBe(true);
    expect(ofake.holdOnServer).toHaveBeenCalledWith(msg, "OD1", AT8);
    vi.setSystemTime(AT8 + 1000);
    await s().runDueScheduled();
    expect(ofake.sendSavedDraft).not.toHaveBeenCalled();
    await s().cancelScheduled(r.id);
    expect(ofake.releaseFromServer).toHaveBeenCalledWith("OD1");
    expect(s().scheduled).toEqual([]);
  });

  it("send now releases it first, then sends the draft", async () => {
    h.hold = true;
    const r = await s().scheduleMessage("o", msg, AT8);
    await s().sendScheduledNow(r.id);
    expect(ofake.releaseFromServer).toHaveBeenCalledWith("OD1");
    expect(ofake.sendSavedDraft).toHaveBeenCalledWith("OD1");
    expect(ofake.releaseFromServer.mock.invocationCallOrder[0]).toBeLessThan(ofake.sendSavedDraft.mock.invocationCallOrder[0]);
  });
});

describe("runDueScheduled", () => {
  it("sends a due one on time, removes it and its draft rows", async () => {
    const r = await s().scheduleMessage("g", msg, AT8);
    useMail.setState({ emails: [row("a"), row("GM1", { folderId: "g:DRAFT" })] });
    vi.setSystemTime(AT8 - 1000);
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).not.toHaveBeenCalled();
    vi.setSystemTime(AT8 + 30_000);
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).toHaveBeenCalledWith(r.draftId);
    expect(s().scheduled).toEqual([]);
    expect(lastSaved()).toEqual([]);
    expect(s().emails.map((e) => e.id)).toEqual(["a"]);
    expect(h.toasts).toContainEqual({ kind: "success", text: "Sent scheduled email", opts: { description: "Plans" } });
  });

  it("a late send (zMail was closed) says when it was due", async () => {
    await s().scheduleMessage("g", msg, AT8);
    vi.setSystemTime(AT8 + 3 * 3_600_000);
    await s().runDueScheduled();
    const t = h.toasts.find((x) => x.kind === "success");
    expect(t?.text.replace(/\s/g, " ")).toBe("Sent 1 scheduled email that was due at 8:00 AM");
  });

  it("a failure records the error and waits 5 minutes before trying again, toasting once", async () => {
    const r = await s().scheduleMessage("g", msg, AT8);
    gfake.sendSavedDraft.mockImplementation(async () => {
      throw new Error("offline");
    });
    vi.setSystemTime(AT8 + 1000);
    await s().runDueScheduled();
    expect(s().scheduled[0]).toMatchObject({ id: r.id, error: "offline", lastTry: AT8 + 1000 });
    expect(lastSaved()?.[0].lastTry).toBe(AT8 + 1000);
    vi.setSystemTime(AT8 + 1000 + 4 * 60_000);
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).toHaveBeenCalledTimes(1);
    vi.setSystemTime(AT8 + 1000 + 5 * 60_000);
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).toHaveBeenCalledTimes(2);
    expect(h.toasts.filter((x) => x.text === "Couldn't send a scheduled email")).toHaveLength(1);
  });

  it("a draft deleted before its time is dropped with a note", async () => {
    await s().scheduleMessage("g", msg, AT8);
    gfake.sendSavedDraft.mockImplementation(async () => {
      throw new HttpError(404, "not found");
    });
    vi.setSystemTime(AT8 + 1000);
    await s().runDueScheduled();
    expect(s().scheduled).toEqual([]);
    expect(h.toasts.map((x) => x.text)).toContain("A scheduled email was deleted before it went out");
  });
});

describe("cancel, send now, edit", () => {
  it("cancelScheduled removes the record and leaves the draft", async () => {
    const r = await s().scheduleMessage("g", msg, AT8);
    await s().cancelScheduled(r.id);
    expect(s().scheduled).toEqual([]);
    expect(lastSaved()).toEqual([]);
    expect(gfake.sendSavedDraft).not.toHaveBeenCalled();
    expect(h.toasts.map((x) => x.text)).toContain("Not scheduled. It's in Drafts.");
  });

  it("a cancel that can't be saved keeps the record and says so (it would come back on restart)", async () => {
    const r = await s().scheduleMessage("g", msg, AT8);
    h.nextSet = Promise.reject(new Error("disk full"));
    await expect(s().cancelScheduled(r.id)).rejects.toThrow("It's still scheduled");
    expect(s().scheduled).toEqual([r]);
    expect(h.kv.get("scheduled.v1")).toEqual([r]);
    expect(h.toasts.map((x) => x.text)).not.toContain("Not scheduled. It's in Drafts.");
    // The next change's save keeps it too.
    const r2 = await s().scheduleMessage("g", msg, AT8, { id: "GD2" });
    expect(lastSaved()).toEqual([r, r2]);
  });

  it("a schedule that can't be saved isn't reported as scheduled", async () => {
    h.nextSet = Promise.reject(new Error("disk full"));
    await expect(s().scheduleMessage("g", msg, AT8)).rejects.toThrow("couldn't save the schedule");
    expect(s().scheduled).toEqual([]);
    expect(h.kv.get("scheduled.v1")).toEqual([]);
  });

  it("removing the last one while Scheduled is open goes back to the inbox", async () => {
    const r = await s().scheduleMessage("g", msg, AT8);
    useMail.setState({ view: { kind: "scheduled" } });
    await s().sendScheduledNow(r.id);
    expect(gfake.sendSavedDraft).toHaveBeenCalledWith("GD1");
    expect(s().view).toEqual({ kind: "inbox" });
  });

  it("editScheduled keeps the record (held) and reopens the draft with its time, fetching a draft that isn't loaded", async () => {
    const r = await s().scheduleMessage("g", msg, AT8);
    await s().editScheduled(r.id);
    expect(s().scheduled).toEqual([{ ...r, editing: true }]);
    expect(lastSaved()).toEqual([{ ...r, editing: true }]);
    expect(gfake.getMessage).toHaveBeenCalledWith("GM1");
    expect(s().compose).toMatchObject({ draft: { id: "GD1", emailId: "GM1" }, fromAccountId: "g", scheduledAt: AT8 });
  });

  it("a record being edited is not due, even with the composer closed", async () => {
    useMail.setState({ scheduled: [{ ...due("D1"), editing: true }] });
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).not.toHaveBeenCalled();
  });

  it("closing the composer without scheduling keeps the schedule and says so", async () => {
    useMail.setState({ scheduled: [due("D1", { sendAt: AT8 + 3_600_000 })] });
    vi.setSystemTime(T0);
    await s().editScheduled("D1");
    s().closeCompose();
    expect(s().compose).toBeNull();
    expect(s().scheduled[0].editing).toBeUndefined();
    expect(h.toasts.map((x) => x.text.replace(/\s/g, " "))).toContain("Still scheduled for Tomorrow 9:00 AM");
  });

  it("scheduling again from the composer replaces the record, without editing or a toast on close", async () => {
    useMail.setState({ scheduled: [due("GD1", { messageId: "GM1" })] });
    await s().editScheduled("GD1");
    vi.setSystemTime(T0);
    await s().scheduleMessage("g", msg, AT8 + 3_600_000, { id: "GD1", emailId: "GM1" });
    s().openCompose(null);
    expect(s().scheduled).toHaveLength(1);
    expect(s().scheduled[0]).toMatchObject({ draftId: "GD1", sendAt: AT8 + 3_600_000 });
    expect(s().scheduled[0].editing).toBeUndefined();
    expect(h.toasts.some((x) => x.text.startsWith("Still scheduled"))).toBe(false);
  });

  it("deleting or sending the draft from the composer removes its record", async () => {
    useMail.setState({ scheduled: [due("D1"), due("D2")] });
    await s().deleteDraft("g", "D1", "D1");
    await s().sendDraft("g", msg, "D2");
    expect(s().scheduled).toEqual([]);
  });

  it("opening a scheduled draft from Drafts behaves like Edit", async () => {
    useMail.setState({ scheduled: [due("GD1", { messageId: "GM1" })], emails: [row("GM1", { folderId: "g:DRAFT" })] });
    s().select("GM1");
    await vi.waitFor(() => expect(s().compose).toMatchObject({ draft: { id: "GD1", emailId: "GM1" }, scheduledAt: AT8 }));
    expect(s().scheduled[0].editing).toBe(true);
  });

  it("an edit that can't open the draft leaves the record schedulable", async () => {
    useMail.setState({ scheduled: [due("D1", { messageId: "missing" })] });
    gfake.getMessage.mockRejectedValueOnce(new Error("gone"));
    await s().editScheduled("D1");
    expect(s().compose).toBeNull();
    expect(s().scheduled).toHaveLength(1);
    expect(s().scheduled[0].editing).toBeUndefined();
    expect(h.toasts.map((x) => x.text)).toContain("Couldn't open the draft");
  });

  it("an edit over a composer with unsaved changes asks first and leaves the record alone until answered", async () => {
    useMail.setState({ scheduled: [due("D1")], compose: { mode: "blank" }, composeDirty: true });
    await s().editScheduled("D1");
    expect(s().composeCloseAsk).not.toBeNull();
    expect(s().compose).toEqual({ mode: "blank" });
    expect(s().scheduled).toEqual([due("D1")]);
    // The composer's Discard: close, then carry on.
    const ask = s().composeCloseAsk!;
    useMail.setState({ composeDirty: false });
    s().openCompose(null);
    ask.then();
    await vi.waitFor(() => expect(s().compose).toMatchObject({ draft: { id: "D1" }, scheduledAt: AT8 }));
    expect(s().scheduled[0].editing).toBe(true);
  });

  it("saving a scheduled Gmail draft keeps its record's message id current", async () => {
    useMail.setState({ scheduled: [due("GD1", { messageId: "GM0" })] });
    await s().saveDraft("g", msg, "GD1");
    expect(s().scheduled[0].messageId).toBe("GM1");
    expect(lastSaved()?.[0].messageId).toBe("GM1");
  });
});

describe("runs that overlap", () => {
  beforeEach(() => vi.setSystemTime(AT8 + 1000));

  it("two concurrent runs send a due email once", async () => {
    put([due("D1")]);
    const d = deferred();
    gfake.sendSavedDraft.mockImplementationOnce(() => d.promise);
    const a = s().runDueScheduled();
    const b = s().runDueScheduled();
    d.resolve();
    await Promise.all([a, b]);
    expect(gfake.sendSavedDraft).toHaveBeenCalledTimes(1);
    expect(s().scheduled).toEqual([]);
  });

  it("cancelling the next one while the first is sending stops it", async () => {
    put([due("D1"), due("D2", { sendAt: AT8 + 1 })]);
    const d = deferred();
    gfake.sendSavedDraft.mockImplementationOnce(() => d.promise);
    const run = s().runDueScheduled();
    await s().cancelScheduled("D2");
    d.resolve();
    await run;
    expect(gfake.sendSavedDraft.mock.calls).toEqual([["D1"]]);
    expect(s().scheduled).toEqual([]);
  });

  it("editing the next one while the first is sending holds it", async () => {
    put([due("D1"), due("D2", { sendAt: AT8 + 1 })]);
    const d = deferred();
    gfake.sendSavedDraft.mockImplementationOnce(() => d.promise);
    const run = s().runDueScheduled();
    await s().editScheduled("D2");
    d.resolve();
    await run;
    expect(gfake.sendSavedDraft.mock.calls).toEqual([["D1"]]);
    expect(s().scheduled).toEqual([{ ...due("D2", { sendAt: AT8 + 1 }), editing: true }]);
  });

  it("send now during a run sends each email once", async () => {
    put([due("D1"), due("D2", { sendAt: AT8 + 1 })]);
    const d = deferred();
    gfake.sendSavedDraft.mockImplementationOnce(() => d.promise);
    const run = s().runDueScheduled();
    await vi.waitFor(() => expect(gfake.sendSavedDraft).toHaveBeenCalledWith("D1"));
    // D1 is the run's; D2 is claimed by send now before the run reaches it.
    await s().sendScheduledNow("D1");
    await s().sendScheduledNow("D2");
    d.resolve();
    await run;
    expect(gfake.sendSavedDraft.mock.calls).toEqual([["D1"], ["D2"]]);
    expect(s().scheduled).toEqual([]);
  });

  it("a draft open in the composer waits (no error) until it closes", async () => {
    put([due("D1")], { compose: { mode: "blank", draft: { id: "D1" } } });
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).not.toHaveBeenCalled();
    expect(s().scheduled).toEqual([due("D1")]);
    useMail.setState({ compose: null });
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).toHaveBeenCalledWith("D1");
    expect(s().scheduled).toEqual([]);
  });
});

describe("another copy of zMail", () => {
  beforeEach(() => vi.setSystemTime(AT8 + 1000));
  const savedList = () => h.kv.get("scheduled.v1") as ScheduledSend[];

  it("doesn't send one that's gone from the saved list, and drops it", async () => {
    useMail.setState({ scheduled: [due("D1")] });
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).not.toHaveBeenCalled();
    expect(s().scheduled).toEqual([]);
  });

  it("doesn't send one another copy claimed under 3 minutes ago", async () => {
    const r = due("D1", { claim: { by: "other", at: AT8 + 1000 - 2 * 60_000 } });
    put([r]);
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).not.toHaveBeenCalled();
    expect(savedList()).toEqual([r]);
    expect(s().scheduled).toHaveLength(1);
    expect(h.toasts).toEqual([]);
  });

  it("sends one whose claim is over 3 minutes old (that copy quit mid-send)", async () => {
    put([due("D1", { claim: { by: "other", at: AT8 + 1000 - 3 * 60_000 - 1 } })]);
    await s().runDueScheduled();
    expect(gfake.sendSavedDraft).toHaveBeenCalledWith("D1");
    expect(s().scheduled).toEqual([]);
    expect(savedList()).toEqual([]);
  });

  it("writes its own claim to the saved list before sending, and clears it if the send fails", async () => {
    put([due("D1"), due("D2", { sendAt: AT8 + 1 })]);
    const atSend: (ScheduledSend | undefined)[] = [];
    gfake.sendSavedDraft.mockImplementationOnce(async (id: string) => void atSend.push(savedList().find((x) => x.id === id)));
    gfake.sendSavedDraft.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await s().runDueScheduled();
    expect(atSend[0]?.claim).toEqual({ by: INSTANCE_ID, at: AT8 + 1000 });
    // D1 sent and removed; D2 failed: its claim is cleared so it can be retried.
    expect(s().scheduled).toEqual([due("D2", { sendAt: AT8 + 1, error: "offline", lastTry: AT8 + 1000 })]);
    expect(savedList()).toEqual(s().scheduled);
  });

  it("a claim waits for an earlier cancel's save, so it can't write the cancelled one back", async () => {
    put([due("D1"), due("D2")]);
    const atSend: ScheduledSend[][] = [];
    gfake.sendSavedDraft.mockImplementationOnce(async () => void atSend.push(structuredClone(savedList())));
    const gate = deferred();
    h.nextSet = gate.promise;
    const cancel = s().cancelScheduled("D2");
    const run = s().runDueScheduled();
    // The cancel's save is slow: lands after the run started.
    await new Promise((r) => setTimeout(r, 0));
    gate.resolve();
    await Promise.all([cancel, run]);
    // Saved while D1 was sending (what a quit mid-send leaves): D2 isn't there to send after a restart.
    expect(atSend).toEqual([[due("D1", { claim: { by: INSTANCE_ID, at: AT8 + 1000 } })]]);
    expect(savedList()).toEqual([]);
  });
});

describe("restart", () => {
  it("brings back what was saved: a kept schedule, not a cancelled one", async () => {
    vi.setSystemTime(T0);
    const kept = await s().scheduleMessage("g", msg, AT8, { id: "K1" });
    const gone = await s().scheduleMessage("g", msg, AT8, { id: "C1" });
    await s().cancelScheduled(gone.id);
    h.nextSet = Promise.reject(new Error("disk full"));
    await expect(s().cancelScheduled(kept.id)).rejects.toThrow();
    // A fresh copy of the store, loading from the same saved data.
    vi.resetModules();
    const fresh = (await import("@/lib/store")).useMail;
    await fresh.getState().load();
    expect(fresh.getState().scheduled).toEqual([kept]);
    expect(s().scheduled).toEqual([kept]);
  });
});

// Last: it removes the Outlook account for the rest of the file.
describe("removeAccount", () => {
  it("drops the account's schedules and says so", async () => {
    useMail.setState({ scheduled: [due("D1"), due("O1", { accountId: "o" }), due("O2", { accountId: "o" })] });
    await s().removeAccount("o");
    expect(s().scheduled.map((r) => r.id)).toEqual(["D1"]);
    expect(lastSaved()?.map((r) => r.id)).toEqual(["D1"]);
    expect(h.toasts.map((x) => x.text)).toContain("Dropped 2 scheduled emails from that account");
  });
});
