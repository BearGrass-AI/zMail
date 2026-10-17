// Settings → AI providers: connected LLM and decision-model providers, with their models.

import { useState } from "react";
import { Loader2, MoreHorizontal, Pencil, PlugZap, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProviderLogo } from "@/components/assistant/provider-logo";
import { listModels, providerType, type ProviderGroup } from "@/lib/ai/catalog";
import { useSettings, type AiProvider } from "@/lib/settings";
import { AddProviderDialog } from "./add-provider-dialog";
import { ManageModelsDialog } from "./manage-models-dialog";
import { connectionError } from "./model-checklist";

const GROUPS: { id: ProviderGroup; title: string; hint: string }[] = [
  { id: "llm", title: "LLMs", hint: "Chat and writing: the assistant, summaries, drafts." },
  { id: "decision", title: "Decision models", hint: "Sorting: lanes, categories, folder suggestions." },
];

type Status = { state: "busy" | "ok" | "error"; text: string };

function ProviderRow({
  p,
  status,
  onManage,
  onEdit,
  onTest,
  onDelete,
}: {
  p: AiProvider;
  status?: Status;
  onManage: () => void;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const label = providerType(p.group, p.type)?.label ?? p.type;
  const n = p.enabledModels.length;
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/[0.05]">
        <ProviderLogo provider={p.type} className="size-[18px]" />
      </span>
      <button type="button" onClick={onManage} aria-label={`Manage models for ${p.name}`} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[13px] font-medium">{p.name}</div>
        <div className="truncate text-[11.5px] text-foreground/45">
          {label} · {n} model{n === 1 ? "" : "s"} enabled
        </div>
        {status && (
          <div role="status" className={status.state === "error" ? "mt-0.5 text-[11.5px] text-destructive" : status.state === "ok" ? "mt-0.5 text-[11.5px] text-[var(--bucket-ready_archive)]" : "mt-0.5 text-[11.5px] text-foreground/45"}>
            {status.state === "busy" && <Loader2 className="mr-1 inline size-3 animate-spin" />}
            {status.text}
          </div>
        )}
      </button>
      <button type="button" onClick={onManage} className="h-7 shrink-0 rounded-md px-2.5 text-[12px] font-medium text-primary hover:bg-primary/10">
        Manage models
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`Actions for ${p.name}`} className="grid size-7 shrink-0 place-items-center rounded-md text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground">
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onManage}>
            <SlidersHorizontal /> Manage models…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onEdit}>
            <Pencil /> Edit connection…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onTest}>
            <PlugZap /> Test connection
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 /> Delete connection…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ProvidersPage() {
  const providers = useSettings((s) => s.aiProviders);
  const removeProvider = useSettings((s) => s.removeProvider);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AiProvider | null>(null);
  const [status, setStatus] = useState<Record<string, Status>>({});

  const test = async (p: AiProvider) => {
    setStatus((s) => ({ ...s, [p.id]: { state: "busy", text: "Testing…" } }));
    try {
      const models = await listModels(p.group, p.type, p.baseUrl, p.apiKey);
      setStatus((s) => ({ ...s, [p.id]: { state: "ok", text: `Connected · ${models.length} model${models.length === 1 ? "" : "s"}` } }));
    } catch (err) {
      setStatus((s) => ({ ...s, [p.id]: { state: "error", text: connectionError(err) } }));
    }
  };

  const byId = (id: string | null) => providers.find((p) => p.id === id);
  const editingProvider = byId(editing);
  const managingProvider = byId(managing);

  return (
    <>
      <div className="mb-5 flex items-start gap-4">
        <p className="flex-1 pt-1 text-[12.5px] leading-snug text-foreground/55">Connect providers and choose which of their models zMail can use.</p>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-hairline bg-[var(--pane)] px-3 text-[12px] font-medium hover:bg-foreground/5"
        >
          <Plus className="size-3.5" /> Add provider
        </button>
      </div>

      {GROUPS.map((g) => {
        const list = providers.filter((p) => p.group === g.id);
        return (
          <section key={g.id} className="mb-6">
            <h3 className="px-1 text-[12px] font-semibold text-foreground/50">{g.title}</h3>
            <p className="mb-2 px-1 text-[11.5px] text-foreground/40">{g.hint}</p>
            <div className="divide-y divide-hairline overflow-hidden rounded-xl bg-pane-2 shadow-[inset_0_0_0_1px_var(--hairline)]">
              {list.map((p) => (
                <ProviderRow
                  key={p.id}
                  p={p}
                  status={status[p.id]}
                  onManage={() => setManaging(p.id)}
                  onEdit={() => setEditing(p.id)}
                  onTest={() => void test(p)}
                  onDelete={() => setRemoving(p)}
                />
              ))}
              {!list.length && (
                <p className="px-4 py-3.5 text-[12px] text-foreground/45">
                  {g.id === "llm" ? "No LLM providers yet. zMail uses its offline demo for writing and the assistant." : "No decision models yet. zMail sorts with built-in heuristics."}
                </p>
              )}
            </div>
          </section>
        );
      })}

      {adding && <AddProviderDialog onClose={() => setAdding(false)} />}
      {editingProvider && <AddProviderDialog key={editingProvider.id} provider={editingProvider} onClose={() => setEditing(null)} />}
      {managingProvider && <ManageModelsDialog key={managingProvider.id} provider={managingProvider} onClose={() => setManaging(null)} />}

      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent className="gap-3 p-5">
          <DialogTitle className="text-[15px] font-semibold">Delete connection?</DialogTitle>
          <DialogDescription className="text-[12.5px]">
            Remove “{removing?.name}” and its saved API key. Jobs that used its models go back to {removing?.group === "decision" ? "built-in sorting" : "your other models or the offline demo"}.
          </DialogDescription>
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setRemoving(null)}
              className="inline-flex h-8 items-center rounded-lg px-3 text-[12.5px] font-medium text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (removing) removeProvider(removing.id);
                setRemoving(null);
              }}
              className="inline-flex h-8 items-center rounded-lg bg-destructive/10 px-3 text-[12.5px] font-semibold text-destructive hover:bg-destructive/20"
            >
              Delete connection
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
