// @vitest-environment jsdom
// Teaching a sectioned email "Can go" takes it out of its section, or the section keeps holding it.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { emailActions } from "@/components/email-actions";
import { bucketOf, sectionOf, useMail } from "@/lib/store";
import type { Email, Triage } from "@/lib/types";
import type { MailSection } from "@/lib/sections";

const bills: MailSection = { id: "bills", name: "Bills", description: "bills", icon: "credit-card", hue: 140, accountIds: [], dates: true };
const email = { id: "ck", accountId: "g", folderId: "g:INBOX", from: { name: "Credit Karma", address: "mail@creditkarma.com" }, to: [], subject: "See your progress", snippet: "", text: "", date: "2026-09-24T00:00:00Z", unread: true, starred: false } as unknown as Email;
const triage = { emailId: "ck", bucket: "worth_skim", category: "promotions", urgency: 0, needsReply: 0, section: "bills" } as unknown as Triage;

beforeEach(() => {
  useMail.setState({ emails: [email], sections: [bills], triage: { ck: triage }, overrides: {}, sectionOverrides: {}, categoryOverrides: {} });
});

describe("teach", () => {
  it("Can go also takes it out of its section", () => {
    expect(sectionOf(useMail.getState(), email)?.id).toBe("bills");
    emailActions().teach(["ck"], "ready_archive");
    const s = useMail.getState();
    expect(bucketOf(s, "ck")).toBe("ready_archive");
    expect(sectionOf(s, email)).toBeUndefined();
  });
  it("Needs you keeps its section (shown tagged)", () => {
    emailActions().teach(["ck"], "needs_you");
    expect(sectionOf(useMail.getState(), email)?.id).toBe("bills");
  });
});
