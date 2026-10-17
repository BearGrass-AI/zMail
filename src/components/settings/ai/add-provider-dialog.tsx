// Add provider (pick a type, connect, then choose models) and Edit connection (same fields, prefilled).

import { useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ProviderLogo } from "@/components/assistant/provider-logo";
import { listModels, providerType, providerTypes, type ModelInfo, type ProviderGroup, type ProviderTypeId } from "@/lib/ai/catalog";
import { useSettings, type AiProvider } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ModelChecklist, connectionError } from "./model-checklist";

const GROUPS: { id: ProviderGroup; label: string }[] = [
  { id: "llm", label: "LLM" },
  { id: "decision", label: "Decision model" },
];

const fieldClass =
  "selectable h-8 w-full rounded-lg border border-hairline bg-[var(--pane)] px-2.5 text-[12.5px] outline-none placeholder:text-foreground/35 focus:ring-2 focus:ring-ring/30 disabled:opacity-50";

function Field({ label, htmlFor, hint, children }: { label: ReactNode; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={htmlFor} className="text-[12px] font-medium text-foreground/70">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-foreground/45">{hint}</p>}
    </div>
  );
}

const actionClass = "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium disabled:opacity-40";
const primaryClass = cn(actionClass, "bg-primary font-semibold text-primary-foreground transition");
const ghostClass = cn(actionClass, "text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground");
const outlineClass = cn(actionClass, "border border-hairline bg-[var(--pane)] hover:bg-foreground/5");

/**
 * With `provider`, edits that connection (its type and group stay); without, adds a new one.
 * `group` picks the starting group for a new provider.
 */
export function AddProviderDialog({ provider, group: startGroup = "llm", onClose }: { provider?: AiProvider; group?: ProviderGroup; onClose: () => void }) {
  const editing = !!provider;
  const addProvider = useSettings((s) => s.addProvider);
  const updateProvider = useSettings((s) => s.updateProvider);
  const [group, setGroup] = useState<ProviderGroup>(provider?.group ?? startGroup);
  const [type, setType] = useState<ProviderTypeId>(provider?.type ?? providerTypes(startGroup)[0].id);
  const info = providerType(group, type) ?? providerTypes(group)[0];
  const [name, setName] = useState(provider?.name ?? info.label);
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? info.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ModelInfo[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const nameInput = useRef<HTMLInputElement>(null);
  const selectedOnce = useRef(false);

  const savedKey = editing && !!provider.apiKey;
  const key = apiKey.trim() || (savedKey ? provider.apiKey : "");
  const valid = !!name.trim() && !!baseUrl.trim() && (info.key !== "required" || !!key);

  const reset = () => {
    setError("");
    setResult(null);
  };

  const chooseType = (next: ProviderTypeId, nextGroup = group) => {
    const t = providerType(nextGroup, next)!;
    if (!name.trim() || name === info.label) setName(t.label);
    setGroup(nextGroup);
    setType(next);
    setBaseUrl(t.baseUrl);
    setApiKey("");
    setSelected([]);
    reset();
  };

  const fetchModels = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const models = await listModels(group, type, baseUrl, key);
      setResult(models);
      return models;
    } catch (err) {
      setError(connectionError(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const models = await fetchModels();
    if (!models) return;
    setSelected((old) => old.filter((id) => models.some((m) => m.id === id)));
    setSelecting(true);
  };

  const add = () => {
    const id = addProvider({ group, type, name: name.trim(), baseUrl: baseUrl.trim(), models: result ?? [], enabledModels: selected, apiKey: key });
    // The first provider for a job does that job until another model is chosen.
    const s = useSettings.getState();
    const role = group === "decision" ? "sorting" : "writing";
    if (selected.length && !s.aiRoles[role]) s.setRole(role, { providerId: id, model: selected[0] });
    onClose();
  };

  const save = () => {
    updateProvider(provider!.id, { name: name.trim(), baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
    onClose();
  };

  const submit = () => {
    if (busy || !valid) return;
    if (editing) save();
    else if (selecting) add();
    else void connect();
  };

  const title = editing ? "Edit connection" : selecting ? "Choose your models" : "Add provider";
  const description = editing
    ? "Update the connection details. Your selected models are kept."
    : selecting
      ? "Only the models you select will be available in zMail."
      : "Connect a provider, then choose the models you want to use.";

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent initialFocus={selecting ? undefined : nameInput} className="grid-cols-[minmax(0,1fr)] gap-4 p-5 sm:max-w-[520px]">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground/[0.05]">
            <ProviderLogo provider={type} className="size-6" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px]">{description}</DialogDescription>
          </div>
        </div>

        <form
          className="grid gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {selecting && result ? (
            <ModelChecklist type={type} models={result} selected={selected} onChange={setSelected} disabled={busy} />
          ) : (
            <>
              {!editing && (
                <>
                  <div role="radiogroup" aria-label="Provider kind" className="grid grid-cols-2 gap-1 rounded-lg bg-foreground/[0.06] p-0.5">
                    {GROUPS.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        role="radio"
                        aria-checked={group === g.id}
                        disabled={busy}
                        onClick={() => group !== g.id && chooseType(providerTypes(g.id)[0].id, g.id)}
                        className={cn(
                          "h-7 rounded-md text-[12.5px] font-medium text-foreground/60 transition",
                          group === g.id && "bg-[var(--pane)] text-foreground shadow-sm",
                        )}
                      >
                        {g.label}
                      </button>
                    ))}
                  </div>
                  <div role="group" aria-label="Provider" className="grid grid-cols-3 gap-1.5">
                    {providerTypes(group).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={type === t.id}
                        title={t.hint}
                        disabled={busy}
                        onClick={() => chooseType(t.id)}
                        className={cn(
                          "flex h-[60px] flex-col items-center justify-center gap-1.5 rounded-lg border border-hairline px-1 text-[11.5px] text-foreground/75 hover:bg-foreground/[0.04]",
                          type === t.id && "border-primary/60 bg-primary/[0.07] text-foreground ring-1 ring-primary/40",
                        )}
                      >
                        <ProviderLogo provider={t.id} className="size-5" />
                        <span className="truncate">{t.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <Field label="Name" htmlFor="provider-name">
                <input
                  ref={nameInput}
                  id="provider-name"
                  value={name}
                  maxLength={120}
                  disabled={busy}
                  onFocus={(e) => {
                    if (selectedOnce.current) return;
                    selectedOnce.current = true;
                    e.currentTarget.select();
                  }}
                  onChange={(e) => {
                    setName(e.target.value);
                    reset();
                  }}
                  className={fieldClass}
                />
              </Field>
              <Field label="Endpoint" htmlFor="provider-endpoint" hint={info.hint}>
                <input
                  id="provider-endpoint"
                  value={baseUrl}
                  disabled={busy}
                  spellCheck={false}
                  placeholder={info.baseUrl || "https://your-server.example.com"}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    reset();
                  }}
                  className={cn(fieldClass, "font-mono text-[11.5px]")}
                />
              </Field>
              {info.key !== "none" && (
                <Field
                  label={`API key${info.key === "optional" ? " (optional)" : ""}`}
                  htmlFor="provider-key"
                  hint={savedKey ? "A key is saved. Type a new one to replace it." : "Keys are kept in your Mac's Keychain."}
                >
                  <input
                    id="provider-key"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={apiKey}
                    disabled={busy}
                    placeholder={savedKey ? "•••• saved" : info.key === "required" ? "Required" : "Optional"}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      reset();
                    }}
                    className={cn(fieldClass, "font-mono text-[11.5px]")}
                  />
                </Field>
              )}
            </>
          )}

          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {error}
            </p>
          )}
          {editing && result && (
            <p role="status" className="text-[12px] text-[var(--bucket-ready_archive)]">
              Connected · {result.length} model{result.length === 1 ? "" : "s"}
            </p>
          )}

          <div className="mt-1 flex items-center gap-2">
            {editing && (
              <button type="button" disabled={busy || !valid} onClick={() => void fetchModels()} className={outlineClass}>
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                Test connection
              </button>
            )}
            {selecting && (
              <button type="button" onClick={() => setSelecting(false)} className={ghostClass}>
                Back
              </button>
            )}
            <span className="flex-1" />
            <button type="button" disabled={busy} onClick={onClose} className={ghostClass}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !valid} className={primaryClass}>
              {busy && !editing && <Loader2 className="size-3.5 animate-spin" />}
              {editing ? "Save changes" : selecting ? `Add provider${selected.length ? ` · ${selected.length} selected` : ""}` : busy ? "Connecting…" : "Connect & choose models"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
