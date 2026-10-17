// Rich signature editor in the spirit of Outlook's: a contenteditable "paper"
// with a formatting toolbar, paste that keeps Outlook/Word formatting, and an
// HTML source view. Uses execCommand because it preserves the arbitrary tables
// and inline styles real signatures are built from (schema editors flatten them).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bold, Code, Eraser, Highlighter, ImagePlus, Italic, Link2, Redo2, Underline, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { freezeImageSizes, sanitizeSignature } from "@/lib/signature";
import { cn } from "@/lib/utils";

const FONTS = ["Aptos", "Arial", "Calibri", "Cambria", "Georgia", "Helvetica", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36];
const COLORS = ["#000000", "#404040", "#7f7f7f", "#ffffff", "#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050", "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0", "#70002e", "#ff66cc"];
const HIGHLIGHTS = ["#ffff00", "#00ff00", "#00ffff", "#ff00ff", "#c0c0c0"];
/** Logos past this size bloat every message you send. */
const IMAGE_WARN = 250 * 1024;

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      // Keep the editor's selection when clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-foreground/65 hover:bg-foreground/[0.07] hover:text-foreground",
        active && "bg-foreground/10 text-foreground",
      )}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-hairline" />;

export function SignatureEditor({ value, onChange, docKey }: { value: string; onChange: (html: string) => void; docKey: string }) {
  const editor = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [state, setState] = useState({ bold: false, italic: false, underline: false, font: "", size: "" });
  const [link, setLink] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const watched = useRef(new WeakSet<HTMLImageElement>());
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  /**
   * Pin images to the size they show at here (Outlook would otherwise send an unsized
   * logo at its intrinsic size), and do it again for any image still loading once it
   * loads, saving the result. Returns whether anything changed now.
   */
  const settleImages = useCallback((): boolean => {
    const el = editor.current;
    if (!el) return false;
    const changed = freezeImageSizes(el);
    for (const img of el.querySelectorAll("img")) {
      if ((img.hasAttribute("width") && img.hasAttribute("height")) || watched.current.has(img)) continue;
      watched.current.add(img);
      img.addEventListener(
        "load",
        () => {
          const root = editor.current;
          // Ignore images from a signature that's since been swapped out.
          if (root?.contains(img) && freezeImageSizes(root)) onChangeRef.current(root.innerHTML);
        },
        { once: true },
      );
    }
    return changed;
  }, []);

  // Load a signature's HTML when switching signatures (the editor is uncontrolled while typing).
  const [prevDocKey, setPrevDocKey] = useState(docKey);
  if (prevDocKey !== docKey) {
    setPrevDocKey(docKey);
    setSource(null);
  }
  useEffect(() => {
    if (!editor.current) return;
    editor.current.innerHTML = value;
    // Saved without sizes (pasted before sizes were pinned): fix it now that it's shown.
    if (settleImages()) onChange(editor.current.innerHTML);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  const emit = useCallback(() => {
    if (!editor.current) return;
    settleImages();
    onChange(editor.current.innerHTML);
  }, [onChange, settleImages]);

  const refresh = useCallback(() => {
    const sel = document.getSelection();
    const node = sel?.anchorNode;
    if (!node || !editor.current?.contains(node)) return;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const cs = el ? getComputedStyle(el) : null;
    const pt = cs ? Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2 : 0;
    setState({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      font: cs?.fontFamily.split(",")[0].replace(/["']/g, "").trim() ?? "",
      size: pt ? String(pt) : "",
    });
  }, []);

  // Remember the last selection inside the editor so toolbar popovers and selects can act on it.
  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      if (sel?.rangeCount && editor.current?.contains(sel.anchorNode)) {
        saved.current = sel.getRangeAt(0).cloneRange();
        refresh();
      }
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [refresh]);

  const restore = () => {
    const el = editor.current;
    if (!el) return;
    el.focus();
    const sel = document.getSelection();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
  };

  const exec = (cmd: string, arg?: string) => {
    restore();
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(cmd, false, arg);
    emit();
    refresh();
  };

  /** execCommand only knows sizes 1–7; mark with 7, then swap in a real point size. */
  const setSize = (pt: number) => {
    restore();
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("fontSize", false, "7");
    for (const f of editor.current?.querySelectorAll('font[size="7"]') ?? []) {
      const span = document.createElement("span");
      span.style.fontSize = `${pt}pt`;
      span.append(...f.childNodes);
      f.replaceWith(span);
    }
    document.execCommand("styleWithCSS", false, "true");
    emit();
    refresh();
  };

  const insertImage = async (file: Blob) => {
    if (file.size > IMAGE_WARN) toast.warning("That image is large", { description: "It's sent with every message. A smaller logo (under 100 KB) is kinder to inboxes." });
    exec("insertImage", await readAsDataUrl(file));
  };

  /** Pasted images that point at local files won't survive sending; inline them if we can. */
  const embedLocalImages = async () => {
    const imgs = [...(editor.current?.querySelectorAll("img") ?? [])].filter((i) => !/^(data:|https?:|cid:)/i.test(i.getAttribute("src") ?? ""));
    let failed = 0;
    for (const img of imgs) {
      try {
        const blob = await (await fetch(img.src)).blob();
        img.src = await readAsDataUrl(blob);
      } catch {
        failed++;
      }
    }
    if (failed) toast.error("Couldn't bring an image across", { description: "Use the image button to add your logo file." });
    if (imgs.length) emit();
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const html = e.clipboardData.getData("text/html");
    const image = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
    if (html) {
      e.preventDefault();
      exec("insertHTML", sanitizeSignature(html));
      await embedLocalImages();
    } else if (image) {
      e.preventDefault();
      await insertImage(image);
    }
  };

  const toggleSource = () => {
    if (source === null) {
      if (editor.current && settleImages()) onChange(editor.current.innerHTML);
      return setSource(editor.current?.innerHTML ?? value);
    }
    const clean = sanitizeSignature(source);
    setSource(null);
    requestAnimationFrame(() => {
      if (!editor.current) return onChange(clean);
      editor.current.innerHTML = clean;
      emit();
    });
  };

  const select = "h-7 shrink-0 rounded-md border border-hairline bg-[var(--pane)] px-1.5 text-[12px] outline-none disabled:opacity-40";
  const rich = source === null;

  return (
    <div className="overflow-hidden rounded-xl border border-hairline">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-hairline bg-pane-2 px-2 py-1.5">
        <ToolButton label="Undo" onClick={() => exec("undo")}>
          <Undo2 className="size-4" />
        </ToolButton>
        <ToolButton label="Redo" onClick={() => exec("redo")}>
          <Redo2 className="size-4" />
        </ToolButton>
        <Divider />
        <select
          aria-label="Font"
          disabled={!rich}
          value={FONTS.includes(state.font) ? state.font : ""}
          onChange={(e) => exec("fontName", e.target.value)}
          className={cn(select, "w-[124px]")}
        >
          <option value="" disabled>
            {state.font || "Font"}
          </option>
          {FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
        <select
          aria-label="Size"
          disabled={!rich}
          value={SIZES.map(String).includes(state.size) ? state.size : ""}
          onChange={(e) => setSize(Number(e.target.value))}
          className={cn(select, "ml-1 w-[54px]")}
        >
          <option value="" disabled>
            {state.size || "Size"}
          </option>
          {SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <Divider />
        <ToolButton label="Bold" active={state.bold} onClick={() => exec("bold")}>
          <Bold className="size-4" />
        </ToolButton>
        <ToolButton label="Italic" active={state.italic} onClick={() => exec("italic")}>
          <Italic className="size-4" />
        </ToolButton>
        <ToolButton label="Underline" active={state.underline} onClick={() => exec("underline")}>
          <Underline className="size-4" />
        </ToolButton>
        <Swatches label="Text color" colors={COLORS} onPick={(c) => exec("foreColor", c)} custom>
          <span className="flex flex-col items-center leading-none">
            <span className="text-[13px] font-semibold">A</span>
            <span className="mt-px h-[3px] w-3.5 rounded-full bg-[#c00000]" />
          </span>
        </Swatches>
        <Swatches label="Highlight" colors={HIGHLIGHTS} onPick={(c) => exec("hiliteColor", c)} onClear={() => exec("hiliteColor", "transparent")}>
          <Highlighter className="size-4" />
        </Swatches>
        <Divider />
        <Popover open={linkOpen} onOpenChange={(o) => (setLinkOpen(o), o && setLink(""))}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Link"
                title="Link"
                onMouseDown={(e) => e.preventDefault()}
                className="grid size-7 place-items-center rounded-md text-foreground/65 hover:bg-foreground/[0.07] hover:text-foreground"
              >
                <Link2 className="size-4" />
              </button>
            }
          />
          <PopoverContent align="start" className="w-72">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const url = link.trim();
                if (!url) return;
                const href = /^(https?:|mailto:)/i.test(url) ? url : url.includes("@") ? `mailto:${url}` : `https://${url}`;
                setLinkOpen(false);
                if (saved.current?.collapsed) exec("insertHTML", `<a href="${href.replace(/"/g, "&quot;")}">${url.replace(/</g, "&lt;")}</a>`);
                else exec("createLink", href);
              }}
              className="flex gap-1.5"
            >
              <input
                autoFocus
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="example.org/it or name@example.org"
                className="selectable h-7 flex-1 rounded-md border border-hairline bg-[var(--pane)] px-2 text-[12px] outline-none"
              />
              <button className="h-7 rounded-md bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground">Link</button>
            </form>
          </PopoverContent>
        </Popover>
        <ToolButton label="Insert image" onClick={() => imageInput.current?.click()}>
          <ImagePlus className="size-4" />
        </ToolButton>
        <ToolButton label="Clear formatting" onClick={() => exec("removeFormat")}>
          <Eraser className="size-4" />
        </ToolButton>
        <button
          type="button"
          onClick={toggleSource}
          className={cn(
            "ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-foreground/60 hover:bg-foreground/[0.07]",
            !rich && "bg-primary/10 text-primary",
          )}
        >
          <Code className="size-3.5" /> {rich ? "Edit HTML" : "Done"}
        </button>
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void insertImage(f);
            e.target.value = "";
          }}
        />
      </div>
      {/* White paper: signatures are designed for how recipients see them. */}
      <div className={cn("bg-white", !rich && "hidden")}>
        <div
          ref={editor}
          contentEditable
          suppressContentEditableWarning
          spellCheck
          role="textbox"
          aria-multiline
          aria-label="Signature"
          onInput={emit}
          onBlur={emit}
          onPaste={(e) => void onPaste(e)}
          onKeyUp={refresh}
          onMouseUp={refresh}
          className="selectable max-h-[420px] min-h-[180px] overflow-auto px-5 py-4 text-[11pt] text-[#1d1d1f] outline-none [font-family:Aptos,Calibri,Helvetica,Arial,sans-serif] [&_a]:text-[#0563c1] [&_a]:underline [&_img]:inline-block"
        />
      </div>
      {!rich && (
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          spellCheck={false}
          aria-label="Signature HTML"
          className="selectable block max-h-[420px] min-h-[220px] w-full resize-y bg-[var(--pane)] px-4 py-3 font-mono text-[11.5px] leading-relaxed outline-none"
        />
      )}
    </div>
  );
}

function Swatches({
  label,
  colors,
  onPick,
  onClear,
  custom,
  children,
}: {
  label: string;
  colors: string[];
  onPick: (c: string) => void;
  onClear?: () => void;
  custom?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pick = (c: string) => {
    setOpen(false);
    onPick(c);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            onMouseDown={(e) => e.preventDefault()}
            className="grid size-7 place-items-center rounded-md text-foreground/65 hover:bg-foreground/[0.07] hover:text-foreground"
          >
            {children}
          </button>
        }
      />
      <PopoverContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-8 gap-1">
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(c)}
              className="size-5 rounded ring-1 ring-foreground/15 hover:scale-110"
              style={{ background: c }}
            />
          ))}
        </div>
        {(custom || onClear) && (
          <div className="mt-2 flex items-center gap-3 text-[11.5px] text-foreground/60">
            {custom && (
              <label className="flex cursor-pointer items-center gap-1.5 hover:text-foreground">
                <input type="color" className="size-5 cursor-pointer border-0 bg-transparent p-0" onChange={(e) => onPick(e.target.value)} />
                Custom…
              </label>
            )}
            {onClear && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onClear();
                }}
                className="hover:text-foreground"
              >
                No highlight
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
