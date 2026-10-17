// Ranking for the "Move to…" folder search: the folder whose own name matches comes before
// the folders that only match because they sit under it.

const SEP = " › ";

/** How well the typed text matches a folder: lower is better, null when it doesn't match. */
function tier(path: string, needle: string): number | null {
  const p = path.toLowerCase();
  if (!p.includes(needle)) return null;
  const i = p.lastIndexOf(SEP);
  const leaf = i < 0 ? p : p.slice(i + SEP.length);
  if (leaf === needle) return 0;
  if (leaf.startsWith(needle)) return 1;
  if (leaf.split(/[\s/&()-]+/).some((w) => w.startsWith(needle))) return 2;
  if (leaf.includes(needle)) return 3;
  // Only a parent folder's name matched.
  return 4;
}

/** Folders whose path contains `query`, best first: own-name matches, then shallower, then A–Z. */
export function rankFolderMatches<T extends { path: string }>(folders: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return folders;
  return folders
    .flatMap((f) => {
      const t = tier(f.path, needle);
      return t === null ? [] : [{ f, t, depth: f.path.split(SEP).length }];
    })
    .sort((a, b) => a.t - b.t || a.depth - b.depth || a.f.path.localeCompare(b.f.path, undefined, { sensitivity: "base" }))
    .map((x) => x.f);
}
