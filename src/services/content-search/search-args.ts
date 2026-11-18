/**
 * What the search host runs: ripgrep's argv, VS Code globs turned into ripgrep's, and for the
 * GNU grep fallback the list of files to search, split into batches that fit on a command line.
 * Runs in the search host, so it imports nothing that reaches config or the database.
 */
import { lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { matchesGlob } from "../file-glob";
import type { SearchRequest } from "./search-options";

/** Folders left out while "Use Exclude Settings and Ignore Files" is on. */
export const DEFAULT_EXCLUDED_DIRS = ["node_modules", ".git", "dist", ".next", "build", ".turbo", "coverage", "__pycache__"];
/** Files left out while "Use Exclude Settings and Ignore Files" is on. */
export const DEFAULT_EXCLUDED_FILES = ["*.min.js", "*.map", "*.lock", "bun.lock"];
/** Bytes of argv one grep run may carry (Windows caps a command line at 32 KB). */
export const GREP_ARGV_BUDGET = 24 * 1024;

/**
 * A VS Code glob as ripgrep globs: with no `/` it matches at any depth, as a file or a folder;
 * ending in `/**` it stays as it is; any other path also matches everything under it.
 */
export function toRipgrepGlobs(glob: string): string[] {
  let g = glob.trim().split("\\").join("/");
  while (g.startsWith("./")) g = g.slice(2);
  while (g.endsWith("/")) g = g.slice(0, -1);
  if (!g) return [];
  if (g === "**" || g.endsWith("/**")) return [g];
  if (!g.includes("/")) return [`**/${g}`, `**/${g}/**`];
  return [g, `${g}/**`];
}

/**
 * The replace text in ripgrep's syntax. Literal search keeps every `$`. Regex search takes the
 * browser's (VS Code's) `$1`…`$99`, `$&`, `$0` and `$$`; ripgrep would read `$1y` as a group
 * named `1y`, so groups are braced, and any other `$` is kept literal.
 */
export function toRipgrepReplacement(replace: string, regex: boolean): string {
  if (!regex) return replace.split("$").join("$$");
  let out = "";
  for (let i = 0; i < replace.length; i++) {
    const ch = replace[i]!;
    if (ch !== "$") { out += ch; continue; }
    const next = replace[i + 1];
    if (next === "$") { out += "$$"; i++; continue; }
    if (next === "&") { out += "${0}"; i++; continue; }
    const digits = /^\d{1,2}/.exec(replace.slice(i + 1))?.[0];
    if (digits) { out += "${" + digits + "}"; i += digits.length; continue; }
    out += "$$";
  }
  return out;
}

/** True when a path segment holds glob syntax rather than a literal name. */
const GLOB_SEGMENT = /[*?[\]{}!]/;

/**
 * The literal folder an include's ripgrep glob starts with ("" for none), or null when it points
 * outside the project. The last segment is never part of it: it may name a file, and ripgrep
 * searches a file named on its command line even when an ignore file leaves it out.
 */
function literalFolder(glob: string): string | null {
  const segments = glob.split("/");
  if (isAbsolute(glob) || /^[A-Za-z]:/.test(glob) || segments.includes("..")) return null;
  const folder: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (GLOB_SEGMENT.test(segment)) break;
    if (segment !== "" && segment !== ".") folder.push(segment);
  }
  return folder.join("/");
}

/**
 * Where ripgrep searches while ignore files are on and "Files to include" is set: ripgrep's `-g`
 * would override the ignore files, so the includes become search paths instead (each include's
 * literal folder, run with the project as cwd) and `runSearch` filters on the globs themselves.
 * `["."]` when an include has no literal folder; nested folders collapse into their ancestor;
 * folders that do not exist are dropped (ripgrep exits 2 on them), leaving `[]` when none do.
 */
export function includeSearchPaths(projectPath: string, include: string[]): string[] {
  const folders = new Set<string>();
  let any = false;
  for (const glob of include) {
    // A trailing slash says the path is a folder, which toRipgrepGlobs would forget.
    const named = /[\\/]\s*$/.test(glob) ? `${glob.trim()}**` : glob;
    // A bare path matches as itself or as a folder, so its last segment may be a file: take the
    // shortest folder among its globs.
    const own = toRipgrepGlobs(named).map(literalFolder);
    if (!own.length) continue;
    any = true;
    if (own.some((f) => f === null)) continue;
    const folder = (own as string[]).reduce((a, b) => (a.length <= b.length ? a : b));
    if (!folder) return ["."];
    folders.add(folder);
  }
  if (!any) return ["."];
  const existing = [...folders].filter((folder) => {
    try { return lstatSync(join(projectPath, folder)).isDirectory(); } catch { return false; }
  }).sort();
  return existing.filter((folder) => !existing.some((other) => other !== folder && folder.startsWith(`${other}/`)));
}

/**
 * ripgrep's argv for `req`, run with the project as cwd, searching `paths`. Paths come back as
 * `./a/b` under `.`, as `a/b` under any other search path. With ignore files on, includes are not
 * part of it: see `includeSearchPaths`.
 */
export function ripgrepArgs(req: SearchRequest, paths: string[] = ["."]): string[] {
  // --no-config: a user's RIPGREP_CONFIG_PATH could change the output. --engine=auto falls back
  // to PCRE2 for look-around and back-references, as VS Code does.
  const args = ["--json", "--hidden", "--no-config", "--engine=auto", "--path-separator=/"];
  if (!req.regex) args.push("-F");
  if (!req.caseSensitive) args.push("-i");
  if (req.wholeWord) args.push("-w");
  if (req.replace !== undefined) args.push("-r", toRipgrepReplacement(req.replace, req.regex));
  if (!req.useIgnore) args.push("--no-ignore");
  // A -g include whitelists files the ignore files leave out, so it is used only with them off.
  // ripgrep lets the last matching glob win, so excludes go after includes.
  if (!req.useIgnore) for (const glob of req.include.flatMap(toRipgrepGlobs)) args.push("-g", glob);
  if (req.useIgnore) {
    // A trailing slash matches folders only.
    for (const dir of DEFAULT_EXCLUDED_DIRS) args.push("-g", `!${dir}/`);
    for (const file of DEFAULT_EXCLUDED_FILES) args.push("-g", `!${file}`);
  }
  for (const glob of req.exclude.flatMap(toRipgrepGlobs)) args.push("-g", `!${glob}`);
  args.push("--", req.query, ...paths);
  return args;
}

/**
 * GNU grep's flags for `req`; the files of one batch follow the trailing `--`. Each match prints
 * `path\0line:content`. -s: a file git lists but that is gone (or a submodule folder) is no error.
 */
export function grepArgs(req: SearchRequest): string[] {
  // Long --null also works with BSD grep, where -Z means decompress.
  const args = ["-H", "-n", "--null", "-I", "-s", req.regex ? "-E" : "-F"];
  if (!req.caseSensitive) args.push("-i");
  if (req.wholeWord) args.push("-w");
  args.push("-e", req.query, "--");
  return args;
}

/** Splits `files` into batches whose argv, with `baseArgs`, stays within `budget` bytes. */
export function batchFiles(baseArgs: string[], files: string[], budget = GREP_ARGV_BUDGET): string[][] {
  const size = (arg: string) => Buffer.byteLength(arg) + 1;
  const baseBytes = baseArgs.reduce((n, arg) => n + size(arg), 0);
  const batches: string[][] = [];
  let batch: string[] = [];
  let used = baseBytes;
  for (const file of files) {
    const bytes = size(file);
    if (batch.length && used + bytes > budget) {
      batches.push(batch);
      batch = [];
      used = baseBytes;
    }
    batch.push(file);
    used += bytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export interface GrepPlan {
  /** Flags and pattern, ending in `--`. */
  args: string[];
  /** Project-relative `/` paths, each batch one grep run with the project as cwd. */
  batches: string[][];
}

/**
 * The grep fallback's work: with ignore files on and a git repository, the files git does not
 * ignore; otherwise a walk that prunes excluded folders. Both are filtered with the same globs
 * ripgrep gets, so the two engines search the same files.
 */
export async function planGrepSearch(projectPath: string, req: SearchRequest,
  deps: { gitPath?: string | null } = {}): Promise<GrepPlan> {
  const defaults = req.useIgnore ? [...DEFAULT_EXCLUDED_DIRS, ...DEFAULT_EXCLUDED_FILES] : [];
  const include = req.include.flatMap(toRipgrepGlobs);
  const exclude = [...defaults, ...req.exclude.flatMap(toRipgrepGlobs)];
  const gitPath = deps.gitPath === undefined ? Bun.which("git") : deps.gitPath;
  const listed = req.useIgnore && gitPath ? await gitFiles(gitPath, projectPath) : null;
  const files = (listed ?? await walkFiles(projectPath, exclude))
    .filter((file) => !(exclude.length && matchesGlob(file, exclude)) && (!include.length || matchesGlob(file, include)))
    .sort();
  const args = grepArgs(req);
  return { args, batches: batchFiles(args, files) };
}

/** Tracked and untracked files git does not ignore, or null when this is no repository. */
async function gitFiles(gitPath: string, cwd: string): Promise<string[] | null> {
  // The host's own GIT_DIR / GIT_INDEX_FILE would point git at another repository.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  try {
    // Bun.spawn throws, synchronously, when the binary is missing.
    const proc = Bun.spawn([gitPath, "ls-files", "-z", "-co", "--exclude-standard"], { cwd, env, stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    // An unmerged path is listed once per stage.
    return [...new Set(text.split("\0").filter(Boolean))];
  } catch {
    return null;
  }
}

/** Regular files under `root` (symlinks not followed, as ripgrep), never entering an excluded folder. */
async function walkFiles(root: string, exclude: string[]): Promise<string[]> {
  const files: string[] = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries;
    try { entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!(exclude.length && matchesGlob(path, exclude))) stack.push(path);
      } else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}
