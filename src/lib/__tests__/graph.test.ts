// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventToCal, foldersToTree, messageToEmail, toGraphMessage, type GMsg } from "@/lib/microsoft/graph-map";

const MSG: GMsg = {
  id: "AAMk1",
  conversationId: "conv1",
  subject: "Lab refresh quote — revised",
  from: { emailAddress: { name: "Mark Ellis", address: "Mark.Ellis@dell.com" } },
  toRecipients: [{ emailAddress: { name: "Alex", address: "alex@example.org" } }],
  receivedDateTime: "2026-10-09T17:21:00Z",
  isRead: false,
  flag: { flagStatus: "flagged" },
  bodyPreview: "Hi Alex, attached is the revised quote",
  body: { contentType: "html", content: "<html><body><p>Hi Alex,</p><p>Attached is the revised quote.</p></body></html>" },
  parentFolderId: "INBOXID",
  hasAttachments: true,
  internetMessageId: "<q@dell.com>",
};

describe("graph mapping", () => {
  it("builds a nested tree from flat folders and maps well-known ids", () => {
    const tree = foldersToTree(
      "m1",
      [
        { id: "INBOXID", displayName: "Inbox", parentFolderId: "ROOT", unreadItemCount: 207 },
        { id: "DEPTS", displayName: "Campus Departments", parentFolderId: "INBOXID", unreadItemCount: 28 },
        { id: "HR", displayName: "HR", parentFolderId: "DEPTS", unreadItemCount: 8 },
        { id: "SENTID", displayName: "Sent Items", parentFolderId: "ROOT" },
        { id: "VENDORS", displayName: "Vendors", parentFolderId: "ROOT" },
      ],
      { INBOXID: "inbox", SENTID: "sent" },
    );
    const byId = (id: string) => tree.find((f) => f.id === `m1:${id}`)!;
    expect(byId("INBOXID")).toMatchObject({ system: "inbox", parentId: undefined, unread: 207 });
    expect(byId("HR").parentId).toBe("m1:DEPTS");
    expect(byId("DEPTS").parentId).toBe("m1:INBOXID");
    expect(byId("VENDORS").parentId).toBeUndefined(); // parent was the hidden root
    expect(tree[0].system).toBe("inbox");
  });

  it("maps a message with html body, flag and attachments", () => {
    const e = messageToEmail("m1", MSG, [
      { id: "att1", name: "quote.pdf", contentType: "application/pdf", size: 9000 },
      { id: "att2", name: "logo.png", contentType: "image/png", size: 100, isInline: true },
    ]);
    expect(e).toMatchObject({
      id: "AAMk1",
      threadId: "conv1",
      folderId: "m1:INBOXID",
      unread: true,
      starred: true,
      from: { name: "Mark Ellis", address: "mark.ellis@dell.com" },
      rfc: { messageId: "<q@dell.com>" },
    });
    expect(e.text).toContain("Attached is the revised quote.");
    expect(e.attachments).toEqual([{ id: "att1", filename: "quote.pdf", mimeType: "application/pdf", size: 9000 }]);
  });

  it("maps List-Unsubscribe from internet message headers", () => {
    const e = messageToEmail("m1", { ...MSG, internetMessageHeaders: [{ name: "Received", value: "x" }, { name: "LIST-UNSUBSCRIBE", value: "<https://dell.com/u>" }, { name: "list-unsubscribe-post", value: "List-Unsubscribe=One-Click" }] });
    expect(e.unsubscribe).toEqual({ http: "https://dell.com/u", oneClick: true });
    expect(messageToEmail("m1", MSG).unsubscribe).toBeUndefined();
  });

  it("maps calendar events in UTC with Teams links", () => {
    const ev = eventToCal("m1:cal", {
      id: "E1",
      subject: "Board of Trustees",
      start: { dateTime: "2026-10-12T16:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-10-12T18:00:00.0000000", timeZone: "UTC" },
      isOnlineMeeting: true,
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" },
      organizer: { emailAddress: { address: "Jen.Alvarez@example.org" } },
      isOrganizer: false,
      attendees: [{ emailAddress: { name: "Jen", address: "jen.alvarez@example.org" } }, { emailAddress: { name: "Alex", address: "alex@example.org" } }],
    })!;
    expect(ev.start).toBe("2026-10-12T16:00:00.000Z");
    expect(ev).toMatchObject({ video: true, joinUrl: "https://teams.microsoft.com/l/meetup-join/x", related: { from: "jen.alvarez@example.org" } });
    expect(ev.attendees.map((a) => a.address)).toEqual(["alex@example.org"]);
  });

  it("anchors all-day events to the local date, not UTC midnight", () => {
    const ev = eventToCal("m1:cal", {
      id: "AD",
      subject: "Fall break",
      isAllDay: true,
      start: { dateTime: "2026-10-10T00:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-10-11T00:00:00.0000000", timeZone: "UTC" },
    })!;
    expect(ev.allDay).toBe(true);
    expect(new Date(ev.start).getDate()).toBe(10);
    expect(new Date(ev.start).getHours()).toBe(0);
  });

  it("builds sendMail payloads with file attachments", () => {
    expect(toGraphMessage({ to: ["a@b.com"], subject: "Hi", text: "Body", attachments: [{ filename: "a.txt", mimeType: "text/plain", base64: "aGk=" }] })).toEqual({
      bccRecipients: [],
      subject: "Hi",
      body: { contentType: "Text", content: "Body" },
      toRecipients: [{ emailAddress: { address: "a@b.com" } }],
      ccRecipients: [],
      attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: "a.txt", contentType: "text/plain", contentBytes: "aGk=" }],
    });
  });
});

// ---- provider wiring with mocked I/O ------------------------------------------------

const calls: { method: string; url: string; body?: unknown; headers?: Record<string, string> }[] = [];
let routes: [RegExp, unknown][] = [];
let cursor: string | null = null;
const cache = new Map<string, { id: string; folder_id: string; date: string; json: string }>();

vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/db", () => ({
  cachePutMessages: async (_a: string, ms: { id: string; folder_id: string; date: string; json: string }[]) => ms.forEach((m) => cache.set(m.id, m)),
  cacheGetMessage: async (id: string) => cache.get(id) ?? null,
  cacheListMessages: async () => [...cache.values()],
  cacheListIds: async (_a: string, folders?: string[]) => [...cache.values()].filter((m) => !folders || folders.includes(m.folder_id)).map((m) => m.id),
  cacheDeleteMessages: async (ids: string[]) => ids.forEach((id) => cache.delete(id)),
  cachePutFolders: async () => undefined,
  syncGet: async () => cursor,
  syncSet: async (_a: string, c: string) => void (cursor = c),
}));
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    request: async (method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) => {
      calls.push({ method, url, body: opts.body, headers: opts.headers });
      const hit = routes.find(([re]) => re.test(`${method} ${url}`));
      if (!hit) throw new real.HttpError(404, `no route ${method} ${url}`);
      return typeof hit[1] === "function" ? (hit[1] as () => unknown)() : hit[1];
    },
  };
});

const { GraphProvider, graph } = await import("@/lib/microsoft/graph");
const { inlineDataImages } = await import("@/lib/signature");
const { graphThrottle } = await import("@/lib/microsoft/throttle");
const { HttpError } = await import("@/lib/transport");

/** Sleeping advances a fake clock instantly; the waits are recorded. */
const slept: number[] = [];
let now = 0;
graphThrottle.clock = { now: () => now, sleep: async (ms: number) => void (slept.push(ms), (now += ms)) };
const acct = { id: "m1", kind: "m365" as const, name: "M365", address: "alex@example.org" };

/** Messages "on the server": the /me/messages listing returns only id + lastModifiedDateTime, $batch GETs return the whole message. */
let serverMsgs: (GMsg & { lastModifiedDateTime?: string })[] = [];
const fullFetches = () => calls.flatMap((c) => ((c.body as { requests?: { url: string }[] } | undefined)?.requests ?? []).map((r) => r.url)).filter((u) => /^\/me\/messages\/[^/?]+\?/.test(u));

beforeEach(() => {
  calls.length = 0;
  slept.length = 0;
  cache.clear();
  cursor = null;
  serverMsgs = [{ ...MSG, lastModifiedDateTime: "2026-10-09T17:30:00Z" }];
  routes = [
    [/POST .*\/\$batch$/, () => {
      const reqs = (calls.at(-1)!.body as { requests: { id: string; url: string }[] }).requests;
      return {
        responses: reqs.map((r) => {
          const m = serverMsgs.find((x) => r.url.startsWith(`/me/messages/${x.id}?`));
          return m ? { id: r.id, status: 200, body: m } : { id: r.id, status: 404 };
        }),
      };
    }],
    [/mailFolders\/inbox\?/, { id: "INBOXID" }],
    [/mailFolders\/sentitems\?/, { id: "SENTID" }],
    [/mailFolders\/(drafts|deleteditems|junkemail|archive|conversationhistory)\?/, { id: "OTHER" }],
    [/\/me\/mailFolders\?/, { value: [{ id: "INBOXID", displayName: "Inbox", parentFolderId: "ROOT", childFolderCount: 1 }, { id: "SENTID", displayName: "Sent Items", parentFolderId: "ROOT" }] }],
    [/mailFolders\/INBOXID\/childFolders/, { value: [{ id: "DEPTS", displayName: "Campus Departments", parentFolderId: "INBOXID", childFolderCount: 1 }] }],
    [/mailFolders\/DEPTS\/childFolders/, { value: [{ id: "HR", displayName: "HR", parentFolderId: "DEPTS" }] }],
    [/GET .*\/me\/messages\?/, () => ({ value: serverMsgs.map((m) => ({ id: m.id, lastModifiedDateTime: m.lastModifiedDateTime })) })],
    [/attachments\?/, { value: [{ id: "att1", name: "quote.pdf", size: 9 }] }],
    [/POST .*\/move$/, { id: "AAMk1" }],
    [/POST .*\/reply$/, undefined],
    [/POST .*\/sendMail$/, undefined],
    [/POST .*\/createReply$/, { id: "DRAFT1", body: { contentType: "html", content: "<html><body><hr><p>Original</p></body></html>" } }],
    [/PATCH .*\/messages\/DRAFT1$/, { id: "DRAFT1" }],
    [/POST .*\/DRAFT1\/attachments$/, { id: "a" }],
    [/POST .*\/DRAFT1\/send$/, undefined],
  ];
});

describe("GraphProvider", () => {
  it("asks for internet message headers only when getting one message", async () => {
    routes.unshift([/GET .*\/me\/messages\/AAMk1\?/, { ...MSG, internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<mailto:u@dell.com>" }] }]);
    const p = new GraphProvider(acct);
    const e = await p.getMessage("AAMk1");
    expect(e.unsubscribe).toEqual({ mailto: "mailto:u@dell.com", oneClick: false });
    expect(calls.find((c) => c.url.includes("/me/messages/AAMk1?"))!.url).toContain("internetMessageHeaders");
    calls.length = 0;
    await p.listMessages();
    expect(calls.filter((c) => c.url.includes("/me/messages")).every((c) => !c.url.includes("internetMessageHeaders"))).toBe(true);
  });

  it("walks child folders recursively and sends immutable-id headers", async () => {
    const p = new GraphProvider(acct);
    const folders = await p.listFolders();
    expect(folders.find((f) => f.name === "HR")!.parentId).toBe("m1:DEPTS");
    expect(folders.find((f) => f.id === "m1:INBOXID")!.system).toBe("inbox");
    expect(calls.every((c) => c.headers?.Prefer === 'IdType="ImmutableId"')).toBe(true);
  });

  it("first sync filters by received date, later syncs by lastModified", async () => {
    const p = new GraphProvider(acct);
    const emails = await p.listMessages();
    expect(emails[0].attachments?.[0].filename).toBe("quote.pdf");
    expect(calls.find((c) => c.url.includes("/me/messages?"))!.url).toContain("receivedDateTime ge");
    calls.length = 0;
    await p.listMessages();
    expect(calls.find((c) => c.url.includes("/me/messages?"))!.url).toContain("lastModifiedDateTime ge");
  });

  it("syncChanges: full on the first run, then the modified messages", async () => {
    const p = new GraphProvider(acct);
    expect(await p.syncChanges()).toEqual({ full: true });
    serverMsgs = [{ ...MSG, isRead: true, hasAttachments: false, lastModifiedDateTime: "2026-10-09T18:00:00Z" }];
    const ch = await p.syncChanges();
    if (ch.full) throw new Error("expected changes");
    expect(ch.changed.map((e) => [e.id, e.unread])).toEqual([["AAMk1", false]]);
    expect(ch.removed).toEqual([]);
  });

  it("later syncs fetch only mail whose lastModifiedDateTime changed, and expand attachments in the same request", async () => {
    const p = new GraphProvider(acct);
    await p.listFolders();
    await p.listMessages();
    expect(fullFetches().length).toBe(1);
    expect(fullFetches()[0]).toContain("$expand=attachments");
    expect(cache.get("AAMk1")!.json).toContain('"lastModified":"2026-10-09T17:30:00Z"');
    // Same timestamp on the server: listed, but not downloaded again.
    calls.length = 0;
    const same = await p.syncChanges();
    expect(same).toEqual({ full: false, changed: [], removed: [] });
    expect(fullFetches()).toEqual([]);
    expect(calls.find((c) => c.url.includes("/me/messages?"))!.url).toContain("$select=id,lastModifiedDateTime");
    // New timestamp: downloaded.
    serverMsgs = [{ ...serverMsgs[0], isRead: true, lastModifiedDateTime: "2026-10-09T17:40:00Z" }];
    calls.length = 0;
    const ch = await p.syncChanges();
    if (ch.full) throw new Error("expected changes");
    expect(fullFetches().length).toBe(1);
    expect(ch.changed.map((e) => [e.id, e.unread])).toEqual([["AAMk1", false]]);
  });

  it("refetches without $expand when Graph rejects it (400): the message still lands in changed, attachments read separately", async () => {
    const p = new GraphProvider(acct);
    await p.listFolders();
    await p.syncChanges();
    serverMsgs = [{ ...serverMsgs[0], isRead: true, lastModifiedDateTime: "2026-10-09T19:00:00Z" }];
    routes.shift(); // drop the default $batch handler
    routes.unshift([/POST .*\/\$batch$/, () => {
      const reqs = (calls.at(-1)!.body as { requests: { id: string; url: string }[] }).requests;
      return { responses: reqs.map((r) => (r.url.includes("$expand") ? { id: r.id, status: 400 } : { id: r.id, status: 200, body: serverMsgs[0] })) };
    }]);
    calls.length = 0;
    const ch = await p.syncChanges();
    if (ch.full) throw new Error("expected changes");
    expect(ch.changed.map((e) => [e.id, e.unread, e.attachments?.[0]?.filename])).toEqual([["AAMk1", false, "quote.pdf"]]);
    expect(fullFetches().map((u) => u.includes("$expand"))).toEqual([true, false]);
  });

  describe("when a changed message's attachment list can't be read", () => {
    let attachmentsUp = false;
    async function failingSync() {
      const p = new GraphProvider(acct);
      await p.listFolders();
      await p.syncChanges(); // cached at 17:30 with quote.pdf
      serverMsgs = [{ ...serverMsgs[0], isRead: true, lastModifiedDateTime: "2026-10-09T19:00:00Z" }];
      // Graph rejects the $expand, so the attachments are read on their own, and that read fails.
      routes.shift();
      routes.unshift(
        [/POST .*\/\$batch$/, () => {
          const reqs = (calls.at(-1)!.body as { requests: { id: string; url: string }[] }).requests;
          return { responses: reqs.map((r) => (r.url.includes("$expand") ? { id: r.id, status: 400 } : { id: r.id, status: 200, body: serverMsgs[0] })) };
        }],
        [/GET .*\/messages\/AAMk1\/attachments\?/, () => {
          if (!attachmentsUp) throw new Error("connection reset");
          return { value: [{ id: "att2", name: "quote-v2.pdf", size: 9 }] };
        }],
      );
      attachmentsUp = false;
      cursor = "2026-10-09T18:00:00Z";
      return p;
    }

    it("keeps the old row and the sync cursor, then picks the message up on the next sync", async () => {
      const p = await failingSync();
      const before = cache.get("AAMk1")!.json;
      expect(await p.syncChanges()).toEqual({ full: false, changed: [], removed: [] });
      expect(cache.get("AAMk1")!.json).toBe(before);
      expect(cursor).toBe("2026-10-09T18:00:00Z");
      attachmentsUp = true;
      const ch = await p.syncChanges();
      if (ch.full) throw new Error("expected changes");
      expect(ch.changed.map((e) => [e.id, e.unread, e.attachments?.[0]?.filename])).toEqual([["AAMk1", false, "quote-v2.pdf"]]);
      expect(cache.get("AAMk1")!.json).toContain('"lastModified":"2026-10-09T19:00:00Z"');
      expect(cursor).not.toBe("2026-10-09T18:00:00Z");
    });

    it("stops holding the cursor after three failed syncs, so one bad message can't stall sync", async () => {
      const p = await failingSync();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await p.syncChanges();
      await p.syncChanges();
      expect(cursor).toBe("2026-10-09T18:00:00Z");
      const ch = await p.syncChanges();
      expect(err).toHaveBeenCalled();
      err.mockRestore();
      if (ch.full) throw new Error("expected changes");
      expect(ch.changed.map((e) => [e.id, e.unread])).toEqual([["AAMk1", false]]);
      expect(cache.get("AAMk1")!.json).toContain('"lastModified":"2026-10-09T19:00:00Z"');
      expect(cursor).not.toBe("2026-10-09T18:00:00Z");
    });
  });

  it("a sync that hits the change cap resumes from the last listed change instead of skipping the rest", async () => {
    const { SYNC_CAP } = await import("@/lib/microsoft/graph");
    expect(SYNC_CAP).toBe(2000);
    // A cap of 200 keeps the test fast; 300 changes, one second apart, oldest first.
    const CAP = 200;
    const base = Date.parse("2026-10-11T00:00:00Z");
    const ts = (i: number) => new Date(base + i * 1000).toISOString().replace(".000", "");
    serverMsgs = Array.from({ length: CAP + 100 }, (_, i) => ({ ...MSG, id: `M${i}`, hasAttachments: false, lastModifiedDateTime: ts(i) }));
    // The listing honours `ge`, sorts ascending and pages 100 at a time, like Graph.
    routes.unshift([/GET .*\/me\/messages\?/, () => {
      const url = calls.at(-1)!.url;
      expect(url).toContain("$orderby=lastModifiedDateTime asc");
      const since = decodeURIComponent(url).match(/lastModifiedDateTime ge (\S+?)&/)![1];
      const skip = Number(url.match(/\$skip=(\d+)/)?.[1] ?? 0);
      const all = serverMsgs.filter((m) => Date.parse(m.lastModifiedDateTime!) >= Date.parse(since));
      const page = all.slice(skip, skip + 100).map((m) => ({ id: m.id, lastModifiedDateTime: m.lastModifiedDateTime }));
      return { value: page, ...(skip + 100 < all.length ? { "@odata.nextLink": `${url.replace(/&\$skip=\d+/, "")}&$skip=${skip + 100}` } : {}) };
    }]);
    cursor = "2026-10-11T00:05:00Z"; // minus the 5-minute overlap: everything is listed
    const p = new GraphProvider(acct, CAP);
    const ch = await p.syncChanges();
    if (ch.full) throw new Error("expected changes");
    expect(ch.changed).toHaveLength(CAP);
    // The next sync's `ge` lands exactly on the newest change this one listed.
    expect(new Date(Date.parse(cursor!) - 5 * 60_000).toISOString().replace(".000", "")).toBe(ts(CAP - 1));
    const rest = await p.syncChanges();
    if (rest.full) throw new Error("expected changes");
    // The one already fetched at the boundary isn't downloaded again; the 100 left over are.
    expect(rest.changed.map((e) => e.id)).toEqual(serverMsgs.slice(CAP).map((m) => m.id));
  });

  it("uses attachments that came back with the message instead of asking again", async () => {
    serverMsgs = [{ ...serverMsgs[0], attachments: [{ id: "a9", name: "inline.pdf", size: 5 }] } as GMsg & { lastModifiedDateTime?: string }];
    const p = new GraphProvider(acct);
    await p.listFolders();
    const emails = await p.listMessages();
    expect(emails[0].attachments?.map((a) => a.filename)).toEqual(["inline.pdf"]);
    expect(calls.some((c) => c.url.includes("/attachments"))).toBe(false);
  });

  it("sends Bcc recipients on sendMail and on-thread replies", async () => {
    const p = new GraphProvider(acct);
    const bcc = [{ emailAddress: { address: "h@x.com" } }];
    await p.send({ to: ["a@b.com"], bcc: ["h@x.com"], subject: "Hi", text: "Body" });
    expect(calls.at(-1)!.body).toMatchObject({ message: { bccRecipients: bcc } });
    await p.send({ to: ["a@b.com"], bcc: ["h@x.com"], subject: "Re: x", text: "Thanks", replyTo: messageToEmail("m1", MSG) });
    expect(calls.at(-1)!.url).toMatch(/\/reply$/);
    expect(calls.at(-1)!.body).toMatchObject({ message: { bccRecipients: bcc } });
  });

  it("maps bccRecipients on messages", () => {
    expect(messageToEmail("m1", { ...MSG, bccRecipients: [{ emailAddress: { name: "H", address: "h@x.com" } }] }).bcc).toEqual([{ name: "H", address: "h@x.com" }]);
  });

  it("moves with destinationId and replies on-thread", async () => {
    const p = new GraphProvider(acct);
    await p.move("AAMk1", "m1:HR");
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { destinationId: "HR" } });
    const replyTo = messageToEmail("m1", MSG);
    await p.send({ to: ["mark.ellis@dell.com"], subject: "Re: x", text: "Thanks", replyTo });
    expect(calls.at(-1)!.url).toMatch(/\/me\/messages\/AAMk1\/reply$/);
    await p.send({ to: ["a@b.com"], subject: "Hi", text: "Body" });
    expect(calls.at(-1)!.url).toMatch(/\/me\/sendMail$/);
  });

  it("sends HTML replies through a threaded draft with the quote kept below", async () => {
    const p = new GraphProvider(acct);
    const replyTo = messageToEmail("m1", MSG);
    calls.length = 0;
    await p.send({
      to: ["mark.ellis@dell.com"],
      subject: "Re: x",
      text: "Thanks",
      html: '<div>Thanks</div><img src="cid:image1.t@zmail">',
      inline: [{ cid: "image1.t@zmail", filename: "image1.png", mimeType: "image/png", base64: "iVBO" }],
      replyTo,
      attachments: [{ filename: "a.txt", mimeType: "text/plain", base64: "aGk=" }],
    });
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://graph.microsoft.com/v1.0/me", "")}`)).toEqual([
      "POST /messages/AAMk1/createReply",
      "PATCH /messages/DRAFT1",
      "POST /messages/DRAFT1/attachments",
      "POST /messages/DRAFT1/attachments",
      "POST /messages/DRAFT1/send",
    ]);
    expect((calls[1].body as { body: { content: string } }).body.content).toBe(
      '<html><body><div>Thanks</div><img src="cid:image1.t@zmail"><hr><p>Original</p></body></html>',
    );
    expect(calls[3].body).toMatchObject({ isInline: true, contentId: "image1.t@zmail" });
  });

  // A plain-text original comes back from createReply as a text draft: the sender's text, markup and all, must stay text.
  const TEXT_QUOTE = "________________________________\nFrom: Ann <ann@example.com>\n\nSee <img src=https://x.example/p> & thanks";
  const TEXT_QUOTE_HTML = "________________________________<br>From: Ann &lt;ann@example.com&gt;<br><br>See &lt;img src=https://x.example/p&gt; &amp; thanks";

  it("escapes a plain-text quoted original instead of sending the sender's markup as HTML", async () => {
    routes.unshift([/POST .*\/createReply$/, { id: "DRAFT1", body: { contentType: "text", content: TEXT_QUOTE } }]);
    const p = new GraphProvider(acct);
    calls.length = 0;
    await p.send({ to: ["ann@example.com"], cc: ["jane@example.org"], subject: "Re: x", text: "Thanks", html: "<div>Thanks</div>", replyTo: messageToEmail("m1", MSG) });
    const body = (calls.find((c) => c.method === "PATCH")!.body as { body: { contentType: string; content: string } }).body;
    expect(body).toEqual({ contentType: "HTML", content: `<div>Thanks</div>${TEXT_QUOTE_HTML}` });
    expect(body.content).not.toMatch(/<img/i);
  });

  it("treats a quoted original with no contentType as text", async () => {
    routes.unshift([/POST .*\/createReply$/, { id: "DRAFT1", body: { content: "<img src=https://x.example/p>" } }]);
    const p = new GraphProvider(acct);
    calls.length = 0;
    await p.send({ to: ["ann@example.com"], subject: "Re: x", text: "Thanks", html: "<div>Thanks</div>", replyTo: messageToEmail("m1", MSG) });
    expect((calls.find((c) => c.method === "PATCH")!.body as { body: { content: string } }).body.content).toBe("<div>Thanks</div>&lt;img src=https://x.example/p&gt;");
  });

  it("a reply to another account's email goes out as a new message, not through that mailbox's message id", async () => {
    const p = new GraphProvider(acct);
    const replyTo = messageToEmail("g1", MSG);
    calls.length = 0;
    await p.send({ to: ["mark.ellis@dell.com"], subject: "Re: x", text: "Thanks", replyTo });
    await p.send({ to: ["mark.ellis@dell.com"], subject: "Re: x", text: "Thanks", html: "<div>Thanks</div><blockquote>Original</blockquote>", replyTo });
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://graph.microsoft.com/v1.0/me", "")}`)).toEqual(["POST /sendMail", "POST /sendMail"]);
    expect(calls[0].body).toMatchObject({ message: { subject: "Re: x", body: { contentType: "Text", content: "Thanks" } } });
    expect(calls[1].body).toMatchObject({ message: { body: { contentType: "HTML", content: "<div>Thanks</div><blockquote>Original</blockquote>" } } });
  });

  it("deletes the reply draft if sending fails", async () => {
    const p = new GraphProvider(acct);
    routes = routes.filter(([re]) => !re.test("POST https://graph.microsoft.com/v1.0/me/messages/DRAFT1/send"));
    routes.push([/DELETE .*\/messages\/DRAFT1$/, undefined]);
    await expect(p.send({ to: ["a@b.com"], subject: "Re", text: "x", html: "<p>x</p>", replyTo: messageToEmail("m1", MSG) })).rejects.toThrow();
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });
});

describe("GraphProvider drafts", () => {
  const trail = () => calls.map((c) => `${c.method} ${c.url.replace("https://graph.microsoft.com/v1.0/me", "")}`);
  beforeEach(() => {
    routes.unshift(
      [/POST .*\/me\/messages$/, { id: "NEW1" }],
      [/PATCH .*\/messages\/NEW1$/, { id: "NEW1" }],
      [/GET .*\/messages\/NEW1\/attachments\?/, { value: [] }],
      [/POST .*\/NEW1\/attachments$/, { id: "x" }],
      [/POST .*\/NEW1\/send$/, undefined],
      [/GET .*\/messages\/DRAFT1\/attachments\?/, { value: [{ id: "old1", name: "quote.pdf", size: 9 }] }],
      [/DELETE .*\/DRAFT1\/attachments\/old1$/, undefined],
    );
  });

  it("creates a new draft with POST /me/messages and no attachments in the body", async () => {
    const p = new GraphProvider(acct);
    const r = await p.saveDraft({ to: ["a@b.com"], subject: "Hi", text: "Body", attachments: [{ filename: "a.txt", mimeType: "text/plain", base64: "aGk=" }] });
    expect(r).toEqual({ draftId: "NEW1", messageId: "NEW1" });
    expect(trail()).toEqual(["POST /messages", "GET /messages/NEW1/attachments?$select=id,name,contentId,isInline", "POST /messages/NEW1/attachments"]);
    expect(calls[0].body).toMatchObject({ subject: "Hi", toRecipients: [{ emailAddress: { address: "a@b.com" } }] });
    expect(calls[0].body).not.toHaveProperty("attachments");
  });

  it("includes bccRecipients when saving a new draft and when re-saving it", async () => {
    const p = new GraphProvider(acct);
    const bcc = [{ emailAddress: { address: "h@x.com" } }];
    await p.saveDraft({ to: ["a@b.com"], bcc: ["h@x.com"], subject: "Hi", text: "Body" });
    expect(calls[0].body).toMatchObject({ bccRecipients: bcc });
    calls.length = 0;
    await p.saveDraft({ to: ["a@b.com"], bcc: ["h@x.com"], subject: "Hi", text: "Body" }, "NEW1");
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ bccRecipients: bcc });
  });

  it("saves a reply through createReply, then re-saves with the quote still under our text", async () => {
    const p = new GraphProvider(acct);
    const replyTo = messageToEmail("m1", MSG);
    const first = await p.saveDraft({ to: ["a@b.com"], subject: "Re: x", text: "One", html: "<div>One</div>", replyTo });
    expect(first.draftId).toBe("DRAFT1");
    expect(trail().slice(0, 2)).toEqual(["POST /messages/AAMk1/createReply", "PATCH /messages/DRAFT1"]);
    calls.length = 0;
    await p.saveDraft({ to: ["a@b.com"], subject: "Re: x", text: "Two", html: "<div>Two</div>", replyTo }, "DRAFT1");
    expect(trail()[0]).toBe("PATCH /messages/DRAFT1");
    expect(trail()).not.toContain("POST /messages/AAMk1/createReply");
    expect((calls[0].body as { body: { content: string } }).body.content).toBe("<html><body><div>Two</div><hr><p>Original</p></body></html>");
  });

  it("a reply draft to a plain-text original keeps the quote escaped on every save", async () => {
    routes.unshift([/POST .*\/createReply$/, { id: "DRAFT1", body: { contentType: "Text", content: "Hi\n<img src=https://x.example/p>" } }]);
    const p = new GraphProvider(acct);
    const replyTo = messageToEmail("m1", MSG);
    await p.saveDraft({ to: ["a@b.com"], subject: "Re: x", text: "One", html: "<div>One</div>", replyTo });
    const patched = () => (calls.find((c) => c.method === "PATCH")!.body as { body: { content: string } }).body.content;
    expect(patched()).toBe("<div>One</div>Hi<br>&lt;img src=https://x.example/p&gt;");
    calls.length = 0;
    await p.saveDraft({ to: ["a@b.com"], subject: "Re: x", text: "Two", html: "<div>Two</div>", replyTo }, "DRAFT1");
    expect(patched()).toBe("<div>Two</div>Hi<br>&lt;img src=https://x.example/p&gt;");
  });

  it("deletes attachments the user removed and uploads new ones", async () => {
    const p = new GraphProvider(acct);
    await p.saveDraft({ to: ["a@b.com"], subject: "Hi", text: "Body", attachments: [{ filename: "new.txt", mimeType: "text/plain", base64: "aGk=" }] }, "DRAFT1");
    expect(trail()).toEqual([
      "PATCH /messages/DRAFT1",
      "GET /messages/DRAFT1/attachments?$select=id,name,contentId,isInline",
      "DELETE /messages/DRAFT1/attachments/old1",
      "POST /messages/DRAFT1/attachments",
    ]);
    expect(calls.at(-1)!.body).toMatchObject({ name: "new.txt" });
  });

  it("replaces a file on a reopened draft once (its bytes are unknown), then keeps it", async () => {
    const p = new GraphProvider(acct);
    const msg = { to: ["a@b.com"], subject: "Hi", text: "Body", attachments: [{ filename: "quote.pdf", mimeType: "application/pdf", base64: "aGk=" }] };
    routes.unshift([/POST .*\/DRAFT1\/attachments$/, { id: "new1" }]);
    await p.saveDraft(msg, "DRAFT1");
    expect(trail().filter((t) => t.startsWith("DELETE") || t.endsWith("/attachments"))).toEqual(["DELETE /messages/DRAFT1/attachments/old1", "POST /messages/DRAFT1/attachments"]);
    routes.unshift([/GET .*\/messages\/DRAFT1\/attachments\?/, { value: [{ id: "new1", name: "quote.pdf", isInline: false }] }]);
    calls.length = 0;
    await p.saveDraft(msg, "DRAFT1");
    expect(trail().filter((t) => t.startsWith("DELETE") || t.endsWith("/attachments"))).toEqual([]);
  });

  it("uploads an inline image added after the first save, and keeps one already on the draft", async () => {
    routes.unshift([/GET .*\/messages\/DRAFT1\/attachments\?/, { value: [{ id: "i1", name: "old.png", isInline: true, contentId: "c-old.png" }] }]);
    const p = new GraphProvider(acct);
    const img = (n: string) => ({ cid: `c-${n}`, filename: n, mimeType: "image/png", base64: "aGk=" });
    await p.saveDraft({ to: ["a@b.com"], subject: "Hi", text: "Body", html: "<p>x</p>", inline: [img("old.png"), img("new.png")] }, "DRAFT1");
    const posts = calls.filter((c) => c.method === "POST" && /attachments$/.test(c.url));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ name: "new.png", isInline: true, contentId: "c-new.png" });
    expect(trail().filter((t) => t.startsWith("DELETE"))).toEqual([]);
  });

  /** Draft D7's attachments as Graph holds them; `size` includes MAPI property overhead, like Exchange reports it. */
  function draftServer() {
    let n = 0;
    const atts: { id: string; name: string; size: number; isInline: boolean; contentId?: string; contentBytes: string }[] = [];
    routes.unshift(
      [/PATCH .*\/messages\/D7$/, { id: "D7" }],
      [/POST .*\/D7\/send$/, undefined],
      [/GET .*\/messages\/D7\/attachments\?/, () => ({ value: atts.map((a) => ({ id: a.id, name: a.name, size: a.size, isInline: a.isInline, contentId: a.contentId })) })],
      [/POST .*\/D7\/attachments$/, () => {
        const b = calls.at(-1)!.body as { name: string; contentBytes: string; isInline?: boolean; contentId?: string };
        const a = { id: `att${++n}`, name: b.name, size: atob(b.contentBytes).length + 180, isInline: !!b.isInline, contentId: b.contentId, contentBytes: b.contentBytes };
        atts.push(a);
        return a;
      }],
      [/DELETE .*\/D7\/attachments\/att\d+$/, () => {
        const id = calls.at(-1)!.url.split("/").at(-1);
        atts.splice(atts.findIndex((a) => a.id === id), 1);
      }],
    );
    return atts;
  }

  it("a draft saved before send goes out with the signature image its HTML references", async () => {
    const atts = draftServer();
    const p = new GraphProvider(acct);
    const sig = '<p>Thanks</p><img src="data:image/png;base64,iVBORw0KGgo=">';
    // Every save and send rebuilds the cid: references with a fresh tag, as the composer does.
    const build = () => {
      const { html, inline } = inlineDataImages(sig);
      return { to: ["a@b.com"], subject: "Hi", text: "Thanks", html, inline };
    };
    const saved = build();
    await p.saveDraft(saved, "D7");
    calls.length = 0;
    const sent = build();
    expect(sent.inline[0].cid).not.toBe(saved.inline[0].cid);
    expect(sent.inline[0].filename).toBe(saved.inline[0].filename);
    await p.sendDraft(sent, "D7");
    expect(trail()).toEqual([
      "PATCH /messages/D7",
      "GET /messages/D7/attachments?$select=id,name,contentId,isInline",
      "DELETE /messages/D7/attachments/att1",
      "POST /messages/D7/attachments",
      "POST /messages/D7/send",
    ]);
    const cid = (calls[0].body as { body: { content: string } }).body.content.match(/cid:([^"]+)/)![1];
    expect(atts.map((a) => [a.isInline, a.contentId])).toEqual([[true, cid]]);
  });

  it("keeps the images Outlook copied into a reply draft for its quoted original", async () => {
    const atts = draftServer();
    atts.push({ id: "att0", name: "image001.png", size: 300, isInline: true, contentId: "image001.png@01DB1234", contentBytes: "iVBORw0KGgo=" });
    const p = new GraphProvider(acct);
    p.keepDraftQuote("D7", '<html><body><hr><p>Original</p><img src="cid:image001.png@01DB1234"></body></html>');
    await p.saveDraft({ to: ["a@b.com"], subject: "Re: Hi", text: "Thanks" }, "D7");
    expect(trail()).not.toContain("DELETE /messages/D7/attachments/att0");
    expect(atts.map((a) => a.id)).toEqual(["att0"]);
  });

  it("replaces a file whose bytes changed under the same name, and keeps two files that share a name", async () => {
    const atts = draftServer();
    const p = new GraphProvider(acct);
    const file = (base64: string) => ({ filename: "notes.txt", mimeType: "text/plain", base64 });
    const msg = { to: ["a@b.com"], subject: "Hi", text: "Body" };
    await p.saveDraft({ ...msg, attachments: [file("aGk=")] }, "D7");
    calls.length = 0;
    await p.saveDraft({ ...msg, attachments: [file("aGVsbG8=")] }, "D7");
    expect(trail().filter((t) => !t.startsWith("PATCH") && !t.startsWith("GET"))).toEqual(["DELETE /messages/D7/attachments/att1", "POST /messages/D7/attachments"]);
    expect(atts.map((a) => a.contentBytes)).toEqual(["aGVsbG8="]);
    await p.saveDraft({ ...msg, attachments: [file("aGVsbG8="), file("aGk=")] }, "D7");
    expect(atts.map((a) => a.contentBytes)).toEqual(["aGVsbG8=", "aGk="]);
    // Nothing changed: nothing is uploaded or deleted again.
    calls.length = 0;
    await p.saveDraft({ ...msg, attachments: [file("aGVsbG8="), file("aGk=")] }, "D7");
    expect(trail().filter((t) => t.startsWith("DELETE") || t.startsWith("POST"))).toEqual([]);
    // Two copies of the same file stay two attachments.
    await p.saveDraft({ ...msg, attachments: [file("aGk="), file("aGk=")] }, "D7");
    expect(atts.map((a) => a.contentBytes)).toEqual(["aGk=", "aGk="]);
  });

  it("saves and sends a reply to another account's email as a new draft in this mailbox", async () => {
    const p = new GraphProvider(acct);
    const replyTo = messageToEmail("g1", MSG);
    const first = await p.saveDraft({ to: ["a@b.com"], subject: "Re: x", text: "One", html: "<div>One</div>", replyTo });
    expect(first.draftId).toBe("NEW1");
    expect(trail()[0]).toBe("POST /messages");
    expect(calls[0].body).toMatchObject({ subject: "Re: x", body: { contentType: "HTML", content: "<div>One</div>" } });
    calls.length = 0;
    await p.sendDraft({ to: ["a@b.com"], subject: "Re: x", text: "Two", html: "<div>Two</div>", replyTo }, "NEW1");
    expect(trail().some((t) => t.includes("AAMk1"))).toBe(false);
    expect((calls[0].body as { body: { content: string } }).body.content).toBe("<div>Two</div>");
    expect(trail().at(-1)).toBe("POST /messages/NEW1/send");
  });

  it("forgetDraftQuote makes a reopened reply draft save without a second quote", async () => {
    const p = new GraphProvider(acct);
    const replyTo = messageToEmail("m1", MSG);
    await p.saveDraft({ to: ["a@b.com"], subject: "Re: x", text: "One", html: "<div>One</div>", replyTo });
    p.forgetDraftQuote("DRAFT1");
    calls.length = 0;
    await p.saveDraft({ to: ["a@b.com"], subject: "Re: x", text: "Two", html: "<div>Two<hr><p>Original</p></div>", replyTo }, "DRAFT1");
    const body = (calls.find((c) => c.method === "PATCH")!.body as { body: { content: string } }).body.content;
    expect(body).toBe("<div>Two<hr><p>Original</p></div>");
  });

  it("sendDraft saves then posts /send; draftIdFor is the message id", async () => {
    const p = new GraphProvider(acct);
    await p.sendDraft({ to: ["a@b.com"], subject: "Hi", text: "Body" }, "NEW1");
    expect(trail().at(-1)).toBe("POST /messages/NEW1/send");
    expect(await p.draftIdFor("NEW1")).toBe("NEW1");
  });

  it("sendSavedDraft posts /send without re-saving", async () => {
    const p = new GraphProvider(acct);
    await p.sendSavedDraft("NEW1");
    expect(trail()).toEqual(["POST /messages/NEW1/send"]);
  });

  it("holdOnServer saves, sets PidTagDeferredSendTime (SystemTime 0x3FEF), then posts /send", async () => {
    const p = new GraphProvider(acct);
    await p.holdOnServer({ to: ["a@b.com"], subject: "Hi", text: "Body" }, "NEW1", Date.UTC(2026, 9, 14, 14, 0, 0, 123));
    const t = trail();
    expect(t.at(-1)).toBe("POST /messages/NEW1/send");
    const patches = calls.filter((c) => c.method === "PATCH" && /\/messages\/NEW1$/.test(c.url));
    expect(patches.at(-1)!.body).toEqual({ singleValueExtendedProperties: [{ id: "SystemTime 0x3FEF", value: "2026-10-14T14:00:00Z" }] });
    // The property is set after the save and before the send.
    const deferIdx = calls.indexOf(patches.at(-1)!);
    expect(calls.findIndex((c) => c.method === "PATCH")).toBeLessThan(deferIdx);
    expect(deferIdx).toBe(calls.length - 2);
  });

  it("releaseFromServer moves the held message back to Drafts", async () => {
    const p = new GraphProvider(acct);
    await p.releaseFromServer("NEW1");
    expect(trail()).toEqual(["POST /messages/NEW1/move"]);
    expect(calls[0].body).toEqual({ destinationId: "drafts" });
  });
});

describe("GraphProvider.backfillInbox", () => {
  it("pages the Inbox via nextLink, skipping cached ids and reporting the folder total", async () => {
    const NEXT = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=abc";
    cache.set("AAMk1", { id: "AAMk1", folder_id: "m1:INBOXID", date: "2026-01-01", json: "{}" });
    routes.unshift(
      [/GET .*mailFolders\/inbox\/messages\?\$skiptoken=abc/, { value: [{ ...MSG, id: "AAMk4", hasAttachments: false }] }],
      [/GET .*mailFolders\/inbox\/messages\?/, { value: [MSG, { ...MSG, id: "AAMk2", hasAttachments: false }, { ...MSG, id: "AAMk3", hasAttachments: false }], "@odata.nextLink": NEXT }],
      [/GET .*mailFolders\/inbox\?\$select=totalItemCount/, { totalItemCount: 4 }],
    );
    const p = new GraphProvider(acct);
    const first = await p.backfillInbox!();
    expect(first.emails.map((e) => e.id)).toEqual(["AAMk2", "AAMk3"]);
    expect(first.next).toBe(NEXT);
    expect(first.total).toBe(4);
    expect(first.failed).toBe(0);
    expect(cache.has("AAMk2")).toBe(true);
    expect(calls.find((c) => c.url.includes("/inbox/messages?"))!.url).toContain("$orderby=receivedDateTime desc");
    calls.length = 0;
    const second = await p.backfillInbox!(NEXT);
    expect(second.emails.map((e) => e.id)).toEqual(["AAMk4"]);
    expect(second.next).toBeUndefined();
    expect(calls.every((c) => !c.url.includes("totalItemCount"))).toBe(true);
  });

  it("returns but does not cache mail whose attachment list failed", async () => {
    routes.unshift(
      [/attachments\?/, { value: [] }],
      [/GET .*mailFolders\/inbox\/messages\?/, { value: [{ ...MSG, id: "OK1" }, { ...MSG, id: "BAD" }] }],
    );
    routes.unshift([/GET .*\/messages\/BAD\/attachments/, () => { throw new Error("503"); }]);
    const p = new GraphProvider(acct);
    const r = await p.backfillInbox!();
    expect(r.emails.map((e) => e.id).sort()).toEqual(["BAD", "OK1"]);
    expect(cache.has("OK1")).toBe(true);
    expect(cache.has("BAD")).toBe(false);
    expect(r.failed).toBe(1);
  });
});

describe("GraphProvider Inbox reconcile", () => {
  const row = (id: string, folder = "m1:INBOXID") => ({ id, folder_id: folder, date: "2026-10-01", json: JSON.stringify({ id, folderId: folder }) });
  const PAGE2 = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$select=id&$skiptoken=p2";
  /**
   * Inbox ids on the server: KEEP on page 1, KEEP2 on page 2. GONE is hard-deleted, MOVED is in Archive.
   * `status` gives other ids a $batch status of their own (e.g. 500).
   */
  function server(status: Record<string, number> = {}) {
    serverMsgs = [{ ...MSG, id: "MOVED", parentFolderId: "ARCHID", hasAttachments: false }];
    routes.unshift(
      [/POST .*\/\$batch$/, () => {
        const reqs = (calls.at(-1)!.body as { requests: { id: string; url: string }[] }).requests;
        return {
          responses: reqs.map((r) => {
            const id = r.url.match(/messages\/([A-Z0-9]+)\?/)![1];
            const m = serverMsgs.find((x) => x.id === id);
            return status[id] ? { id: r.id, status: status[id] } : m ? { id: r.id, status: 200, body: m } : { id: r.id, status: 404 };
          }),
        };
      }],
      [/GET .*\/me\/messages\?/, { value: [] }],
      [/GET .*mailFolders\/inbox\/messages\?\$select=id&\$skiptoken=p2/, { value: [{ id: "KEEP2" }] }],
      [/GET .*mailFolders\/inbox\/messages\?\$select=id&\$top=1000$/, { value: [{ id: "KEEP" }], "@odata.nextLink": PAGE2 }],
    );
    for (const id of ["KEEP", "KEEP2", "GONE", "MOVED"]) cache.set(id, row(id));
  }
  const refetched = () => fullFetches().map((u) => u.match(/messages\/([A-Z0-9]+)\?/)![1]).sort();

  it("drops hard-deleted Inbox mail and re-saves mail moved elsewhere", async () => {
    server();
    const p = new GraphProvider(acct);
    await p.listFolders();
    const emails = await p.listMessages();
    expect(refetched()).toEqual(["GONE", "MOVED"]);
    // Both in one $batch, not a request each.
    expect(calls.filter((c) => c.url.endsWith("/$batch"))).toHaveLength(1);
    expect(calls.some((c) => /GET .*\/me\/messages\/[A-Z0-9]+\?/.test(`${c.method} ${c.url}`))).toBe(false);
    expect(cache.has("GONE")).toBe(false);
    expect(cache.get("MOVED")!.folder_id).toBe("m1:ARCHID");
    expect(cache.has("KEEP") && cache.has("KEEP2")).toBe(true);
    expect(emails.map((e) => e.id)).not.toContain("GONE");
    expect(calls.find((c) => c.url.includes("/mailFolders/inbox/messages?"))!.url).toContain("$select=id&$top=1000");
  });

  it("deletes nothing when a refetch fails with anything but 404, and still returns the cache", async () => {
    server({ BROKEN: 500 });
    cache.set("BROKEN", row("BROKEN"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = new GraphProvider(acct);
    await p.listFolders();
    const emails = await p.listMessages();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect(cache.has("GONE") && cache.has("BROKEN")).toBe(true);
    expect(emails.map((e) => e.id).sort()).toEqual(["BROKEN", "GONE", "KEEP", "KEEP2", "MOVED"]);
  });

  it("reconciles at most once every 15 minutes", async () => {
    server();
    const p = new GraphProvider(acct);
    await p.listFolders();
    await p.listMessages();
    const lists = () => calls.filter((c) => c.url.includes("/mailFolders/inbox/messages?")).length;
    expect(lists()).toBe(2); // two pages
    now += 14 * 60_000;
    await p.listMessages();
    expect(lists()).toBe(2);
    now += 60_000;
    await p.listMessages();
    expect(lists()).toBe(4);
  });

  it("syncChanges reports reconciled mail: 404s as removed, moved mail as changed", async () => {
    server();
    cursor = "2026-10-10T00:00:00Z";
    const p = new GraphProvider(acct);
    await p.listFolders();
    const ch = await p.syncChanges();
    if (ch.full) throw new Error("expected changes");
    expect(ch.removed).toEqual(["GONE"]);
    expect(ch.changed.map((e) => [e.id, e.folderId])).toEqual([["MOVED", "m1:ARCHID"]]);
  });

  it("syncChanges reports nothing from a reconcile chunk that failed with anything but 404", async () => {
    server({ BROKEN: 500 });
    cache.set("BROKEN", row("BROKEN"));
    cursor = "2026-10-10T00:00:00Z";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = new GraphProvider(acct);
    await p.listFolders();
    const ch = await p.syncChanges();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect(ch).toEqual({ full: false, changed: [], removed: [] });
    expect(cache.has("GONE")).toBe(true);
  });

  it("skips the reconcile until the Inbox folder id is known", async () => {
    server();
    await new GraphProvider(acct).listMessages();
    expect(calls.some((c) => c.url.includes("/mailFolders/inbox/messages?"))).toBe(false);
    expect(cache.has("GONE")).toBe(true);
  });
});

describe("Graph throttling", () => {
  type BatchReq = { id: string; method: string; url: string };
  const batchCalls = () => calls.filter((c) => c.url.endsWith("/$batch")).map((c) => (c.body as { requests: BatchReq[] }).requests);
  const ids = Array.from({ length: 20 }, (_, i) => `M${i}`);
  /** Answers each $batch item via `status(item, round)`; throttled items carry Retry-After: 1. */
  function batchRoute(status: (item: BatchReq, round: number) => number) {
    let round = 0;
    routes.unshift([
      /POST .*\/\$batch$/,
      () => {
        const reqs = (calls.at(-1)!.body as { requests: BatchReq[] }).requests;
        const r = round++;
        return {
          responses: reqs.map((q) => {
            const s = status(q, r);
            return s === 429 ? { id: q.id, status: s, headers: { "Retry-After": "1" }, body: { error: { code: "ApplicationThrottled" } } } : { id: q.id, status: s, body: {} };
          }),
        };
      },
    ]);
  }

  it("resends only the throttled $batch items after their Retry-After", async () => {
    batchRoute((q, round) => (round === 0 && (q.id === "3" || q.id === "7") ? 429 : 200));
    const out = await new GraphProvider(acct).batchSetRead(ids, true);
    expect(out).toEqual({ skipped: [], failed: [] });
    const sent = batchCalls();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveLength(20);
    // The resend keeps the original ids, so outcome() maps results back to the right messages.
    expect(sent[1].map((q) => [q.id, q.url])).toEqual([
      ["3", "/me/messages/M3"],
      ["7", "/me/messages/M7"],
    ]);
    expect(slept).toEqual([1000]);
  });

  it("reports items still throttled after 3 resend rounds as failed", async () => {
    batchRoute((q) => (q.id === "3" || q.id === "7" ? 429 : 200));
    const out = await new GraphProvider(acct).batchSetRead(ids, true);
    expect(out).toEqual({ skipped: [], failed: ["M3", "M7"] });
    const sent = batchCalls();
    expect(sent).toHaveLength(4); // the first send plus 3 resends
    expect(sent.slice(1).every((r) => r.map((q) => q.id).join() === "3,7")).toBe(true);
    expect(slept).toEqual([1000, 1000, 1000]);
  });

  it("keeps first-round successes when a resend round fails outright", async () => {
    let round = 0;
    routes.unshift([
      /POST .*\/\$batch$/,
      () => {
        if (round++ > 0) throw new HttpError(400, "bad request");
        const reqs = (calls.at(-1)!.body as { requests: BatchReq[] }).requests;
        return { responses: reqs.map((q) => ({ id: q.id, status: q.id === "3" ? 429 : 200, headers: { "retry-after": "1" } })) };
      },
    ]);
    const out = await new GraphProvider(acct).batchSetRead(ids, true);
    expect(out).toEqual({ skipped: [], failed: ["M3"] });
  });

  it("retries a $batch that gets a 504 (moves and patches are safe to repeat)", async () => {
    let n = 0;
    routes.unshift([
      /POST .*\/\$batch$/,
      () => {
        if (++n === 1) throw new HttpError(504, "gateway timeout");
        const reqs = (calls.at(-1)!.body as { requests: BatchReq[] }).requests;
        return { responses: reqs.map((q) => ({ id: q.id, status: 200 })) };
      },
    ]);
    expect(await new GraphProvider(acct).batchSetRead(ids.slice(0, 2), true)).toEqual({ skipped: [], failed: [] });
    expect(n).toBe(2);
  });

  it("never resends sendMail after a 503 (it may have gone out), but does after a 429", async () => {
    const sends = () => calls.filter((c) => c.url.endsWith("/sendMail")).length;
    routes.unshift([/POST .*\/sendMail$/, () => { throw new HttpError(503, "unavailable"); }]);
    const p = new GraphProvider(acct);
    await expect(p.send({ to: ["a@b.com"], subject: "Hi", text: "Body" })).rejects.toMatchObject({ status: 503 });
    expect(sends()).toBe(1);
    calls.length = 0;
    let n = 0;
    routes[0] = [/POST .*\/sendMail$/, () => { if (++n === 1) throw new HttpError(429, "throttled", 1); }];
    await p.send({ to: ["a@b.com"], subject: "Hi", text: "Body" });
    expect(sends()).toBe(2);
  });

  it("retries a single move on 503 (repeating it is harmless)", async () => {
    let n = 0;
    routes.unshift([/POST .*\/move$/, () => { if (++n === 1) throw new HttpError(503, "busy"); return { id: "AAMk1" }; }]);
    await new GraphProvider(acct).move("AAMk1", "m1:HR");
    expect(n).toBe(2);
  });

  it("graph() retries a throttled call after Retry-After", async () => {
    let n = 0;
    routes.unshift([
      /GET .*\/me\/mailFolders\/inbox\?\$select=totalItemCount/,
      () => {
        if (++n === 1) throw new HttpError(429, "throttled", 2);
        return { totalItemCount: 9 };
      },
    ]);
    await expect(graph("m1", "GET", "/me/mailFolders/inbox?$select=totalItemCount")).resolves.toEqual({ totalItemCount: 9 });
    expect(n).toBe(2);
    expect(slept).toEqual([2000]);
  });
});

describe("GraphProvider.createFolder", () => {
  const posts = () => calls.filter((c) => c.method === "POST").map((c) => [c.url.replace("https://graph.microsoft.com/v1.0", ""), c.body]);

  it("posts a top-level folder to /me/mailFolders and a child to the parent's childFolders", async () => {
    routes.unshift(
      [/POST .*\/me\/mailFolders$/, { id: "KIDS", displayName: "Kids", parentFolderId: "ROOT" }],
      [/POST .*\/mailFolders\/KIDS\/childFolders$/, { id: "SAM", displayName: "Lincoln Elementary – Sam", parentFolderId: "KIDS", unreadItemCount: 0 }],
    );
    const p = new GraphProvider(acct);
    await p.listFolders();
    const top = await p.createFolder("Kids");
    const child = await p.createFolder("Lincoln Elementary – Sam", top.id);
    expect(posts()).toEqual([
      ["/me/mailFolders", { displayName: "Kids" }],
      ["/me/mailFolders/KIDS/childFolders", { displayName: "Lincoln Elementary – Sam" }],
    ]);
    expect(top).toMatchObject({ id: "m1:KIDS", accountId: "m1", name: "Kids", parentId: undefined });
    expect(child).toEqual({ id: "m1:SAM", accountId: "m1", name: "Lincoln Elementary – Sam", parentId: "m1:KIDS", system: undefined, unread: 0 });
    // Both join the cached tree.
    expect((await p.listFolders()).map((f) => f.id)).toEqual(expect.arrayContaining(["m1:KIDS", "m1:SAM"]));
  });

  it("returns the existing folder when Graph answers 409", async () => {
    routes.unshift(
      [/POST .*\/mailFolders\/DEPTS\/childFolders$/, () => { throw new HttpError(409, '{"error":{"code":"ErrorFolderExists"}}'); }],
      [/GET .*\/mailFolders\/DEPTS\/childFolders\?/, { value: [{ id: "HR", displayName: "HR", parentFolderId: "DEPTS", unreadItemCount: 8 }] }],
    );
    const p = new GraphProvider(acct);
    expect(await p.createFolder("hr", "m1:DEPTS")).toMatchObject({ id: "m1:HR", name: "HR", parentId: "m1:DEPTS", unread: 8 });
  });
});
