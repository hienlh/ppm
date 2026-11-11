/**
 * The search panel's result rows, as a pure model (no React, no stores) so it runs under
 * `bun:test`: list and tree rows, counts without dismissed matches, Collapse/Expand All,
 * F4 / Shift+F4, arrow-key focus moves, the body of a replace, and the filters-active dot.
 *
 * Ids: a file row's id is its path, a folder row's id is its folder path, a match row's id
 * is its `matchKey`. The `collapsed` set holds file and folder ids. The `dismissed` set holds
 * match keys, or a file path to dismiss the whole file.
 */
import type {
  ReplaceRequest,
  SearchFileResult,
  SearchMatch,
  SearchResponse,
} from "../../../services/content-search/search-options.ts";

export type ViewMode = "list" | "tree";

export interface FolderRow {
  kind: "folder";
  id: string;
  /** The folder's name, or a chain of single-child folders joined with `/`. */
  name: string;
  depth: number;
  count: number;
  collapsed: boolean;
}

export interface FileRow {
  kind: "file";
  id: string;
  name: string;
  /** The folder path, `""` at the project root. */
  dir: string;
  depth: number;
  count: number;
  collapsed: boolean;
}

export interface MatchRow {
  kind: "match";
  id: string;
  file: string;
  match: SearchMatch;
  depth: number;
}

export type SearchRow = FolderRow | FileRow | MatchRow;

export interface RowOptions {
  viewMode: ViewMode;
  dismissed: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
}

export interface MatchTarget {
  key: string;
  file: string;
  match: SearchMatch;
}

export type FocusKey = "up" | "down" | "left" | "right" | "enter";

export interface FocusResult {
  focus: string | null;
  collapse?: string;
  expand?: string;
  open?: { file: string; match: SearchMatch };
}

export type ReplaceScope = { all: true } | { file: string } | { match: string };

export function matchKey(file: string, match: Pick<SearchMatch, "line" | "column">): string {
  return `${file}:${match.line}:${match.column}`;
}

function visibleMatches(result: SearchFileResult, dismissed: ReadonlySet<string>): SearchMatch[] {
  if (dismissed.has(result.file)) return [];
  if (dismissed.size === 0) return result.matches;
  return result.matches.filter((m) => !dismissed.has(matchKey(result.file, m)));
}

/** "N results in M files", counting only what is listed (dismissed matches left out). */
export function countResults(
  response: SearchResponse | null,
  dismissed: ReadonlySet<string>,
): { total: number; files: number } {
  let total = 0;
  let files = 0;
  for (const result of response?.results ?? []) {
    const n = visibleMatches(result, dismissed).length;
    if (n === 0) continue;
    total += n;
    files++;
  }
  return { total, files };
}

export function resultSummary({ total, files }: { total: number; files: number }): string {
  if (total === 0) return "No results found";
  return `${total} ${total === 1 ? "result" : "results"} in ${files} ${files === 1 ? "file" : "files"}`;
}

function splitPath(file: string): { dir: string; name: string } {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? { dir: "", name: file } : { dir: file.slice(0, slash), name: file.slice(slash + 1) };
}

function pushFile(
  rows: SearchRow[],
  file: string,
  matches: SearchMatch[],
  name: string,
  dir: string,
  depth: number,
  collapsed: ReadonlySet<string>,
) {
  const isCollapsed = collapsed.has(file);
  rows.push({ kind: "file", id: file, name, dir, depth, count: matches.length, collapsed: isCollapsed });
  if (isCollapsed) return;
  for (const match of matches) {
    rows.push({ kind: "match", id: matchKey(file, match), file, match, depth: depth + 1 });
  }
}

interface FolderNode {
  path: string;
  segment: string;
  count: number;
  folders: Map<string, FolderNode>;
  files: Array<{ file: string; name: string; matches: SearchMatch[] }>;
}

function newFolder(path: string, segment: string): FolderNode {
  return { path, segment, count: 0, folders: new Map(), files: [] };
}

function emitFolder(node: FolderNode, depth: number, rows: SearchRow[], collapsed: ReadonlySet<string>) {
  const names = [...node.folders.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const segment of names) {
    // Compact folders, as VS Code does: a folder holding one folder and no file joins it.
    let child = node.folders.get(segment)!;
    let name = child.segment;
    while (child.files.length === 0 && child.folders.size === 1) {
      child = child.folders.values().next().value!;
      name += `/${child.segment}`;
    }
    const isCollapsed = collapsed.has(child.path);
    rows.push({ kind: "folder", id: child.path, name, depth, count: child.count, collapsed: isCollapsed });
    if (!isCollapsed) emitFolder(child, depth + 1, rows, collapsed);
  }
  for (const f of node.files) pushFile(rows, f.file, f.matches, f.name, "", depth, collapsed);
}

/** The rows to render: list (files with their folder, then matches) or tree (folders → files → matches). */
export function buildRows(response: SearchResponse | null, opts: RowOptions): SearchRow[] {
  const rows: SearchRow[] = [];
  if (!response) return rows;

  if (opts.viewMode === "list") {
    for (const result of response.results) {
      const matches = visibleMatches(result, opts.dismissed);
      if (matches.length === 0) continue;
      const { dir, name } = splitPath(result.file);
      pushFile(rows, result.file, matches, name, dir, 0, opts.collapsed);
    }
    return rows;
  }

  const root = newFolder("", "");
  for (const result of response.results) {
    const matches = visibleMatches(result, opts.dismissed);
    if (matches.length === 0) continue;
    const { dir, name } = splitPath(result.file);
    let node = root;
    if (dir) {
      let path = "";
      for (const segment of dir.split("/")) {
        path = path ? `${path}/${segment}` : segment;
        let next = node.folders.get(segment);
        if (!next) {
          next = newFolder(path, segment);
          node.folders.set(segment, next);
        }
        next.count += matches.length;
        node = next;
      }
    }
    node.files.push({ file: result.file, name, matches });
  }
  emitFolder(root, 0, rows, opts.collapsed);
  return rows;
}

/** Every file and folder id, i.e. the `collapsed` set Collapse All leaves. Expand All is an empty set. */
export function allCollapsibleIds(
  response: SearchResponse | null,
  viewMode: ViewMode,
  dismissed: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const row of buildRows(response, { viewMode, dismissed, collapsed: new Set() })) {
    if (row.kind !== "match") ids.add(row.id);
  }
  return ids;
}

/**
 * The match F4 (`dir` 1) or Shift+F4 (`dir` -1) opens after `currentKey`, in the view's order,
 * collapsed files included, wrapping at both ends. No current match: the first, or the last.
 */
export function nextMatch(
  response: SearchResponse | null,
  opts: { viewMode: ViewMode; dismissed: ReadonlySet<string> },
  currentKey: string | null,
  dir: 1 | -1,
): MatchTarget | null {
  const matches = buildRows(response, { ...opts, collapsed: new Set() }).filter(
    (row): row is MatchRow => row.kind === "match",
  );
  if (matches.length === 0) return null;
  const at = currentKey === null ? -1 : matches.findIndex((row) => row.id === currentKey);
  const index = at < 0 ? (dir === 1 ? 0 : matches.length - 1) : (at + dir + matches.length) % matches.length;
  const row = matches[index]!;
  return { key: row.id, file: row.file, match: row.match };
}

function parentIndex(rows: SearchRow[], index: number): number {
  const depth = rows[index]!.depth;
  for (let i = index - 1; i >= 0; i--) if (rows[i]!.depth < depth) return i;
  return -1;
}

/** What ↑ ↓ ← → Enter do from the focused row, as VS Code's tree does. */
export function moveFocus(rows: SearchRow[], focusedId: string | null, key: FocusKey): FocusResult {
  if (rows.length === 0) return { focus: null };
  const index = focusedId === null ? -1 : rows.findIndex((row) => row.id === focusedId);
  if (index < 0) return { focus: rows[0]!.id };
  const row = rows[index]!;

  switch (key) {
    case "up":
      return { focus: rows[Math.max(index - 1, 0)]!.id };
    case "down":
      return { focus: rows[Math.min(index + 1, rows.length - 1)]!.id };
    case "left": {
      if (row.kind !== "match" && !row.collapsed) return { focus: row.id, collapse: row.id };
      const parent = parentIndex(rows, index);
      return { focus: parent < 0 ? row.id : rows[parent]!.id };
    }
    case "right": {
      if (row.kind === "match") return { focus: row.id };
      if (row.collapsed) return { focus: row.id, expand: row.id };
      const child = rows[index + 1];
      return { focus: child && child.depth === row.depth + 1 ? child.id : row.id };
    }
    case "enter":
      if (row.kind === "match") return { focus: row.id, open: { file: row.file, match: row.match } };
      return row.collapsed ? { focus: row.id, expand: row.id } : { focus: row.id, collapse: row.id };
  }
}

/**
 * The `files` of a `ReplaceRequest` (the route adds `projectPath`) for one match, one file or
 * everything left: dismissed matches and matches without a computed replacement are left out,
 * and files with unsaved changes are named in `unsaved` instead of sent (5.8).
 */
export function buildReplaceFiles(
  response: SearchResponse | null,
  dismissed: ReadonlySet<string>,
  scope: ReplaceScope,
  isUnsaved?: (file: string) => boolean,
): { files: ReplaceRequest["files"]; unsaved: string[]; matches: number } {
  const files: ReplaceRequest["files"] = [];
  const unsaved: string[] = [];
  let count = 0;
  for (const result of response?.results ?? []) {
    if ("file" in scope && result.file !== scope.file) continue;
    const matches = visibleMatches(result, dismissed).filter(
      (m) =>
        m.replacement !== undefined && (!("match" in scope) || matchKey(result.file, m) === scope.match),
    );
    if (matches.length === 0) continue;
    if (isUnsaved?.(result.file)) {
      unsaved.push(result.file);
      continue;
    }
    files.push({
      file: result.file,
      matches: matches.map((m) => ({ line: m.line, column: m.column, text: m.text, replacement: m.replacement! })),
    });
    count += matches.length;
  }
  return { files, unsaved, matches: count };
}

function hasGlob(field: string): boolean {
  return field.split(",").some((part) => part.trim() !== "");
}

/** The dot on the ··· button: a filter still applies while the fields are folded (2.6). */
export function filtersActive(f: { include: string; exclude: string; useIgnore: boolean }): boolean {
  return hasGlob(f.include) || hasGlob(f.exclude) || !f.useIgnore;
}
