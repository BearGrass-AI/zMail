// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RichEditor } from "@/components/mail/rich-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
function render(autoFocus: boolean, root = createRoot(document.body.appendChild(document.createElement("div")))) {
  act(() => root.render(createElement(RichEditor, { html: "", onChange: noop, onSubmit: noop, onFiles: noop, autoFocus })));
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RichEditor autoFocus", () => {
  it("focuses the body when it first appears with autoFocus", () => {
    render(true);
    expect(document.activeElement?.getAttribute("contenteditable")).toBe("true");
  });

  it("does not steal focus when autoFocus turns on later (typing the first letter in To)", () => {
    const to = document.body.appendChild(document.createElement("input"));
    const root = render(false);
    to.focus();
    render(true, root);
    expect(document.activeElement).toBe(to);
  });
});
