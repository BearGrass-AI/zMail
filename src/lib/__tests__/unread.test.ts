// Today lists: unread first, read after (or hidden); the open email holds its place.
import { describe, expect, it } from "vitest";
import { sortNeeds, todayList, unreadCount } from "@/lib/mail/unread";

const e = (id: string, unread: boolean) => ({ id, unread });
const L = [e("a", false), e("b", true), e("c", false), e("d", true)];

describe("todayList", () => {
  it("puts unread first, keeping each part's order", () => {
    expect(todayList(L, "all").list.map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
    expect(todayList(L, "all").read).toBe(2);
  });
  it("hides read mail with the switch on Unread", () => {
    expect(todayList(L, "unread").list.map((x) => x.id)).toEqual(["b", "d"]);
    expect(todayList(L, "unread").read).toBe(2);
  });
  it("keeps the open email where it was even after it's marked read", () => {
    expect(todayList(L, "all", "a").list.map((x) => x.id)).toEqual(["a", "b", "d", "c"]);
    expect(todayList(L, "unread", "c").list.map((x) => x.id)).toEqual(["b", "c", "d"]);
  });
  it("keeps every id in a set in place", () => {
    const keep = new Set(["a", "c"]);
    expect(todayList(L, "all", keep).list.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(todayList(L, "unread", keep).list.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(todayList(L, "all", keep).read).toBe(0);
  });
  it("counts unread", () => {
    expect(unreadCount(L)).toBe(2);
  });
});

describe("sortNeeds", () => {
  const l = [{ id: "a", date: "2026-09-02T00:00:00Z" }, { id: "b", date: "2026-07-26T00:00:00Z" }, { id: "c", date: "2026-09-30T00:00:00Z" }];
  it("keeps the model's order for urgency", () => {
    expect(sortNeeds(l, "urgency").map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
  it("sorts newest or oldest first without changing the input", () => {
    expect(sortNeeds(l, "newest").map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(sortNeeds(l, "oldest").map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(l.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});
