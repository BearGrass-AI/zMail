// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS, MULTIPART, HTML_ONLY_ARCHIVED } from "./fixtures/gmail";

// In-memory stand-ins for the network, Keychain tokens and SQLite cache.
const calls: { method: string; url: string; body?: unknown }[] = [];
let routes: Record<string, unknown> = {};
const cache = new Map<string, { id: string; folder_id: string; date: string; json: string }>();
let cursor: string | null = null;
let putCalls = 0;
let listReads = 0;
let minimal: Record<string, string[] | null> = {};

vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/db", () => ({
  cachePutMessages: async (_a: string, ms: { id: string; folder_id: string; date: string; json: string }[]) => {
    putCalls++;
    ms.forEach((m) => cache.set(m.id, m));
  },
  cacheGetMessage: async (id: string) => cache.get(id) ?? null,
  cacheListMessages: async () => {
    listReads++;
    return [...cache.values()].sort((a, b) => b.date.localeCompare(a.date));
  },
  cacheListIds: async (_a: string, folders?: string[], limit = 2000) => {
    const rows = [...cache.values()].sort((a, b) => b.date.localeCompare(a.date));
    const ids = new Set(rows.slice(0, limit).map((r) => r.id));
    for (const r of rows) if (folders?.includes(r.folder_id)) ids.add(r.id);
    return [...ids];
  },
  cacheDeleteMessages: async (ids: string[]) => ids.forEach((id) => cache.delete(id)),
  cachePutFolders: async () => undefined,
  syncGet: async () => cursor,
  syncSet: async (_a: string, c: string) => void (cursor = c),
}));
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    // Gmail's multipart batch endpoint. Only format=minimal label reads use it here: `minimal[id]` is the label list, or null for a 404.
    requestText: async (method: string, url: string, opts: { body?: string } = {}) => {
      calls.push({ method, url, body: opts.body });
      const ids = [...(opts.body ?? "").matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?\s]+)\?format=minimal/g)].map((m) => m[1]);
      return (
        ids
          .map((id, i) => {
            const labels = minimal[id];
            const head = `--zmail_batch_resp\r\nContent-Type: application/http\r\nContent-ID: <response-m${i}>\r\n\r\n`;
            return labels
              ? `${head}HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ id, threadId: "t", labelIds: labels })}\r\n`
              : `${head}HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{"code":404}}\r\n`;
          })
          .join("") + "--zmail_batch_resp--"
      );
    },
    request: async (method: string, url: string, opts: { body?: unknown } = {}) => {
      calls.push({ method, url, body: opts.body });
      const path = url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "");
      const key = Object.keys(routes).find((k) => path === k || path.startsWith(k + "?") || (k.endsWith("*") && path.startsWith(k.slice(0, -1))));
      if (!key) throw new real.HttpError(404, `no route for ${method} ${path}`);
      const v = routes[key];
      return typeof v === "function" ? (v as (b: unknown) => unknown)(opts.body) : v;
    },
  };
});

const { GmailProvider } = await import("@/lib/google/gmail");
const { HttpError } = await import("@/lib/transport");
const { decodeBase64Url } = await import("@/lib/google/gmail-map");
const { replyRecipients } = await import("@/lib/mail/compose-text");

const account = { id: "g1", kind: "gmail" as const, name: "Gmail", address: "me@gmail.com" };

beforeEach(() => {
  calls.length = 0;
  cache.clear();
  cursor = null;
  putCalls = 0;
  listReads = 0;
  minimal = {};
  routes = {
    "/labels": { labels: LABELS },
    "/labels/*": { messagesUnread: 3 },
    "/profile": { emailAddress: "me@gmail.com", historyId: "100", messagesTotal: 2 },
    "/messages": { messages: [{ id: "18c1" }, { id: "18c2" }] },
    "/messages/18c1": MULTIPART,
    "/messages/18c2": HTML_ONLY_ARCHIVED,
  };
});

describe("GmailProvider", () => {
  it("does a full sync first, caches mail and saves the history cursor", async () => {
    const p = new GmailProvider(account);
    const folders = await p.listFolders();
    expect(folders.find((f) => f.name === "Finance")?.unread).toBe(3);
    const emails = await p.listMessages();
    expect(emails.map((e) => e.id)).toEqual(["18c1", "18c2"]);
    expect(emails[1].folderId).toBe("g1:Label_2");
    expect(cursor).toBe("100");
  });

  it("syncs incrementally from history: fetches changed, drops deleted", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    await p.listMessages();
    calls.length = 0;
    routes["/history"] = {
      historyId: "120",
      history: [{ messagesAdded: [{ message: { id: "18c3" } }], messagesDeleted: [{ message: { id: "18c2" } }] }],
    };
    routes["/messages/18c3"] = { ...MULTIPART, id: "18c3", internalDate: "1791600000000" };
    const emails = await p.listMessages();
    expect(emails.map((e) => e.id)).toEqual(["18c3", "18c1"]);
    expect(cursor).toBe("120");
    expect(calls.some((c) => c.url.includes("/messages?"))).toBe(false); // no full re-list
  });

  it("syncChanges: full on the first run, then only what history changed", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    expect(await p.syncChanges()).toEqual({ full: true });
    expect(cursor).toBe("100");
    calls.length = 0;
    routes["/history"] = {
      historyId: "140",
      history: [{ labelsAdded: [{ message: { id: "18c1" } }], messagesDeleted: [{ message: { id: "18c2" } }] }],
    };
    minimal["18c1"] = [...(MULTIPART.labelIds ?? []), "STARRED"];
    const ch = await p.syncChanges();
    if (ch.full) throw new Error("expected changes");
    expect(ch.changed.map((e) => e.id)).toEqual(["18c1"]);
    expect(ch.changed[0].starred).toBe(true);
    expect(ch.removed).toEqual(["18c2"]);
    expect(cache.has("18c2")).toBe(false);
    expect(cursor).toBe("140");
    expect(calls.some((c) => c.url.includes("/messages?"))).toBe(false); // no full re-list
  });

  it("patches labels on cached mail from a minimal read: no full download, body kept", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    await p.syncChanges();
    const body = (JSON.parse(cache.get("18c1")!.json) as { text: string }).text;
    calls.length = 0;
    listReads = 0;
    // Read and archived (UNREAD and INBOX dropped), starred.
    routes["/history"] = { historyId: "150", history: [{ labelsRemoved: [{ message: { id: "18c1" } }] }, { labelsAdded: [{ message: { id: "18c1" } }] }] };
    minimal["18c1"] = ["STARRED", "CATEGORY_UPDATES"];
    const ch = await p.syncChanges();
    if (ch.full) throw new Error("expected changes");
    expect(calls.some((c) => /\/messages\/[^?/]+\?format=full/.test(c.url))).toBe(false);
    expect(calls.filter((c) => c.url.includes("/batch/")).length).toBe(1);
    expect(listReads).toBe(0); // per-id reads only, never the whole cache
    expect(ch.changed).toHaveLength(1);
    expect(ch.changed[0]).toMatchObject({ id: "18c1", unread: false, starred: true, folderId: "g1:ARCHIVE", labels: ["STARRED", "CATEGORY_UPDATES"], text: body });
    expect(JSON.parse(cache.get("18c1")!.json)).toMatchObject({ unread: false, starred: true, folderId: "g1:ARCHIVE" });
    expect(cache.get("18c1")!.folder_id).toBe("g1:ARCHIVE");
    expect(cursor).toBe("150");
  });

  it("a relabeled message that Gmail no longer has (404) is removed and uncached", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    await p.syncChanges();
    routes["/history"] = { historyId: "151", history: [{ labelsAdded: [{ message: { id: "18c1" } }] }] };
    minimal["18c1"] = null;
    const ch = await p.syncChanges();
    if (ch.full) throw new Error("expected changes");
    expect(ch.removed).toEqual(["18c1"]);
    expect(ch.changed).toEqual([]);
    expect(cache.has("18c1")).toBe(false);
  });

  it("downloads in full when the message is added, or relabeled but not cached", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    await p.syncChanges();
    calls.length = 0;
    routes["/history"] = {
      historyId: "152",
      history: [{ messagesAdded: [{ message: { id: "18c3" } }] }, { labelsAdded: [{ message: { id: "18c3" } }, { message: { id: "18c4" } }, { message: { id: "18c1" } }] }],
    };
    routes["/messages/18c3"] = { ...MULTIPART, id: "18c3" };
    routes["/messages/18c4"] = { ...MULTIPART, id: "18c4" };
    minimal["18c1"] = ["INBOX"];
    const ch = await p.syncChanges();
    if (ch.full) throw new Error("expected changes");
    const full = calls.filter((c) => /\/messages\/[^?/]+\?format=full/.test(c.url)).map((c) => c.url.split("/messages/")[1].split("?")[0]).sort();
    expect(full).toEqual(["18c3", "18c4"]); // 18c1 was patched, not downloaded
    expect(ch.changed.map((e) => e.id).sort()).toEqual(["18c1", "18c3", "18c4"]);
    expect(cache.has("18c4")).toBe(true);
  });

  it("does not advance the cursor when a fetch fails (no silently dropped mail)", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    await p.listMessages();
    routes["/history"] = { historyId: "130", history: [{ messagesAdded: [{ message: { id: "18c9" } }] }] };
    routes["/messages/18c9"] = () => {
      throw new Error("503 backend error");
    };
    await expect(p.listMessages()).rejects.toThrow(/503/);
    expect(cursor).toBe("100");
  });

  it("falls back to a full sync when history has expired (404)", async () => {
    cursor = "1";
    const p = new GmailProvider(account);
    await p.listFolders();
    const emails = await p.listMessages();
    expect(emails).toHaveLength(2);
    expect(cursor).toBe("100");
  });

  it("after a history expiry, refetches cached Inbox rows no longer in the Inbox: drops 404s, saves the rest", async () => {
    cursor = "1";
    const row = (id: string, folder_id: string) => ({ id, folder_id, date: "2026-01-01", json: JSON.stringify({ id, folderId: folder_id, labels: [], date: "2026-01-01" }) });
    cache.set("18c1", row("18c1", "g1:INBOX"));
    cache.set("still", row("still", "g1:INBOX"));
    cache.set("archived", row("archived", "g1:INBOX"));
    cache.set("deleted", row("deleted", "g1:INBOX"));
    cache.set("elsewhere", row("elsewhere", "g1:Label_2"));
    routes["/messages/archived"] = { ...HTML_ONLY_ARCHIVED, id: "archived" };
    routes["/messages"] = () => {
      const url = decodeURIComponent(calls[calls.length - 1].url.replace(/\+/g, " "));
      if (!url.includes("q=in:inbox -in:chats")) return { messages: [{ id: "18c1" }] };
      expect(url).toContain("maxResults=500");
      return url.includes("pageToken=P2") ? { messages: [{ id: "still" }] } : { messages: [{ id: "18c1" }], nextPageToken: "P2" };
    };
    minimal = { "18c1": ["INBOX"], still: ["INBOX"] }; // still in the Inbox: labels refreshed, not downloaded
    const p = new GmailProvider(account);
    await p.listFolders();
    const emails = await p.listMessages();
    const gets = calls.filter((c) => /\/messages\/[^?/]+\?format=full/.test(c.url)).map((c) => c.url.split("/messages/")[1].split("?")[0]);
    expect(gets.sort()).toEqual(["archived", "deleted"]);
    expect(cache.has("deleted")).toBe(false);
    expect(cache.get("still")?.folder_id).toBe("g1:INBOX");
    expect(cache.get("18c1")?.folder_id).toBe("g1:INBOX");
    expect(cache.get("archived")?.folder_id).toBe("g1:Label_2");
    expect(cache.get("elsewhere")?.folder_id).toBe("g1:Label_2");
    // (The mock cache lists every row; the real one lists only g1:INBOX rows past the newest 2000.)
    expect(emails.map((e) => e.id)).not.toContain("deleted");
    expect(emails.find((e) => e.id === "archived")?.folderId).toBe("g1:Label_2");
    expect(cursor).toBe("100");
    // An incremental sync doesn't reconcile.
    calls.length = 0;
    routes["/history"] = { historyId: "101", history: [] };
    await p.listMessages();
    expect(calls.some((c) => decodeURIComponent(c.url).includes("in:inbox"))).toBe(false);
  });

  it("moves by editing labels and archives by removing INBOX", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    await p.listMessages();
    routes["/messages/18c1/modify"] = (b: unknown) => ({ labelIds: ["Label_1", "UNREAD"], b });
    await p.move("18c1", "g1:Label_1");
    const modify = calls.find((c) => c.url.endsWith("/messages/18c1/modify"))!;
    expect(modify.body).toEqual({ addLabelIds: ["Label_1"], removeLabelIds: ["INBOX", "TRASH", "SPAM"] });
  });

  it("refreshCounts reads only the given labels (max 5), maps messagesUnread and updates the folder cache", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    calls.length = 0;
    routes["/labels/*"] = (): unknown => ({ messagesUnread: 7 });
    const ids = ["g1:INBOX", "g1:Label_1", "g1:Label_2", "g1:Label_3", "g1:Label_4", "g1:Label_5", "g1:ARCHIVE", "g1:path:Finance"];
    const out = await p.refreshCounts(ids);
    const urls = calls.map((c) => c.url.replace("https://gmail.googleapis.com/gmail/v1/users/me", ""));
    expect(urls).toEqual(["/labels/INBOX", "/labels/Label_1", "/labels/Label_2", "/labels/Label_3", "/labels/Label_4"]);
    expect(out).toEqual({ "g1:INBOX": 7, "g1:Label_1": 7, "g1:Label_2": 7, "g1:Label_3": 7, "g1:Label_4": 7 });
    calls.length = 0;
    const cached = await p.listFolders();
    expect(calls).toEqual([]);
    expect(cached.find((f) => f.id === "g1:INBOX")?.unread).toBe(7);
  });
});

describe("GmailProvider.backfillInbox", () => {
  it("pages through the Inbox, skipping cached ids, caching as it goes", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    cache.set("b1", { id: "b1", folder_id: "g1:INBOX", date: "2026-01-01", json: "{}" });
    for (const id of ["b1", "b2", "b3", "b4"]) routes[`/messages/${id}`] = { ...MULTIPART, id };
    routes["/messages"] = { messages: [{ id: "b1" }, { id: "b2" }, { id: "b3" }], nextPageToken: "T2", resultSizeEstimate: 4 };
    const first = await p.backfillInbox!();
    expect(first.emails.map((e) => e.id)).toEqual(["b2", "b3"]);
    expect(first.next).toBe("T2");
    expect(first.total).toBe(4);
    expect(cache.has("b2") && cache.has("b3")).toBe(true);
    const list1 = calls.find((c) => c.url.includes("/messages?"))!.url;
    expect(decodeURIComponent(list1.replace(/\+/g, " "))).toContain("q=in:inbox -in:chats");
    expect(list1).toContain("maxResults=100");
    expect(list1).not.toContain("pageToken");
    routes["/messages"] = { messages: [{ id: "b4" }], resultSizeEstimate: 4 };
    calls.length = 0;
    const second = await p.backfillInbox!("T2");
    expect(second.emails.map((e) => e.id)).toEqual(["b4"]);
    expect(second.next).toBeUndefined();
    expect(calls.find((c) => c.url.includes("/messages?"))!.url).toContain("pageToken=T2");
  });

  it("returns next even when every id on the page is already cached", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    cache.set("c1", { id: "c1", folder_id: "g1:INBOX", date: "2026-01-01", json: "{}" });
    routes["/messages"] = { messages: [{ id: "c1" }], nextPageToken: "T9" };
    const r = await p.backfillInbox!();
    expect(r.emails).toEqual([]);
    expect(r.next).toBe("T9");
  });

  it("fetches and saves more than 25 new ids in chunks", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    const ids = Array.from({ length: 30 }, (_, i) => `d${i}`);
    for (const id of ids) routes[`/messages/${id}`] = { ...MULTIPART, id };
    routes["/messages"] = { messages: ids.map((id) => ({ id })) };
    const r = await p.backfillInbox!();
    expect(r.emails).toHaveLength(30);
    expect(putCalls).toBe(2);
    expect(cache.size).toBe(30);
  });
});

describe("GmailProvider drafts", () => {
  const msg = { to: ["a@b.com"], subject: "Hi", text: "Body" };
  const drafts = () => calls.filter((c) => c.url.includes("/drafts")).map((c) => `${c.method} ${c.url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "")}`);
  beforeEach(() => {
    routes["/drafts/send"] = { id: "sent1" };
    routes["/drafts/*"] = { id: "D1", message: { id: "M2", threadId: "t" } };
    routes["/drafts"] = { id: "D1", message: { id: "M1", threadId: "t" }, drafts: [{ id: "D7", message: { id: "M7" } }, { id: "D1", message: { id: "M1" } }] };
  });

  it("creates the draft, then replaces the same one on the next save", async () => {
    const p = new GmailProvider(account);
    const first = await p.saveDraft(msg);
    expect(first).toEqual({ draftId: "D1", messageId: "M1" });
    await p.saveDraft(msg, first.draftId);
    expect(drafts()).toEqual(["POST /drafts", "PUT /drafts/D1"]);
    expect((calls[0].body as { message: { raw: string } }).message.raw).toEqual(expect.any(String));
    expect((calls[1].body as { id: string }).id).toBe("D1");
  });

  it("sends a saved draft by updating it, then posting drafts/send", async () => {
    const p = new GmailProvider(account);
    await p.sendDraft(msg, "D1");
    expect(drafts()).toEqual(["PUT /drafts/D1", "POST /drafts/send"]);
    expect(calls.at(-1)!.body).toEqual({ id: "D1" });
  });

  it("finds a draft id from a message id, and deletes drafts", async () => {
    const p = new GmailProvider(account);
    expect(await p.draftIdFor("M7")).toBe("D7");
    await expect(p.draftIdFor("nope")).rejects.toThrow(/Drafts/);
    await p.deleteDraft("D7");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    expect(calls.at(-1)!.url).toMatch(/\/drafts\/D7$/);
  });

  it("sendSavedDraft posts drafts/send with the id, without re-saving; no server hold", async () => {
    const p = new GmailProvider(account);
    await p.sendSavedDraft("D1");
    expect(drafts()).toEqual(["POST /drafts/send"]);
    expect(calls.at(-1)!.body).toEqual({ id: "D1" });
    expect((p as { holdOnServer?: unknown }).holdOnServer).toBeUndefined();
    expect((p as { releaseFromServer?: unknown }).releaseFromServer).toBeUndefined();
  });
});

describe("GmailProvider.createFolder", () => {
  /** POST /labels makes Label_N; GET lists the fixture labels plus the ones made. */
  const made: { id: string; name: string; type: "user" }[] = [];
  beforeEach(() => {
    made.length = 0;
    routes["/labels"] = (body: unknown) => {
      if (!body) return { labels: [...LABELS, ...made] };
      const l = { id: `Label_${10 + made.length}`, name: (body as { name: string }).name, type: "user" as const };
      made.push(l);
      return l;
    };
  });
  const posts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/labels")).map((c) => c.body);

  it("creates a label named by its full path under a real parent", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    const f = await p.createFolder("2026", "g1:Label_1");
    expect(posts()).toEqual([{ name: "Finance/2026", labelListVisibility: "labelShow", messageListVisibility: "show" }]);
    expect(f).toEqual({ id: "g1:Label_10", accountId: "g1", name: "2026", parentId: "g1:Label_1" });
    // It joins the cached tree, so the next listFolders shows it without a refetch.
    expect((await p.listFolders()).some((x) => x.id === "g1:Label_10")).toBe(true);
  });

  it("makes real labels for parents that only existed as a deeper label's path, top level first", async () => {
    const p = new GmailProvider(account);
    await p.listFolders();
    const f = await p.createFolder("Wednesday", "g1:path:Golf/Leagues");
    expect(posts().map((b) => (b as { name: string }).name)).toEqual(["Golf", "Golf/Leagues", "Golf/Leagues/Wednesday"]);
    expect(f).toMatchObject({ name: "Wednesday", parentId: "g1:path:Golf/Leagues" });
    // The tree is re-read: the parents are real labels now.
    const tree = await p.listFolders();
    expect(tree.find((x) => x.name === "Leagues")?.id).toBe("g1:Label_11");
  });

  it("returns the existing label when Gmail says it already exists (409)", async () => {
    routes["/labels"] = (body: unknown) => {
      if (body) throw new HttpError(409, "Label name exists or conflicts");
      return { labels: [...LABELS, { id: "Label_7", name: "Kids", type: "user" }] };
    };
    const p = new GmailProvider(account);
    expect(await p.createFolder("kids")).toEqual({ id: "g1:Label_7", accountId: "g1", name: "Kids", parentId: undefined });
  });
});

describe("GmailProvider replies to untrusted headers", () => {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const word = (s: string) => `=?UTF-8?B?${b64(s)}?=`;
  /** The raw MIME of the last send, its header block and the request body. */
  const sent = () => {
    const c = calls.filter((x) => x.url.endsWith("/messages/send")).at(-1)!;
    const raw = decodeBase64Url((c.body as { raw: string }).raw);
    return { head: raw.split("\r\n\r\n")[0], body: c.body as { raw: string; threadId?: string } };
  };
  const crafted = (headers: { name: string; value: string }[]) => ({
    id: "evil",
    threadId: "tE",
    labelIds: ["INBOX"],
    internalDate: "1791590400000",
    payload: { mimeType: "text/plain", headers, body: { size: 2, data: "aGk" } },
  });
  /** Incoming Gmail JSON → mapped email → reply recipients → sent raw MIME. */
  const reply = async (p: InstanceType<typeof GmailProvider>, all = true) => {
    const e = await p.getMessage("evil");
    const { to, cc } = replyRecipients(e, [account.address], all);
    await p.send({ to, cc, subject: `Re: ${e.subject}`, text: "Thanks", replyTo: e });
    return sent();
  };
  beforeEach(() => {
    routes["/messages/send"] = { id: "S1" };
  });

  it("an encoded-word Message-ID or References can't add a header line to the reply", async () => {
    routes["/messages/evil"] = crafted([
      { name: "From", value: "Ann <ann@x.com>" },
      { name: "Subject", value: "Hi" },
      { name: "Message-ID", value: word("<a@b>\r\nBcc: evil@x.com") },
      { name: "References", value: `<r1@x.com> ${word("<r2@x.com>\r\nBcc: evil2@x.com")}` },
    ]);
    const { head } = await reply(new GmailProvider(account));
    expect(head).not.toMatch(/^bcc:/im);
    expect(head).not.toContain("evil");
    expect(head).toMatch(/^To: ann@x\.com$/m);
    expect(head).toMatch(/^References: <r1@x\.com>$/m); // valid ids are kept
    expect(head).not.toMatch(/^In-Reply-To:/m); // the crafted one is dropped; the reply still goes
  });

  it("an encoded-word From, To, Cc or Subject can't add a header line to the reply", async () => {
    routes["/messages/evil"] = crafted([
      { name: "From", value: word("Eve <eve@x.com\r\nBcc: evil@x.com>") },
      { name: "To", value: `me@gmail.com, ${word("<t@x.com>\r\nBcc: evil2@x.com")}` },
      { name: "Cc", value: `${word("Cee")} <c@x.com>, "${word("<d@x.com\r\nBcc: evil3@x.com")}" <d@x.com>` },
      { name: "Subject", value: word("Hi\r\nBcc: evil4@x.com") },
      { name: "Message-ID", value: "<ok@x.com>" },
    ]);
    const p = new GmailProvider(account);
    const e = await p.getMessage("evil");
    expect(e.cc?.[0]).toEqual({ name: "Cee", address: "c@x.com" }); // display names still decode
    const { head } = await reply(p);
    expect(head).not.toMatch(/^bcc:/im);
    expect(head).not.toContain("evil");
    expect(head).toMatch(/^Cc: c@x\.com, d@x\.com$/m);
    expect(head).toMatch(/^In-Reply-To: <ok@x\.com>$/m);
  });

  it("a normal reply threads: In-Reply-To, References and the thread id", async () => {
    routes["/messages/evil"] = { ...MULTIPART, id: "evil" };
    const { head, body } = await reply(new GmailProvider(account), false);
    expect(head).toMatch(/^In-Reply-To: <abc@chase\.com>$/m);
    expect(head).toMatch(/^References: <abc@chase\.com>$/m);
    expect(head).toMatch(/^To: no-reply@chase\.com$/m);
    expect(body.threadId).toBe("18c0");
  });

  it("a reply sent from another account keeps the threading headers but not the other account's thread id", async () => {
    routes["/messages/evil"] = { ...MULTIPART, id: "evil" };
    const p = new GmailProvider(account);
    const other = { ...(await p.getMessage("evil")), accountId: "g2" };
    await p.send({ to: ["no-reply@chase.com"], subject: "Re: x", text: "Thanks", replyTo: other });
    const { head, body } = sent();
    expect(head).toMatch(/^In-Reply-To: <abc@chase\.com>$/m);
    expect(body.threadId).toBeUndefined();
    routes["/drafts"] = { id: "D1", message: { id: "M1" } };
    const draftThread = () => (calls.at(-1)!.body as { message: { threadId?: string } }).message.threadId;
    await p.saveDraft({ to: ["no-reply@chase.com"], subject: "Re: x", text: "Thanks", replyTo: other });
    expect(draftThread()).toBeUndefined();
    await p.saveDraft({ to: ["no-reply@chase.com"], subject: "Re: x", text: "Thanks", replyTo: { ...other, accountId: "g1" } });
    expect(draftThread()).toBe("18c0");
  });
});

describe("GmailProvider.draftIdFor paging", () => {
  it("finds a draft on the second page of drafts", async () => {
    routes["/drafts"] = () =>
      calls.at(-1)!.url.includes("pageToken=P2") ? { drafts: [{ id: "D9", message: { id: "M9" } }] } : { drafts: [{ id: "D1", message: { id: "M1" } }], nextPageToken: "P2" };
    expect(await new GmailProvider(account).draftIdFor("M9")).toBe("D9");
    expect(calls.filter((c) => c.url.includes("/drafts")).length).toBe(2);
  });

  it("throws a clear error when the message isn't in any page of drafts", async () => {
    routes["/drafts"] = { drafts: [{ id: "D1", message: { id: "M1" } }] };
    await expect(new GmailProvider(account).draftIdFor("nope")).rejects.toThrow(/no longer in Gmail's Drafts/);
  });
});

describe("GmailProvider history-gap recovery", () => {
  it("refreshes read, star and labels on cached Inbox mail that is still in the Inbox", async () => {
    cursor = "1";
    const kept = { id: "kept", accountId: "g1", folderId: "g1:INBOX", labels: ["INBOX", "UNREAD"], unread: true, starred: false, text: "kept body", date: "2026-01-01" };
    cache.set("kept", { id: "kept", folder_id: "g1:INBOX", date: "2026-01-01", json: JSON.stringify(kept) });
    routes["/messages"] = () => {
      const url = decodeURIComponent(calls[calls.length - 1].url.replace(/\+/g, " "));
      return url.includes("q=in:inbox -in:chats") ? { messages: [{ id: "kept" }] } : { messages: [] };
    };
    minimal["kept"] = ["INBOX", "STARRED", "Label_1"]; // read, starred and labelled elsewhere while history lapsed
    const p = new GmailProvider(account);
    await p.listFolders();
    await p.listMessages();
    expect(calls.some((c) => /\/messages\/kept\?format=full/.test(c.url))).toBe(false); // labels only, no download
    expect(JSON.parse(cache.get("kept")!.json)).toMatchObject({ unread: false, starred: true, labels: ["INBOX", "STARRED", "Label_1"], folderId: "g1:INBOX", text: "kept body" });
    expect(cursor).toBe("100");
  });
});
