// Renders an email body. HTML is sanitized (DOMPurify) and shown in a
// sandboxed iframe whose CSP blocks all email script; remote images stay off until the user
// allows them; links open in the system browser.

import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { ImageOff } from "lucide-react";
import type { Email } from "@/lib/types";
import { create } from "zustand";
import { useMail } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { DARK_CSS, LIGHT_CSS, forwardKeys, frameSrcDoc } from "@/lib/mail/email-frame";
import { adaptedFor, canRenderDark, darkKindFor, sanitizedFor, type DarkKind } from "@/lib/mail/dark-mode";
import { useAppDark } from "@/lib/theme";

export async function openExternal(url: string) {
  if (!/^(https?:|mailto:)/i.test(url)) return;
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** In-memory (not persisted) set of emails the user switched to the light rendering. */
export const useLightForced = create<{ ids: ReadonlySet<string>; toggle: (id: string) => void }>((set) => ({
  ids: new Set<string>(),
  toggle: (id) =>
    set((s) => {
      const ids = new Set(s.ids);
      if (!ids.delete(id)) ids.add(id);
      return { ids };
    }),
}));

/** Whether this email shows dark right now before any per-email override (setting + app theme + content). */
export function useWouldRenderDark(email: Email) {
  const appDark = useAppDark();
  const bg = useSettings((s) => s.messageBackground);
  const html = email.html;
  return useMemo(() => appDark && bg === "theme" && !!html && canRenderDark(html), [appDark, bg, html]);
}

/** Look up a cid: reference; falls back to the part before "@" (Outlook names often match that way). */
function findCid(cids: Map<string, string>, ref: string) {
  let id = ref;
  try {
    id = decodeURIComponent(ref);
  } catch {
    // keep the raw reference
  }
  id = id.trim().toLowerCase();
  const exact = cids.get(id);
  if (exact) return exact;
  const local = id.split("@")[0];
  for (const [k, v] of cids) if (k.split("@")[0] === local) return v;
  return undefined;
}

/**
 * Sanitize and, unless allowed, neutralize remote images. In dark mode a light-designed
 * email gets its colors adapted for the dark card. `dark` says whether it rendered dark.
 */
export function prepareHtml(html: string, allowImages: boolean, mode: "light" | "dark" = "light", cids?: Map<string, string>) {
  let blocked = 0;
  const clean = sanitizedFor(html);
  let kind: DarkKind = mode === "dark" ? darkKindFor(clean) : "light";
  const adapted = kind === "adapt" ? adaptedFor(clean, allowImages) : null;
  if (kind === "adapt" && adapted === null) kind = "light";
  const dark = kind !== "light";
  const doc = new DOMParser().parseFromString(`<body>${adapted ?? clean}</body>`, "text/html");
  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (/^cid:/i.test(src)) {
      // Embedded part: show it when fetched, else leave the placeholder. Never a tracker.
      const url = cids && findCid(cids, src.slice(4));
      if (url) img.setAttribute("src", url);
      else img.removeAttribute("src");
      continue;
    }
    if (/^https?:/i.test(src) && !allowImages) {
      img.setAttribute("data-zmail-src", src);
      img.removeAttribute("src");
      img.setAttribute("alt", img.getAttribute("alt") || "");
      blocked++;
    }
  }
  // Every link asks for a new window, which the app opens in the default browser.
  // A link without a target would otherwise navigate the email frame itself.
  for (const a of doc.querySelectorAll("a[href]")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  // Background images and video posters are trackers too. The frame's CSP blocks
  // every remote load anyway; this rewrite counts them for the banner.
  if (!allowImages) {
    for (const el of doc.querySelectorAll<HTMLElement>("[style]")) {
      if (!/url\(/i.test(el.getAttribute("style") ?? "")) continue;
      el.style.backgroundImage = "none";
      blocked++;
    }
    for (const el of doc.querySelectorAll("[background]")) {
      const bg = el.getAttribute("background") ?? "";
      if (!/^https?:/i.test(bg.trim())) continue;
      el.setAttribute("data-zmail-background", bg);
      el.removeAttribute("background");
      blocked++;
    }
    for (const v of doc.querySelectorAll("video[poster]")) {
      const poster = v.getAttribute("poster") ?? "";
      if (!/^https?:/i.test(poster.trim())) continue;
      v.setAttribute("data-zmail-poster", poster);
      v.removeAttribute("poster");
      blocked++;
    }
  }
  // Exactly one of the email's light/dark media rules must match. Its own dark
  // design: its dark rules apply and light ones never do. Otherwise (the white
  // card, or its light design adapted for the dark card, which has no dark rules)
  // the reverse, so white-on-white text from a dark card can't happen.
  const ownDark = kind === "own" || kind === "simple";
  const [onDark, onLight] = ownDark ? ["(min-width: 0px)", "(max-width: 0px)"] : ["(max-width: 0px)", "(min-width: 0px)"];
  for (const style of doc.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    // Remote url()/@import in a stylesheet: left as is (the CSP blocks them), but
    // counted so a styles-only email still offers "Load images".
    if (!allowImages) {
      blocked += (css.match(/url\(\s*["']?\s*https?:/gi) ?? []).length;
      blocked += (css.match(/@import\s+(url\()?\s*["']?\s*https?:/gi) ?? []).length;
    }
    style.textContent = css
      .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, onDark)
      .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, onLight);
  }
  return { html: doc.body.innerHTML, blocked, dark };
}

function HtmlFrame({ html, dark, allowRemote }: { html: string; dark: boolean; allowRemote: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    let stopKeys: (() => void) | undefined;
    const onLoad = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const measure = () => setHeight(Math.max(80, doc.documentElement.scrollHeight));
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(doc.body);
      doc.addEventListener("click", (e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        void openExternal(a.href);
      });
      stopKeys?.();
      stopKeys = forwardKeys(doc, frame);
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
      stopKeys?.();
    };
  }, [html, dark, allowRemote]);

  return (
    <iframe
      ref={ref}
      // aria-label, not title: WebKit shows an iframe's title as a hover tooltip.
      aria-label="Email content"
      // allow-scripts lets WebKit run zMail's listeners on the email document (key
      // forwarding, link clicks, height); the CSP meta in frameSrcDoc blocks every
      // script in the email itself. allow-same-origin lets zMail reach the document.
      // allow-popups keeps the native new-window handler as the fallback link path.
      sandbox="allow-same-origin allow-scripts allow-popups"
      srcDoc={frameSrcDoc(dark ? DARK_CSS : LIGHT_CSS, html, allowRemote)}
      style={{ height, colorScheme: dark ? "dark" : "light" }}
      className={`selectable block w-full rounded-xl border border-hairline ${dark ? "bg-[#16181c]" : "bg-white"}`}
    />
  );
}

const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function PlainText({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <div className="selectable text-[14.5px] leading-relaxed whitespace-pre-wrap text-foreground/90">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} onClick={(e) => (e.preventDefault(), void openExternal(p))} className="text-primary underline-offset-2 hover:underline">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </div>
  );
}

export function EmailBody({ email }: { email: Email }) {
  const imageSenders = useMail((s) => s.imageSenders);
  const allowSender = useMail((s) => s.allowImagesFrom);
  const [showOnce, setShowOnce] = useState(false);
  const sender = email.from.address.toLowerCase();
  const allow = showOnce || imageSenders.has(sender);
  const [shownFor, setShownFor] = useState(email.id);
  if (shownFor !== email.id) {
    setShownFor(email.id);
    setShowOnce(false);
  }

  const wouldDark = useWouldRenderDark(email);
  const forcedLight = useLightForced((s) => s.ids.has(email.id));
  const mode = wouldDark && !forcedLight ? "dark" : "light";
  const needsCids = useMemo(() => /cid:/i.test(email.html ?? ""), [email.html]);
  const inlineImages = useMail((s) => s.inlineImages);
  const [loaded, setLoaded] = useState<{ id: string; map: Map<string, string> }>();
  const cids = needsCids && loaded?.id === email.id ? loaded.map : undefined;
  useEffect(() => {
    if (!needsCids) return;
    let live = true;
    inlineImages(email.id).then((m) => live && setLoaded({ id: email.id, map: m }));
    return () => {
      live = false;
    };
  }, [email.id, needsCids, inlineImages]);
  const prepared = useMemo(() => (email.html ? prepareHtml(email.html, allow, mode, cids) : null), [email.html, allow, mode, cids]);

  if (!prepared) return <PlainText text={email.text} />;
  return (
    <div>
      {prepared.blocked > 0 && !allow && (
        <div className="mb-3 flex items-center gap-2.5 rounded-lg bg-foreground/[0.05] px-3 py-2 text-[12.5px] text-foreground/65">
          <ImageOff className="size-3.5 shrink-0" />
          <span className="flex-1">Remote images are hidden to protect your privacy.</span>
          <button onClick={() => setShowOnce(true)} className="font-medium text-primary hover:underline">
            Load images
          </button>
          <span className="text-foreground/25">·</span>
          <button onClick={() => allowSender(sender)} className="font-medium text-primary hover:underline">
            Always for {email.from.name.split(/[\s(]/)[0]}
          </button>
        </div>
      )}
      <HtmlFrame html={prepared.html} dark={prepared.dark} allowRemote={allow} />
    </div>
  );
}
