// Account folder trees for the sidebar. Handles deep Outlook hierarchies
// (subfolders under Inbox), Gmail labels, favorites and quick filtering.

import { useMemo, useState, type ComponentType } from "react";
import { QUICK } from "@/lib/motion";
import { motion } from "motion/react";
import {
  Archive,
  ChevronRight,
  Clock,
  Folder as FolderIcon,
  FolderPlus,
  Inbox,
  Layers,
  MailCheck,
  MessagesSquare,
  PenLine,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { Account, Folder, SystemFolder } from "@/lib/types";
import { childFoldersIndexed, folderPathCached, folderUnread, idsByFolder, useMail } from "@/lib/store";
import { useFolderPrefs } from "@/lib/folder-prefs";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { AccountIcon, accountLabel } from "./account-switcher";

const SYSTEM_ICON: Record<SystemFolder, ComponentType<{ className?: string; strokeWidth?: number }>> = {
  inbox: Inbox,
  drafts: PenLine,
  sent: Send,
  archive: Archive,
  spam: ShieldAlert,
  trash: Trash2,
  snoozed: Clock,
  clutter: Layers,
  history: MessagesSquare,
};

function descendants(folders: Folder[], id: string): string[] {
  const kids = folders.filter((f) => f.parentId === id);
  return kids.flatMap((k) => [k.id, ...descendants(folders, k.id)]);
}

const NO_IDS: string[] = [];

function FolderRow({
  folder,
  depth,
  forceOpen,
  visible,
}: {
  folder: Folder;
  depth: number;
  forceOpen: boolean;
  visible?: Set<string>;
}) {
  const folders = useMail((s) => s.folders);
  const setView = useMail((s) => s.setView);
  const setRead = useMail((s) => s.setRead);
  const active = useMail((s) => s.view.kind === "folder" && s.view.folderId === folder.id);
  const unread = useMail((s) => folderUnread(s, folder));
  const expanded = useFolderPrefs((p) => !!p.expanded[folder.id]);
  const fav = useFolderPrefs((p) => p.favorites.includes(folder.id));
  const setExpanded = useFolderPrefs((p) => p.setExpanded);
  const toggleFavorite = useFolderPrefs((p) => p.toggleFavorite);
  const kids = childFoldersIndexed(folders, folder.accountId, folder.id).filter((k) => !visible || visible.has(k.id));
  const open = forceOpen || expanded;
  const Icon = folder.system ? SYSTEM_ICON[folder.system] : FolderIcon;

  const setAll = (value: boolean) => {
    for (const id of [folder.id, ...descendants(folders, folder.id)]) setExpanded(id, value);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <div
            onClick={() => setView({ kind: "folder", folderId: folder.id })}
            title={folderPathCached(folders, folder.id) || folder.name}
            className={cn(
              "group relative flex h-[30px] cursor-default items-center gap-2 rounded-lg pr-2 text-[13px] text-foreground/80 transition-colors hover:bg-foreground/[0.04] hover:text-foreground",
              active && "bg-foreground/[0.075] font-medium text-foreground dark:bg-foreground/10",
            )}
            style={{ paddingLeft: 6 + depth * 14 }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(folder.id, !open);
              }}
              aria-label={open ? "Collapse" : "Expand"}
              className={cn("grid size-4 shrink-0 place-items-center rounded text-foreground/40 hover:text-foreground", !kids.length && "invisible")}
            >
              <ChevronRight className={cn("size-3 transition-transform duration-150", open && "rotate-90")} />
            </button>
            <Icon className="size-[16px] shrink-0 text-foreground/60" strokeWidth={1.6} />
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            {!folder.system && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(folder.id);
                }}
                aria-label={fav ? "Remove from favorites" : "Add to favorites"}
                className={cn("shrink-0 text-foreground/35 hover:text-amber-400", fav ? "text-amber-400" : "hidden group-hover:block")}
              >
                <Star className={cn("size-3.5", fav && "fill-amber-400")} />
              </button>
            )}
            {unread > 0 && (
              <span className="shrink-0 text-[11.5px] font-medium text-[var(--bucket-needs_you)] tabular-nums">
                {unread.toLocaleString()}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem onClick={() => setView({ kind: "folder", folderId: folder.id })}>
            <Icon /> Open
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() =>
              // The counts drop at once; the toast waits for the server.
              void setRead(idsByFolder(useMail.getState().emails).get(folder.id) ?? NO_IDS, true).then((r) =>
                r.failed.length
                  ? toast.error(r.done.length ? `${r.failed.length} of ${r.done.length + r.failed.length} still unread` : "Couldn't mark as read", { description: r.error })
                  : toast(`Marked ${folder.name} as read`),
              )
            }
          >
            <MailCheck /> Mark all as read
          </ContextMenuItem>
          {!folder.system && (
            <ContextMenuItem onClick={() => toggleFavorite(folder.id)}>
              <Star /> {fav ? "Remove from Favorites" : "Add to Favorites"}
            </ContextMenuItem>
          )}
          {kids.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setAll(true)}>Expand all</ContextMenuItem>
              <ContextMenuItem onClick={() => setAll(false)}>Collapse all</ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => toast("Folder management lands with Gmail and Graph sync")}>
            <FolderPlus /> New subfolder…
          </ContextMenuItem>
          {!folder.system && (
            <ContextMenuItem onClick={() => toast("Folder management lands with Gmail and Graph sync")}>Rename…</ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {kids.length > 0 && (
        <motion.div
          initial={false}
          animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
          transition={QUICK}
          className="overflow-hidden"
        >
          {kids.map((k) => (
            <FolderRow key={k.id} folder={k} depth={depth + 1} forceOpen={forceOpen} visible={visible} />
          ))}
        </motion.div>
      )}
    </>
  );
}

function AccountTree({ account, filter, onSettings }: { account: Account; filter: string; onSettings: () => void }) {
  const accounts = useMail((s) => s.accounts);
  const allFolders = useMail((s) => s.folders);
  const refresh = useMail((s) => s.refresh);
  const key = `acct:${account.id}`;
  const acctOpen = useFolderPrefs((p) => p.expanded[key] !== false);
  const setExpanded = useFolderPrefs((p) => p.setExpanded);
  const status = useMail((st) => st.accountStatus[account.id]);
  const folders = useMemo(() => allFolders.filter((f) => f.accountId === account.id), [allFolders, account.id]);
  // Shown on the header while the account is collapsed, so you can see where the unread mail is.
  const inboxUnread = useMail((s) => {
    const inbox = s.folders.find((f) => f.accountId === account.id && f.system === "inbox");
    return inbox ? folderUnread(s, inbox) : 0;
  });

  // When filtering, keep matches plus their ancestors.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return undefined;
    const keep = new Set<string>();
    for (const f of folders) {
      if (!f.name.toLowerCase().includes(q)) continue;
      let cur: Folder | undefined = f;
      while (cur) {
        keep.add(cur.id);
        cur = cur.parentId ? folders.find((x) => x.id === cur!.parentId) : undefined;
      }
    }
    return keep;
  }, [filter, folders]);

  const roots = folders.filter((f) => !f.parentId && (!visible || visible.has(f.id)));
  const ordered = [
    ...roots.filter((f) => f.system === "inbox"),
    ...roots.filter((f) => !f.system),
    ...roots.filter((f) => f.system && f.system !== "inbox"),
  ];
  const open = !!visible || acctOpen;
  if (visible && !roots.length) return null;

  return (
    <div className="mt-3">
      <ContextMenu>
        <ContextMenuTrigger>
          <button
            onClick={() => setExpanded(key, !open)}
            className="group flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-foreground/[0.03]"
          >
            <ChevronRight className={cn("size-3 shrink-0 text-foreground/40 transition-transform", open && "rotate-90")} />
            <AccountIcon account={account} size={22} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-semibold text-foreground/75">{accountLabel(account, accounts)}</span>
              <span className="block truncate text-[10.5px] text-foreground/40">
                {account.address}
                {account.kind === "mock" && " · demo"}
                {status?.state === "syncing" && " · syncing…"}
                {status?.state === "error" && <span className="text-destructive"> · sync failed</span>}
              </span>
            </span>
            {!open && inboxUnread > 0 && (
              <span title="Unread in Inbox" className="shrink-0 pr-1 text-[11.5px] font-medium text-[var(--bucket-needs_you)] tabular-nums">
                {inboxUnread.toLocaleString()}
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onClick={() => void refresh()}>
            <RefreshCw /> Check for new mail
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              for (const f of folders) setExpanded(f.id, false);
            }}
          >
            Collapse all folders
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onSettings}>
            <Settings /> Account settings…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <motion.div
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={QUICK}
        className="overflow-hidden"
      >
        {ordered.map((f) => (
          <FolderRow key={f.id} folder={f} depth={0} forceOpen={!!visible} visible={visible} />
        ))}
      </motion.div>
    </div>
  );
}

function Favorites() {
  const allFolders = useMail((s) => s.folders);
  const favorites = useFolderPrefs((p) => p.favorites);
  const folders = favorites.map((id) => allFolders.find((f) => f.id === id)).filter((f): f is Folder => !!f);
  if (!folders.length) return null;
  return (
    <div className="mt-3">
      <div className="flex h-7 items-center px-2.5 text-[11px] font-semibold tracking-[0.06em] text-foreground/40 uppercase">Favorites</div>
      {folders.map((f) => (
        <FolderRow key={`fav-${f.id}`} folder={{ ...f, parentId: undefined }} depth={0} forceOpen={false} visible={new Set()} />
      ))}
    </div>
  );
}

export function FolderTrees({ onSettings }: { onSettings: () => void }) {
  const accounts = useMail((s) => s.accounts);
  const count = useMail((s) => s.folders.filter((f) => !f.system).length);
  const [filter, setFilter] = useState("");
  return (
    <>
      <Favorites />
      {count > 20 && (
        <label className="mx-1 mt-4 flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-foreground/40 focus-within:bg-foreground/[0.05] hover:bg-foreground/[0.03]">
          <Search className="size-3.5" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            placeholder={`Filter ${count} folders`}
            className="selectable w-full bg-transparent text-foreground outline-none placeholder:text-foreground/35"
          />
        </label>
      )}
      {accounts.map((a) => (
        <AccountTree key={a.id} account={a} filter={filter} onSettings={onSettings} />
      ))}
    </>
  );
}
