// Organize: rules, categories, sections, re-sorting and folder suggestions.
import { decisionProvider } from "@/lib/ai/providers";
import { describeRule, normalizeFrom, type AutoRule } from "@/lib/rules";
import type { MailSection } from "@/lib/sections";
import { useSettings } from "@/lib/settings";
import { folderPath, isInbox, splitFolderPath, suggestionFor, userFolderAt, useMail, type Lesson } from "@/lib/store";
import { CATEGORIES, type Category, type Email, type Folder } from "@/lib/types";
import { DIRECT_LIMIT } from "@/lib/mail/bulk";
import { useAssistant } from "../state";
import { pathOf, pendingFolderCard, resolveFolder, type CreateFolderPayload } from "../folders";
import type { ToolDeps } from "../tools";
import { pushConfirmCard } from "./confirm";
import { takeDirect } from "./budget";
import { heldForConfirm } from "@/lib/ropeline-security";
import { refsFrom } from "./ids";
import { extOf, type ToolModule } from "./types";

const ID = "organize";
const MAX_IDS = 1000;
const SUGGESTION_CAP = 30;

/** What set_category changed, so Undo can put it back. */
export interface CategorySnapshot {
  prev: Record<string, Category | undefined>;
  lessons: Lesson[];
}

export interface Suggestion {
  folderId: string;
  probability: number;
}

export interface OrganizeDeps {
  autoRules(): AutoRule[];
  rules(): Record<string, string>;
  folders(): Folder[];
  sections(): MailSection[];
  accountCount(): number;
  inbox(): Email[];
  suggestionFor(e: Email): Suggestion | undefined;
  modelName(): string;
  setAutoRuleEnabled(id: string, on: boolean): void;
  removeAutoRule(id: string): void;
  addRule(sender: string, folderId: string): void;
  removeRule(sender: string): void;
  snapshotCategories(ids: string[]): CategorySnapshot;
  /** teach: also record lessons, which the sorting model reads as the user's own corrections. */
  setCategory(ids: string[], category: Category, teach: boolean): void;
  /** The sender addresses of these emails, deduped. */
  sendersOf(ids: string[]): string[];
  restoreCategories(ids: string[], snap: CategorySnapshot): void;
  addSection(input: Omit<MailSection, "id">): string;
  updateSection(id: string, patch: Partial<Omit<MailSection, "id">>): void;
  removeSection(id: string): void;
  /** Throws when the whole sort failed; returns what some emails' failure was, if any. */
  sort(opts?: { onlyNew?: boolean; staleSections?: boolean }): Promise<{ failed: number; total: number; error: string } | undefined>;
  acceptSuggestion(ids: string[]): Promise<{ done: number; failed?: number; error?: string }>;
  dismissSuggestion(ids: string[]): void;
  accounts(): { id: string; address: string }[];
  /** The account of the folder the user is looking at, if they're in a folder. */
  viewAccount(): string | undefined;
  createFolder(accountId: string, path: string): Promise<Folder>;
}

function realOrganizeDeps(): OrganizeDeps {
  const s = () => useMail.getState();
  const isCat = (l: Lesson) => l.category !== undefined;
  return {
    autoRules: () => s().autoRules,
    rules: () => s().rules,
    folders: () => s().folders,
    sections: () => s().sections,
    accountCount: () => s().accounts.length,
    inbox: () => s().emails.filter((e) => isInbox(s(), e)),
    suggestionFor: (e) => {
      const r = suggestionFor(s(), e, useSettings.getState().suggestThreshold);
      return r && { folderId: r.folderId, probability: r.probability };
    },
    modelName: () => decisionProvider().name,
    setAutoRuleEnabled: (id, on) => s().setAutoRuleEnabled(id, on),
    removeAutoRule: (id) => s().removeAutoRule(id),
    addRule: (sender, folderId) => s().addRule(sender, folderId),
    removeRule: (sender) => s().removeRule(sender),
    snapshotCategories: (ids) => {
      const want = new Set(ids);
      const st = s();
      return {
        prev: Object.fromEntries(ids.map((id) => [id, st.categoryOverrides[id]])),
        lessons: st.lessons.filter((l) => want.has(l.emailId) && isCat(l)),
      };
    },
    setCategory: (ids, category, teach) => s().setCategory(ids, category, { learn: teach }),
    sendersOf: (ids) => {
      const mine = new Map(s().emails.map((e) => [e.id, e]));
      const seen = useAssistant.getState().headers;
      const out = ids.map((id) => (mine.get(id) ?? (Object.hasOwn(seen, id) ? seen[id] : undefined))?.from.address.toLowerCase());
      return [...new Set(out.filter((a): a is string => !!a))];
    },
    restoreCategories: (ids, snap) => {
      const want = new Set(ids);
      useMail.setState((st) => {
        const categoryOverrides = { ...st.categoryOverrides };
        for (const id of ids) {
          const p = snap.prev[id];
          if (p) categoryOverrides[id] = p;
          else delete categoryOverrides[id];
        }
        return { categoryOverrides, lessons: [...snap.lessons, ...st.lessons.filter((l) => !(want.has(l.emailId) && isCat(l)))] };
      });
    },
    addSection: (input) => s().addSection(input),
    updateSection: (id, patch) => s().updateSection(id, patch),
    removeSection: (id) => s().removeSection(id),
    // The store's sort records a failure in sorting.error/failed instead of rejecting; surface it.
    sort: async (opts) => {
      await s().sort(opts);
      const { error, failed, total } = s().sorting;
      if (error) throw new Error(`Sorting failed: ${error.replace(/^Error: /, "")}`);
      return failed ? { failed: failed.count, total, error: failed.error.replace(/^Error: /, "") } : undefined;
    },
    acceptSuggestion: async (ids) => {
      const r = await s().acceptSuggestion(ids);
      return { done: r.done.length, failed: r.failed.length, error: r.error };
    },
    dismissSuggestion: (ids) => s().dismissSuggestion(ids),
    accounts: () => s().accounts.map((a) => ({ id: a.id, address: a.address })),
    viewAccount: () => {
      const v = s().view;
      return v.kind === "folder" ? s().folders.find((f) => f.id === v.folderId)?.accountId : undefined;
    },
    createFolder: (accountId, path) => s().createFolder(accountId, path),
  };
}

// ---- helpers ------------------------------------------------------------------

const d = (deps: ToolDeps) => extOf<OrganizeDeps>(deps, ID);
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const AWAIT = { status: "awaiting_confirmation", note: "A card is waiting for the user's OK. Nothing has happened yet." };
const step = (text: string) => useAssistant.getState().push({ kind: "step", text });

const FOLDER_NAME_MAX = 100;
/** A section's name and description are the criteria the sorting model reads for every email. */
const SECTION_NAME_MAX = 100;
const SECTION_DESCRIPTION_MAX = 500;
/** Senders named on a card; the rest are counted. */
const SENDERS_SHOWN = 5;

/** The account create_folder works in: the one named, else the open folder's, else the only one. */
function folderAccount(o: OrganizeDeps, v: unknown): { id: string; address: string } {
  const accounts = o.accounts();
  const list = () => accounts.map((a) => `${a.address} = ${a.id}`).join("; ");
  if (v !== undefined && str(v)) {
    const q = str(v).toLowerCase();
    const a = accounts.find((x) => x.id === str(v) || x.address.toLowerCase() === q);
    if (!a) throw new Error(`bad_query: unknown account_id "${str(v)}"; use one of ${list()}`);
    return a;
  }
  const viewing = o.viewAccount();
  const a = (viewing && accounts.find((x) => x.id === viewing)) || (accounts.length === 1 ? accounts[0] : undefined);
  if (!a) throw new Error(`bad_query: which account? Give account_id (${list()})`);
  return a;
}

/** Email ids from `ids` or a `set_id`; every id must have come from an earlier tool result. */
function targetIds(a: Record<string, unknown>): string[] {
  return refsFrom(a, { max: MAX_IDS }).map((r) => r.id);
}

function requireSection(deps: OrganizeDeps, id: unknown): MailSection {
  const sec = deps.sections().find((x) => x.id === id);
  if (!sec) throw new Error(`unknown section "${String(id)}": use an id from list_sections`);
  return sec;
}

/** A section name or description from the model: non-empty and bounded. */
function sectionText(v: unknown, what: "name" | "description"): string {
  const t = str(v);
  if (!t) throw new Error(`bad_query: ${what} can't be empty`);
  const max = what === "name" ? SECTION_NAME_MAX : SECTION_DESCRIPTION_MAX;
  if (t.length > max) throw new Error(`bad_query: ${what} must be ${max} characters or fewer`);
  return t;
}

/** "a@x.com, b@y.com and 3 more". */
function senderList(senders: string[]): string {
  const shown = senders.slice(0, SENDERS_SHOWN).join(", ");
  return senders.length > SENDERS_SHOWN ? `${shown} and ${(senders.length - SENDERS_SHOWN).toLocaleString()} more` : shown;
}

function resortStale(deps: OrganizeDeps) {
  void deps.sort({ staleSections: true }).catch(() => {});
}

// ---- tools --------------------------------------------------------------------

const none = { type: "object", properties: {} };

export const organizeModule: ToolModule = {
  id: ID,
  prompt: [
    "- Categories (primary, transactions, updates, promotions, social, newsletters, security) are what kind of email it is; lanes are what to do with it; sections are the user's own groups.",
    "- Turning rules on or off, rule deletions, always-file rules, new sections, section edits, deleting sections, whole-inbox re-sorts and accepting folder suggestions show a card; tell the user to confirm there.",
    "- To always file a sender's mail into a folder, use always_file. For other automatic handling of new mail (trash, archive, mark read, a lane), use propose_rule.",
    "- Folders must exist before you file, move or add rules into them. To make new ones, call create_folder (one per folder) and wait for the user's confirmation before moving mail or adding rules into them.",
    "- When proposing a new folder structure, list the folders you'd create and ask before calling create_folder.",
  ],
  tools: [
    { name: "list_rules", description: "List the user's automatic rules (id, text, enabled, hits) and always-file rules (sender, folder).", parameters: none },
    {
      name: "set_rule_enabled",
      description: "Turn an automatic rule on or off. Shows a confirm card naming the rule.",
      parameters: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"] },
    },
    {
      name: "delete_rule",
      description: "Delete an automatic rule (id) or an always-file rule (sender). Shows a confirm card.",
      parameters: { type: "object", properties: { id: { type: "string" }, sender: { type: "string" } } },
    },
    {
      name: "always_file",
      description: "Always file mail from a sender into a folder. Shows a confirm card.",
      parameters: {
        type: "object",
        properties: { sender: { type: "string", description: "An address, or a domain (amazon.com) for everyone there, its subdomains included" }, folder: { type: "string", description: "Folder name, path or id" } },
        required: ["sender", "folder"],
      },
    },
    {
      name: "create_folder",
      description: "Create a folder (missing parent folders too). The user confirms on a card; it doesn't exist until they do. Returns exists: true when it is already there.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Use "/" for nesting, e.g. "Kids/Sam"' },
          account_id: { type: "string", description: "Optional when one account is connected or the user is in one of its folders" },
        },
        required: ["path"],
      },
    },
    {
      name: "set_category",
      description: `Set the category of emails (ids from earlier tool results, or a set_id). Changes how they show, right away with Undo while they total ${DIRECT_LIMIT} emails or fewer in this user message; more shows a confirm card. Only with teach: true does the sorting model learn from it for future mail from these senders, and then the user always confirms on a card.`,
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          set_id: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          teach: { type: "boolean", description: "Only when the user asked zMail to learn this for the future" },
        },
        required: ["category"],
      },
    },
    { name: "list_sections", description: "List the user's sections (id, name, description, folder).", parameters: none },
    {
      name: "create_section",
      description: "Create a section, a group of mail the sorting model fills from a plain-English description. Shows a confirm card.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string", description: "Plain English criteria for what belongs in it" },
          folder: { type: "string", description: "Optional folder/label to link" },
          catch_dates: { type: "boolean", description: "Also pull due dates and events out of its mail" },
        },
        required: ["name", "description"],
      },
    },
    {
      name: "update_section",
      description: "Rename a section or change its description. Shows a confirm card with the new text; once confirmed, mail sorted before the change is re-sorted in the background.",
      parameters: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["id"] },
    },
    { name: "delete_section", description: "Delete a section. Shows a confirm card.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    {
      name: "resort",
      description: 'Run the sorting model again. scope "new" sorts only mail not yet sorted, right away. scope "inbox" re-sorts the whole inbox, which costs money, so it shows a confirm card.',
      parameters: { type: "object", properties: { scope: { type: "string", enum: ["new", "inbox"] } }, required: ["scope"] },
    },
    { name: "folder_suggestions", description: `Inbox emails the sorting model suggests moving to a folder (up to ${SUGGESTION_CAP}).`, parameters: none },
    {
      name: "accept_suggestions",
      description: "Move emails to their suggested folders. Shows a confirm card.",
      parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
    },
    {
      name: "dismiss_suggestions",
      description: `Dismiss folder suggestions for these emails right away (past ${DIRECT_LIMIT} emails in this user message, the user confirms on a card).`,
      parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
    },
  ],
  handlers: {
    async list_rules(_a, deps) {
      const o = d(deps);
      const folders = o.folders();
      const name = (id: string) => folderPath(folders, id) || undefined;
      step("Read your rules");
      return {
        automatic: o.autoRules().map((r) => ({ id: r.id, text: describeRule(r, name), enabled: r.enabled, hits: r.hits })),
        always_file: Object.entries(o.rules()).map(([sender, folderId]) => ({ sender, folder: name(folderId) ?? folderId })),
      };
    },

    async set_rule_enabled(a, deps) {
      const o = d(deps);
      const rule = o.autoRules().find((r) => r.id === a.id);
      if (!rule) throw new Error(`unknown rule id "${String(a.id)}": use an id from list_rules`);
      if (typeof a.enabled !== "boolean") throw new Error("bad_query: enabled must be true or false");
      if (rule.enabled === a.enabled) return { id: rule.id, enabled: a.enabled, note: `That rule is already ${a.enabled ? "on" : "off"}.` };
      const folders = o.folders();
      const text = describeRule(rule, (id) => folderPath(folders, id) || undefined);
      pushConfirmCard({
        module: ID,
        action: "set_rule_enabled",
        title: a.enabled ? "Turn on rule" : "Turn off rule",
        detail: text,
        preview: { fields: [{ label: "Rule", value: text }] },
        payload: { id: rule.id, enabled: a.enabled },
        confirmLabel: a.enabled ? "Turn on" : "Turn off",
      });
      return AWAIT;
    },

    async delete_rule(a, deps) {
      const o = d(deps);
      if (a.id !== undefined && a.sender !== undefined) throw new Error("bad_query: give id or sender, not both");
      const folders = o.folders();
      const name = (id: string) => folderPath(folders, id) || undefined;
      if (a.id !== undefined) {
        const rule = o.autoRules().find((r) => r.id === a.id);
        if (!rule) throw new Error(`unknown rule id "${String(a.id)}": use an id from list_rules`);
        pushConfirmCard({
          module: ID,
          action: "delete_rule",
          title: "Delete automatic rule",
          detail: describeRule(rule, name),
          preview: { fields: [{ label: "Rule", value: describeRule(rule, name) }] },
          payload: { id: rule.id },
          confirmLabel: "Delete",
        });
        return AWAIT;
      }
      const sender = str(a.sender).toLowerCase();
      const folderId = Object.hasOwn(o.rules(), sender) ? o.rules()[sender] : undefined;
      if (!folderId) throw new Error(`unknown sender "${sender}": use a sender from list_rules`);
      pushConfirmCard({
        module: ID,
        action: "delete_rule",
        title: `Stop filing ${sender}`,
        detail: `Currently filed into ${name(folderId) ?? folderId}`,
        payload: { sender },
        confirmLabel: "Delete",
      });
      return AWAIT;
    },

    async always_file(a, deps) {
      const o = d(deps);
      const sender = normalizeFrom(str(a.sender));
      if (!sender) throw new Error("bad_query: sender must be an email address or a domain (amazon.com)");
      const folder = resolveFolder(o.folders(), a.folder);
      const path = folderPath(o.folders(), folder.id) || folder.name;
      const from = sender.includes("@") ? sender : `Anyone at ${sender}`;
      pushConfirmCard({
        module: ID,
        action: "always_file",
        title: `Always file ${sender}`,
        detail: `Into ${path}`,
        preview: { fields: [{ label: "From", value: from }, { label: "Folder", value: path }] },
        payload: { sender, folderId: folder.id },
        confirmLabel: "Always file",
      });
      return AWAIT;
    },

    async create_folder(a, deps) {
      const o = d(deps);
      if (typeof a.path !== "string") throw new Error("bad_query: path must be a string");
      const raw = a.path.split("/").map((p) => p.trim());
      if (raw.some((p) => !p)) throw new Error('bad_query: path needs a name for every level, e.g. "Kids/Sam"');
      // eslint-disable-next-line no-control-regex
      if (raw.some((p) => /[\u0000-\u001f\u007f]/.test(p))) throw new Error("bad_query: folder names can't contain control characters");
      if (raw.some((p) => p.length > FOLDER_NAME_MAX)) throw new Error(`bad_query: each folder name must be ${FOLDER_NAME_MAX} characters or fewer`);
      const parts = splitFolderPath(raw.join("/"));
      const path = parts.join("/");
      const account = folderAccount(o, a.account_id);
      const folders = o.folders();
      const there = userFolderAt(folders, account.id, path);
      if (there) return { exists: true, folder_id: there.id, path: pathOf(folders, there) };
      // The same folder asked for twice in a turn gets one card.
      if (pendingFolderCard(path, account.id)) return AWAIT;
      const create = parts.map((_, i) => parts.slice(0, i + 1).join("/")).filter((p) => !userFolderAt(folders, account.id, p));
      const payload: CreateFolderPayload = { accountId: account.id, path, create };
      pushConfirmCard({
        module: ID,
        action: "create_folder",
        title: `Create folder "${path}"`,
        detail: account.address,
        preview: { fields: create.map((p) => ({ label: "New folder", value: p })) },
        payload,
        confirmLabel: "Create",
      });
      return AWAIT;
    },

    async set_category(a, deps) {
      const o = d(deps);
      const category = a.category as Category;
      if (!CATEGORIES.includes(category)) throw new Error(`bad_query: category must be one of ${CATEGORIES.join(", ")}`);
      const ids = targetIds(a);
      // Teaching is a lasting change to how future mail is sorted, so only a click on a card does it.
      const teach = a.teach === true;
      const known = o.inbox().filter((e) => ids.includes(e.id));
      if (!teach && !known.some((e) => heldForConfirm(e)) && takeDirect(ids.length)) {
        const snap = o.snapshotCategories(ids);
        o.setCategory(ids, category, false);
        step(`Set ${plural(ids.length, "email")} to ${category}`);
        deps.toast(`Set ${plural(ids.length, "email")} to ${category}`, () => o.restoreCategories(ids, snap));
        return { done: ids.length, category, taught: false, note: "Only how these emails show changed; the sorting model didn't learn from it." };
      }
      const senders = o.sendersOf(ids);
      pushConfirmCard({
        module: ID,
        action: "set_category",
        title: `Set ${plural(ids.length, "email")} to ${category}`,
        detail: teach ? "zMail's sorting model will learn this for future mail from these senders." : "Only these emails change; the sorting model doesn't learn from it.",
        preview: { fields: [...(senders.length ? [{ label: "From", value: senderList(senders) }] : []), { label: "Category", value: category }] },
        payload: { ids, category, teach },
        confirmLabel: teach ? "Set and teach" : "Set category",
      });
      return AWAIT;
    },

    async list_sections(_a, deps) {
      const o = d(deps);
      const folders = o.folders();
      return {
        sections: o.sections().map((x) => ({ id: x.id, name: x.name, description: x.description, folder: x.folderId ? folderPath(folders, x.folderId) || x.folderId : null, dates: x.dates })),
      };
    },

    async create_section(a, deps) {
      const o = d(deps);
      if (!str(a.name) || !str(a.description)) throw new Error("bad_query: name and description are required");
      const name = sectionText(a.name, "name");
      const description = sectionText(a.description, "description");
      if (o.sections().some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`bad_query: a section named "${name}" already exists`);
      const folder = a.folder !== undefined && str(a.folder) ? resolveFolder(o.folders(), a.folder, { userOnly: true }) : undefined;
      const dates = a.catch_dates === true;
      pushConfirmCard({
        module: ID,
        action: "create_section",
        title: `Create section “${name}”`,
        detail: description,
        preview: {
          fields: [
            { label: "Name", value: name },
            { label: "Description", value: description },
            ...(folder ? [{ label: "Folder", value: folderPath(o.folders(), folder.id) || folder.name }] : []),
            { label: "Catch dates", value: dates ? "Yes" : "No" },
          ],
        },
        payload: { name, description, folderId: folder?.id, dates },
        confirmLabel: "Create section",
      });
      return AWAIT;
    },

    async update_section(a, deps) {
      const o = d(deps);
      const sec = requireSection(o, a.id);
      const patch: { name?: string; description?: string } = {};
      if (a.name !== undefined) patch.name = sectionText(a.name, "name");
      if (a.description !== undefined) patch.description = sectionText(a.description, "description");
      if (!Object.keys(patch).length) throw new Error("bad_query: give a name or description to change");
      // The description is what the sorting model reads, so the card shows the whole new text.
      pushConfirmCard({
        module: ID,
        action: "update_section",
        title: `Change section “${sec.name}”`,
        detail: "Mail is re-sorted with the new wording once you confirm.",
        preview: {
          fields: [
            ...(patch.name !== undefined ? [{ label: "Name", value: patch.name }] : []),
            ...(patch.description !== undefined ? [{ label: "Description", value: patch.description }] : []),
          ],
        },
        payload: { id: sec.id, patch },
        confirmLabel: "Save section",
      });
      return AWAIT;
    },

    async delete_section(a, deps) {
      const sec = requireSection(d(deps), a.id);
      pushConfirmCard({
        module: ID,
        action: "delete_section",
        title: `Delete section “${sec.name}”`,
        detail: "Mail in it goes back to the regular lanes. Nothing is deleted from your mailbox.",
        payload: { id: sec.id },
        confirmLabel: "Delete section",
      });
      return AWAIT;
    },

    async resort(a, deps) {
      const o = d(deps);
      if (a.scope === "new") {
        // Awaited, so a failed sort is reported instead of claimed.
        const missed = await o.sort({ onlyNew: true });
        step("Sorted new mail");
        if (missed) return { status: "partial", note: `${missed.failed} of ${missed.total} emails couldn't be sorted (${missed.error}); the rest are sorted now.` };
        return { status: "done", note: "Mail that hadn't been sorted yet is sorted now." };
      }
      if (a.scope !== "inbox") throw new Error('bad_query: scope must be "new" or "inbox"');
      const n = o.inbox().length;
      const model = o.modelName();
      pushConfirmCard({
        module: ID,
        action: "resort",
        title: `Re-sort ${plural(n, "inbox email")} with ${model}`,
        detail: "This runs the sorting model on every inbox email and can cost money.",
        payload: {},
        confirmLabel: "Re-sort",
      });
      return AWAIT;
    },

    async folder_suggestions(_a, deps) {
      const o = d(deps);
      const st = useAssistant.getState();
      const folders = o.folders();
      const picked: { e: Email; s: Suggestion }[] = [];
      for (const e of o.inbox()) {
        const s = o.suggestionFor(e);
        if (s) picked.push({ e, s });
        if (picked.length >= SUGGESTION_CAP) break;
      }
      st.remember(picked.map(({ e }) => ({ id: e.id, accountId: e.accountId })));
      step("Looked at folder suggestions");
      const suggestions = picked.map(({ e, s }) => ({
        id: e.id,
        ref: st.refFor(e),
        from: e.from.name || e.from.address,
        subject: e.subject,
        folder: folderPath(folders, s.folderId) || s.folderId,
        confidence: Math.round(s.probability * 100) / 100,
      }));
      return { suggestions, count: suggestions.length };
    },

    async accept_suggestions(a, deps) {
      const o = d(deps);
      const ids = targetIds({ ids: a.ids });
      const byId = new Map(o.inbox().map((e) => [e.id, e]));
      const counts = new Map<string, number>();
      const usable: string[] = [];
      for (const id of ids) {
        const e = byId.get(id);
        const s = e && o.suggestionFor(e);
        if (!s) continue;
        usable.push(id);
        counts.set(s.folderId, (counts.get(s.folderId) ?? 0) + 1);
      }
      if (!usable.length) throw new Error("unknown target: none of those emails has a folder suggestion");
      const folders = o.folders();
      pushConfirmCard({
        module: ID,
        action: "accept_suggestions",
        title: `Move ${plural(usable.length, "email")} to suggested folders`,
        preview: { fields: [...counts].map(([f, n]) => ({ label: folderPath(folders, f) || f, value: plural(n, "email") })) },
        payload: { ids: usable },
        confirmLabel: "Move",
      });
      return AWAIT;
    },

    async dismiss_suggestions(a, deps) {
      const ids = targetIds({ ids: a.ids });
      if (!takeDirect(ids.length)) {
        pushConfirmCard({
          module: ID,
          action: "dismiss_suggestions",
          title: `Dismiss ${plural(ids.length, "folder suggestion")}`,
          payload: { ids },
          confirmLabel: "Dismiss",
        });
        return AWAIT;
      }
      d(deps).dismissSuggestion(ids);
      step(`Dismissed ${plural(ids.length, "suggestion")}`);
      return { dismissed: ids.length };
    },
  },
  confirm: {
    async set_rule_enabled(payload, deps) {
      const o = d(deps);
      const p = payload as { id: string; enabled: boolean };
      if (!o.autoRules().some((r) => r.id === p.id)) throw new Error("That rule is gone.");
      o.setAutoRuleEnabled(p.id, p.enabled);
      return `Rule turned ${p.enabled ? "on" : "off"}`;
    },
    async delete_rule(payload, deps) {
      const o = d(deps);
      const p = payload as { id?: string; sender?: string };
      if (p.id) {
        o.removeAutoRule(p.id);
        return "Rule deleted";
      }
      o.removeRule(String(p.sender));
      return `No longer filing ${p.sender}`;
    },
    async always_file(payload, deps) {
      const p = payload as { sender: string; folderId: string };
      const o = d(deps);
      o.addRule(p.sender, p.folderId);
      return `Mail from ${p.sender} will go to ${folderPath(o.folders(), p.folderId) || "that folder"}`;
    },
    async create_folder(payload, deps) {
      const p = payload as CreateFolderPayload;
      await d(deps).createFolder(p.accountId, p.path);
      return `Created "${p.path}"`;
    },
    async set_category(payload, deps) {
      const p = payload as { ids: string[]; category: Category; teach?: boolean };
      // Cards saved before teach existed said "This also teaches the sorting model".
      const teach = p.teach ?? true;
      d(deps).setCategory(p.ids, p.category, teach);
      return `Set ${plural(p.ids.length, "email")} to ${p.category}${teach ? "; the sorting model learned from it" : ""}`;
    },
    async update_section(payload, deps) {
      const o = d(deps);
      const p = payload as { id: string; patch: { name?: string; description?: string } };
      const sec = o.sections().find((x) => x.id === p.id);
      if (!sec) throw new Error("That section is gone.");
      o.updateSection(sec.id, p.patch);
      resortStale(o);
      return `Updated “${p.patch.name ?? sec.name}”; mail sorted before the change is being re-sorted`;
    },
    async create_section(payload, deps) {
      const o = d(deps);
      const p = payload as { name: string; description: string; folderId?: string; dates: boolean };
      const folder = p.folderId ? o.folders().find((f) => f.id === p.folderId) : undefined;
      o.addSection({
        name: p.name,
        description: p.description,
        icon: "heart",
        hue: 295,
        dates: p.dates,
        folderId: folder?.id,
        accountIds: folder && o.accountCount() > 1 ? [folder.accountId] : [],
      });
      resortStale(o);
      return `Created “${p.name}”; mail sorted before it is being re-sorted`;
    },
    async delete_section(payload, deps) {
      const o = d(deps);
      const p = payload as { id: string };
      const sec = o.sections().find((x) => x.id === p.id);
      if (!sec) throw new Error("That section is already gone.");
      o.removeSection(p.id);
      return `Deleted “${sec.name}”`;
    },
    async resort(_payload, deps) {
      // sort() throws when the store recorded an error, so the card shows it as failed.
      const missed = await d(deps).sort();
      return missed ? `Inbox re-sorted; ${missed.failed} of ${missed.total} couldn't be sorted (${missed.error})` : "Inbox re-sorted";
    },
    async dismiss_suggestions(payload, deps) {
      const p = payload as { ids: string[] };
      d(deps).dismissSuggestion(p.ids);
      return `Dismissed ${plural(p.ids.length, "suggestion")}`;
    },
    async accept_suggestions(payload, deps) {
      const p = payload as { ids: string[] };
      const r = await d(deps).acceptSuggestion(p.ids);
      if (r.error && !r.done) throw new Error(r.error);
      return `Moved ${plural(r.done, "email")}${r.failed ? `; ${r.failed} failed` : ""}`;
    },
  },
  realDeps: realOrganizeDeps,
};
