// @vitest-environment jsdom
// Row clicks: plain click opens; once anything is ticked, a plain click ticks or unticks instead.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

import { useRowSelect } from "@/components/selection";
import { useMail } from "@/lib/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Row({ id }: { id: string }) {
  const sel = useRowSelect(id, () => ["a", "b", "c"]);
  return createElement("div", { "data-id": id, onClick: sel.onClick }, id);
}

let root: Root;
const click = (id: string, init: MouseEventInit = {}) =>
  act(() => document.querySelector(`[data-id="${id}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })));

beforeEach(() => {
  useMail.setState({ checked: new Set(), checkAnchor: null, selectedId: null });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(createElement("div", null, ...["a", "b", "c"].map((id) => createElement(Row, { id, key: id })))));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("useRowSelect", () => {
  it("opens the email on a plain click when nothing is ticked", () => {
    click("a");
    expect(useMail.getState().selectedId).toBe("a");
    expect(useMail.getState().checked.size).toBe(0);
  });

  it("ticks and unticks on plain clicks once something is ticked", () => {
    click("a", { metaKey: true });
    click("b");
    expect([...useMail.getState().checked].sort()).toEqual(["a", "b"]);
    click("a");
    click("b");
    expect(useMail.getState().checked.size).toBe(0);
    expect(useMail.getState().selectedId).toBeNull();
  });

  it("shift-click still extends the range", () => {
    click("a", { metaKey: true });
    click("c", { shiftKey: true });
    expect([...useMail.getState().checked].sort()).toEqual(["a", "b", "c"]);
  });

  it("shift-click after opening an email ticks from the open email to the clicked one, like Mail", () => {
    click("a");
    click("c", { shiftKey: true });
    expect([...useMail.getState().checked].sort()).toEqual(["a", "b", "c"]);
  });

  it("shift-click with nothing open or ticked ticks just that email", () => {
    click("b", { shiftKey: true });
    expect([...useMail.getState().checked]).toEqual(["b"]);
  });
});
