// Navigate: moving the app to a view, folder or email.
import { folderPath, useMail, type View } from "@/lib/store";
import type { Account, Email, Folder } from "@/lib/types";
import { useAssistant } from "../state";
import { extOf, type ToolModule } from "./types";
import { refOf } from "./ids";

export interface NavigateDeps {
  folders: () => Folder[];
  accounts: () => Account[];
  emails: () => Email[];
  currentView: () => View;
  accountFilter: () => string | null;
  setView: (v: View) => void;
  select: (id: string | null) => void;
  setAccountFilter: (id: string | null) => void;
}

const ID = "navigate";
const VIEWS = ["today", "triage", "calendar", "inbox", "starred", "snoozed", "folder"] as const;
const VIEW_NAMES: Record<string, string> = { today: "Today", triage: "Triage", calendar: "Calendar", inbox: "Inbox", starred: "Starred", snoozed: "Snoozed" };
const VIEW_KINDS: Record<string, View> = {
  today: { kind: "brief" },
  triage: { kind: "triage" },
  calendar: { kind: "calendar" },
  inbox: { kind: "inbox" },
  starred: { kind: "starred" },
  snoozed: { kind: "snoozed" },
};

const pathOf = (folders: Folder[], f: Folder) => folderPath(folders, f.id) || f.name;

/** Folder by id, else case-insensitive name or path; ambiguity lists up to 5 paths. */
function findFolder(arg: string, folders: Folder[]): Folder {
  const byId = folders.find((f) => f.id === arg);
  if (byId) return byId;
  const q = arg.trim().toLowerCase();
  const hits = folders.filter((f) => f.name.toLowerCase() === q || pathOf(folders, f).toLowerCase() === q);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`unknown folder "${arg}"`);
  const list = hits.slice(0, 5).map((f) => pathOf(folders, f)).join("; ");
  throw new Error(`bad_query: "${arg}" matches ${hits.length} folders (${list}); say which one`);
}

function findAccount(arg: string, accounts: Account[]): Account {
  const q = arg.trim().toLowerCase();
  const hits = accounts.filter((a) => [a.address, a.label, a.name].some((x) => x?.toLowerCase() === q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`bad_query: "${arg}" matches ${hits.length} accounts (${hits.slice(0, 5).map((a) => a.address).join("; ")}); use the address`);
  throw new Error(`unknown account "${arg}"`);
}

const step = (text: string) => useAssistant.getState().push({ kind: "step", text });

export const navigateModule: ToolModule = {
  id: ID,
  prompt: ["- When the user asks to see, open or go to something, use open_view or open_email."],
  tools: [
    {
      name: "open_view",
      description: "Switch the app to a view: Today, Triage, Calendar, Inbox, Starred, Snoozed, or a folder (by id, name or path).",
      parameters: {
        type: "object",
        properties: {
          view: { type: "string", enum: [...VIEWS] },
          folder: { type: "string", description: 'Folder id, name or path; required when view is "folder"' },
        },
        required: ["view"],
      },
    },
    {
      name: "open_email",
      description: "Open an email in the reader. Only ids from earlier tool results work.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "show_account",
      description: 'Show mail from one account (address, label or name), or "all" accounts.',
      parameters: { type: "object", properties: { account: { type: "string", description: 'Address, label or name; omit or "all" for every account' } } },
    },
  ],
  handlers: {
    open_view: async (a, deps) => {
      const d = extOf<NavigateDeps>(deps, ID);
      const view = String(a.view ?? "");
      if (view === "folder") {
        if (typeof a.folder !== "string" || !a.folder.trim()) throw new Error('bad_query: view "folder" needs a folder');
        const f = findFolder(a.folder, d.folders());
        d.setView({ kind: "folder", folderId: f.id });
        const name = pathOf(d.folders(), f);
        step(`Opened ${name}`);
        return { opened: name };
      }
      const v = Object.hasOwn(VIEW_KINDS, view) ? VIEW_KINDS[view] : undefined;
      if (!v) throw new Error(`bad_query: unknown view "${view}"; use ${VIEWS.join(", ")}`);
      d.setView({ ...v });
      step(`Opened ${VIEW_NAMES[view]}`);
      return { opened: VIEW_NAMES[view] };
    },
    open_email: async (a, deps) => {
      const d = extOf<NavigateDeps>(deps, ID);
      const id = refOf(a.id).id;
      const e = d.emails().find((x) => x.id === id);
      if (!e) throw new Error(`unknown id "${id}": that email is not loaded in the mailbox`);
      const folders = d.folders();
      const cur = d.currentView();
      const folder = folders.find((f) => f.id === e.folderId);
      const inView =
        (cur.kind === "folder" && cur.folderId === e.folderId) ||
        (cur.kind === "inbox" && folder?.system === "inbox") ||
        (cur.kind === "starred" && e.starred);
      const filter = d.accountFilter();
      if (filter && filter !== e.accountId) d.setAccountFilter(null);
      if (!inView) d.setView(folder && folder.system !== "inbox" ? { kind: "folder", folderId: folder.id } : { kind: "inbox" });
      d.select(e.id);
      step(`Opened “${e.subject}”`);
      return { opened: e.subject };
    },
    show_account: async (a, deps) => {
      const d = extOf<NavigateDeps>(deps, ID);
      const arg = typeof a.account === "string" ? a.account.trim() : "";
      if (!arg || arg.toLowerCase() === "all") {
        d.setAccountFilter(null);
        step("Showing all accounts");
        return { showing: "all accounts" };
      }
      const acc = findAccount(arg, d.accounts());
      d.setAccountFilter(acc.id);
      step(`Showing ${acc.label || acc.address}`);
      return { showing: acc.address };
    },
  },
  realDeps: (): NavigateDeps => ({
    folders: () => useMail.getState().folders,
    accounts: () => useMail.getState().accounts,
    emails: () => useMail.getState().emails,
    currentView: () => useMail.getState().view,
    accountFilter: () => useMail.getState().accountFilter,
    setView: (v) => useMail.getState().setView(v),
    select: (id) => useMail.getState().select(id),
    setAccountFilter: (id) => useMail.getState().setAccountFilter(id),
  }),
};
