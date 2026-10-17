// Automatic replies through the Graph and Gmail providers: request shapes and the missing-permission 403.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; url: string; body?: unknown }[] = [];
let reply: (method: string, url: string, body: unknown) => unknown = () => ({});

vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/db", () => ({ cachePutMessages: async () => undefined, cacheListMessages: async () => [], cachePutFolders: async () => undefined, syncGet: async () => null, syncSet: async () => undefined }));
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    request: async (method: string, url: string, opts: { body?: unknown } = {}) => {
      calls.push({ method, url, body: opts.body });
      return reply(method, url, opts.body);
    },
  };
});

const { GraphProvider } = await import("@/lib/microsoft/graph");
const { GmailProvider } = await import("@/lib/google/gmail");
const { HttpError } = await import("@/lib/transport");
const { NeedsPermissionError } = await import("@/lib/mail/auto-replies");

const outlook = new GraphProvider({ id: "o", kind: "m365", name: "Work", address: "z@example.org" });
const gmail = new GmailProvider({ id: "g", kind: "gmail", name: "Me", address: "z@gmail.com" });
const START = Date.UTC(2026, 9, 19, 14, 0);
const END = Date.UTC(2026, 9, 23, 23, 0);

beforeEach(() => {
  calls.length = 0;
  reply = () => ({});
});

describe("Graph automatic replies", () => {
  it("reads the setting", async () => {
    reply = () => ({ status: "alwaysEnabled", externalAudience: "contactsOnly", internalReplyMessage: "<p>Away</p>", externalReplyMessage: "<p>Away</p>" });
    expect(await outlook.getAutoReply()).toEqual({ enabled: true, message: "<p>Away</p>", audience: "contactsOnly" });
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/mailboxSettings/automaticRepliesSetting" });
  });

  it("PATCHes mailboxSettings with automaticRepliesSetting", async () => {
    await outlook.setAutoReply({ enabled: true, start: START, end: END, message: "<p>Away</p>", externalMessage: "<p>Out</p>", audience: "all" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/mailboxSettings");
    expect(calls[0].body).toEqual({
      automaticRepliesSetting: {
        status: "scheduled",
        externalAudience: "all",
        internalReplyMessage: "<p>Away</p>",
        externalReplyMessage: "<p>Out</p>",
        scheduledStartDateTime: { dateTime: "2026-10-19T14:00:00", timeZone: "UTC" },
        scheduledEndDateTime: { dateTime: "2026-10-23T23:00:00", timeZone: "UTC" },
      },
    });
  });

  it("turns a missing-scope 403 into NeedsPermissionError and passes other errors on", async () => {
    reply = () => {
      throw new HttpError(403, '{"error":{"code":"ErrorAccessDenied","message":"Access is denied."}}');
    };
    await expect(outlook.getAutoReply()).rejects.toBeInstanceOf(NeedsPermissionError);
    await expect(outlook.setAutoReply({ enabled: false, message: "", audience: "all" })).rejects.toBeInstanceOf(NeedsPermissionError);
    reply = () => {
      throw new HttpError(400, "bad");
    };
    await expect(outlook.getAutoReply()).rejects.toMatchObject({ status: 400 });
  });
});

describe("Gmail automatic replies", () => {
  it("reads the vacation setting", async () => {
    reply = () => ({ enableAutoReply: true, responseBodyHtml: "<p>Away</p>", restrictToContacts: false, restrictToDomain: false, startTime: String(START), endTime: String(END) });
    expect(await gmail.getAutoReply()).toEqual({ enabled: true, start: START, end: END, message: "<p>Away</p>", audience: "all" });
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation" });
  });

  it("PUTs string times and drops the Outlook-only external message", async () => {
    await gmail.setAutoReply({ enabled: true, start: START, end: END, message: "<p>Away</p>", externalMessage: "<p>Out</p>", audience: "contactsOnly" });
    expect(calls[0].method).toBe("GET");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation");
    expect(put.body).toEqual({
      enableAutoReply: true,
      responseBodyHtml: "<p>Away</p>",
      restrictToContacts: true,
      restrictToDomain: false,
      startTime: String(START),
      endTime: String(END),
    });
  });

  it("keeps fields it doesn't edit when saving", async () => {
    reply = (method) => (method === "GET" ? { responseSubject: "OOO", restrictToDomain: true, someUnknownField: 1, startTime: "1" } : {});
    await gmail.setAutoReply({ enabled: true, message: "<p>New</p>", audience: "none", subject: "OOO" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ responseSubject: "OOO", restrictToDomain: true, someUnknownField: 1, responseBodyHtml: "<p>New</p>" });
    expect(put.body).not.toHaveProperty("startTime");
  });

  it("keeps the Gmail subject when the reply carries none", async () => {
    reply = (method) => (method === "GET" ? { responseSubject: "OOO" } : {});
    await gmail.setAutoReply({ enabled: true, message: "<p>x</p>", audience: "all" });
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ responseSubject: "OOO" });
  });

  it("falls back to a plain PUT when reading the current setting fails", async () => {
    reply = (method) => {
      if (method === "GET") throw new HttpError(500, "boom");
      return {};
    };
    await gmail.setAutoReply({ enabled: true, message: "<p>x</p>", audience: "all" });
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ enableAutoReply: true, responseBodyHtml: "<p>x</p>" });
  });

  it("turns a missing-scope 403 into NeedsPermissionError", async () => {
    reply = () => {
      throw new HttpError(403, '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}');
    };
    await expect(gmail.getAutoReply()).rejects.toBeInstanceOf(NeedsPermissionError);
    await expect(gmail.setAutoReply({ enabled: false, message: "", audience: "all" })).rejects.toBeInstanceOf(NeedsPermissionError);
  });
});
