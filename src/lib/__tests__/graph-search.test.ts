// src/lib/__tests__/graph-search.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const calls: { method: string; url: string; body?: unknown; headers?: Record<string, string> }[] = [];
let reply: (method: string, url: string, body: unknown) => unknown = () => ({});

vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/db", () => ({ cachePutMessages: async () => undefined, cacheListMessages: async () => [], cachePutFolders: async () => undefined, syncGet: async () => null, syncSet: async () => undefined }));
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    request: async (method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) => {
      calls.push({ method, url, body: opts.body, headers: opts.headers });
      return reply(method, url, opts.body);
    },
  };
});

const { GraphProvider } = await import("@/lib/microsoft/graph");
const { HttpError } = await import("@/lib/transport");
// Throttling waits (Retry-After / backoff) pass instantly in these tests.
let now = 0;
(await import("@/lib/microsoft/throttle")).graphThrottle.clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
const account = { id: "o", kind: "m365" as const, name: "Work", address: "z@example.org" };
const folders: Folder[] = [{ id: "o:AAinbox", accountId: "o", name: "Inbox", system: "inbox" }];
const msg = (id: string, isRead: boolean, parent = "AAinbox") => ({ id, subject: `S ${id}`, from: { emailAddress: { name: "Amazon", address: "a@amazon.com" } }, receivedDateTime: "2025-01-02T00:00:00Z", isRead, parentFolderId: parent, bodyPreview: "p" });

beforeEach(() => (calls.length = 0));

describe("Graph search", () => {
  it("uses $search for sender terms, returns header rows, and applies flags locally", async () => {
    reply = () => ({ value: [msg("1", false), msg("2", true)], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" });
    const page = await new GraphProvider(account).search({ from: "amazon.com", unread: true }, folders);
    expect(decodeURIComponent(calls[0].url)).toContain('/me/messages?$search="from:amazon.com"');
    expect(page.ids).toEqual(["1"]);
    expect(page.headers?.[0]).toMatchObject({ id: "1", partial: true, unread: true, folderId: "o:AAinbox" });
    expect(page.next).toBe("https://graph.microsoft.com/v1.0/next");
  });

  it("searches inside a folder and pages with nextLink", async () => {
    reply = () => ({ value: [] });
    const p = new GraphProvider(account);
    await p.search({ folder: "inbox", unread: true }, folders);
    expect(decodeURIComponent(calls[0].url)).toContain("/me/mailFolders/AAinbox/messages?$filter=receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false");
    await p.search({ folder: "inbox" }, folders, "https://graph.microsoft.com/v1.0/next");
    expect(calls[1].url).toBe("https://graph.microsoft.com/v1.0/next");
  });

  it("returns nothing, without calling the API, when the folder does not resolve", async () => {
    reply = () => ({ value: [msg("1", false)] });
    const page = await new GraphProvider(account).search({ folder: "o:missing", from: "amazon.com" }, folders);
    expect(page).toEqual({ ids: [] });
    expect(calls).toHaveLength(0);
    await new GraphProvider(account).search({ folder: "o:missing" }, folders, "https://graph.microsoft.com/v1.0/next");
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/next");
  });

  it("moves through $batch with immutable ids and reports 404s as skipped, other errors as failed", async () => {
    reply = (_m, url, body) => {
      if (!url.endsWith("/$batch")) return {};
      const reqs = (body as { requests: { id: string }[] }).requests;
      return { responses: reqs.map((r) => ({ id: r.id, status: r.id === "1" ? 404 : r.id === "2" ? 429 : 201 })) };
    };
    const out = await new GraphProvider(account).batchMove([{ id: "a" }, { id: "b" }, { id: "c" }] as Email[], "o:AAdeleted");
    const reqs = (calls[0].body as { requests: { method: string; url: string; body: unknown; headers: Record<string, string> }[] }).requests;
    expect(reqs[0]).toMatchObject({ method: "POST", url: "/me/messages/a/move", body: { destinationId: "AAdeleted" } });
    expect(reqs[0].headers.Prefer).toBe('IdType="ImmutableId"');
    expect(out).toEqual({ skipped: ["b"], failed: ["c"] });
  });

  it("marks read with PATCH requests in $batch", async () => {
    reply = (_m, _u, body) => ({ responses: (body as { requests: { id: string }[] }).requests.map((r) => ({ id: r.id, status: 200 })) });
    await new GraphProvider(account).batchSetRead(["a"], true);
    expect((calls[0].body as { requests: unknown[] }).requests[0]).toMatchObject({ method: "PATCH", url: "/me/messages/a", body: { isRead: true } });
  });

  it("reports every id as failed when the $batch request itself fails", async () => {
    reply = () => {
      throw new HttpError(503, "down");
    };
    const p = new GraphProvider(account);
    expect(await p.batchSetRead(["a", "b"], true)).toEqual({ skipped: [], failed: ["a", "b"] });
    expect(await p.batchSetStarred(["c"], true)).toEqual({ skipped: [], failed: ["c"] });
    expect(await p.batchMove([{ id: "d" }] as Email[], "o:AAdeleted")).toEqual({ skipped: [], failed: ["d"] });
  });

  it("fetches header rows through $batch, drops 404s and throws on throttling", async () => {
    reply = (_m, _u, body) => ({
      responses: (body as { requests: { id: string; url: string }[] }).requests.map((r) =>
        r.id === "1" ? { id: r.id, status: 404 } : { id: r.id, status: 200, body: msg(r.url.split("/")[3].split("?")[0], false) },
      ),
    });
    const rows = await new GraphProvider(account).headers(["z", "y", "x"]);
    expect(rows.map((r) => r.id)).toEqual(["z", "x"]);
    expect(rows[0].partial).toBe(true);

    reply = (_m, _u, body) => ({
      responses: (body as { requests: { id: string }[] }).requests.map((r) => (r.id === "1" ? { id: r.id, status: 429 } : { id: r.id, status: 200, body: msg(`n${r.id}`, false) })),
    });
    await expect(new GraphProvider(account).headers(["p", "q"])).rejects.toMatchObject({ status: 429 });
  });

  it("hides trash and junk from folderless search on a fresh provider", async () => {
    const fs: Folder[] = [...folders, { id: "o:AAdeleted", accountId: "o", name: "Deleted Items", system: "trash" }];
    reply = () => ({ value: [msg("1", false), msg("2", false, "AAdeleted")] });
    const page = await new GraphProvider(account).search({ from: "amazon.com" }, fs);
    expect(page.ids).toEqual(["1"]);
  });

  it("hides drafts from folderless search", async () => {
    const fs: Folder[] = [...folders, { id: "o:AAdrafts", accountId: "o", name: "Drafts", system: "drafts" }];
    reply = () => ({ value: [msg("1", false), msg("2", false, "AAdrafts")] });
    expect((await new GraphProvider(account).search({ from: "amazon.com" }, fs)).ids).toEqual(["1"]);
    expect((await new GraphProvider(account).search({ from: "amazon.com", folder: "drafts" }, fs)).ids).toEqual(["1", "2"]);
  });

  it("reports $search's 1,000-result limit and the rows it scanned; $filter has none", async () => {
    const fs: Folder[] = [...folders, { id: "o:AAdeleted", accountId: "o", name: "Deleted Items", system: "trash" }];
    reply = () => ({ value: [msg("1", false), msg("2", false, "AAdeleted")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" });
    const p = new GraphProvider(account);
    const first = await p.search({ from: "amazon.com" }, fs);
    expect(first).toMatchObject({ ids: ["1"], limit: 1000, scanned: 2 });
    expect(await p.search({ from: "amazon.com" }, fs, "https://graph.microsoft.com/v1.0/next")).toMatchObject({ limit: 1000, scanned: 2 });
    const filtered = await p.search({ unread: true }, fs);
    expect(filtered.limit).toBeUndefined();
  });

  it("keeps cached header rows fresh after edits", async () => {
    reply = (_m, url, body) =>
      url.endsWith("/$batch") ? { responses: (body as { requests: { id: string }[] }).requests.map((r) => ({ id: r.id, status: 200 })) } : { value: [msg("1", false), msg("2", false)] };
    const p = new GraphProvider(account);
    await p.search({ from: "amazon.com" }, folders);
    await p.batchMove([{ id: "1" }] as Email[], "o:AAarchive");
    await p.batchSetRead(["2"], true);
    await p.batchSetStarred(["2"], true);
    calls.length = 0;
    const rows = await p.headers(["2", "1"]);
    expect(calls).toHaveLength(0);
    expect(rows.map((r) => r.id)).toEqual(["2", "1"]);
    expect(rows[1].folderId).toBe("o:AAarchive");
    expect(rows[0]).toMatchObject({ unread: false, starred: true });
  });

  it("counts ids missing from the $batch response as failed and skips empty lists", async () => {
    reply = () => ({ responses: [{ id: "0", status: 200 }] });
    expect(await new GraphProvider(account).batchSetRead(["a", "b"], true)).toEqual({ skipped: [], failed: ["b"] });
    calls.length = 0;
    expect(await new GraphProvider(account).batchSetRead([], true)).toEqual({ skipped: [], failed: [] });
    expect(calls).toHaveLength(0);
  });

  it("refreshCounts asks for unreadItemCount per folder (max 5) and updates the folder cache", async () => {
    reply = (_m, url) => (url.includes("/me/mailFolders/") ? { unreadItemCount: 4 } : {});
    const p = new GraphProvider(account);
    const out = await p.refreshCounts(["o:AAinbox", "o:B", "o:C", "o:D", "o:E", "o:F"]);
    expect(calls.map((c) => c.url.replace("https://graph.microsoft.com/v1.0", ""))).toEqual(
      ["AAinbox", "B", "C", "D", "E"].map((id) => `/me/mailFolders/${id}?$select=unreadItemCount`),
    );
    expect(out).toEqual({ "o:AAinbox": 4, "o:B": 4, "o:C": 4, "o:D": 4, "o:E": 4 });
  });
});
