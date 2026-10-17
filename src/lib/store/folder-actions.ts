// The store's folder actions: creating folders (and any missing parents) on the server.

import type { StoreApi } from "zustand";
import type { Folder } from "@/lib/types";
import { cachePutFolders } from "@/lib/db";
import { providerFor } from "./providers";
import { folderPath } from "./selectors";
import type { MailState } from "./types";

/** A folder path's parts: "/" (or the " › " zMail shows) separates them; blank parts are dropped. */
export function splitFolderPath(path: string): string[] {
  return path
    .split(/[/›]/)
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/**
 * A folder name or path for comparing: case-insensitive, any dash (– — ‐ −) as "-", runs of spaces as one,
 * so "Lincoln Elementary – Sam" and "lincoln elementary - sam" are the same folder.
 */
export function folderKey(path: string): string {
  return splitFolderPath(path)
    .map((p) => p.toLowerCase().replace(/[‐-―−]/g, "-"))
    .join("/");
}

/** The account's user folder at this path (system folders are never parents of a new folder). */
export function userFolderAt(folders: Folder[], accountId: string, path: string): Folder | undefined {
  const key = folderKey(path);
  return folders.find((f) => f.accountId === accountId && !f.system && folderKey(folderPath(folders, f.id) || f.name) === key);
}

/** Folders after a grouping became a real label: the grouping is gone, its children hang off the label. */
export function replaceGrouping(folders: Folder[], groupingId: string, label: Folder): Folder[] {
  return [
    ...folders.filter((f) => f.id !== groupingId && f.id !== label.id).map((f) => (f.parentId === groupingId ? { ...f, parentId: label.id } : f)),
    label,
  ];
}

export function folderActions(set: StoreApi<MailState>["setState"], get: StoreApi<MailState>["getState"]): Pick<MailState, "createFolder" | "realizeFolder"> {
  return {
    async realizeFolder(folderId) {
      const f = get().folders.find((x) => x.id === folderId);
      if (!f) throw new Error("That folder no longer exists.");
      if (!f.id.includes(":path:")) return f;
      const p = providerFor(f.accountId);
      if (!p.createFolder) throw new Error("This account can't create folders from zMail.");
      // Gmail creates the label under the grouping's own parent (making any parent grouping real first).
      const label = await p.createFolder(f.name, f.parentId);
      set((s) => ({
        folders: replaceGrouping(s.folders, f.id, label),
        // A section linked to the grouping now files into the real label.
        sections: s.sections.map((x) => (x.folderId === f.id ? { ...x, folderId: label.id } : x)),
      }));
      if (get().accounts.find((a) => a.id === f.accountId)?.kind !== "mock") {
        const mine = get().folders.filter((x) => x.accountId === f.accountId);
        void cachePutFolders(f.accountId, mine.map((x) => [x.id, JSON.stringify(x)])).catch(() => {});
      }
      return label;
    },

    async createFolder(accountId, path) {
      const parts = splitFolderPath(path);
      if (!parts.length) throw new Error("A folder needs a name.");
      const p = providerFor(accountId);
      if (!p.createFolder) throw new Error("This account can't create folders from zMail.");
      let parent: Folder | undefined;
      for (let i = 0; i < parts.length; i++) {
        const have = userFolderAt(get().folders, accountId, parts.slice(0, i + 1).join("/"));
        if (have) {
          parent = have;
          continue;
        }
        const made: Folder = await p.createFolder(parts[i], parent?.id);
        set((s) => ({ folders: [...s.folders.filter((f) => f.id !== made.id), made] }));
        parent = made;
      }
      // Saved like a folder sync saves them, so the new folders are there on the next launch.
      if (get().accounts.find((a) => a.id === accountId)?.kind !== "mock") {
        const mine = get().folders.filter((f) => f.accountId === accountId);
        void cachePutFolders(accountId, mine.map((f) => [f.id, JSON.stringify(f)])).catch(() => {});
      }
      return parent!;
    },
  };
}
