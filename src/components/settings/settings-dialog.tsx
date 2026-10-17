// Settings window, laid out like macOS System Settings: a searchable left rail
// of sections and grouped panels on the right.

import { useMemo, useState, type ComponentType } from "react";
import { SPRING_PILL } from "@/lib/motion";
import { motion } from "motion/react";
import { Bell, Bot, CalendarDays, Info, Keyboard, LayoutList, Mail, Palette, Search, Signature, Sparkles, Video, WandSparkles, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSettingsOpen } from "@/lib/settings-open";
import { cn } from "@/lib/utils";
import { AppearancePage } from "./appearance-page";
import { AccountsPage } from "./accounts-page";
import { NotificationsPage } from "./notifications-page";
import { SignaturesPage } from "./signatures-page";
import { SectionsPage } from "./sections-page";
import { ProvidersPage } from "./ai/providers-page";
import { AssistantPage } from "./ai/assistant-page";
import { RulesPage } from "./rules-page";
import { CalendarsPage } from "./calendars-page";
import { VideoMeetingsPage } from "./video-meetings-page";
import { ShortcutsPage } from "./shortcuts-page";
import { AboutPage } from "./about-page";

type SectionId = "appearance" | "accounts" | "notifications" | "signatures" | "sections" | "providers" | "assistant" | "rules" | "calendars" | "video" | "shortcuts" | "about";

const SECTIONS: { id: SectionId; label: string; icon: ComponentType<{ className?: string; strokeWidth?: number }>; keywords: string }[] = [
  { id: "appearance", label: "Appearance", icon: Palette, keywords: "theme dark light glass translucent color palette category" },
  { id: "accounts", label: "Accounts", icon: Mail, keywords: "gmail outlook microsoft 365 graph connect" },
  { id: "notifications", label: "Notifications", icon: Bell, keywords: "notifications banner alert badge dock quiet hours sound focus" },
  { id: "signatures", label: "Signatures", icon: Signature, keywords: "signature sign-off footer" },
  { id: "sections", label: "Sections", icon: LayoutList, keywords: "sections categories bills school custom groups labels due dates calendar" },
  { id: "providers", label: "AI providers", icon: Bot, keywords: "decision jev clef ollama anthropic openai gemini xai perplexity openrouter vllm llm provider endpoint api key models" },
  { id: "assistant", label: "AI Assistant", icon: Sparkles, keywords: "assistant writing sorting default model threshold search meaning semantic embedding index" },
  { id: "rules", label: "Sorting & Rules", icon: WandSparkles, keywords: "rules automatic always file sender corrections habits folders" },
  { id: "calendars", label: "Calendars", icon: CalendarDays, keywords: "calendar google outlook family show hide" },
  { id: "video", label: "Video Meetings", icon: Video, keywords: "zoom teams meet google video meeting conference" },
  { id: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard, keywords: "keys hotkeys shortcuts" },
  { id: "about", label: "About zMail", icon: Info, keywords: "version about local" },
];

const CONTENT: Record<SectionId, ComponentType> = {
  appearance: AppearancePage,
  accounts: AccountsPage,
  notifications: NotificationsPage,
  signatures: SignaturesPage,
  sections: SectionsPage,
  providers: ProvidersPage,
  assistant: AssistantPage,
  rules: RulesPage,
  calendars: CalendarsPage,
  video: VideoMeetingsPage,
  shortcuts: ShortcutsPage,
  about: AboutPage,
};

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [section, setSection] = useState<SectionId>("appearance");
  const [q, setQ] = useState("");
  // Opened from elsewhere (e.g. the assistant's model picker) on a particular section.
  const requested = useSettingsOpen((s) => s.section);
  const [prevOpen, setPrevOpen] = useState({ open, requested });
  if (prevOpen.open !== open || prevOpen.requested !== requested) {
    setPrevOpen({ open, requested });
    if (open && requested && SECTIONS.some((s) => s.id === requested)) {
      setSection(requested as SectionId);
      setQ("");
    }
  }
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? SECTIONS.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(needle)) : SECTIONS;
  }, [q]);
  const current = SECTIONS.find((s) => s.id === section)!;
  const Content = CONTENT[section];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="flex h-[min(680px,86vh)] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[920px]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <aside className="flex w-[230px] shrink-0 flex-col border-r border-hairline bg-foreground/[0.025] p-3">
          <label className="mb-2 flex h-7 items-center gap-2 rounded-md bg-foreground/[0.06] px-2.5 text-[12.5px] text-foreground/45 focus-within:ring-2 focus-within:ring-ring/30">
            <Search className="size-3.5" />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                const needle = e.target.value.trim().toLowerCase();
                const hit = SECTIONS.find((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(needle));
                if (needle && hit) setSection(hit.id);
              }}
              placeholder="Search"
              className="selectable w-full bg-transparent text-foreground outline-none placeholder:text-foreground/40"
            />
          </label>
          {visible.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={cn(
                "relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-foreground/80 hover:text-foreground",
                section === s.id && "font-medium text-foreground",
              )}
            >
              {section === s.id && (
                <motion.span layoutId="settings-active" className="absolute inset-0 rounded-lg bg-foreground/[0.08]" transition={SPRING_PILL} />
              )}
              <s.icon className="relative size-[16px] text-foreground/60" strokeWidth={1.7} />
              <span className="relative">{s.label}</span>
            </button>
          ))}
          {visible.length === 0 && <p className="px-2.5 py-2 text-[12px] text-foreground/40">No matches</p>}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center border-b border-hairline px-6">
            <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{current.label}</h2>
            <button onClick={() => onOpenChange(false)} className="ml-auto grid size-7 place-items-center rounded-md text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground" aria-label="Close">
              <X className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {/* Sections swap in place, as in System Settings: waiting for the old one to fade out left the page blank. */}
            <Content key={section} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
