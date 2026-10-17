import { describe, expect, it } from "vitest";
import { replyRecipients } from "@/lib/mail/compose-text";
import type { Email } from "@/lib/types";

const c = (address: string) => ({ name: address, address });
const mail = (o: Partial<Email>) => ({ from: c("sam@x.edu"), to: [c("me@example.org"), c("kim@x.edu")], cc: [c("lee@x.edu")], ...o }) as Email;
const mine = ["me@example.org"];

describe("replyRecipients", () => {
  it("reply goes to the sender only", () => {
    expect(replyRecipients(mail({}), mine, false)).toEqual({ to: ["sam@x.edu"], cc: [] });
  });
  it("reply all: sender and other To in To, Cc in Cc, own address removed in any case", () => {
    const e = mail({ to: [c("ME@Example.org"), c("kim@x.edu")], cc: [c("Me@example.org"), c("lee@x.edu")] });
    expect(replyRecipients(e, mine, true)).toEqual({ to: ["sam@x.edu", "kim@x.edu"], cc: ["lee@x.edu"] });
  });
  it("duplicates appear once, first place wins", () => {
    const e = mail({ to: [c("sam@x.edu"), c("kim@x.edu")], cc: [c("KIM@x.edu"), c("lee@x.edu")] });
    expect(replyRecipients(e, mine, true)).toEqual({ to: ["sam@x.edu", "kim@x.edu"], cc: ["lee@x.edu"] });
  });
  it("falls back to the original To when the user wrote the email", () => {
    const e = mail({ from: c("me@example.org"), to: [c("kim@x.edu"), c("pat@x.edu")], cc: [] });
    expect(replyRecipients(e, mine, false)).toEqual({ to: ["kim@x.edu", "pat@x.edu"], cc: [] });
    expect(replyRecipients(e, mine, true)).toEqual({ to: ["kim@x.edu", "pat@x.edu"], cc: [] });
  });
  it("never includes Bcc recipients of the original", () => {
    const e = mail({ bcc: [c("secret@x.edu"), c("kim@x.edu")] });
    const r = replyRecipients(e, mine, true);
    expect([...r.to, ...r.cc]).not.toContain("secret@x.edu");
    expect(replyRecipients(e, mine, false)).toEqual({ to: ["sam@x.edu"], cc: [] });
  });
  it("missing cc gives an empty cc", () => {
    expect(replyRecipients(mail({ cc: undefined }), mine, true).cc).toEqual([]);
  });
});
