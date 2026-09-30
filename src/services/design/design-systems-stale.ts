import simpleGit from "simple-git";
import type { DesignSystemStaleInfo, DesignSystemSummary } from "../../shared/design-types.ts";
import { systemAppRoot } from "./design-systems-paths.ts";

/**
 * Whether an app's design system has drifted from its real source since the last setup
 * (`builtFrom.commit..HEAD`, restricted to the app root). Server-side, cheap, cached per
 * (root, HEAD): a timeout or a missing repo answers "unknown" rather than blocking the
 * designs list or guessing.
 */

const GIT_TIMEOUT_MS = 1500;
const STALE_FILE_COUNT = 20;
const UI_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte", ".css", ".scss", ".sass", ".less"]);
const THEME_CONFIG_RE = /(^|\/)(tailwind\.config\.\w+|postcss\.config\.\w+)$/i;
const THEME_WORD_RE = /\b(theme|tokens|variables)\b/i;
const STYLES_PARTIAL_RE = /(^|\/)(styles|theme)\/_[^/]+\.(scss|less)$/i;

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i).toLowerCase();
}

/** Exported for the unit test: a theme/style-config file makes the app stale on its own. */
export function isThemeConfigFile(path: string): boolean {
  return THEME_CONFIG_RE.test(path) || THEME_WORD_RE.test(path) || STYLES_PARTIAL_RE.test(path);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface CacheEntry { at: number; info: DesignSystemStaleInfo }
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 500;

function cacheKey(root: string, head: string): string {
  return `${root}::${head}`;
}

function rememberAndReturn(key: string, info: DesignSystemStaleInfo): DesignSystemStaleInfo {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), info });
  return info;
}

/** Decide staleness from a `--name-only` diff's lines, already restricted to the app root. */
export function staleFromChangedPaths(paths: string[]): DesignSystemStaleInfo {
  const theme = paths.some(isThemeConfigFile);
  const uiCount = paths.filter((p) => UI_EXTENSIONS.has(extOf(p))).length;
  return { stale: theme || uiCount >= STALE_FILE_COUNT, changedFiles: paths.length, unknown: false };
}

/**
 * `system`'s stale status. Requires `builtFrom` and a git repository at the app root; either
 * missing, or the diff timing out, answers `{ stale: false, unknown: true }` — "built <date>"
 * in the UI, never a guess.
 */
export async function designSystemStaleness(projectPath: string, system: DesignSystemSummary): Promise<DesignSystemStaleInfo> {
  if (!system.builtFrom) return { stale: false, unknown: true };
  const root = systemAppRoot(projectPath, system.root);
  const git = simpleGit(root);
  let head: string;
  try {
    head = (await withTimeout(git.revparse(["HEAD"]), GIT_TIMEOUT_MS)).trim();
  } catch {
    return { stale: false, unknown: true };
  }
  const key = cacheKey(root, `${system.builtFrom.commit}..${head}`);
  const cached = cache.get(key);
  if (cached) return cached.info;
  if (head === system.builtFrom.commit) return rememberAndReturn(key, { stale: false, changedFiles: 0, unknown: false });
  try {
    const diff = await withTimeout(
      git.diff(["--name-only", `${system.builtFrom.commit}..${head}`, "--", "."]),
      GIT_TIMEOUT_MS,
    );
    const paths = diff.split("\n").map((l) => l.trim()).filter(Boolean);
    return rememberAndReturn(key, staleFromChangedPaths(paths));
  } catch {
    return { stale: false, unknown: true };
  }
}
