// Reconnect checks who signed in before replacing an account's tokens.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/types";

/** Every native OAuth call, in order. */
const calls: string[] = [];
/** The mailbox the browser sign-in lands on. */
let signedInAs = "";

vi.mock("@/lib/oauth", () => ({
  GOOGLE_SCOPES: ["g"],
  MICROSOFT_SCOPES: ["m"],
  signIn: vi.fn(async (account: string, _config: unknown, loginHint?: string) => {
    calls.push(`signIn:${account}:${loginHint ?? ""}`);
    return "token";
  }),
  signOut: vi.fn(async (account: string) => void calls.push(`signOut:${account}`)),
  moveSignIn: vi.fn(async (from: string, to: string) => void calls.push(`move:${from}->${to}`)),
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => ({ clientId: "cid" }), kvSet: async () => {} }));
vi.mock("@/lib/secrets", () => ({ getSecret: async () => null, setSecret: async () => {} }));
vi.mock("@/lib/google/gmail", () => ({
  GmailProvider: class {
    async profile() {
      return { emailAddress: signedInAs, historyId: "1", messagesTotal: 0 };
    }
  },
}));
vi.mock("@/lib/transport", () => ({
  request: async () => ({ mail: signedInAs, userPrincipalName: signedInAs.replace("@", ".upn@"), displayName: "Z" }),
}));
vi.mock("@/lib/microsoft/throttle", () => ({ graphThrottle: { run: <T>(_id: string, fn: () => Promise<T>) => fn() } }));
const refresh = vi.fn(async () => {});
vi.mock("@/lib/store", () => ({ useMail: { getState: () => ({ refresh, accounts: [] }) } }));

const { reconnect } = await import("@/lib/connect");

const gmail: Account = { id: "gmail-1234abcd", kind: "gmail", name: "Gmail", address: "alex@gmail.com" };
const m365: Account = { id: "m365-1234abcd", kind: "m365", name: "Microsoft 365", address: "someone@example.edu" };

beforeEach(() => {
  calls.length = 0;
  refresh.mockClear();
});

describe("reconnect", () => {
  it("signs in under a temporary id with the address as a hint, then moves the tokens to the account", async () => {
    signedInAs = "Alex@Gmail.com";
    await reconnect(gmail);
    const temp = calls[0].split(":")[1];
    expect(temp).not.toBe(gmail.id);
    expect(calls).toEqual([`signIn:${temp}:alex@gmail.com`, `move:${temp}->${gmail.id}`]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refuses a different mailbox, drops its tokens and keeps the account's own", async () => {
    signedInAs = "someone.else@gmail.com";
    await expect(reconnect(gmail)).rejects.toThrow(/someone\.else@gmail\.com.*alex@gmail\.com/);
    const temp = calls[0].split(":")[1];
    expect(temp).not.toBe(gmail.id);
    expect(calls).toEqual([`signIn:${temp}:alex@gmail.com`, `signOut:${temp}`]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("checks Microsoft 365 sign-ins against the mail address or the user principal name", async () => {
    signedInAs = "someone@example.edu";
    await reconnect(m365);
    expect(calls[1]).toMatch(new RegExp(`^move:.+->${m365.id}$`));
    calls.length = 0;
    await reconnect({ ...m365, address: "someone.upn@example.edu" });
    expect(calls[1]).toMatch(/^move:/);
    calls.length = 0;
    signedInAs = "other@example.edu";
    await expect(reconnect(m365)).rejects.toThrow(/someone@example\.edu/);
    expect(calls[1]).toMatch(/^signOut:/);
    expect(calls.some((c) => c.includes(m365.id))).toBe(false);
  });
});
