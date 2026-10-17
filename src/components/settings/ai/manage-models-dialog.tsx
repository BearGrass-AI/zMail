// Manage models: choose which of a provider's models zMail can use.

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ProviderLogo } from "@/components/assistant/provider-logo";
import { listModels, type ModelInfo } from "@/lib/ai/catalog";
import { useSettings, type AiProvider } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ModelChecklist, connectionError } from "./model-checklist";

export function ManageModelsDialog({ provider, onClose }: { provider: AiProvider; onClose: () => void }) {
  const updateProvider = useSettings((s) => s.updateProvider);
  const [selected, setSelected] = useState(provider.enabledModels);
  const [catalog, setCatalog] = useState<ModelInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  // A refresh (or another provider) starts a fresh load.
  const loadKey = `${provider.id}|${refresh}`;
  const [prevLoadKey, setPrevLoadKey] = useState(loadKey);
  if (prevLoadKey !== loadKey) {
    setPrevLoadKey(loadKey);
    setLoading(true);
    setError("");
  }

  useEffect(() => {
    let live = true;
    listModels(provider.group, provider.type, provider.baseUrl, provider.apiKey)
      .then((models) => live && setCatalog(models))
      .catch((err) => live && setError(connectionError(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // Fetch on open and on refresh; the provider's connection doesn't change while this is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, refresh]);

  // The fresh list, else the last one, plus anything already enabled.
  const base = catalog ?? provider.models;
  const models = base.filter((m, i) => base.findIndex((x) => x.id === m.id) === i);
  for (const id of new Set([...provider.enabledModels, ...selected])) if (!models.some((m) => m.id === id)) models.push({ id });

  const save = () => {
    updateProvider(provider.id, { enabledModels: selected, models: catalog ?? provider.models });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] gap-4 p-5 sm:max-w-[520px]">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground/[0.05]">
            <ProviderLogo provider={provider.type} className="size-6" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="truncate text-[15px] font-semibold">{provider.name} models</DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px]">Choose which models zMail can use.</DialogDescription>
          </div>
        </div>
        <div className="flex items-center gap-2 px-1 text-[12px] text-foreground/55">
          <span role="status" className="flex-1">
            {loading ? "Fetching available models…" : catalog ? `${catalog.length} available from this provider` : "Saved model list"}
          </span>
          <button
            type="button"
            onClick={() => setRefresh((n) => n + 1)}
            disabled={loading}
            aria-label="Refresh available models"
            title="Fetch the latest model list"
            className="grid size-7 place-items-center rounded-md text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error}
          </p>
        )}
        <ModelChecklist type={provider.type} models={models} selected={selected} onChange={setSelected} available={catalog?.map((m) => m.id)} />
        <div className="mt-1 flex items-center gap-2">
          <span className="flex-1 text-[11.5px] text-foreground/45">{selected.length ? "You can change this anytime." : "No models from this provider will be available."}</span>
          <button type="button" onClick={onClose} className="inline-flex h-8 items-center rounded-lg px-3 text-[12.5px] font-medium text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={loading}
            className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground transition disabled:opacity-40"
          >
            Save selection
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
