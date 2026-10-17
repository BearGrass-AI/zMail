// @vitest-environment jsdom
// Recipient suggestions: people from your mail show on the keystroke, directory results merge in
// when they arrive without moving the highlighted row, and an answer to an older query is dropped.
import { createElement, act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";
import type { Person } from "@/lib/contacts";

vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

const h = vi.hoisted(() => ({ calls: [] as { q: string; resolve: (lists: Person[][]) => void }[] }));
vi.mock("@/lib/contacts", async (orig) => ({
  ...(await orig<typeof import("@/lib/contacts")>()),
  searchRemotePeople: (q: string) => new Promise<Person[][]>((resolve) => h.calls.push({ q, resolve })),
}));

import { AddressInput, REMOTE_DEBOUNCE_MS } from "@/components/mail/people-suggest";
import { keepInPlace } from "@/lib/contacts";
import { useMail } from "@/lib/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const me = { id: "a", kind: "m365" as const, name: "Me", address: "me@x.edu" };
const mail = (id: string, name: string, address: string) =>
  ({ id, accountId: "a", threadId: id, folderId: "a:inbox", from: { name, address }, to: [{ name: "Me", address: "me@x.edu" }], subject: "Hi", snippet: "", text: "", date: "2026-10-01T10:00:00Z", unread: false, starred: false, labels: [] }) as unknown as Email;
const directory = (name: string, address: string): Person => ({ name, address, source: "directory", title: "Director" });

function Field() {
  const [value, setValue] = useState("");
  return createElement(AddressInput, { value, onChange: setValue });
}

let root: Root;
const input = () => document.querySelector("input")!;
const type = (text: string) =>
  act(() => {
    const el = input();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
const highlighted = () => document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? "";
const answer = async (i: number, lists: Person[][]) => {
  await act(async () => {
    h.calls[i].resolve(lists);
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  h.calls.length = 0;
  useMail.setState({ accounts: [me] as never, emails: [mail("1", "Dana Morrow", "dana@x.edu"), mail("2", "Dan Price", "dan.price@x.edu")] });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(createElement(Field)));
  act(() => input().focus());
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("recipient suggestions", () => {
  it("shows people from your mail on the keystroke, before any network answer", () => {
    type("dana");
    expect(options().join("|")).toContain("Dana Morrow");
    expect(h.calls).toHaveLength(0);
  });

  it("asks the directory once typing pauses, and merges its answer in", async () => {
    type("da");
    type("dan");
    act(() => vi.advanceTimersByTime(REMOTE_DEBOUNCE_MS));
    expect(h.calls.map((c) => c.q)).toEqual(["dan"]);
    await answer(0, [[directory("Dana Whitfield", "dana.whitfield@x.edu")]]);
    expect(options().join("|")).toContain("Dana Whitfield");
  });

  it("keeps the highlighted person in place when better directory matches arrive", async () => {
    type("dan");
    act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const before = highlighted();
    const at = options().indexOf(before);
    expect(at).toBe(1);
    act(() => vi.advanceTimersByTime(REMOTE_DEBOUNCE_MS));
    await answer(0, [[directory("Dan Abbott", "dan.abbott@x.edu"), directory("Danielle Ross", "danielle@x.edu")]]);
    expect(options()).toHaveLength(4);
    expect(highlighted()).toBe(before);
    expect(options().indexOf(highlighted())).toBe(at);
  });

  it("drops an answer to a query you've typed past", async () => {
    type("dan");
    act(() => vi.advanceTimersByTime(REMOTE_DEBOUNCE_MS));
    type("dana");
    act(() => vi.advanceTimersByTime(REMOTE_DEBOUNCE_MS));
    expect(h.calls.map((c) => c.q)).toEqual(["dan", "dana"]);
    // The older search answers last, with someone who also matches "dana".
    await answer(1, [[]]);
    await answer(0, [[directory("Dana Stale", "stale@x.edu")]]);
    expect(options().join("|")).not.toContain("Dana Stale");
  });
});

describe("keepInPlace", () => {
  const p = (address: string): Person => ({ name: address, address, source: "mail" });
  it("holds the row at its index while the rest re-rank around it", () => {
    expect(keepInPlace([p("a"), p("b")], [p("x"), p("a"), p("b")], 1).map((x) => x.address)).toEqual(["x", "b", "a"]);
    expect(keepInPlace([p("a"), p("b")], [p("x"), p("b"), p("a")], 0).map((x) => x.address)).toEqual(["a", "x", "b"]);
  });
  it("keeps a held row the new answer left out, without growing past the list", () => {
    expect(keepInPlace([p("a")], [p("x"), p("y")], 0).map((x) => x.address)).toEqual(["a", "x"]);
    expect(keepInPlace([], [p("x")], 0).map((x) => x.address)).toEqual(["x"]);
  });
});
