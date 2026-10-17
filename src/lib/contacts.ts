// People search for @mentions and address fields: the Microsoft 365 directory
// (People API, relevance-ranked GAL + contacts), Google contacts and "other
// contacts", and everyone you've exchanged mail with. Results are merged by
// address and ranked by how well the name matches, then by source.

import type { Account, Email } from "@/lib/types";
import { request } from "@/lib/transport";
import { accessToken } from "@/lib/oauth";
import { graph } from "@/lib/microsoft/graph";
import { held } from "@/lib/store/held";
import { isSingleMailbox } from "@/lib/mail/address";

export interface Person {
  /** "First Last", even when the directory stores "Last, First". */
  name: string;
  address: string;
  title?: string;
  department?: string;
  source: "directory" | "contacts" | "mail";
}

export interface PeopleSource {
  search(q: string): Promise<Person[]>;
}

/** Directory names often come as "Hollis, Scott"; mail wants "Scott Hollis". */
export function displayName(raw: string): string {
  const m = /^\s*([^,]+?),\s*([^,]+?)\s*$/.exec(raw);
  return m ? `${m[2]} ${m[1]}` : raw.trim();
}

export const firstName = (name: string) => displayName(name).split(/\s+/)[0] ?? name;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.\s]/g, " ").replace(/\s+/g, " ").trim();

/** 0 = no match; higher is better. Every query word must prefix a name word or the address. */
export function matchScore(p: Person, q: string): number {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return 1;
  const nameWords = norm(p.name).split(" ");
  const addr = p.address.toLowerCase();
  let score = 0;
  for (const w of words) {
    const i = nameWords.findIndex((n) => n.startsWith(w));
    if (i === 0) score += 3;
    else if (i > 0) score += 2;
    else if (addr.startsWith(w) || addr.includes(`.${w}`)) score += 1;
    else return 0;
  }
  return score;
}

const SOURCE_RANK: Record<Person["source"], number> = { directory: 2, contacts: 1, mail: 0 };

/** Merge by address (keeping the richest record) and rank. */
export function mergePeople(q: string, lists: Person[][], limit = 8): Person[] {
  const byAddr = new Map<string, Person>();
  for (const p of lists.flat()) {
    // Picking someone inserts their address into a To field: never one that is really several.
    if (!p.address.includes("@") || !isSingleMailbox(p.address)) continue;
    const key = p.address.toLowerCase();
    const prev = byAddr.get(key);
    byAddr.set(key, prev ? { ...p, ...prev, title: prev.title ?? p.title, department: prev.department ?? p.department, source: SOURCE_RANK[p.source] > SOURCE_RANK[prev.source] ? p.source : prev.source } : p);
  }
  return [...byAddr.values()]
    .map((p, i) => ({ p, s: matchScore(p, q), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || SOURCE_RANK[b.p.source] - SOURCE_RANK[a.p.source] || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.p);
}

// ---- people from your mail ------------------------------------------------------------

let mailMemo: { emails: Email[]; own: string; people: Person[] } | null = null;

/** Everyone you've exchanged mail with, most frequent first. Memoized on the emails array and own addresses (it ran per keystroke). */
export function peopleFromMail(emails: Email[], own: Set<string>): Person[] {
  const ownKey = [...own].sort().join("\n");
  if (mailMemo && mailMemo.emails === emails && mailMemo.own === ownKey) return mailMemo.people;
  const people = scanPeopleFromMail(emails, own);
  mailMemo = { emails, own: ownKey, people };
  return people;
}

function scanPeopleFromMail(emails: Email[], own: Set<string>): Person[] {
  const seen = new Map<string, { p: Person; n: number }>();
  for (const e of emails) {
    // Search results held in the store (see store/held.ts) aren't part of your mail here.
    if (held.has(e.id)) continue;
    for (const c of [e.from, ...e.to, ...(e.cc ?? [])]) {
      const key = c.address.toLowerCase();
      if (!key.includes("@") || own.has(key) || /no-?reply|notifications?@|mailer-daemon/.test(key)) continue;
      const hit = seen.get(key);
      if (hit) hit.n++;
      else seen.set(key, { p: { name: displayName(c.name || c.address), address: c.address, source: "mail" }, n: 1 });
    }
  }
  return [...seen.values()].sort((a, b) => b.n - a.n).map((x) => x.p);
}

// ---- Microsoft 365: People API ------------------------------------------------------------

interface GPerson {
  displayName?: string;
  jobTitle?: string | null;
  department?: string | null;
  scoredEmailAddresses?: { address?: string }[];
}

export function graphPersonToPerson(g: GPerson): Person | null {
  const address = g.scoredEmailAddresses?.[0]?.address;
  if (!address) return null;
  return { name: displayName(g.displayName || address), address, title: g.jobTitle ?? undefined, department: g.department ?? undefined, source: "directory" };
}

export class GraphPeople implements PeopleSource {
  constructor(readonly account: Account) {}
  async search(q: string) {
    const params = new URLSearchParams({ $search: `"${q.replace(/"/g, "")}"`, $top: "10", $select: "displayName,jobTitle,department,scoredEmailAddresses" });
    const res = await graph<{ value: GPerson[] }>(this.account.id, "GET", `/me/people?${params}`);
    return res.value.map(graphPersonToPerson).filter((p): p is Person => !!p);
  }
}

// ---- Google: contacts + other contacts ---------------------------------------------------

interface GContact {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  organizations?: { title?: string; department?: string; name?: string }[];
}

export function googleContactToPeople(c: GContact, source: Person["source"]): Person[] {
  const org = c.organizations?.[0];
  return (c.emailAddresses ?? [])
    .filter((e) => e.value)
    .map((e) => ({
      name: displayName(c.names?.[0]?.displayName || e.value!),
      address: e.value!,
      title: org?.title,
      department: org?.department ?? org?.name,
      source,
    }));
}

export class GooglePeople implements PeopleSource {
  private warmed = false;
  constructor(readonly account: Account) {}

  private async get<T>(path: string, params: Record<string, string>) {
    const token = await accessToken(this.account.id);
    return request<T>("GET", `https://people.googleapis.com/v1/${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  }

  async search(q: string) {
    // Google asks for an empty "warmup" search before the first real one.
    if (!this.warmed) {
      this.warmed = true;
      await Promise.allSettled([
        this.get("people:searchContacts", { query: "", readMask: "names" }),
        this.get("otherContacts:search", { query: "", readMask: "names" }),
      ]);
    }
    const [mine, other] = await Promise.allSettled([
      this.get<{ results?: { person: GContact }[] }>("people:searchContacts", { query: q, readMask: "names,emailAddresses,organizations", pageSize: "10" }),
      this.get<{ results?: { person: GContact }[] }>("otherContacts:search", { query: q, readMask: "names,emailAddresses", pageSize: "10" }),
    ]);
    return [
      ...(mine.status === "fulfilled" ? (mine.value?.results ?? []).flatMap((r) => googleContactToPeople(r.person, "contacts")) : []),
      ...(other.status === "fulfilled" ? (other.value?.results ?? []).flatMap((r) => googleContactToPeople(r.person, "mail")) : []),
    ];
  }
}

// ---- demo ------------------------------------------------------------------------------

/** A small made-up directory so the demo accounts show titles and departments. */
const DEMO_DIRECTORY: Person[] = [
  { name: "Jen Alvarez", address: "jen.alvarez@example.org", title: "Chief of Staff", department: "Office of the President", source: "directory" },
  { name: "Sarah Kim", address: "sarah.kim@example.org", title: "Director, Enterprise Applications", department: "Information Technology", source: "directory" },
  { name: "Dana Whitfield", address: "dana.whitfield@example.org", title: "Associate CIO", department: "Information Technology", source: "directory" },
  { name: "Marcus Webb", address: "marcus.webb@example.org", title: "Network Engineer", department: "Information Technology", source: "directory" },
  { name: "Priya Natarajan", address: "priya.natarajan@example.org", title: "Budget Analyst", department: "Office of the Provost", source: "directory" },
];

export class DemoPeople implements PeopleSource {
  async search(q: string) {
    return DEMO_DIRECTORY.filter((p) => matchScore(p, q) > 0);
  }
}

/** One source per account, so GooglePeople stays warmed between searches. */
const sourceCache = new Map<string, { account: Account; source: PeopleSource }>();

export function peopleSourceFor(account: Account): PeopleSource {
  const hit = sourceCache.get(account.id);
  if (hit && hit.account.kind === account.kind && hit.account.address === account.address) return hit.source;
  const source = account.kind === "m365" ? new GraphPeople(account) : account.kind === "gmail" ? new GooglePeople(account) : new DemoPeople();
  sourceCache.set(account.id, { account, source });
  return source;
}

/** Whether a query is long enough to ask the directories (one letter matches half of them). */
export const searchesRemote = (q: string) => q.trim().length >= 2;

/** Every account's directory or contacts; a failing source never sinks the rest. */
export async function searchRemotePeople(q: string, accounts: Account[]): Promise<Person[][]> {
  // Forget sources of accounts that are gone.
  for (const id of sourceCache.keys()) if (!accounts.some((a) => a.id === id)) sourceCache.delete(id);
  const sources = [
    ...accounts.filter((a) => a.kind !== "mock").map(peopleSourceFor),
    ...(accounts.some((a) => a.kind === "mock") ? [new DemoPeople()] : []),
  ];
  const remote = await Promise.allSettled(searchesRemote(q) ? sources.map((s) => s.search(q.trim())) : []);
  return remote.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/** People from your mail plus any directory results, ranked, minus your own addresses. No network, so it runs per keystroke. */
export function rankPeople(q: string, accounts: Account[], emails: Email[], remote: Person[][] = [], limit = 8): Person[] {
  const own = new Set(accounts.map((a) => a.address.toLowerCase()));
  return mergePeople(q, [...remote, peopleFromMail(emails, own)], limit).filter((p) => !own.has(p.address.toLowerCase()));
}

/** Search every account plus local mail. */
export async function searchPeople(q: string, accounts: Account[], emails: Email[], limit = 8): Promise<Person[]> {
  return rankPeople(q, accounts, emails, await searchRemotePeople(q, accounts), limit);
}

/**
 * `next`, with the person at `prev[at]` kept at index `at`. When directory results arrive and the
 * list re-ranks, the row that's highlighted (or under the pointer) stays where it is.
 */
export function keepInPlace(prev: Person[], next: Person[], at: number): Person[] {
  const held = prev[at];
  if (!held) return next;
  const key = held.address.toLowerCase();
  const fresh = next.find((p) => p.address.toLowerCase() === key) ?? held;
  const rest = next.filter((p) => p.address.toLowerCase() !== key);
  return [...rest.slice(0, at), fresh, ...rest.slice(at)].slice(0, Math.max(next.length, at + 1));
}
