/**
 * The command palette's path mode, where the query is an absolute path (`D:\dir\file.mp4`,
 * `~/dir/fi`) and the list holds what the host found in that directory.
 *
 * Kept apart from the palette so it can be tested without the stores it pulls in.
 */
import { basename } from "@/lib/utils";

/** Absolute path (POSIX `/`, `~/`, `~\`, Windows `C:\` or `C:/`) — the queries that browse the disk. */
export function isPathQuery(q: string): boolean {
  if (!q) return false;
  return q.startsWith("/") || q.startsWith("~/") || q.startsWith("~\\") || /^[A-Za-z]:[/\\]/.test(q);
}

const WRAPPERS: Record<string, string> = { '"': '"', "'": "'", "`": "`", "<": ">" };

/**
 * A pasted path the way it was copied, back to a plain path: Windows Explorer's "Copy as path"
 * wraps it in quotes, a Markdown code span in backticks, and a browser hands out `file:///` URLs.
 * Any of those used to miss path mode altogether, so the palette searched the project instead.
 * Text that does not come out as a path is returned untouched.
 */
export function normalizePathQuery(query: string): string {
  let s = query.trim();
  const close = WRAPPERS[s[0] ?? ""];
  if (close && s.length > 1 && s.endsWith(close)) s = s.slice(1, -1).trim();
  if (/^file:\/\//i.test(s)) {
    let rest = s.slice("file://".length).replace(/^localhost(?=\/)/i, "");
    try { rest = decodeURIComponent(rest); } catch { /* keep the raw text */ }
    // `file:///C:/x` carries the drive after a slash of its own.
    s = /^\/[A-Za-z]:[/\\]/.test(rest) ? rest.slice(1) : rest;
  }
  return isPathQuery(s) ? s : query;
}

function lastSeparator(query: string): number {
  return Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
}

/** The directory a path query is browsing: everything up to and including its last separator. */
export function pathQueryDir(query: string): string {
  const lastSep = lastSeparator(query);
  return lastSep >= 0 ? query.slice(0, lastSep + 1) : query;
}

/**
 * The part of a path query after its last separator — what the user is typing inside the
 * directory. Both separators count: a Windows path has no `/` at all, and splitting on
 * `/` alone left the filter empty, so every entry of the folder was listed unranked.
 */
export function pathQueryFileFilter(query: string): string {
  return query.slice(lastSeparator(query) + 1).toLowerCase();
}

/** The query that opens `folderName` inside the directory `query` is browsing, in its own separator. */
export function pathQueryIntoFolder(query: string, folderName: string): string {
  const lastSep = lastSeparator(query);
  const sep = lastSep >= 0 ? query[lastSep]! : "/";
  return `${pathQueryDir(query)}${folderName}${sep}`;
}

/** `GET /api/fs/list?withDirs=1` — the directory as the host resolved it, its folders, its files. */
export interface PathListing {
  dir: string;
  dirs: string[];
  files: string[];
  /** The host stopped at its file cap: files beyond it cannot be listed or matched. */
  truncated?: boolean;
}

export interface PathEntry {
  kind: "file" | "folder";
  name: string;
  /** Absolute, as the host wrote it. */
  path: string;
  /**
   * The folders between the listed directory and the entry, `/`-joined with a trailing `/`,
   * or `""` directly inside it. This is all a row needs to show of the path: the directory
   * itself is the same for every row and is shown once, above the list.
   */
  relDir: string;
}

/** `file` relative to `dir`, `/`-separated; the bare name when the host answered with another root. */
export function relativeToDir(dir: string, file: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const base = norm(dir).replace(/\/+$/, "");
  const target = norm(file);
  if (target.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return target.slice(base.length + 1);
  return basename(file);
}

export function pathListingEntries(listing: PathListing): PathEntry[] {
  const entry = (kind: PathEntry["kind"], path: string): PathEntry => {
    const rel = relativeToDir(listing.dir, path);
    const cut = rel.lastIndexOf("/");
    return { kind, name: basename(path), path, relDir: cut >= 0 ? rel.slice(0, cut + 1) : "" };
  };
  return [...listing.dirs.map((d) => entry("folder", d)), ...listing.files.map((f) => entry("file", f))];
}

/**
 * 0 = the name itself, 1 = inside a folder whose whole name was typed, 2 = starts with it,
 * 3 = contains it, null = no match. Tier 1 is what a folder path pasted without its trailing
 * separator needs: `…\evidence\NX-6641` lists `NX-6641` and then what is in it, rather than
 * whichever files elsewhere happen to carry that name.
 */
function matchTier(entry: PathEntry, filter: string): number | null {
  const name = entry.name.toLowerCase();
  if (name === filter) return 0;
  if (entry.relDir && entry.relDir.slice(0, entry.relDir.indexOf("/")).toLowerCase() === filter) return 1;
  if (name.startsWith(filter)) return 2;
  if (name.includes(filter)) return 3;
  return null;
}

/** `shot-2` before `shot-10`, case ignored — the order a file browser shows. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const depthOf = (e: PathEntry) => (e.relDir.match(/\//g) ?? []).length;

/**
 * Entries matching `filter`, closest first: the exact name, the contents of a folder named
 * exactly, names starting with it, then the rest; within a tier folders first, then the
 * shallower entry, then the shorter name. Matching is on the name only — every entry shares
 * the directory, so matching the full path would let the directory's own name match everything.
 *
 * With no filter (the query ends at a separator) only the directory's own entries are listed,
 * folders first, the way a file browser shows it; files further down are reached by typing.
 */
export function rankPathEntries(entries: PathEntry[], filter: string): PathEntry[] {
  if (!filter) {
    // By name: the host lists in its filesystem's order, which on Linux is hash order.
    const own = entries.filter((e) => !e.relDir).sort((a, b) => byName.compare(a.name, b.name));
    return [...own.filter((e) => e.kind === "folder"), ...own.filter((e) => e.kind === "file")];
  }
  const ranked: Array<{ entry: PathEntry; tier: number }> = [];
  for (const entry of entries) {
    const tier = matchTier(entry, filter);
    if (tier !== null) ranked.push({ entry, tier });
  }
  ranked.sort((a, b) =>
    a.tier - b.tier
    || (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === "folder" ? -1 : 1)
    || depthOf(a.entry) - depthOf(b.entry)
    || a.entry.name.length - b.entry.name.length,
  );
  return ranked.map((r) => r.entry);
}
