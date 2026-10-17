import { describe, expect, it } from "vitest";
import { MockMailProvider } from "@/lib/mail/mock-provider";
import { ACCOUNTS, FOLDERS } from "@/lib/mail/mock-data";

const p = new MockMailProvider(ACCOUNTS[0]);

describe("mock search", () => {
  it("finds the demo Amazon mail, with header rows", async () => {
    const page = await p.search({ from: "amazon.com" }, FOLDERS);
    expect(page.ids.length).toBeGreaterThanOrEqual(35);
    expect(page.headers?.every((h) => h.partial && h.from.address.endsWith("amazon.com"))).toBe(true);
  });

  it("leaves trash and spam out unless asked", async () => {
    const all = await p.search({ from: "amazon.com" }, FOLDERS);
    await p.batchMove([{ id: all.ids[0] } as never], "personal:trash");
    expect((await p.search({ from: "amazon.com" }, FOLDERS)).ids).not.toContain(all.ids[0]);
    expect((await p.search({ from: "amazon.com", folder: "trash" }, FOLDERS)).ids).toContain(all.ids[0]);
    await p.batchMove([{ id: all.ids[0] } as never], "personal:inbox");
  });

  it("leaves drafts out unless asked", async () => {
    const all = await p.search({ from: "amazon.com" }, FOLDERS);
    await p.batchMove([{ id: all.ids[0] } as never], "personal:drafts");
    expect((await p.search({ from: "amazon.com" }, FOLDERS)).ids).not.toContain(all.ids[0]);
    expect((await p.search({ from: "amazon.com", folder: "drafts" }, FOLDERS)).ids).toContain(all.ids[0]);
    await p.batchMove([{ id: all.ids[0] } as never], "personal:inbox");
  });

  it("returns nothing when the named folder doesn't exist for this account", async () => {
    expect((await p.search({ from: "amazon.com", folder: "no-such-folder" }, FOLDERS)).ids).toEqual([]);
  });

  it("skips ids that don't exist", async () => {
    expect(await p.batchSetRead(["nope"], true)).toEqual({ skipped: ["nope"], failed: [] });
  });
});
