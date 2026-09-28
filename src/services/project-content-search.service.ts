import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class ProjectSearchError extends Error {
  constructor(message: string, public status: 400 | 500 | 503 | 504 = 500) { super(message); }
}

interface ResolverOptions {
  platform?: string;
  which?: (name: string) => string | null;
  exists?: (path: string) => Promise<boolean>;
  programFiles?: string;
  programFilesX86?: string;
}

/** Git for Windows ships GNU grep even when its usr/bin is absent from PATH. */
export async function resolveProjectSearchGrep(options: ResolverOptions = {}): Promise<string | undefined> {
  const which = options.which ?? ((name: string) => Bun.which(name));
  const direct = which("grep");
  if (direct) return direct;
  if ((options.platform ?? process.platform) !== "win32") return;
  const exists = options.exists ?? (async (path: string) => { try { await access(path); return true; } catch { return false; } });
  const git = which("git");
  const roots = git ? [resolve(dirname(git), ".."), resolve(dirname(git), "../..")] : [];
  for (const base of [options.programFiles ?? process.env.ProgramFiles, options.programFilesX86 ?? process.env["ProgramFiles(x86)"]]) {
    if (base) roots.push(resolve(base, "Git"));
  }
  for (const root of roots) {
    const candidate = resolve(root, "usr/bin/grep.exe");
    if (await exists(candidate)) return candidate;
  }
}

/** Convert glob pattern (VSCode-style) to RegExp for path filtering.
 *  - `*.ts`       → matches any .ts file in any directory
 *  - `src/**`     → matches any file under src/
 *  - `src/**\/*.ts` → matches .ts files under src/
 */
function globToPathRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars
    .replace(/\*\*/g, "\x00") // temp placeholder for **
    .replace(/\*/g, "[^/]*") // * = within one segment
    .replace(/\x00/g, ".*") // ** = across segments
    .replace(/\?/g, "[^/]"); // ? = single non-slash char
  // No slash in pattern → match at any depth (like **/<pattern>)
  const re = glob.includes("/") ? `^${escaped}($|/)` : `(^|/)${escaped}($|/)`;
  return new RegExp(re);
}

export interface ProjectSearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  include?: string;
}

export async function searchProjectContent(projectPath: string, options: ProjectSearchOptions,
  dependencies: { resolveGrep?: () => Promise<string | undefined>; timeoutMs?: number; maxBytes?: number } = {}) {
  const empty = { results: [] as Array<{ file: string; matches: Array<{ lineNum: number; content: string }> }>, total: 0 };
  if (options.query.length < (options.regex ? 1 : 2)) return empty;
  const executable = await (dependencies.resolveGrep ?? resolveProjectSearchGrep)();
  if (!executable) throw new ProjectSearchError("Content search needs GNU grep. Install Git for Windows, or make grep available on PATH, then retry.", 503);
  const excluded = ["node_modules", ".git", "dist", ".next", "build", ".turbo", "coverage", "__pycache__"];
  // Long --null also works with BSD grep, where -Z means decompress.
  const flags = ["-rHn", "--null", "--max-count=5", "-I", options.regex ? "-E" : "-F", ...(options.caseSensitive ? [] : ["-i"]), ...(options.wholeWord ? ["-w"] : [])];
  const proc = Bun.spawn({ cmd: [executable, ...flags, ...excluded.flatMap((dir) => ["--exclude-dir", dir]),
    "--exclude=*.min.js", "--exclude=*.map", "--exclude=*.lock", "--exclude=bun.lock", "--", options.query, "."],
    cwd: projectPath, stdout: "pipe", stderr: "pipe" });
  let failure: ProjectSearchError | undefined;
  let bytes = 0;
  const stop = (error: ProjectSearchError) => { failure ??= error; proc.kill(); };
  const timer = setTimeout(() => stop(new ProjectSearchError("Content search timed out. Narrow the query or choose a smaller project and retry.", 504)), dependencies.timeoutMs ?? 10_000);
  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > (dependencies.maxBytes ?? 8 * 1024 * 1024)) {
          stop(new ProjectSearchError("Too many search results. Narrow the query or choose a smaller project and retry.", 400));
        } else text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally { reader.releaseLock(); }
  }
  let raw: string, stderr: string, code: number;
  try { [raw, stderr, code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]); }
  finally { clearTimeout(timer); if (proc.exitCode === null) proc.kill(); }
  if (failure) throw failure;
  if (code !== 0 && code !== 1) {
    const invalidPattern = options.regex && /regular expression|unmatched|unterminated|invalid range|trailing backslash|repetition/i.test(stderr);
    throw new ProjectSearchError(invalidPattern ? "Invalid regular expression. Check the pattern and retry." : "Content search failed. Check file permissions and the search tool, then retry.", invalidPattern ? 400 : 500);
  }
  if (code === 1) return empty;
  const filters = (options.include ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(globToPathRegex);
  const files = new Map<string, Array<{ lineNum: number; content: string }>>();
  // grep --null separates filenames with NUL: colons, spaces and newlines are safe.
  let offset = 0;
  while (offset < raw.length) {
    const separator = raw.indexOf("\0", offset);
    if (separator < 0) break;
    const end = raw.indexOf("\n", separator + 1);
    const recordEnd = end < 0 ? raw.length : end;
    const file = raw.slice(offset, separator).replace(/^\.\//, "");
    const record = /^(\d+):(.*)$/s.exec(raw.slice(separator + 1, recordEnd));
    offset = recordEnd + 1;
    if (!record || (filters.length && !filters.some((filter) => filter.test(file)))) continue;
    const matches = files.get(file) ?? [];
    matches.push({ lineNum: Number(record[1]), content: record[2]!.trimEnd() });
    files.set(file, matches);
  }
  const results = Array.from(files, ([file, matches]) => ({ file, matches }));
  return { results, total: results.reduce((sum, result) => sum + result.matches.length, 0) };
}
