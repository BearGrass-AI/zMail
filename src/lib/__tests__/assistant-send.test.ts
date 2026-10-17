// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import { runConfirm } from "@/lib/ai/assistant/modules/confirm";
import { useAssistant } from "@/lib/ai/assistant/state";
import type { SendDeps } from "@/lib/ai/assistant/modules/send";
import type { SendRequest } from "@/lib/mail/provider";
import type { Email } from "@/lib/types";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const mk = (id: string, over: Partial<Email> = {}): Email =>
  ({
    id, accountId: "a1", threadId: "t" + id, folderId: "inbox", from: { name: "Ann", address: "ann@x.com" },
    to: [{ name: "Me", address: "me@x.com" }], cc: [{ name: "Bob", address: "bob@x.com" }], subject: "Lunch", snippet: "", text: "hi",
    date: "2026-10-10T00:00:00Z", unread: true, starred: false, labels: [], ...over,
  }) as Email;

function setup(sendImpl?: () => Promise<void>) {
  const emails: Record<string, Email> = { e1: mk("e1"), e2: mk("e2", { subject: "Re: Plans" }), e3: mk("e3") };
  const send = vi.fn(sendImpl ?? (async () => {}));
  const schedule = vi.fn(async () => ({}));
  const sd: SendDeps = {
    signatureFor: () => "<p>Alex<br>CIO</p>",
    ownAddresses: () => ["me@x.com"],
    finishHtml: async (html) => ({ html, inline: [] }),
    send,
    schedule,
  };
  const deps = { ext: { send: sd }, getEmail: async (r: { id: string }) => emails[r.id] } as unknown as ToolDeps;
  useAssistant.getState().remember(Object.values(emails).map((e) => ({ id: e.id, accountId: e.accountId })));
  return { deps, send, schedule };
}
const cards = () => useAssistant.getState().items.flatMap((i) => (i.kind === "card" && i.card.type === "confirm" ? [{ id: i.id, card: i.card }] : []));
const call = (deps: ToolDeps, args: Record<string, unknown>) => executeTool({ id: "c1", name: "send_reply", args }, deps);

beforeEach(() => useAssistant.getState().newChat());

describe("send_reply", () => {
  it("pushes a card with recipients, subject and the signature, sending nothing", async () => {
    const { deps, send } = setup();
    const r = await call(deps, { email_id: "e1", body: "Sounds good, thanks" });
    expect(r.content).toMatchObject({ status: "awaiting_confirmation" });
    const [{ card }] = cards();
    expect(card.title).toBe("Reply to Ann");
    expect(card.preview?.fields).toEqual([{ label: "To", value: "ann@x.com" }, { label: "Subject", value: "Re: Lunch" }]);
    expect(card.preview?.body).toContain("Sounds good, thanks");
    expect(card.preview?.body).toContain("Alex");
    expect(card.payload).toEqual({ emailId: "e1", accountId: "a1", body: "Sounds good, thanks", replyAll: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("shows Cc on reply-all, without the user's own address", async () => {
    const { deps } = setup();
    await call(deps, { email_id: "e1", body: "ok", reply_all: true });
    expect(cards()[0].card.preview?.fields).toContainEqual({ label: "Cc", value: "bob@x.com" });
  });

  it("rejects bodies over the limit and unknown ids", async () => {
    const { deps } = setup();
    const r = await call(deps, { email_id: "e1", body: "x".repeat(1501) });
    expect(JSON.stringify(r.content)).toContain("use draft");
    expect(cards()).toHaveLength(0);
    await call(deps, { email_id: "nope", body: "ok" });
    expect(cards()).toHaveLength(0);
  });

  it("makes one pending card per call", async () => {
    const { deps } = setup();
    for (const id of ["e1", "e2", "e3"]) await call(deps, { email_id: id, body: "Thanks" });
    const cs = cards();
    expect(cs).toHaveLength(3);
    expect(cs.every((c) => c.card.status === "pending" && c.card.module === "send" && c.card.action === "send_reply")).toBe(true);
  });
});

describe("send_reply confirm", () => {
  it("builds the SendRequest with threading, one Re:, and the signature", async () => {
    const { deps, send } = setup();
    await call(deps, { email_id: "e2", body: "**Yes**, see you then", reply_all: true });
    await runConfirm(cards()[0].id, deps);
    expect(send).toHaveBeenCalledTimes(1);
    const [acct, msg] = send.mock.calls[0] as unknown as [string, SendRequest];
    expect(acct).toBe("a1");
    expect(msg.to).toEqual(["ann@x.com"]);
    expect(msg.cc).toEqual(["bob@x.com"]);
    expect(msg.subject).toBe("Re: Plans");
    expect(msg.replyTo?.id).toBe("e2");
    expect(msg.html).toContain("Alex");
    expect(msg.html).toContain("<strong>Yes</strong>");
    expect(msg.text).toContain("Alex");
    expect(cards()[0].card).toMatchObject({ status: "done", result: "Sent to Ann" });
  });

  it("keeps a failed card retryable", async () => {
    let fail = true;
    const { deps, send } = setup(async () => {
      if (fail) throw new Error("offline");
    });
    await call(deps, { email_id: "e1", body: "ok" });
    const id = cards()[0].id;
    await runConfirm(id, deps);
    expect(cards()[0].card).toMatchObject({ status: "failed", error: "offline" });
    fail = false;
    await runConfirm(id, deps);
    expect(cards()[0].card.status).toBe("done");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("send_reply send_at", () => {
  // A local "YYYY-MM-DDTHH:mm" two days out at 8:00.
  const twoDaysAt8 = () => {
    const d = new Date();
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2, 8, 0);
    const p = (n: number) => String(n).padStart(2, "0");
    return { at: at.getTime(), text: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T08:00` };
  };

  it("every card offers Send later; send_at makes a Schedule card with the time in the payload", async () => {
    const { deps, send } = setup();
    await call(deps, { email_id: "e1", body: "ok" });
    expect(cards()[0].card.later).toBe(true);
    const { at, text } = twoDaysAt8();
    await call(deps, { email_id: "e3", body: "Sure", send_at: text });
    const card = cards()[1].card;
    expect(card.later).toBe(true);
    expect(card.title).toBe("Schedule reply to Ann");
    expect(card.payload).toMatchObject({ emailId: "e3", sendAt: at });
    expect(card.confirmLabel).toMatch(/^Schedule · /);
    expect(card.preview?.fields?.map((f) => f.label)).toContain("When");
    expect(send).not.toHaveBeenCalled();
  });

  it("treats a malformed or past send_at as a malformed call", async () => {
    const { deps } = setup();
    for (const send_at of ["tomorrow at 8", "2020-01-01T08:00", "2026-02-30T08:00"]) {
      const r = await call(deps, { email_id: "e1", body: "ok", send_at });
      expect(r.malformed).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/send_at must be a future local time/);
    }
    expect(cards()).toHaveLength(0);
  });

  it("confirming a card with sendAt schedules instead of sending", async () => {
    const { deps, send, schedule } = setup();
    const { at, text } = twoDaysAt8();
    await call(deps, { email_id: "e2", body: "Will do", send_at: text });
    await runConfirm(cards()[0].id, deps);
    expect(send).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
    const [acct, msg, when] = schedule.mock.calls[0] as unknown as [string, SendRequest, number];
    expect(acct).toBe("a1");
    expect(msg.subject).toBe("Re: Plans");
    expect(msg.replyTo?.id).toBe("e2");
    expect(when).toBe(at);
    expect(cards()[0].card).toMatchObject({ status: "done", result: expect.stringMatching(/^Scheduled for /) });
  });

  it("a time picked on the card (patched payload) schedules too; without one it sends as before", async () => {
    const { deps, send, schedule } = setup();
    await call(deps, { email_id: "e1", body: "ok" });
    await call(deps, { email_id: "e3", body: "ok" });
    const [a, b] = cards();
    const { at } = twoDaysAt8();
    useAssistant.getState().patchCard(a.id, { payload: { ...(a.card.payload as object), sendAt: at } });
    await runConfirm(a.id, deps);
    await runConfirm(b.id, deps);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(cards()[1].card.result).toBe("Sent to Ann");
  });
});
