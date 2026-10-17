// Automatic replies: the Outlook and Gmail mappings, permission detection and the sidebar label.
import { describe, expect, it } from "vitest";
import {
  activeNow,
  fromGmailVacation,
  fromGraphSetting,
  fromLocalInput,
  isPermissionError,
  stripText,
  toGmailVacation,
  gmailAudienceOptions,
  toGraphSetting,
  toLocalInput,
  upcoming,
  type AutoReply,
} from "@/lib/mail/auto-replies";
import { HttpError } from "@/lib/transport";

const START = Date.UTC(2026, 9, 19, 14, 0);
const END = Date.UTC(2026, 9, 23, 23, 0);
const scheduled: AutoReply = { enabled: true, start: START, end: END, message: "<p>Away</p>", externalMessage: "<p>Out</p>", audience: "contactsOnly" };
const always: AutoReply = { enabled: true, message: "<p>Away</p>", audience: "all" };
const disabled: AutoReply = { enabled: false, message: "<p>Away</p>", audience: "none" };

describe("Graph mapping", () => {
  it("writes a scheduled reply with UTC times", () => {
    expect(toGraphSetting(scheduled)).toEqual({
      status: "scheduled",
      externalAudience: "contactsOnly",
      internalReplyMessage: "<p>Away</p>",
      externalReplyMessage: "<p>Out</p>",
      scheduledStartDateTime: { dateTime: "2026-10-19T14:00:00", timeZone: "UTC" },
      scheduledEndDateTime: { dateTime: "2026-10-23T23:00:00", timeZone: "UTC" },
    });
  });

  it("round-trips scheduled, always and disabled", () => {
    for (const r of [scheduled, always, disabled]) expect(fromGraphSetting(toGraphSetting(r))).toEqual(r);
    expect(toGraphSetting(always).status).toBe("alwaysEnabled");
    expect(toGraphSetting(disabled).status).toBe("disabled");
    expect(toGraphSetting(always).externalReplyMessage).toBe("<p>Away</p>");
  });

  it("drops an external message equal to the internal one", () => {
    const r = fromGraphSetting({ status: "alwaysEnabled", internalReplyMessage: "<p>Away</p>", externalReplyMessage: " <p>Away</p>\n", externalAudience: "all" });
    expect(r.externalMessage).toBeUndefined();
  });

  it("parses UTC times as UTC and ignores times unless scheduled", () => {
    const r = fromGraphSetting({
      status: "scheduled",
      scheduledStartDateTime: { dateTime: "2026-10-19T14:00:00.0000000", timeZone: "UTC" },
      scheduledEndDateTime: { dateTime: "2026-10-23T23:00:00.0000000", timeZone: "UTC" },
    });
    expect(r.start).toBe(START);
    expect(r.end).toBe(END);
    expect(r.audience).toBe("all");
    expect(r.message).toBe("");
    const off = fromGraphSetting({ status: "alwaysEnabled", scheduledStartDateTime: { dateTime: "2026-10-19T14:00:00", timeZone: "UTC" } });
    expect(off.start).toBeUndefined();
  });

  it("reads a non-UTC time as this Mac's local time", () => {
    const r = fromGraphSetting({
      status: "scheduled",
      scheduledStartDateTime: { dateTime: "2026-10-19T08:00:00", timeZone: "Mountain Standard Time" },
      scheduledEndDateTime: { dateTime: "2026-10-23T17:00:00", timeZone: "Mountain Standard Time" },
    });
    expect(r.start).toBe(new Date(2026, 9, 19, 8, 0).getTime());
  });
});

describe("Gmail mapping", () => {
  it("writes string epoch times and the audience flags", () => {
    expect(toGmailVacation(scheduled)).toEqual({
      enableAutoReply: true,
      responseBodyHtml: "<p>Away</p>",
      restrictToContacts: true,
      restrictToDomain: false,
      startTime: String(START),
      endTime: String(END),
    });
    expect(toGmailVacation(always)).not.toHaveProperty("startTime");
    expect(toGmailVacation(disabled)).toMatchObject({ enableAutoReply: false, restrictToDomain: true, restrictToContacts: false });
  });

  it("round-trips scheduled, always and disabled", () => {
    const { externalMessage: _, ...gmailScheduled } = scheduled;
    for (const r of [gmailScheduled, always, disabled]) expect(fromGmailVacation(toGmailVacation(r))).toEqual(r);
  });

  it("falls back to the plain-text body", () => {
    expect(fromGmailVacation({ enableAutoReply: true, responseBodyPlainText: "Away <now>\nBack Monday" }).message).toBe("Away &lt;now&gt;<br>Back Monday");
  });
});

describe("isPermissionError", () => {
  it("is true for Outlook's and Google's missing-scope 403s", () => {
    expect(isPermissionError(new HttpError(403, '{"error":{"code":"ErrorAccessDenied","message":"Access is denied. Check credentials and try again."}}'))).toBe(true);
    expect(isPermissionError(new HttpError(403, '{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}'))).toBe(true);
  });

  it("is false for rate limits, server errors and other errors", () => {
    expect(isPermissionError(new HttpError(403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}'))).toBe(false);
    expect(isPermissionError(new HttpError(500, "Access is denied"))).toBe(false);
    expect(isPermissionError(new Error("Access is denied"))).toBe(false);
  });
});

describe("active, upcoming and the sidebar label", () => {
  // Wed Oct 14 2026, noon local.
  const now = new Date(2026, 9, 14, 12, 0).getTime();
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).getTime();

  it("knows when replies are on and when they start later", () => {
    expect(activeNow(always, now)).toBe(true);
    expect(activeNow(disabled, now)).toBe(false);
    expect(activeNow({ ...always, start: at(13, 8), end: at(14, 11) }, now)).toBe(false);
    expect(upcoming({ ...always, start: at(15, 8), end: at(16, 17) }, now)).toBe(true);
    expect(upcoming(always, now)).toBe(false);
  });

  it("names a weekday within six days, else a date", () => {
    expect(stripText({ ...always, start: at(13, 8), end: at(16, 17) }, now)).toBe("Auto-replies on until Fri");
    expect(stripText({ ...always, start: at(13, 8), end: at(23, 17) }, now)).toBe("Auto-replies on until Oct 23");
    expect(stripText(always, now)).toBe("Auto-replies on");
    expect(stripText({ ...always, start: at(15, 8), end: at(16, 17) }, now)).toBe("Auto-replies start Thu");
    expect(stripText({ ...always, start: at(26, 8), end: at(30, 17) }, now)).toBe("Auto-replies start Oct 26");
    expect(stripText(disabled, now)).toBeNull();
    expect(stripText({ ...always, start: at(10, 8), end: at(13, 17) }, now)).toBeNull();
  });
});

describe("local input times", () => {
  it("round-trips YYYY-MM-DDTHH:mm and rejects other shapes", () => {
    const ms = new Date(2026, 9, 19, 8, 0).getTime();
    expect(toLocalInput(ms)).toBe("2026-10-19T08:00");
    expect(fromLocalInput("2026-10-19T08:00")).toBe(ms);
    expect(fromLocalInput("2026-10-19 08:00")).toBeUndefined();
    expect(fromLocalInput("2026-02-30T08:00")).toBeUndefined();
    expect(fromLocalInput("2026-10-19T08:00:00Z")).toBeUndefined();
  });
});

describe("Gmail subject and audience", () => {
  it("round-trips responseSubject", () => {
    const r = fromGmailVacation({ enableAutoReply: true, responseSubject: "OOO", responseBodyHtml: "<p>x</p>" });
    expect(r.subject).toBe("OOO");
    expect(toGmailVacation(r).responseSubject).toBe("OOO");
    expect(toGmailVacation({ enabled: true, message: "", audience: "all" })).not.toHaveProperty("responseSubject");
  });

  it("offers the organization choice only when already set", () => {
    expect(gmailAudienceOptions("all").map((o) => o.value)).toEqual(["all", "contactsOnly"]);
    expect(gmailAudienceOptions("none").map((o) => o.value)).toEqual(["all", "contactsOnly", "none"]);
  });
});
