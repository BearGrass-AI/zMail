// @vitest-environment jsdom
// Today's J/K order: emails opened during a visit hold their place, so K goes back; a new visit re-sorts.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

import { orderedEmails, useMail } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import type { Email } from "@/lib/types";

const mk = (id: string, unread: boolean) => ({ id, accountId: "g", folderId: "g:INBOX", unread, date: 1 }) as unknown as Email;
const ids = () => orderedEmails(useMail.getState()).map((e) => e.id);

beforeEach(() => {
  useSettings.setState({ todayShow: "all" });
  useMail.setState({
    view: { kind: "brief" },
    selectedId: null,
    todayKept: new Set(),
    accountFilter: null,
    query: "",
    snoozed: {},
    compose: null,
    composeDirty: false,
    folders: [{ id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" }] as never,
    emails: [mk("A", true), mk("B", true), mk("C", false)],
    triage: { A: { bucket: "needs_you" }, B: { bucket: "needs_you" }, C: { bucket: "needs_you" } } as never,
    overrides: {},
    sections: [],
    sectionOverrides: {},
  });
  // Opening marks mail read through the provider; here just flip the flag.
  useMail.setState({ setRead: (async (rids: string[]) => useMail.setState((s) => ({ emails: s.emails.map((e) => (rids.includes(e.id) ? { ...e, unread: false } : e)) }))) as never });
});

describe("Today J/K order", () => {
  it("keeps an opened email in place so K can go back to it", () => {
    useMail.getState().select("A");
    useMail.getState().select("B");
    expect(ids()).toEqual(["A", "B", "C"]);
  });

  it("re-sorts on the next visit", () => {
    useMail.setState((st) => ({ emails: st.emails.map((e) => (e.id === "C" ? { ...e, unread: true } : e)) }));
    useMail.getState().select("A");
    useMail.getState().select("B");
    expect(ids()).toEqual(["A", "B", "C"]);
    useMail.getState().setView({ kind: "inbox" });
    useMail.getState().setView({ kind: "brief" });
    expect(ids()).toEqual(["C", "A", "B"]);
  });

  it("ends the visit when the Unread / All switch changes", () => {
    useMail.getState().select("A");
    useSettings.setState({ todayShow: "unread" });
    expect(useMail.getState().todayKept.size).toBe(0);
  });
});
