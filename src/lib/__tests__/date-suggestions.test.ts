// @vitest-environment jsdom
// Dates without sections: finds show for any mail, and two "Not now"s from one sender turn them off.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

vi.mock("sonner", () => ({ toast: vi.fn() }));

const inbox: Folder = { id: "p:INBOX", accountId: "p", name: "Inbox", system: "inbox" };
const future = new Date(Date.now() + 5 * 864e5);
const date = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
const mail = (id: string, from = "a@x.com"): Email =>
  ({ id, accountId: "p", threadId: id, folderId: inbox.id, from: { name: "A", address: from }, to: [], subject: "S", snippet: "", text: "", date: new Date().toISOString(), unread: false, starred: false, labels: [] }) as unknown as Email;
const find = { title: "Pay", date, kind: "deadline" as const, quote: "q" };

const fresh = async () => {
  vi.resetModules();
  return await import("@/lib/store");
};

async function setup(extra: Record<string, unknown> = {}) {
  const m = await fresh();
  m.useMail.setState({
    emails: [mail("e1"), mail("e2")],
    folders: [inbox],
    accounts: [{ id: "p", kind: "gmail", name: "G", address: "z@gmail.com" }] as never,
    dateFinds: { e1: [find], e2: [{ ...find, title: "Other" }] },
    sections: [],
    noDateSenders: {},
    ...extra,
  });
  return m;
}

beforeEach(() => vi.clearAllMocks());

describe("date suggestions without sections", () => {
  it("returns finds from non-section mail, with no sectionId", async () => {
    const { useMail, inboxSuggestions } = await setup();
    const out = inboxSuggestions(useMail.getState());
    expect(out.map((x) => x.emailId).sort()).toEqual(["e1", "e2"]);
    expect(out[0].sectionId).toBeUndefined();
  });

  it("hides finds from senders in noDateSenders", async () => {
    const { useMail, inboxSuggestions } = await setup({ noDateSenders: { "a@x.com": true } });
    expect(inboxSuggestions(useMail.getState())).toEqual([]);
  });

  it("hides finds when the section has dates off", async () => {
    const { useMail, inboxSuggestions } = await setup();
    const id = useMail.getState().addSection({ name: "Bills", icon: "receipt", hue: 150, dates: false, accountIds: [] } as never);
    useMail.getState().setSection(["e1"], id);
    expect(inboxSuggestions(useMail.getState()).map((x) => x.emailId)).toEqual(["e2"]);
  });
});

describe("what hides finds", () => {
  it("hides non-section finds when the find-dates switch is off, but keeps section finds with dates on", async () => {
    const { useMail, inboxSuggestions } = await setup();
    const id = useMail.getState().addSection({ name: "Bills", icon: "receipt", hue: 150, dates: true, accountIds: [] } as never);
    useMail.getState().setSection(["e1"], id);
    expect(inboxSuggestions(useMail.getState(), false).map((x) => x.emailId)).toEqual(["e1"]);
    expect(inboxSuggestions(useMail.getState(), true).map((x) => x.emailId).sort()).toEqual(["e1", "e2"]);
  });

  it("reads the switch from settings by default", async () => {
    const { useMail, inboxSuggestions } = await setup();
    const { useSettings } = await import("@/lib/settings");
    useSettings.setState({ findDatesEverywhere: false });
    expect(inboxSuggestions(useMail.getState())).toEqual([]);
    useSettings.setState({ findDatesEverywhere: true });
    expect(inboxSuggestions(useMail.getState())).toHaveLength(2);
  });

  it("hides finds the user has since marked promotions or newsletters", async () => {
    const t = (id: string) => ({ emailId: id, bucket: "worth_skim", category: "transactions", urgency: 0, model: "jev" });
    const { useMail, inboxSuggestions } = await setup({
      triage: { e1: t("e1"), e2: t("e2") },
      categoryOverrides: { e1: "promotions", e2: "newsletters" },
    });
    expect(inboxSuggestions(useMail.getState(), true)).toEqual([]);
    useMail.setState({ categoryOverrides: { e1: "transactions" } });
    expect(inboxSuggestions(useMail.getState(), true).map((x) => x.emailId).sort()).toEqual(["e1", "e2"]);
  });
});

describe("learning from Not now", () => {
  it("does not opt a sender out after two dates from the same email", async () => {
    const { useMail, inboxSuggestions } = await setup({ dateFinds: { e1: [find, { ...find, title: "Second" }] } });
    const list = inboxSuggestions(useMail.getState());
    expect(list).toHaveLength(2);
    for (const x of list) useMail.getState().dismissCalSuggestion(x.id);
    expect(useMail.getState().noDateSenders).toEqual({});
    expect(useMail.getState().dateDismissals["a@x.com"]).toEqual(["e1"]);
  });

  it("adds the sender on the second dismissal, and removeNoDateSender undoes it", async () => {
    const { useMail, inboxSuggestions } = await setup();
    const [a, b] = inboxSuggestions(useMail.getState());
    useMail.getState().dismissCalSuggestion(a.id);
    expect(useMail.getState().noDateSenders).toEqual({});
    expect(useMail.getState().dateDismissals["a@x.com"]).toEqual(["e1"]);
    useMail.getState().dismissCalSuggestion(b.id);
    expect(useMail.getState().noDateSenders).toEqual({ "a@x.com": true });
    useMail.getState().removeNoDateSender("a@x.com");
    expect(useMail.getState().noDateSenders).toEqual({});
    expect(useMail.getState().dateDismissals["a@x.com"]).toEqual([]);
    expect(inboxSuggestions(useMail.getState())).toEqual([]); // both were resolved
  });
});

// An out-of-range time used to throw a RangeError while building suggestions, breaking Today and Calendar.
describe("impossible times", () => {
  it("the parser drops them, so the model's reply yields only real suggestions", async () => {
    const { parseDates } = await import("@/lib/ai/dates");
    const raw = JSON.stringify(["25:00", "12:60", "24:00", "9:30", "23:59"].map((time) => ({ title: `At ${time}`, date, time, kind: "event", quote: "" })));
    const finds = parseDates(raw);
    expect(finds.map((f) => f.time)).toEqual(["09:30", "23:59"]);
    const { useMail, inboxSuggestions } = await setup({ dateFinds: { e1: finds } });
    expect(inboxSuggestions(useMail.getState()).map((x) => x.title)).toEqual(["At 9:30", "At 23:59"]);
  });

  it("a malformed saved find is skipped, and accepting or dismissing the others still works", async () => {
    const bad = [
      { ...find, title: "Late", time: "25:00", kind: "event" as const },
      { ...find, title: "Rolled", time: "24:00", kind: "event" as const },
      { ...find, title: "Nodate", date: "2026-13-45" },
    ];
    const { useMail, inboxSuggestions } = await setup({ dateFinds: { e1: [...bad, find], e2: [{ ...find, title: "Other" }] } });
    const sugs = inboxSuggestions(useMail.getState());
    expect(sugs.map((x) => x.title).sort()).toEqual(["Other", "Pay"]);
    useMail.getState().dismissCalSuggestion(sugs[0].id);
    await useMail.getState().acceptCalSuggestion(sugs[1].id);
    expect(inboxSuggestions(useMail.getState())).toEqual([]);
  });
});
