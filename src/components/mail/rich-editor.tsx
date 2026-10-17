import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bold, Italic, Link as LinkIcon, List, ListOrdered, RemoveFormatting, Underline } from "lucide-react";
import { WithTip } from "@/components/icon-button";
import { cleanBodyHtml } from "@/lib/mail/compose-html";
import { cn } from "@/lib/utils";

type State = "bold" | "italic" | "underline" | "insertUnorderedList" | "insertOrderedList";
const STATES: State[] = ["bold", "italic", "underline", "insertUnorderedList", "insertOrderedList"];

const btn = "grid size-7 place-items-center rounded-md text-foreground/60 hover:bg-foreground/5 [&_svg]:size-3.5";

/** A toolbar button; mouse-down is swallowed so the editor keeps its selection. */
function Tool(props: { label: string; shortcut?: string; icon: ReactNode; onClick: () => void; pressed?: boolean }) {
  const { label, shortcut, icon, onClick, pressed } = props;
  return (
    <WithTip tip={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn(btn, pressed && "bg-primary/15 text-primary hover:bg-primary/15")}
      >
        {icon}
      </button>
    </WithTip>
  );
}

/** The draft body: a contentEditable field under an always-visible formatting toolbar. */
export function RichEditor(props: {
  html: string;
  onChange: (html: string) => void;
  onSubmit: () => void;
  onFiles: (files: FileList) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const { html, onChange, onSubmit, onFiles, autoFocus, className } = props;
  const ref = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [active, setActive] = useState<Partial<Record<State, boolean>>>({});
  const [dragging, setDragging] = useState(false);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const urlInput = useRef<HTMLInputElement>(null);

  // Only write the DOM when the value came from outside (a new or redrafted body); typing owns it otherwise.
  useEffect(() => {
    const el = ref.current;
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }, [html]);

  // Like the native autoFocus attribute: only when the editor first appears. The composer's
  // value flips when the first letter is typed in an empty To field, and must not steal focus then.
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inEditor = () => {
    const sel = window.getSelection();
    return !!(sel && sel.rangeCount && ref.current?.contains(sel.anchorNode));
  };

  useEffect(() => {
    const refresh = () => {
      if (!inEditor()) return;
      const next: Partial<Record<State, boolean>> = {};
      for (const s of STATES) next[s] = document.queryCommandState(s);
      setActive(next);
    };
    document.addEventListener("selectionchange", refresh);
    return () => document.removeEventListener("selectionchange", refresh);
  }, []);

  const emit = () => {
    if (ref.current) onChange(ref.current.innerHTML);
  };

  const run = (cmd: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, value);
    emit();
  };

  const openLink = () => {
    const sel = window.getSelection();
    saved.current = inEditor() && sel ? sel.getRangeAt(0).cloneRange() : null;
    setUrl("");
    setLinking(true);
  };

  useEffect(() => {
    if (linking) urlInput.current?.focus();
  }, [linking]);

  const closeLink = useCallback(() => {
    setLinking(false);
    ref.current?.focus();
    const sel = window.getSelection();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
  }, []);

  const applyLink = () => {
    let href = url.trim();
    if (!href) return closeLink();
    if (!/^(https?:|mailto:)/i.test(href)) href = `https://${href}`;
    closeLink();
    if (window.getSelection()?.isCollapsed) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = href;
      document.execCommand("insertHTML", false, a.outerHTML);
    } else document.execCommand("createLink", false, href);
    emit();
  };

  const sep = <span aria-hidden className="mx-1 h-4 w-px bg-hairline" />;

  return (
    <>
      <div role="toolbar" aria-label="Formatting" className="relative flex items-center gap-0.5 border-b border-hairline px-5 py-1.5">
        <Tool label="Bold" shortcut="⌘B" icon={<Bold />} onClick={() => run("bold")} pressed={active.bold} />
        <Tool label="Italic" shortcut="⌘I" icon={<Italic />} onClick={() => run("italic")} pressed={active.italic} />
        <Tool label="Underline" shortcut="⌘U" icon={<Underline />} onClick={() => run("underline")} pressed={active.underline} />
        {sep}
        <Tool label="Bulleted list" icon={<List />} onClick={() => run("insertUnorderedList")} pressed={active.insertUnorderedList} />
        <Tool label="Numbered list" icon={<ListOrdered />} onClick={() => run("insertOrderedList")} pressed={active.insertOrderedList} />
        {sep}
        <Tool label="Link" shortcut="⌘K" icon={<LinkIcon />} onClick={openLink} />
        <Tool label="Clear formatting" icon={<RemoveFormatting />} onClick={() => run("removeFormat")} />
        {linking && (
          <input
            ref={urlInput}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeLink();
              }
            }}
            onBlur={() => setLinking(false)}
            placeholder="Paste or type a link, then press Enter"
            aria-label="Link address"
            className="selectable ml-3 h-7 min-w-0 flex-1 rounded-md border border-hairline bg-pane px-2 text-[12.5px] outline-none focus:border-primary/50"
          />
        )}
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        onInput={emit}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          e.preventDefault();
          const h = e.clipboardData.getData("text/html");
          if (h) document.execCommand("insertHTML", false, cleanBodyHtml(h));
          else document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
          emit();
        }}
        onKeyDown={(e) => {
          if (!(e.metaKey || e.ctrlKey)) return;
          const k = e.key.toLowerCase();
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (k === "k") {
            e.preventDefault();
            openLink();
          } else if (k === "b" || k === "i" || k === "u") {
            e.preventDefault();
            run(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
          }
        }}
        className={cn(
          "selectable min-h-0 flex-1 overflow-y-auto bg-transparent px-6 py-5 text-[14.5px] leading-relaxed outline-none [&_a]:text-primary [&_a]:underline [&_ol]:list-decimal [&_p]:mb-3 [&_ul]:list-disc [&_ul,&_ol]:pl-6",
          dragging && "bg-primary/[0.05] ring-2 ring-primary/30 ring-inset",
          className,
        )}
      />
    </>
  );
}
