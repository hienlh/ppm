/**
 * `runSearch`: one content search, run in the search host. Starts ripgrep (or GNU grep over the
 * planned file list), reads its output as it comes, keeps every match up to `MAX_MATCHES`, stops
 * the tool at the match limit, the time limit or a cancel, and answers the matches sorted by path.
 * Imports nothing that reaches config or the database: the host's import graph must stay free of them.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { matchesGlob } from "../file-glob";
import { resolveProjectSearchTool, type ProjectSearchTool } from "../project-content-search.service";
import { createGrepMatcher } from "./grep-matches";
import { preserveCase } from "./preserve-case";
import { buildSearchMatch, parseRgJsonLine } from "./rg-json-parse";
import {
  DEFAULT_EXCLUDED_DIRS, DEFAULT_EXCLUDED_FILES, includeSearchPaths, planGrepSearch, ripgrepArgs, toRipgrepGlobs,
} from "./search-args";
import { MAX_MATCHES, TIME_LIMIT_MS, type SearchMatch, type SearchRequest, type SearchResponse } from "./search-options";

/** A search that cannot answer: 400 the pattern, 503 no tool, 500 anything else. */
export class SearchRunError extends Error {
  constructor(message: string, public status: 400 | 500 | 503 = 500) {
    super(message);
  }
}

export interface SearchRunDeps {
  resolveTool?: () => Promise<ProjectSearchTool | undefined>;
  timeLimitMs?: number;
  maxMatches?: number;
  /** null: no git. The grep plan walks the project instead, and include folders are not trusted. */
  gitPath?: string | null;
}

const NO_TOOL = "Content search needs ripgrep or GNU grep. Install ripgrep or Git for Windows, or make grep available on PATH, then retry.";
/** stderr kept from one run: enough for any message, bounded for a tool that floods it. */
const STDERR_LIMIT = 64 * 1024;
const RG_PATTERN_ERROR = /regex parse error|PCRE2|error compiling pattern|look-around|backreference/i;

/** Every match up to the limit; `limitHit` once a match past it was seen. */
class MatchCollector {
  readonly byFile = new Map<string, SearchMatch[]>();
  total = 0;
  limitHit = false;

  constructor(private readonly max: number, private readonly keepCase: boolean) {}

  /** Adds what fits; false once the limit was passed, so the tool can stop. */
  add(file: string, matches: SearchMatch[]): boolean {
    if (!matches.length) return !this.limitHit;
    const room = this.max - this.total;
    if (matches.length > room) this.limitHit = true;
    const kept = room > 0 ? matches.slice(0, room) : [];
    if (kept.length) {
      if (this.keepCase) {
        for (const m of kept) if (m.replacement !== undefined) m.replacement = preserveCase(m.text, m.replacement);
      }
      const list = this.byFile.get(file);
      if (list) list.push(...kept);
      else this.byFile.set(file, kept);
      this.total += kept.length;
    }
    return !this.limitHit;
  }
}

interface RunResult {
  code: number | null;
  stderr: string;
}

export async function runSearch(projectPath: string, req: SearchRequest, signal?: AbortSignal,
  deps: SearchRunDeps = {}): Promise<SearchResponse> {
  signal?.throwIfAborted();
  if (!req.query) return { results: [], total: 0, files: 0, limitHit: false, engine: "rg" };

  const tool = await (deps.resolveTool ?? resolveProjectSearchTool)();
  if (!tool) throw new SearchRunError(NO_TOOL, 503);
  signal?.throwIfAborted();

  const collector = new MatchCollector(deps.maxMatches ?? MAX_MATCHES, req.preserveCase === true);
  let stopped: "limit" | "timeout" | "abort" | null = null;
  let current: ReturnType<typeof spawnTool> | null = null;
  const stop = (why: "limit" | "timeout" | "abort") => {
    stopped ??= why;
    current?.kill();
  };
  const onAbort = () => stop("abort");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), deps.timeLimitMs ?? TIME_LIMIT_MS);

  let replaceUnavailable = false;
  try {
    if (tool.kind === "rg") {
      // With ignore files on, includes are search paths plus this filter, never -g (which would
      // bring back ignored files); a file left out must not count toward the limit.
      const filter = req.useIgnore ? req.include.flatMap(toRipgrepGlobs) : [];
      const paths = filter.length
        ? await walkablePaths(projectPath, includeSearchPaths(projectPath, req.include), req, deps.gitPath)
        : ["."];
      if (paths.length) {
        const result = await run([tool.path, ...ripgrepArgs(req, paths)], projectPath, rgLineReader((file, matches) => {
          if (filter.length && !matchesGlob(file, filter)) return;
          if (!collector.add(file, matches)) stop("limit");
        }));
        if (!stopped) checkExit(tool, result, collector.total, RG_PATTERN_ERROR.test(result.stderr));
      }
    } else {
      const plan = await planGrepSearch(projectPath, req, { gitPath: deps.gitPath });
      const matcher = createGrepMatcher(req);
      replaceUnavailable = !matcher.replaceAvailable;
      for (const batch of plan.batches) {
        if (stopped) break;
        const result = await run([tool.path, ...plan.args, ...batch], projectPath, grepRecordReader((file, line, text) => {
          const matches = matcher.matchLine(text).map((m) =>
            buildSearchMatch(text, line, m.column, m.column + m.length, m.replacement));
          if (!collector.add(file, matches)) stop("limit");
        }));
        // -s silences unreadable files, so what grep still says on exit 2 is about the pattern.
        if (!stopped) checkExit(tool, result, collector.total, req.regex && result.stderr.trim() !== "");
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (stopped === "abort") signal!.throwIfAborted();

  const results = Array.from(collector.byFile, ([file, matches]) => ({ file, matches }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const response: SearchResponse = {
    results,
    total: collector.total,
    files: results.length,
    limitHit: collector.limitHit,
    engine: tool.kind,
  };
  if (stopped === "timeout") response.incomplete = "timeout";
  if (replaceUnavailable) response.replaceUnavailable = true;
  return response;

  /** Runs one tool process to its end, feeding stdout to `onText`; `stop()` kills it. */
  async function run(cmd: string[], cwd: string, onText: (text: string, done: boolean) => void): Promise<RunResult> {
    const proc = spawnTool(tool!, cmd, cwd);
    current = proc;
    if (stopped) proc.kill();
    try {
      const [, stderr, code] = await Promise.all([readText(proc.stdout, onText), readStderr(proc.stderr), proc.exited]);
      return { code, stderr };
    } finally {
      current = null;
    }
  }
}

/**
 * The include folders a walk from `.` would enter. ripgrep searches a folder named on its command
 * line even when an ignore file, a default exclude or an exclude glob covers it or a folder above
 * it, so such a folder is dropped: with ignore files on nothing under it is searched. When that
 * cannot be told (no git, or an `.ignore` / `.rgignore` above it), the whole project is searched
 * and the include filter does the rest.
 */
async function walkablePaths(projectPath: string, paths: string[], req: SearchRequest,
  gitPathDep: string | null | undefined): Promise<string[]> {
  if (paths.length === 0 || paths.includes(".")) return paths;
  const exclude = [...DEFAULT_EXCLUDED_DIRS, ...DEFAULT_EXCLUDED_FILES, ...req.exclude.flatMap(toRipgrepGlobs)];
  const ancestors = (path: string) => path.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
  const kept = paths.filter((path) => !ancestors(path).some((dir) => matchesGlob(dir, exclude)));
  if (!kept.length) return kept;
  // An ignore file between the project and a folder could leave that folder out.
  const above = new Set(kept.flatMap((path) => ["", ...ancestors(path).slice(0, -1)]));
  for (const dir of above) {
    if (IGNORE_FILES.some((name) => existsSync(join(projectPath, dir, name)))) return ["."];
  }
  const gitPath = gitPathDep === undefined ? Bun.which("git") : gitPathDep;
  const ignored = gitPath ? await gitIgnored(gitPath, projectPath, kept) : null;
  if (!ignored) return ["."];
  return kept.filter((path) => !ignored.has(path));
}

const IGNORE_FILES = [".ignore", ".rgignore"];

/** Which of `folders` git ignores (a folder under an ignored one is listed too), or null when git cannot say. */
async function gitIgnored(gitPath: string, cwd: string, folders: string[]): Promise<Set<string> | null> {
  // The host's own GIT_DIR / GIT_INDEX_FILE would point git at another repository.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  try {
    // --no-index: ripgrep skips an ignored folder whether or not git tracks files in it.
    const proc = Bun.spawn([gitPath, "check-ignore", "--no-index", "-z", "--stdin"],
      { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc.stdin.write(folders.map((f) => `${f}/\0`).join(""));
    await proc.stdin.end();
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    // 1 = nothing ignored; 128 outside a repository, where ripgrep reads no .gitignore either.
    if (code === 128 && !(await insideRepository(gitPath, cwd, env))) return new Set();
    if (code !== 0 && code !== 1) return null;
    return new Set(text.split("\0").filter(Boolean).map((f) => f.replace(/\/$/, "")));
  } catch {
    return null;
  }
}

async function insideRepository(gitPath: string, cwd: string, env: Record<string, string>): Promise<boolean> {
  const proc = Bun.spawn([gitPath, "rev-parse", "--git-dir"], { cwd, env, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

/** Bun.spawn throws, synchronously, on a binary that is not there. */
function spawnTool(tool: ProjectSearchTool, cmd: string[], cwd: string) {
  try {
    return Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new SearchRunError(`Search could not start ${tool.path}: ${error instanceof Error ? error.message : String(error)}`, 503);
  }
}

/** 0 = matches, 1 = none; 2 is a pattern error, a failure, or files it could not read beside its matches. */
function checkExit(tool: ProjectSearchTool, result: RunResult, found: number, patternError: boolean): void {
  if (result.code === 0 || result.code === 1) return;
  const message = engineWords(tool, result.stderr);
  if (patternError) throw new SearchRunError(message || "Invalid regular expression.", 400);
  if (result.code === 2 && found > 0) return;
  if (result.code === 2 && !message) return;
  throw new SearchRunError(message || `Content search failed: ${basename(tool.path)} exited with code ${result.code}.`, 500);
}

/** The tool's stderr without its `rg: ` / `/usr/bin/grep: ` prefix. */
function engineWords(tool: ProjectSearchTool, stderr: string): string {
  const name = basename(tool.path);
  const prefixes = [`${tool.path}: `, `${name}: `, `${name.replace(/\.exe$/i, "")}: `];
  return stderr.trim().split("\n")
    .map((line) => {
      const prefix = prefixes.find((p) => line.startsWith(p));
      return prefix ? line.slice(prefix.length) : line;
    })
    .join("\n")
    .trim();
}

async function readText(stream: ReadableStream<Uint8Array>, onText: (text: string, done: boolean) => void): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onText(decoder.decode(value, { stream: true }), false);
    }
    onText(decoder.decode(), true);
  } finally {
    reader.releaseLock();
  }
}

async function readStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  await readText(stream, (chunk) => {
    if (text.length < STDERR_LIMIT) text += chunk.slice(0, STDERR_LIMIT - text.length);
  });
  return text;
}

/** `rg --json` output, one JSON object a line (a JSON line never holds a raw newline). */
function rgLineReader(onMatch: (file: string, matches: SearchMatch[]) => void) {
  let rest = "";
  return (text: string, done: boolean) => {
    rest += text;
    let start = 0;
    for (let nl = rest.indexOf("\n"); nl !== -1; nl = rest.indexOf("\n", start)) {
      const parsed = parseRgJsonLine(rest.slice(start, nl));
      start = nl + 1;
      if (parsed) onMatch(parsed.file, parsed.matches);
    }
    rest = rest.slice(start);
    if (done && rest) {
      const parsed = parseRgJsonLine(rest);
      rest = "";
      if (parsed) onMatch(parsed.file, parsed.matches);
    }
  };
}

/**
 * grep's `path\0line:content\n` records. The path ends at the NUL, so a path holding a newline
 * still parses; -I keeps binary files, and with them NULs inside content, out.
 */
function grepRecordReader(onLine: (file: string, line: number, text: string) => void) {
  let rest = "";
  const record = (path: string, body: string) => {
    const colon = body.indexOf(":");
    const line = Number(body.slice(0, colon));
    if (colon < 1 || !Number.isInteger(line)) return;
    let text = body.slice(colon + 1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    onLine(path.startsWith("./") ? path.slice(2) : path, line, text);
  };
  return (text: string, done: boolean) => {
    rest += text;
    let start = 0;
    while (true) {
      const nul = rest.indexOf("\0", start);
      if (nul === -1) break;
      const nl = rest.indexOf("\n", nul + 1);
      if (nl === -1) break;
      record(rest.slice(start, nul), rest.slice(nul + 1, nl));
      start = nl + 1;
    }
    rest = rest.slice(start);
    if (done && rest) {
      const nul = rest.indexOf("\0");
      if (nul !== -1) record(rest.slice(0, nul), rest.slice(nul + 1));
      rest = "";
    }
  };
}
