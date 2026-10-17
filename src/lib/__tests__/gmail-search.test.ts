// src/lib/__tests__/gmail-search.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const calls: { method: string; url: string; body?: unknown }[] = [];
let routes: Record<string, unknown> = {};
let batchReply = "";
let batchReplies: string[] = [];
let failBatchModifyAt: number[] = [];
let modifyCount = 0;

vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/db", () => ({
  cachePutMessages: async () => undefined,
  cacheListMessages: async () => [],
  cacheDeleteMessages: async () => undefined,
  cachePutFolders: async () => undefined,
  syncGet: async () => null,
  syncSet: async () => undefined,
}));
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    request: async (method: string, url: string, opts: { body?: unknown } = {}) => {
      calls.push({ method, url, body: opts.body });
      if (url.endsWith("/messages/batchModify") && failBatchModifyAt.includes(modifyCount++)) throw new real.HttpError(500, "boom");
      const path = url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "");
      const key = Object.keys(routes).find((k) => path === k || path.startsWith(k + "?"));
      if (!key) throw new real.HttpError(404, `no route for ${method} ${path}`);
      return routes[key];
    },
    requestText: async (method: string, url: string, opts: { body?: string } = {}) => {
      calls.push({ method, url, body: opts.body });
      return batchReplies.length ? batchReplies.shift()! : batchReply;
    },
  };
});

const { GmailProvider } = await import("@/lib/google/gmail");
const account = { id: "g", kind: "gmail" as const, name: "Gmail", address: "me@gmail.com" };
const folders: Folder[] = [{ id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" }];

const part = (id: string, subject: string, labels: string[]) =>
  `--batch_abc\r\nContent-Type: application/http\r\nContent-ID: <response-m>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n` +
  JSON.stringify({ id, threadId: id, labelIds: labels, snippet: `${subject}…`, internalDate: "1700000000000", payload: { mimeType: "text/plain", body: { size: 0 }, headers: [{ name: "From", value: "Amazon <ship@amazon.com>" }, { name: "Subject", value: subject }] } }) +
  "\r\n";

beforeEach(() => {
  calls.length = 0;
  routes = {};
  batchReplies = [];
  failBatchModifyAt = [];
  modifyCount = 0;
});

describe("Gmail search", () => {
  it("lists ids for the query, excluding chats, 500 per page", async () => {
    routes = { "/messages": { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2", resultSizeEstimate: 812 } };
    const page = await new GmailProvider(account).search({ from: "amazon.com", folder: "inbox" }, folders);
    expect(page).toEqual({ ids: ["a", "b"], next: "p2", estimate: 812 });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("q")).toBe("from:amazon.com in:inbox -in:chats");
    expect(url.searchParams.get("maxResults")).toBe("500");
  });

  it("fetches header rows through one batch request and marks them partial", async () => {
    batchReply = part("a", "Your package was delivered", ["INBOX", "UNREAD"]) + part("b", "Shipped: rain boots", ["CATEGORY_UPDATES"]) + "--batch_abc--";
    const rows = await new GmailProvider(account).headers(["a", "b"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gmail.googleapis.com/batch/gmail/v1");
    expect(String(calls[0].body)).toContain("GET /gmail/v1/users/me/messages/a?format=metadata");
    expect(String(calls[0].body)).toContain("metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post");
    expect(rows.map((r) => [r.id, r.subject, r.folderId, r.unread, r.partial])).toEqual([
      ["a", "Your package was delivered", "g:INBOX", true, true],
      ["b", "Shipped: rain boots", "g:ARCHIVE", false, true],
    ]);
  });

  it("moves in batchModify calls grouped by label change, at most 1000 ids each", async () => {
    routes = { "/messages/batchModify": undefined };
    const p = new GmailProvider(account);
    const inbox = (id: string) => ({ id, labels: ["INBOX"] }) as Email;
    const ids = Array.from({ length: 1001 }, (_, i) => inbox(`m${i}`));
    const out = await p.batchMove(ids, "g:TRASH");
    expect(out).toEqual({ skipped: [], failed: [] });
    const bodies = calls.map((c) => c.body as { ids: string[]; addLabelIds: string[]; removeLabelIds: string[] });
    expect(bodies.map((b) => b.ids.length)).toEqual([1000, 1]);
    expect(bodies[0].addLabelIds).toEqual(["TRASH"]);
    expect(bodies[0].removeLabelIds).toEqual(["INBOX"]);
  });

  it("leaves drafts out of folderless searches only", async () => {
    routes = { "/messages": { messages: [] } };
    const p = new GmailProvider(account);
    await p.search({ from: "amazon.com" }, folders);
    expect(new URL(calls[0].url).searchParams.get("q")).toBe("from:amazon.com -in:drafts -in:chats");
    await p.search({ from: "amazon.com", folder: "inbox" }, folders);
    expect(new URL(calls[1].url).searchParams.get("q")).toBe("from:amazon.com in:inbox -in:chats");
  });

  it("returns no ids, without calling the API, when the folder does not resolve", async () => {
    const page = await new GmailProvider(account).search({ folder: "g:Label_missing" }, folders);
    expect(page).toEqual({ ids: [] });
    expect(calls).toHaveLength(0);
  });

  it("restores an email's folder labels exactly after it was filed elsewhere", async () => {
    routes = { "/messages/batchModify": undefined };
    const p = new GmailProvider(account);
    // INBOX + Label_2 -> filed into Label_1 (drops INBOX and Label_2) ...
    await p.batchMove([{ id: "a", labels: ["INBOX", "Label_2", "UNREAD"] } as Email], "g:Label_1");
    calls.length = 0;
    // ... and back.
    const out = await p.restoreLabels([{ id: "a", labels: ["INBOX", "Label_2", "UNREAD"] }]);
    expect(out).toEqual({ skipped: [], failed: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ ids: ["a"], addLabelIds: ["INBOX", "Label_2"], removeLabelIds: ["Label_1"] });
    // Nothing left to change: no second call.
    calls.length = 0;
    await p.restoreLabels([{ id: "a", labels: ["INBOX", "Label_2", "UNREAD"] }]);
    expect(calls).toHaveLength(0);
  });

  it("reports a failed batchModify group and keeps the others", async () => {
    routes = { "/messages/batchModify": undefined };
    failBatchModifyAt = [1];
    const p = new GmailProvider(account);
    const out = await p.batchMove([{ id: "a", labels: ["INBOX"] } as Email, { id: "b", labels: ["Label_1"] } as Email], "g:Label_2");
    expect(out).toEqual({ skipped: [], failed: ["b"] });
    await p.batchSetRead(["a"], true); // proves a's label map was updated without throwing
    expect(calls).toHaveLength(3);
  });

  it("throws 429 when header ids are still throttled after one retry", async () => {
    vi.useFakeTimers();
    const throttled = "--batch_abc\r\nContent-Type: application/http\r\nContent-ID: <response-m1>\r\n\r\nHTTP/1.1 429 Too Many Requests\r\n\r\n{\"error\":{}}\r\n";
    batchReplies = [part("a", "One", []) + throttled + "--batch_abc--", throttled.replace("response-m1", "response-m0") + "--batch_abc--"];
    const p = expect(new GmailProvider(account).headers(["a", "b"])).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(calls).toHaveLength(2);
    expect(String(calls[1].body)).toContain("messages/b?");
    expect(String(calls[1].body)).not.toContain("messages/a?");
    vi.useRealTimers();
  });

  it("does not retry 404 header parts", async () => {
    batchReply = part("a", "One", []) + "--batch_abc\r\nContent-Type: application/http\r\nContent-ID: <response-m1>\r\n\r\nHTTP/1.1 404 Not Found\r\n\r\n{\"error\":{}}\r\n--batch_abc--";
    const rows = await new GmailProvider(account).headers(["a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(calls).toHaveLength(1);
  });

  it("splits more than 100 header ids into requests of at most 100", async () => {
    batchReply = "--batch_abc--";
    await new GmailProvider(account).headers(Array.from({ length: 230 }, (_, i) => `m${i}`));
    expect(calls).toHaveLength(3);
  });

  it("marks read with one batchModify", async () => {
    routes = { "/messages/batchModify": undefined };
    await new GmailProvider(account).batchSetRead(["a", "b"], true);
    expect(calls[0].body).toEqual({ ids: ["a", "b"], addLabelIds: [], removeLabelIds: ["UNREAD"] });
  });
});

const { parseBatchResponse } = await import("@/lib/google/gmail-map");

describe("parseBatchResponse", () => {
  it("returns status and JSON per part, skipping the closing boundary", () => {
    const text = part("a", "One", []) + "--batch_abc\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 404 Not Found\r\n\r\n{\"error\":{}}\r\n--batch_abc--";
    expect(parseBatchResponse<{ id: string }>(text).map((p) => [p.status, p.body && "id" in p.body ? p.body.id : null])).toEqual([
      [200, "a"],
      [404, null],
    ]);
  });
});
