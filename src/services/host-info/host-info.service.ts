/** Orchestrator + 60s cache for `GET /api/system/host`. Picks providers by
 *  platform, runs them concurrently (each guarded by its own 5s timeout so
 *  one dead network share or TCC-denied read never blocks the response),
 *  then applies the two response-wide rules the individual providers can't
 *  enforce themselves: only directories that still exist on disk survive
 *  (drops Shell COM's archive-as-folder quirk and stale bookmarks), and a
 *  known-folder path wins over a pinned duplicate at the same path.
 *
 *  Existence checks use `fs.promises.stat`, not `statSync` — the whole-disk
 *  scope means a stalled UNC/mapped path must never block the event loop
 *  (same rule `host-drives.ts` follows for the Windows letter probe). */
import { stat as fsStat } from "node:fs/promises";
import { hostname as osHostname, homedir as osHomedir } from "node:os";
import type { HostInfo, PinnedFolder } from "../../types/system.ts";
import { getDrives } from "./host-drives.ts";
import { getKnownFolders } from "./host-known-folders.ts";
import { getWindowsQuickAccessPinned } from "./pinned-windows-quick-access.ts";
import { getLinuxPinned } from "./pinned-linux-bookmarks.ts";
import { getMacosFinderFavoritesPinned } from "./pinned-macos-finder-favorites.ts";

const CACHE_TTL_MS = 60_000;
const PROVIDER_TIMEOUT_MS = 5_000;
/** Floors how often an explicit `?refresh=true` can actually trigger a rebuild — without
 *  this, N concurrent refresh requests (or a trigger-happy client) each spawn their own
 *  round of PowerShell/plutil/findmnt processes. */
const REFRESH_FLOOR_MS = 5_000;

let cached: { info: HostInfo; expiresAt: number } | null = null;
let lastBuildAt = 0;
/** Shared by all callers while a build is running — concurrent calls (refresh or not)
 *  await the same build instead of each starting their own. */
let inFlight: Promise<HostInfo> | null = null;

async function getPinnedByPlatform(
  platform: NodeJS.Platform,
  homedir: string,
  warnings: string[],
): Promise<PinnedFolder[]> {
  if (platform === "win32") return getWindowsQuickAccessPinned(warnings);
  if (platform === "linux") return getLinuxPinned(homedir, warnings);
  if (platform === "darwin") return getMacosFinderFavoritesPinned(homedir, warnings);
  return [];
}

export interface HostInfoDeps {
  getDrives: typeof getDrives;
  getKnownFolders: typeof getKnownFolders;
  getPinned: typeof getPinnedByPlatform;
  /** Directory-existence probe — swappable so orchestrator tests never touch the real filesystem. */
  isDirectory: (path: string) => Promise<boolean>;
}

const defaultDeps: HostInfoDeps = {
  getDrives,
  getKnownFolders,
  getPinned: getPinnedByPlatform,
  isDirectory: async (p) => {
    try {
      return (await fsStat(p)).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Race a provider call against its own timeout; a rejection or a timeout both
 *  degrade to `fallback` plus a warning — the caller never sees an exception. */
async function withTimeout<T>(label: string, promise: Promise<T>, fallback: T, warnings: string[]): Promise<T> {
  const guarded = promise.catch((e) => {
    warnings.push(`${label}: provider threw (${(e as Error)?.message ?? e})`);
    return fallback;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      warnings.push(`${label}: provider timed out after ${PROVIDER_TIMEOUT_MS}ms`);
      resolve(fallback);
    }, PROVIDER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([guarded, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function existingDirectories<T extends { path: string }>(
  items: T[],
  isDirectory: HostInfoDeps["isDirectory"],
): Promise<T[]> {
  const results = await Promise.allSettled(items.map(async (item) => ((await isDirectory(item.path)) ? item : null)));
  const out: T[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) out.push(r.value);
  }
  return out;
}

function toHostPlatform(p: NodeJS.Platform): HostInfo["platform"] {
  if (p === "win32" || p === "darwin" || p === "linux") return p;
  return "linux"; // unsupported host (e.g. freebsd) — closest POSIX-shaped fallback
}

/** Pure orchestration for an explicit platform/homedir/hostname (no `process.*` reads) —
 *  lets tests exercise all three OS branches, and the cache/dedupe/existence-filter
 *  logic in isolation, from any single host. Never throws. */
export async function buildHostInfo(
  platform: NodeJS.Platform,
  homedir: string,
  hostname: string,
  overrides: Partial<HostInfoDeps> = {},
): Promise<HostInfo> {
  const deps: HostInfoDeps = { ...defaultDeps, ...overrides };
  const warnings: string[] = [];

  const [drives, rawKnownFolders, rawPinned] = await Promise.all([
    withTimeout("drives", deps.getDrives(platform, warnings), [], warnings),
    withTimeout("knownFolders", deps.getKnownFolders(platform, homedir, warnings), [], warnings),
    withTimeout("pinned", deps.getPinned(platform, homedir, warnings), [], warnings),
  ]);

  const knownFolders = await existingDirectories(rawKnownFolders, deps.isDirectory);
  const knownPaths = new Set(knownFolders.map((f) => f.path));
  const pinned = await existingDirectories(
    rawPinned.filter((p) => !knownPaths.has(p.path)),
    deps.isDirectory,
  );

  return {
    platform: toHostPlatform(platform),
    sep: platform === "win32" ? "\\" : "/",
    homedir,
    hostname,
    drives,
    knownFolders,
    pinned,
    warnings,
  };
}

/** Cached singleton entrypoint for the route. Pass `refresh: true` to bypass the 60s
 *  cache — floored to one rebuild per `REFRESH_FLOOR_MS`, and de-duped against any
 *  build already in flight, so concurrent/rapid-fire refreshes share one process spawn. */
export async function getHostInfo(
  opts: { refresh?: boolean } = {},
  overrides: Partial<HostInfoDeps> = {},
): Promise<HostInfo> {
  const now = Date.now();
  if (!opts.refresh && cached && cached.expiresAt > now) return cached.info;
  if (opts.refresh && cached && now - lastBuildAt < REFRESH_FLOOR_MS) return cached.info;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const info = await buildHostInfo(process.platform, osHomedir(), osHostname(), overrides);
      lastBuildAt = Date.now();
      cached = { info, expiresAt: lastBuildAt + CACHE_TTL_MS };
      return info;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test-only: force the next `getHostInfo()` call to rebuild instead of serving the cache. */
export function _resetHostInfoCache(): void {
  cached = null;
  lastBuildAt = 0;
  inFlight = null;
}
