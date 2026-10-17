import { describe, expect, it } from "vitest";
import { calendarToInfo, eventToCal, hexToHue, withResponse, type GEvent } from "@/lib/google/calendar-map";

const MEET: GEvent = {
  id: "abc123",
  summary: "Deans & Directors",
  location: "Admin Building 210",
  start: { dateTime: "2026-10-09T14:00:00-06:00" },
  end: { dateTime: "2026-10-09T15:00:00-06:00" },
  organizer: { email: "Provost@example.org" },
  attendees: [
    { email: "provost@example.org", displayName: "Office of the Provost", organizer: true, responseStatus: "accepted" },
    { email: "alex@example.org", self: true, responseStatus: "needsAction" },
  ],
  hangoutLink: "https://meet.google.com/abc-defg-hij",
};

describe("google calendar mapping", () => {
  it("maps a timed Meet event, tying it to the organizer's mail", () => {
    const e = eventToCal("g1:primary", MEET)!;
    expect(e).toMatchObject({
      id: "g1:primary:abc123",
      calendarId: "g1:primary",
      title: "Deans & Directors",
      video: true,
      joinUrl: "https://meet.google.com/abc-defg-hij",
      allDay: false,
      related: { from: "provost@example.org" },
    });
    expect(e.start).toBe(new Date("2026-10-09T20:00:00Z").toISOString());
    expect(e.attendees).toEqual([{ name: "Office of the Provost", address: "provost@example.org" }]);
  });

  it("maps all-day events and drops cancelled ones", () => {
    expect(eventToCal("c", { id: "x", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } })!.allDay).toBe(true);
    expect(eventToCal("c", { ...MEET, status: "cancelled" })).toBeNull();
  });

  it("sets only my RSVP", () => {
    const att = withResponse(MEET, "accepted");
    expect(att.find((a) => a.self)!.responseStatus).toBe("accepted");
    expect(att.find((a) => a.organizer)!.responseStatus).toBe("accepted");
  });

  it("derives calendar hue from Google's color", () => {
    expect(hexToHue("#ff0000")).toBe(0);
    expect(hexToHue("#0000ff")).toBe(240);
    expect(calendarToInfo("g1", { id: "primary", summary: "Alex", backgroundColor: "#00ff00" })).toEqual({
      id: "g1:primary", accountId: "g1", name: "Alex", source: "google", hue: 120,
    });
  });
});
