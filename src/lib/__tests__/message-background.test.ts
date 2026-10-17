// @vitest-environment jsdom
// Settings › Appearance › Message background, end to end through the email body:
// Match theme renders a light-designed email adapted on the dark card, Always light
// keeps the white card, and the per-email ☀ toggle switches that one email to light.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Email } from "@/lib/types";
import { EmailBody, useLightForced } from "@/components/mail/email-body";
import { useSettings } from "@/lib/settings";
import { DARK_CSS, LIGHT_CSS } from "@/lib/mail/email-frame";
import { OUTLOOK } from "./fixtures/dark-mail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const email = {
  id: "bg-1",
  accountId: "m",
  threadId: "bg-1",
  folderId: "m:inbox",
  from: { name: "Jordan Example", address: "jordan@example.org" },
  to: [{ name: "Z", address: "z@example.org" }],
  subject: "Budget draft",
  snippet: "Budget draft",
  text: "Hi team",
  html: OUTLOOK,
  date: "2026-10-12T15:14:00Z",
  unread: false,
  starred: false,
  labels: [],
} as unknown as Email;

let root: Root;
let host: HTMLDivElement;

function frame() {
  const f = host.querySelector("iframe");
  if (!f) throw new Error("no frame");
  return f.getAttribute("srcdoc") ?? "";
}

async function show() {
  await act(async () => root.render(createElement(EmailBody, { email })));
}

beforeEach(() => {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useLightForced.setState({ ids: new Set() });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("message background setting", () => {
  it("Match theme in dark mode renders the Outlook email adapted on the dark card", async () => {
    useSettings.setState({ theme: "dark", messageBackground: "theme" });
    await show();
    expect(frame()).toContain(DARK_CSS);
    // The Outlook body's black text is rewritten for the card in the frame only.
    expect(frame()).not.toMatch(/color:black/);
    expect(email.html).toContain("color:black");
  });
  it("Always light keeps the white card", async () => {
    useSettings.setState({ theme: "dark", messageBackground: "light" });
    await show();
    expect(frame()).toContain(LIGHT_CSS);
    expect(frame()).toContain("color:black");
  });
  it("the per-email light toggle switches just that email to the white card", async () => {
    useSettings.setState({ theme: "dark", messageBackground: "theme" });
    await show();
    expect(frame()).toContain(DARK_CSS);
    await act(async () => useLightForced.getState().toggle(email.id));
    expect(frame()).toContain(LIGHT_CSS);
    await act(async () => useLightForced.getState().toggle(email.id));
    expect(frame()).toContain(DARK_CSS);
  });
  it("a light app theme keeps the white card", async () => {
    useSettings.setState({ theme: "light", messageBackground: "theme" });
    await show();
    expect(frame()).toContain(LIGHT_CSS);
  });
});
