// Who you are: your Mac user name first, then the name on mail you sent, then your address, and the
// demo user only when nothing but the demo mailbox is connected.
import { describe, expect, it } from "vitest";
import { deriveMe } from "@/lib/me";
import { ME } from "@/lib/mail/mock-data";
import type { Account, Email } from "@/lib/types";

const outlook = { id: "o", kind: "m365", name: "Outlook", address: "jane.appleseed@example.org" } as Account;
const gmail = { id: "g", kind: "gmail", name: "Gmail", address: "jane@example.com" } as Account;
const demo = { id: "personal", kind: "mock", name: "Personal", address: ME.address } as Account;
const from = (name: string, address: string) => ({ id: name + address, from: { name, address } }) as Email;

describe("who you are", () => {
  it("uses your Mac user name and your first real account's address", () => {
    expect(deriveMe([outlook, gmail], [], "Jane Appleseed")).toEqual({ name: "Jane Appleseed", address: "jane.appleseed@example.org" });
  });

  it("falls back to the name on mail you sent, turning 'Last, First' around", () => {
    const sent = [from("Appleseed, Jane", "Jane.Appleseed@example.org"), from("Appleseed, Jane", "jane@example.com"), from("J", "jane@example.com")];
    expect(deriveMe([outlook, gmail], sent, "").name).toBe("Jane Appleseed");
  });

  it("ignores names on mail from other people", () => {
    expect(deriveMe([outlook], [from("Somebody Else", "other@example.org")], "").name).toBe("Jane Appleseed");
  });

  it("makes a name from your address as a last resort", () => {
    expect(deriveMe([gmail], [], "").name).toBe("Jane");
  });

  it("is the demo user only when just the demo mailbox is connected", () => {
    expect(deriveMe([demo], [], "Jane Appleseed")).toEqual(ME);
    expect(deriveMe([demo, outlook], [], "Jane Appleseed").address).toBe("jane.appleseed@example.org");
  });
});
