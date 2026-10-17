import { useRef, useState } from "react";
import { Download, File, FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Attachment, Email } from "@/lib/types";
import { useMail } from "@/lib/store";
import { formatBytes, openPath, revealPath, RISKY_MESSAGE, saveFile } from "@/lib/files";
import { fileIcon } from "@/lib/file-icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

function Chip({ email, att }: { email: Email; att: Attachment }) {
  const attachmentData = useMail((s) => s.attachmentData);
  const [busy, setBusy] = useState(false);
  // A ref, not state: a double click would otherwise download and open the file twice.
  const inFlight = useRef(false);
  // fileIcon picks one of a fixed set of module-level icon components, so its identity is stable per file type.
  const Icon = fileIcon(att.mimeType, att.filename);

  const run = async (to: "downloads" | "temp", after?: "open" | "reveal") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const data = await attachmentData(email.id, att.id);
      const path = await saveFile(att.filename, data, to);
      if (path && after === "open") {
        try {
          await openPath(path);
        } catch (err) {
          // Apps, scripts and installers are shown in Finder rather than run on a click.
          if ((err instanceof Error ? err.message : String(err)) !== RISKY_MESSAGE) throw err;
          await revealPath(path);
          toast(`Showed ${att.filename} in Finder`, { description: RISKY_MESSAGE });
        }
      }
      if (path && after === "reveal") await revealPath(path);
      if (to === "downloads") toast.success(`Saved ${att.filename}`, { description: path ?? "Downloaded" });
    } catch (err) {
      toast.error(`Couldn't get ${att.filename}`, { description: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <button
          onClick={() => void run("temp", "open")}
          title={`Open ${att.filename}`}
          className="group flex h-12 max-w-[260px] items-center gap-2.5 rounded-xl border border-hairline bg-pane-2 pr-3 pl-2.5 text-left transition hover:bg-foreground/[0.05]"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            {/* eslint-disable-next-line react-hooks/static-components -- Icon is looked up from fixed module-level components, not created here */}
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] font-medium">{att.filename}</span>
            <span className="block text-[11px] text-foreground/45">{formatBytes(att.size)}</span>
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => void run("temp", "open")}>
          <File /> Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void run("downloads")}>
          <Download /> Save to Downloads
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void run("downloads", "reveal")}>
          <FolderOpen /> Save and show in Finder
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function AttachmentStrip({ email }: { email: Email }) {
  const atts = email.attachments ?? [];
  const attachmentData = useMail((s) => s.attachmentData);
  /** Which attachment "Save all" is on (0-based), or null when it isn't running. */
  const [saving, setSaving] = useState<number | null>(null);
  const inFlight = useRef(false);
  if (!atts.length) return null;
  const saveAll = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const failed: string[] = [];
    let done = 0;
    for (const [i, a] of atts.entries()) {
      setSaving(i);
      try {
        await saveFile(a.filename, await attachmentData(email.id, a.id), "downloads");
        done++;
      } catch {
        failed.push(a.filename);
      }
    }
    inFlight.current = false;
    setSaving(null);
    if (!failed.length) toast.success(`Saved ${done} attachments to Downloads`);
    else toast.error(done ? `Saved ${done} of ${atts.length} attachments` : "Couldn't save the attachments", { description: `Not saved: ${failed.join(", ")}` });
  };
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-foreground/50">
        {atts.length} attachment{atts.length === 1 ? "" : "s"} · {formatBytes(atts.reduce((n, a) => n + a.size, 0))}
        {atts.length > 1 && (
          <button
            onClick={() => void saveAll()}
            disabled={saving !== null}
            className="ml-auto inline-flex items-center gap-1.5 font-medium text-primary hover:underline disabled:no-underline disabled:opacity-70"
          >
            {saving !== null && <Loader2 className="size-3.5 animate-spin" />}
            {saving !== null ? `Saving ${saving + 1} of ${atts.length}…` : "Save all"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {atts.map((a) => (
          <Chip key={a.id} email={email} att={a} />
        ))}
      </div>
    </div>
  );
}
