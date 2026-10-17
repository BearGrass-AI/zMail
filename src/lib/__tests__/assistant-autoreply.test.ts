// @vitest-environment jsdom
// Automatic replies module: reading, validation, the confirm card, and the sign-in-again path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import { runConfirm } from "@/lib/ai/assistant/modules/confirm";
import { useAssistant } from "@/lib/ai/assistant/state";
import type { AutoReplyDeps } from "@/lib/ai/assistant/modules/autoreply";
import { NeedsPermissionError, type AutoReply } from "@/lib/mail/auto-replies";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const ACCOUNTS = [
  { id: "o", address: "alex@example.org", label: "Work", kind: "m365" },
  { id: "g", address: "alex@gmail.com", label: "Personal", kind: "gmail" },
  { id: "n", address: "old@example.org", label: "Old", kind: "m365" },
];

function make(state: Record<string, AutoReply> = {}) {
  const store: Record<string, AutoReply> = {
    o: { enabled: false, message: "<p>Away</p>", audience: "all" },
    g: { enabled: true, start: new Date(2030, 0, 6, 8).getTime(), end: new Date(2030, 0, 10, 17).getTime(), message: "Back soon", audience: "contactsOnly" },
    ...state,
  };
  const set = vi.fn(async (id: string, r: AutoReply) => void (store[id] = r));
  const fake: AutoReplyDeps = {
    accounts: () => ACCOUNTS,
    get: async (id) => {
      if (id === "n") throw new NeedsPermissionError();
      return store[id];
    },
    set,
  };
  return { set, deps: { ext: { autoreply: fake } } as unknown as ToolDeps };
}
const run = (name: string, args: Record<string, unknown>, deps: ToolDeps) => executeTool({ id: "c1", name, args }, deps);
const cards = () => useAssistant.getState().items.flatMap((i) => (i.kind === "card" && i.card.type === "confirm" ? [{ id: i.id, card: i.card }] : []));
const steps = () => useAssistant.getState().items.flatMap((i) => (i.kind === "step" ? [i.text] : []));

beforeEach(() => useAssistant.getState().newChat());

describe("get_auto_reply", () => {
  it("returns every account, with local times, text and the sign-in state", async () => {
    const { deps } = make();
    const r = await run("get_auto_reply", {}, deps);
    expect(r.content).toEqual({
      accounts: [
        { account_id: "o", account: "alex@example.org", enabled: false, message_text: "Away", audience: "all" },
        { account_id: "g", account: "alex@gmail.com", enabled: true, start: "2030-01-06T08:00", end: "2030-01-10T17:00", message_text: "Back soon", audience: "contactsOnly" },
        { account_id: "n", needs_sign_in: true },
      ],
    });
    expect(steps()).toEqual(["Checked automatic replies"]);
  });

  it("reads one account and caps long text", async () => {
    const { deps } = make({ o: { enabled: true, message: "x".repeat(1500), externalMessage: "<p>Outside</p>", audience: "all" } });
    const r = (await run("get_auto_reply", { account_id: "o" }, deps)).content as { accounts: { message_text: string; external_text: string }[] };
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0].message_text.length).toBe(1001);
    expect(r.accounts[0].external_text).toBe("Outside");
  });
});

describe("set_auto_reply validation", () => {
  const malformed = async (args: Record<string, unknown>) => {
    const { deps, set } = make();
    const r = await run("set_auto_reply", args, deps);
    expect(r.malformed, JSON.stringify(args)).toBe(true);
    expect(cards()).toHaveLength(0);
    expect(set).not.toHaveBeenCalled();
  };

  it("rejects bad times, a missing or long message, and bad audiences", async () => {
    await malformed({ account_id: "o", enabled: true, message: "Away", start: "2030-01-06T08:00" });
    await malformed({ account_id: "o", enabled: true, message: "Away", start: "2030-01-06 08:00", end: "2030-01-10T17:00" });
    await malformed({ account_id: "o", enabled: true, message: "Away", start: "2030-01-10T17:00", end: "2030-01-06T08:00" });
    await malformed({ account_id: "o", enabled: true, message: "Away", start: "2020-01-06T08:00", end: "2020-01-10T17:00" });
    await malformed({ account_id: "o", enabled: true });
    await malformed({ account_id: "o", enabled: true, message: "x".repeat(2001) });
    await malformed({ account_id: "o", enabled: true, message: "Away", audience: "everyone" });
  });

  it("treats Outlook-only fields on Gmail as malformed", async () => {
    await malformed({ account_id: "g", enabled: true, message: "Away", external_message: "Out" });
    await malformed({ account_id: "g", enabled: true, message: "Away", audience: "none" });
  });

  it("refuses unknown accounts", async () => {
    const { deps } = make();
    const r = await run("set_auto_reply", { account_id: "zz", enabled: false }, deps);
    expect((r.content as { error: string }).error).toContain('unknown id "zz"');
    expect(cards()).toHaveLength(0);
  });
});

describe("set_auto_reply card", () => {
  it("pushes a turn-on card with the dates, audience and message, changing nothing", async () => {
    const { deps, set } = make();
    const r = await run("set_auto_reply", { account_id: "o", enabled: true, start: "2030-01-07T08:00", end: "2030-01-11T17:00", message: "I'm away.\nAsk Sam.", external_message: "Away this week." }, deps);
    expect(r.content).toEqual({ status: "awaiting_confirmation", note: "A card is waiting for the user's OK. Nothing has changed yet." });
    const [{ card }] = cards();
    expect(card).toMatchObject({ module: "autoreply", action: "set", title: "Turn on automatic replies", detail: "alex@example.org", confirmLabel: "Turn on" });
    const fields = Object.fromEntries((card.preview?.fields ?? []).map((f) => [f.label, f.value]));
    expect(fields.Account).toBe("alex@example.org");
    expect(fields.When).toMatch(/^Mon Jan 7, 8:00\sAM – Fri Jan 11, 5:00\sPM$/);
    expect(fields.Outside).toBe("Different reply");
    expect(card.preview?.body).toContain("I'm away.\nAsk Sam.");
    expect(set).not.toHaveBeenCalled();
  });

  it("runs set with the reply as HTML on confirm", async () => {
    const { deps, set } = make();
    await run("set_auto_reply", { account_id: "o", enabled: true, message: "I'm away.\nAsk <Sam>." }, deps);
    const [{ id, card }] = cards();
    expect(card.preview?.fields).toContainEqual({ label: "When", value: "Until you turn them off" });
    expect(card.preview?.fields).toContainEqual({ label: "Outside", value: "Same reply, everyone" });
    await runConfirm(id, deps);
    expect(set).toHaveBeenCalledWith("o", { enabled: true, message: "I'm away.<br>Ask &lt;Sam&gt;.", audience: "all" });
    expect(cards()[0].card).toMatchObject({ status: "done", result: "Automatic replies on" });
  });

  it("turns off keeping the message, and updates", async () => {
    const { deps, set } = make();
    await run("set_auto_reply", { account_id: "g", enabled: false }, deps);
    const off = cards()[0];
    expect(off.card).toMatchObject({ title: "Turn off automatic replies", confirmLabel: "Turn off" });
    await runConfirm(off.id, deps);
    expect(set).toHaveBeenLastCalledWith("g", { enabled: false, message: "Back soon", audience: "contactsOnly" });
    expect(cards()[0].card.result).toBe("Automatic replies off");

    await run("set_auto_reply", { account_id: "o", enabled: false, message: "New text" }, deps);
    const upd = cards()[1];
    expect(upd.card).toMatchObject({ title: "Update automatic replies", confirmLabel: "Save" });
    await runConfirm(upd.id, deps);
    expect(cards()[1].card.result).toBe("Automatic replies updated");
  });

  it("a Turn off / Save card shows any reply text, audience or dates it saves", async () => {
    const { deps, set } = make();
    // Plain off with nothing else changing: just the account.
    await run("set_auto_reply", { account_id: "o", enabled: false }, deps);
    expect(cards()[0].card.preview).toEqual({ fields: [{ label: "Account", value: "alex@example.org" }] });

    await run("set_auto_reply", { account_id: "o", enabled: false, message: "Planted text", external_message: "Outside text", audience: "contactsOnly", start: "2030-02-01T08:00", end: "2030-02-02T17:00" }, deps);
    const upd = cards()[1];
    expect(upd.card.title).toBe("Update automatic replies");
    expect(upd.card.preview?.body).toContain("Planted text");
    expect(upd.card.preview?.body).toContain("Outside text");
    expect(upd.card.preview?.fields?.find((f) => f.label === "Outside")?.value).toBe("Different reply, only contacts");
    expect(upd.card.preview?.fields?.find((f) => f.label === "When")?.value).toMatch(/Feb 1/);
    await runConfirm(upd.id, deps);
    expect(set).toHaveBeenLastCalledWith("o", expect.objectContaining({ enabled: false, message: "Planted text", audience: "contactsOnly" }));

    // Turning off a scheduled reply clears its dates: the card says so.
    await run("set_auto_reply", { account_id: "g", enabled: false }, deps);
    expect(cards()[2].card.preview?.fields).toContainEqual({ label: "When", value: "No dates" });
    expect(cards()[2].card.preview?.body).toBeUndefined();
  });

  it("tells the model to sign in again when the account lacks the permission", async () => {
    const { deps } = make();
    const r = await run("set_auto_reply", { account_id: "n", enabled: true, message: "Away" }, deps);
    expect(r.content).toEqual({ error: "This account needs to sign in again before zMail can change automatic replies (Settings → Accounts → Edit → Sign in again)." });
    expect(cards()).toHaveLength(0);
  });
});
