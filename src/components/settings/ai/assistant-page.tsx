// Settings → AI Assistant: which model does each job, chosen from the models enabled under AI providers.

import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ProviderLogo } from "@/components/assistant/provider-logo";
import { modelDisplayName } from "@/lib/ai/assistant/model-choices";
import type { ProviderGroup } from "@/lib/ai/catalog";
import { getSecret, setSecret } from "@/lib/secrets";
import { resolveRef, useSettings, webSearchKeyName, type AiProvider, type AiRole, type ModelRef, type Settings } from "@/lib/settings";
import { Group, Row } from "../settings-ui";
import { SemanticSearchGroup } from "./semantic-search";

const nameOf = (p: AiProvider, id: string) => modelDisplayName(p.type, p.models.find((m) => m.id === id) ?? { id });

function RoleSelect({ role, group, none }: { role: AiRole; group: ProviderGroup; none: string }) {
  const providers = useSettings((s) => s.aiProviders);
  const ref = useSettings((s) => s.aiRoles[role]);
  const setRole = useSettings((s) => s.setRole);
  const list = providers.filter((p) => p.group === group && p.enabledModels.length);
  const current = resolveRef({ aiProviders: providers }, ref, group);
  const same = (a: ModelRef | null, p: AiProvider, id: string) => a?.providerId === p.id && a.model === id;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 w-[300px] items-center gap-2 rounded-md border border-hairline bg-[var(--pane)] px-2.5 text-left text-[12.5px] hover:bg-foreground/[0.03]">
        {current && <ProviderLogo provider={current.provider.type} className="size-4 shrink-0 text-foreground/70" />}
        <span className="min-w-0 flex-1 truncate">
          {current ? (
            <>
              {nameOf(current.provider, current.model)}
              <span className="ml-1.5 font-mono text-[10.5px] text-foreground/40">{current.model}</span>
            </>
          ) : (
            <span className="text-foreground/55">{none}</span>
          )}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-foreground/40" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-[320px]">
        <DropdownMenuItem onClick={() => setRole(role, null)}>
          <span className="flex-1 text-[12.5px]">{none}</span>
          {!current && <Check className="text-primary" />}
        </DropdownMenuItem>
        {list.map((p, i) => (
          <DropdownMenuGroup key={p.id}>
            {i === 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{p.name}</DropdownMenuLabel>
            {p.enabledModels.map((id) => (
              <DropdownMenuItem key={id} onClick={() => setRole(role, { providerId: p.id, model: id })} className="py-1.5">
                <ProviderLogo provider={p.type} className="size-4 text-foreground/60" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{nameOf(p, id)}</span>
                  <span className="block truncate font-mono text-[10.5px] opacity-50">{id}</span>
                </span>
                {same(ref, p, id) && current && <Check className="text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
        {!list.length && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <span className="text-[12px]">{group === "decision" ? "Add a decision model under AI providers." : "Add an LLM under AI providers."}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Same look as the fields in the add-provider dialog.
const placeClass =
  "selectable h-8 w-72 rounded-lg border border-hairline bg-[var(--pane)] px-2.5 text-[12.5px] outline-none placeholder:text-foreground/35 focus:ring-2 focus:ring-ring/30 disabled:opacity-50";

type SearchService = Settings["webSearch"]["service"];
const SERVICES: { id: SearchService; label: string }[] = [
  { id: "none", label: "None" },
  { id: "brave", label: "Brave Search" },
  { id: "tavily", label: "Tavily" },
];

function ServiceSelect() {
  const ws = useSettings((s) => s.webSearch);
  const set = useSettings((s) => s.set);
  const current = SERVICES.find((s) => s.id === ws.service) ?? SERVICES[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 w-[200px] items-center gap-2 rounded-md border border-hairline bg-[var(--pane)] px-2.5 text-left text-[12.5px] hover:bg-foreground/[0.03]">
        <span className={`min-w-0 flex-1 truncate ${current.id === "none" ? "text-foreground/55" : ""}`}>{current.label}</span>
        <ChevronDown className="size-3.5 shrink-0 text-foreground/40" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        {SERVICES.map((s) => (
          <DropdownMenuItem key={s.id} onClick={() => set({ webSearch: { ...ws, service: s.id } })}>
            <span className="flex-1 text-[12.5px]">{s.label}</span>
            {s.id === ws.service && <Check className="text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The search service's key goes straight to the Keychain; a saved key is never shown back. */
function SearchKeyInput({ service }: { service: "brave" | "tavily" }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    getSecret(webSearchKeyName(service))
      .then((k) => live && setSaved(!!k))
      .catch(() => live && setSaved(false));
    return () => {
      live = false;
    };
  }, [service]);
  const save = () => {
    const key = value.trim();
    if (!key) return;
    setSecret(webSearchKeyName(service), key)
      .then(() => {
        setValue("");
        setSaved(true);
        toast("Key saved");
      })
      .catch(() => toast("Couldn't save the key to the Keychain"));
  };
  return (
    <input
      type="password"
      autoComplete="new-password"
      spellCheck={false}
      aria-label="Search service API key"
      value={value}
      placeholder={saved ? "Key saved" : "Paste your key"}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      className="selectable h-8 w-72 rounded-lg border border-hairline bg-[var(--pane)] px-2.5 font-mono text-[11.5px] outline-none placeholder:text-foreground/35 focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
    />
  );
}

export function AssistantPage() {
  const threshold = useSettings((s) => s.suggestThreshold);
  const ws = useSettings((s) => s.webSearch);
  const travelPlaces = useSettings((s) => s.travelPlaces);
  const set = useSettings((s) => s.set);
  return (
    <>
      <p className="mb-5 px-1 text-[12.5px] leading-snug text-foreground/55">Which model does each job. Lists show only models you enabled under AI providers.</p>
      <Group footer="The assistant searches, reads and acts on your mail using tools, so pick a model that supports tool calling (Claude, GPT, qwen3…). It sends your messages, short previews of search results, and an email's full text only when it opens that email. Breakdowns by kind send the sender and subject of each email in the set.">
        <Row label="✦ Assistant" hint="Chat, the ✦ search button, and acting with tools. You can switch per chat from the ask box.">
          <RoleSelect role="assistant" group="llm" none="Same as Writing" />
        </Row>
        <Row label="Writing" hint="Summaries, one-line previews and quick-reply drafts.">
          <RoleSelect role="writing" group="llm" none="Offline demo" />
        </Row>
        <Row label="Sorting" hint="Lanes, categories and folder suggestions. Decision models only.">
          <RoleSelect role="sorting" group="decision" none="Built-in heuristics" />
        </Row>
      </Group>
      <Group title="Suggestions" footer="zMail only asks to move an email when the decision model is at least this confident.">
        <Row label="Suggest a folder move above">
          <div className="flex w-56 items-center gap-3">
            <Slider min={0.4} max={0.98} step={0.01} value={[threshold]} onValueChange={(v) => set({ suggestThreshold: Array.isArray(v) ? v[0] : (v as number) })} />
            <span className="w-9 text-right text-[12px] text-foreground/60 tabular-nums">{Math.round(threshold * 100)}%</span>
          </div>
        </Row>
      </Group>
      <Group title="Places" footer="Starting points for drive times, which come from Apple Maps. Leave blank and the assistant will ask.">
        <Row label="Home">
          <input aria-label="Home" value={travelPlaces.home} onChange={(e) => set({ travelPlaces: { ...travelPlaces, home: e.target.value } })} placeholder="Street, city" maxLength={200} spellCheck={false} className={placeClass} />
        </Row>
        <Row label="Work">
          <input aria-label="Work" value={travelPlaces.work} onChange={(e) => set({ travelPlaces: { ...travelPlaces, work: e.target.value } })} placeholder="Street, city" maxLength={200} spellCheck={false} className={placeClass} />
        </Row>
      </Group>
      <SemanticSearchGroup />
      <Group title="Web search" footer="The assistant treats web results like email content: as information, never as instructions.">
        <Row label="Claude's built-in search" hint="With Anthropic models. Billed by Anthropic, about $10 per 1,000 searches.">
          <Switch checked={ws.builtin} onCheckedChange={(v) => set({ webSearch: { ...ws, builtin: v } })} aria-label="Claude's built-in search" />
        </Row>
        <Row label="Search service" hint="For other models, or when the built-in search is off.">
          <ServiceSelect />
        </Row>
        {ws.service !== "none" && (
          <Row label="API key" hint="Saved in the macOS Keychain.">
            <SearchKeyInput key={ws.service} service={ws.service} />
          </Row>
        )}
      </Group>
    </>
  );
}
