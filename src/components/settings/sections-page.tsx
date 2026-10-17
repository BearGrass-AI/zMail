// Settings → Sections: the built-in buckets and your own sections, each with its editor.

import { useMemo, useState } from "react";
import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BUCKETS } from "@/lib/types";
import { folderPath, useMail } from "@/lib/store";
import { cn } from "@/lib/utils";
import { BUCKET_META, SECTION_ICON } from "@/lib/meta";
import { SECTION_ICONS, SECTION_PRESETS, sectionsFor, sectionsKey, type MailSection } from "@/lib/sections";
import { Tile } from "../meta";
import { accountLabel } from "../account-switcher";
import { Group, Row } from "./settings-ui";

const SECTION_HUES = [150, 70, 210, 25, 295, 185, 330, 45];

const field =
  "selectable w-full rounded-lg border border-hairline bg-[var(--pane)] px-2.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/30";

/** Inline editor for one section. */
function SectionEditor({ section }: { section: MailSection }) {
  const s = useMail();
  const update = (patch: Partial<Omit<MailSection, "id">>) => s.updateSection(section.id, patch);
  const labels = s.folders.filter((f) => !f.system);
  const linked = labels.find((f) => f.id === section.folderId);
  const inLabel = linked ? s.emails.filter((e) => e.folderId === linked.id).length : 0;
  const accountName = (id: string) => {
    const a = s.accounts.find((x) => x.id === id);
    return a ? accountLabel(a, s.accounts) : id;
  };

  return (
    <div className="grid grid-cols-[112px_1fr] items-start gap-x-4 gap-y-3.5 border-t border-hairline bg-foreground/[0.015] py-4 pr-4 pl-[58px] text-[12.5px]">
      <span className="pt-1.5 text-foreground/50">Name</span>
      <input
        defaultValue={section.name}
        onBlur={(e) => e.target.value.trim() && update({ name: e.target.value.trim() })}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={cn(field, "h-8 max-w-[320px]")}
      />

      <span className="pt-1 text-foreground/50">Icon &amp; color</span>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap gap-1.5">
          {SECTION_ICONS.map((icon) => (
            <button
              key={icon}
              aria-label={icon}
              onClick={() => update({ icon })}
              className={cn("rounded-[9px] p-0.5 ring-2 ring-transparent transition", section.icon === icon && "ring-foreground/70")}
            >
              <Tile icon={SECTION_ICON[icon]} h={section.hue} variant={section.icon === icon ? "solid" : "soft"} size={26} />
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {SECTION_HUES.map((h) => (
            <button
              key={h}
              aria-label={`Hue ${h}`}
              onClick={() => update({ hue: h })}
              className={cn("size-5 rounded-full transition hover:scale-110", section.hue === h && "ring-2 ring-foreground ring-offset-2 ring-offset-[var(--pane)]")}
              style={{ background: `oklch(0.66 0.15 ${h})` }}
            />
          ))}
        </div>
      </div>

      <span className="pt-1.5 text-foreground/50">What goes here</span>
      <div>
        <textarea
          defaultValue={section.description}
          rows={3}
          onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== section.description && update({ description: e.target.value.trim() })}
          className={cn(field, "resize-none py-2 leading-snug")}
        />
        <p className="mt-1 text-[11.5px] text-foreground/40">Plain English. This is the description the sorting model reads.</p>
      </div>

      <span className="pt-1.5 text-foreground/50">Label</span>
      <div>
        <DropdownMenu>
          <DropdownMenuTrigger className={cn(field, "flex h-8 max-w-[320px] items-center gap-2 text-left")}>
            <span className="min-w-0 flex-1 truncate">{linked ? folderPath(s.folders, linked.id) : <span className="text-foreground/45">None</span>}</span>
            {linked && s.accounts.length > 1 && <span className="shrink-0 text-[11px] text-foreground/40">{accountName(linked.accountId)}</span>}
            <ChevronDown className="size-3.5 shrink-0 text-foreground/40" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-72">
            <DropdownMenuRadioGroup
              value={section.folderId ?? ""}
              onValueChange={(v) => {
                const f = labels.find((x) => x.id === v);
                update({ folderId: f?.id, ...(f && s.accounts.length > 1 && !section.accountIds.length ? { accountIds: [f.accountId] } : {}) });
              }}
            >
              <DropdownMenuRadioItem value="" closeOnClick>
                None
              </DropdownMenuRadioItem>
              {labels.map((f) => (
                <DropdownMenuRadioItem key={f.id} value={f.id} closeOnClick>
                  <span className="truncate">{folderPath(s.folders, f.id)}</span>
                  {s.accounts.length > 1 && <span className="ml-auto pl-2 text-[11px] opacity-50">{accountName(f.accountId)}</span>}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <p className="mt-1 text-[11.5px] text-foreground/40">
          {linked
            ? `Learns from the ${inLabel} email${inLabel === 1 ? "" : "s"} already in it. Archiving mail from this section files it there.`
            : "Optional. A label or folder you already file this mail in teaches zMail who belongs here."}
        </p>
      </div>

      {s.accounts.length > 1 && (
        <>
          <span className="pt-1.5 text-foreground/50">Accounts</span>
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(field, "flex h-8 max-w-[320px] items-center gap-2 text-left")}>
              <span className="flex-1 truncate">{section.accountIds.length ? section.accountIds.map(accountName).join(", ") + " only" : "All accounts"}</span>
              <ChevronDown className="size-3.5 shrink-0 text-foreground/40" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuRadioGroup value={section.accountIds[0] ?? ""} onValueChange={(v) => update({ accountIds: v ? [String(v)] : [] })}>
                <DropdownMenuRadioItem value="" closeOnClick>
                  All accounts
                </DropdownMenuRadioItem>
                {s.accounts.map((a) => (
                  <DropdownMenuRadioItem key={a.id} value={a.id} closeOnClick>
                    {accountLabel(a, s.accounts)} only
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      <span className="pt-1 text-foreground/50">Dates</span>
      <label className="flex items-start gap-3">
        <Switch checked={section.dates} onCheckedChange={(dates) => update({ dates })} />
        <span>
          <span className="block text-[13px]">Catch due dates and suggest calendar events</span>
          <span className="block text-[11.5px] text-foreground/40">
            Only this section's mail is read for dates, by your writing model. Suggestions appear on Today's right side; nothing is added until you click Add.
          </span>
        </span>
      </label>

      <span className="pt-1 text-foreground/50">Needs you</span>
      <label className="flex items-start gap-3">
        <Switch checked={!!section.urgentInNeedsYou} onCheckedChange={(urgentInNeedsYou) => update({ urgentInNeedsYou })} />
        <span>
          <span className="block text-[13px]">Urgent mail also shows in Needs you</span>
          <span className="block text-[11.5px] text-foreground/40">Off: it stays in this section, flagged at the top.</span>
        </span>
      </label>
    </div>
  );
}

export function SectionsPage() {
  const s = useMail();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  // Inbox mail sorted before the latest section changes (it can't be in a new section yet).
  const stale = useMemo(
    () =>
      s.emails.filter(
        (e) =>
          s.folders.find((f) => f.id === e.folderId)?.system === "inbox" &&
          s.triage[e.id] &&
          sectionsFor(s.sections, e.accountId).length > 0 &&
          (s.triage[e.id].sectionsKey ?? "") !== sectionsKey(s.sections, e.accountId),
      ).length,
    [s.emails, s.folders, s.triage, s.sections],
  );

  const create = (preset?: (typeof SECTION_PRESETS)[number]) => {
    const base = preset ?? { name: "New section", description: "", icon: "heart" as const, hue: 295, dates: false };
    // Link a label you already use for this, e.g. "Bills" or "Boy's School".
    const want = base.name.toLowerCase();
    const labels = s.folders.filter((f) => !f.system);
    const label = preset ? labels.find((f) => f.name.toLowerCase() === want) ?? labels.find((f) => f.name.toLowerCase().includes(want)) : undefined;
    const id = s.addSection({
      ...base,
      name: label && label.name.toLowerCase() !== want ? label.name : base.name,
      folderId: label?.id,
      accountIds: label && s.accounts.length > 1 ? [label.accountId] : [],
    });
    setEditing(id);
  };

  const sortStale = async () => {
    const id = toast.loading(`Sorting ${stale} email${stale === 1 ? "" : "s"} into your sections…`);
    await s.sort({ staleSections: true });
    const { error: err, failed } = useMail.getState().sorting;
    if (err) toast.error("Sorting stopped", { id, description: err });
    else if (failed) toast.warning(`${failed.count} email${failed.count === 1 ? "" : "s"} couldn't be sorted`, { id, description: failed.error });
    else toast.success("Sorted into your sections", { id });
  };

  return (
    <>
      <Group title="Built in">
        <Row
          label={
            <span className="flex items-center gap-2.5">
              <span className="flex -space-x-1.5">
                {BUCKETS.map((b) => (
                  <Tile key={b} icon={BUCKET_META[b].icon} k={b} variant="solid" size={26} className="ring-2 ring-pane-2" />
                ))}
              </span>
              <span>
                <span className="block font-medium">Needs you · Worth a skim · Can go</span>
                <span className="block text-[11.5px] text-foreground/45">Every email gets one of these.</span>
              </span>
            </span>
          }
        >
          <span className="text-[11.5px] text-foreground/40">Built in</span>
        </Row>
      </Group>

      <Group
        title="Your sections"
        footer="Each email can be in one of your sections as well as its bucket. It's the same sorting request, with one more question, so it doesn't add a request per email. Section mail shows in its own block on Today and its own lane in Triage instead of in Worth a skim or Can go. Urgent mail stays at the top of its section, flagged, unless you let that section's urgent mail into Needs you."
      >
        {s.sections.length === 0 && (
          <Row label={<span className="text-foreground/45">No sections yet. Start with one below.</span>} />
        )}
        {s.sections.map((x) => (
          <div key={x.id}>
            <Row
              label={
                <span className="flex items-center gap-2.5">
                  <Tile icon={SECTION_ICON[x.icon]} h={x.hue} variant="solid" size={32} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{x.name}</span>
                    <span className="block truncate text-[11.5px] text-foreground/45">
                      {[
                        x.folderId && s.folders.find((f) => f.id === x.folderId)
                          ? `Label “${s.folders.find((f) => f.id === x.folderId)!.name}”`
                          : null,
                        x.dates ? "catches dates" : null,
                        x.accountIds.length && s.accounts.length > 1
                          ? x.accountIds
                              .map((id) => {
                                const a = s.accounts.find((acc) => acc.id === id);
                                return a ? accountLabel(a, s.accounts) : id;
                              })
                              .join(", ") + " only"
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || x.description}
                    </span>
                  </span>
                </span>
              }
            >
              {confirm === x.id ? (
                <>
                  <span className="text-[12px] text-foreground/55">Delete {x.name}?</span>
                  <button
                    onClick={() => {
                      s.removeSection(x.id);
                      setConfirm(null);
                    }}
                    className="h-7 rounded-md bg-destructive px-2.5 text-[12px] font-medium text-white"
                  >
                    Delete
                  </button>
                  <button onClick={() => setConfirm(null)} className="h-7 rounded-md px-2.5 text-[12px] text-foreground/60 hover:bg-foreground/5">
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setEditing((e) => (e === x.id ? null : x.id))}
                    className={cn("h-7 rounded-md px-2.5 text-[12px] text-foreground/60 hover:bg-foreground/5", editing === x.id && "bg-foreground/[0.07] text-foreground")}
                  >
                    {editing === x.id ? "Done" : "Edit"}
                  </button>
                  <button onClick={() => setConfirm(x.id)} aria-label={`Delete ${x.name}`} className="grid size-7 place-items-center rounded-md text-foreground/45 hover:bg-foreground/5 hover:text-destructive">
                    <Trash2 className="size-3.5" />
                  </button>
                </>
              )}
            </Row>
            {editing === x.id && <SectionEditor key={x.id} section={x} />}
          </div>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex h-11 w-full items-center gap-2 px-4 text-[13px] font-medium text-primary hover:bg-foreground/[0.03]">
            <Plus className="size-4" /> New section
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {SECTION_PRESETS.filter((p) => !s.sections.some((x) => x.name === p.name)).map((p) => {
              const Icon = SECTION_ICON[p.icon];
              return (
                <DropdownMenuItem key={p.name} onClick={() => create(p)}>
                  <Icon /> {p.name}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuItem onClick={() => create()}>
              <Pencil /> Start from scratch
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Group>

      {stale > 0 && (
        <Group footer="This is a full sort of those emails, one request each, like Re-sort.">
          <Row
            label={`${stale} inbox email${stale === 1 ? " was" : "s were"} sorted before your latest section changes`}
            hint="New mail is sorted into your sections automatically. Sort these now to fill your sections with what's already in your inbox."
          >
            <button
              onClick={() => void sortStale()}
              disabled={s.sorting.running}
              className="h-7 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:opacity-50"
            >
              {s.sorting.running ? "Sorting…" : `Sort ${stale}`}
            </button>
          </Row>
        </Group>
      )}
    </>
  );
}
