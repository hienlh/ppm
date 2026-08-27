import { invalidateCache } from "./cache.ts";
import type { SlashItem } from "./types.ts";

/**
 * Claude's own built-ins (/context, /init, /usage, …) live inside the CLI binary,
 * so the filesystem scan in skill-loader.ts can never see them. The only way to
 * enumerate them is to ask a live SDK session, which costs a CLI spawn — hence a
 * much longer TTL than the filesystem cache.
 */
const TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface CacheEntry {
  items: SlashItem[];
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SlashItem[]>>();

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && Date.now() - entry.at < TTL_MS;
}

/**
 * Keep only the SDK commands nothing else already provides. The SDK reports every
 * command it knows — including the skills the filesystem scan just found — so
 * dropping known names leaves exactly the ones that live inside the CLI binary.
 */
export function selectSdkOnlyCommands(sdkItems: SlashItem[], knownNames: Iterable<string>): SlashItem[] {
  const known = new Set(knownNames);
  return sdkItems.filter((item) => !known.has(item.name));
}

/** Cached SDK commands, or [] when none were fetched yet. Never spawns. */
export function getSdkCommands(projectPath: string): SlashItem[] {
  const entry = cache.get(projectPath);
  return isFresh(entry) ? entry.items : [];
}

/** Drop cached SDK commands so the next ensure() re-spawns. */
export function invalidateSdkCommands(projectPath?: string): void {
  if (projectPath) cache.delete(projectPath);
  else cache.clear();
}

async function fetchFromSdk(projectPath: string): Promise<SlashItem[]> {
  // Loaded lazily: the CLI (`ppm skills`) uses this module's sync path only and
  // must not pull in the provider's config/database dependencies.
  const [{ query }, provider] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("../../providers/claude-agent-sdk.ts"),
  ]);

  const cliPath = provider.resolveCliExecutablePath();

  // supportedCommands() resolves during the init handshake, but the CLI keeps
  // running until its input stream ends — so hold the stream open until we're done.
  let closeInput!: () => void;
  const inputClosed = new Promise<void>((r) => { closeInput = r; });
  async function* idleInput(): AsyncGenerator<never, void, undefined> {
    await inputClosed;
  }

  const q = query({
    prompt: idleInput(),
    options: {
      cwd: projectPath,
      ...(provider.needsNodeInterpreter(process.platform, cliPath) && { executable: "node" as const }),
      ...(cliPath && { pathToClaudeCodeExecutable: cliPath }),
      settingSources: ["user", "project"],
      maxTurns: 1,
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const commands = await Promise.race([
      q.supportedCommands(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("supportedCommands timed out")), FETCH_TIMEOUT_MS);
      }),
    ]);
    return commands.map((cmd) => ({
      type: "builtin" as const,
      name: cmd.name,
      description: cmd.description ?? "",
      argumentHint: cmd.argumentHint || undefined,
      scope: "bundled" as const,
      category: "session",
      handler: "sdk" as const,
    }));
  } finally {
    if (timer) clearTimeout(timer);
    closeInput();
    try { await q.interrupt?.(); } catch { /* already exiting */ }
  }
}

/**
 * Fetch SDK commands, reusing the cache. Concurrent callers share one spawn.
 * Failures are cached too — an unauthenticated CLI would otherwise re-spawn on
 * every picker open; the picker's refresh button clears it.
 */
export function ensureSdkCommands(projectPath: string): Promise<SlashItem[]> {
  const entry = cache.get(projectPath);
  if (isFresh(entry)) return Promise.resolve(entry.items);

  const existing = inflight.get(projectPath);
  if (existing) return existing;

  const pending = fetchFromSdk(projectPath)
    .catch((e: unknown) => {
      console.warn(`[slash] SDK command discovery failed: ${(e as Error).message}`);
      return [] as SlashItem[];
    })
    .then((items) => {
      cache.set(projectPath, { items, at: Date.now() });
      invalidateCache(projectPath); // merged item list is now stale
      return items;
    })
    .finally(() => { inflight.delete(projectPath); });

  inflight.set(projectPath, pending);
  return pending;
}
