/**
 * One-way sync of the providers' own memories into PPM's store (requirements 2.2, 2.3, 3.4, 4.3,
 * 5.1–5.5, 10.3).
 *
 * `ensureSynced` first takes a fingerprint of every source from file metadata alone (`readdir` +
 * `stat`, never a read). When it matches the one recorded at the last sync nothing else happens,
 * so a chat message pays a few ms. Otherwise the importers run and each imported item is created,
 * rewritten when its `origin_hash` moved, or un-archived when it came back; a copy whose item is
 * gone is archived, never deleted. A provider whose import failed keeps its copies as they are.
 *
 * The project's sources (Claude's folder, Codex's databases) and the global ones (Codex's
 * `memory_summary.md`, Antigravity's knowledge items) have separate fingerprints, so the global
 * store is imported once however many projects sync after it. The outcome per provider and the
 * fingerprints live in `<memory>/sync-status.json`.
 *
 * Nothing here knows about sockets or the embedding queue: the route sets `setChangeListener`
 * and the queue registers an `afterSync` hook.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "../logger.ts";
import { antigravityKnowledgeDir, importAntigravity } from "./import-antigravity.ts";
import { claudeMemoryDir, importClaudeMemories } from "./import-claude.ts";
import { importCodexMemories } from "./import-codex.ts";
import { getMemoryIndex, GLOBAL_MEMORY_KEY } from "./memory-index.ts";
import { globalMemoryDir, memoryRoot, projectMemoryDir, projectMemoryKey } from "./memory-paths.ts";
import { redactSecrets } from "./memory-redact.ts";
import { memoryStore } from "./memory-store.ts";
import type { MemoryRecord, MemoryScope, MemorySource, NativeMemory } from "./memory-types.ts";

const log = createLogger("memory-sync");

export type SyncProvider = "claude" | "codex" | "antigravity";

export interface ProviderSyncStatus {
  /** Items the provider returned for this scope at the last sync. */
  count: number;
  syncedAt: string | null;
  error: string | null;
  skipped: string[];
  /** Secrets replaced with `[REDACTED]` in the imported copies. */
  redacted: number;
}

/** What `<memory>/sync-status.json` holds. */
export interface MemorySyncStatus {
  /** Source fingerprint per project memory key, and of the global sources under `"global"`. */
  fingerprint: Record<string, string>;
  /** The merged per-provider view of the project synced last. */
  providers: Record<SyncProvider, ProviderSyncStatus>;
  projects: Record<string, { path: string; providers: Partial<Record<SyncProvider, ProviderSyncStatus>> }>;
  global: { providers: Partial<Record<SyncProvider, ProviderSyncStatus>> };
}

export interface MemoryChange {
  projectPath: string;
  /** Which stores had a copy created, rewritten or archived. */
  scopes: MemoryScope[];
}

export interface AfterSyncInfo {
  projectPath: string;
  /** Index keys reconciled by this sync (`projectMemoryKey`, `GLOBAL_MEMORY_KEY`). */
  keys: string[];
  /** Whether any copy was written or archived. */
  changed: boolean;
}

export interface SyncResult {
  projectPath: string;
  ran: { project: boolean; global: boolean };
  written: number;
  archived: number;
  /** Set by `syncAll` when this project's sync threw. */
  error?: string;
}

interface ImportOutcome { items: NativeMemory[]; skipped: string[]; error?: string }

export interface MemorySyncDeps {
  /** Claude's config dir; default `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeHome?: string;
  /** Codex homes; default what `setMemorySyncSources` gave (every account), else `~/.codex` and `CODEX_HOME`. */
  codexHomes?: string[];
  /** Antigravity home; default the one `resolveAntigravityPaths` picks. */
  antigravityHome?: string;
  importers?: {
    claude?: typeof importClaudeMemories;
    codex?: typeof importCodexMemories;
    antigravity?: typeof importAntigravity;
  };
  /** The project paths `syncAll` covers; default the projects `setMemorySyncSources` gave. */
  listProjects?: () => string[] | Promise<string[]>;
}

const SOURCE: Record<SyncProvider, MemorySource> = { claude: "claude", codex: "codex", antigravity: "antigravity" };
/** Codex's databases (and their WAL) whose metadata says a Codex memory may have moved. */
const CODEX_DB = /^(?:memories_v2_|memories_|state_)\d+\.sqlite(?:-wal)?$/;
const STATUS_FILE = "sync-status.json";

const emptyStatus = (): ProviderSyncStatus => ({ count: 0, syncedAt: null, error: null, skipped: [], redacted: 0 });
const emptyFile = (): MemorySyncStatus => ({
  fingerprint: {},
  providers: { claude: emptyStatus(), codex: emptyStatus(), antigravity: emptyStatus() },
  projects: {},
  global: { providers: {} },
});
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `<memory>/sync-status.json`. */
export function syncStatusPath(): string {
  return join(memoryRoot(), STATUS_FILE);
}

/** Two halves of one provider's status (its project and global items) as one. */
function mergeStatus(a: ProviderSyncStatus | undefined, b: ProviderSyncStatus | undefined): ProviderSyncStatus {
  if (!a) return b ? { ...b, skipped: [...b.skipped] } : emptyStatus();
  if (!b) return { ...a, skipped: [...a.skipped] };
  const errors = [...new Set([a.error, b.error].filter((e): e is string => !!e))];
  return {
    count: a.count + b.count,
    syncedAt: [a.syncedAt, b.syncedAt].filter((t): t is string => !!t).sort().at(-1) ?? null,
    error: errors.length ? errors.join("; ") : null,
    skipped: [...a.skipped, ...b.skipped],
    redacted: a.redacted + b.redacted,
  };
}

function providersOf(file: MemorySyncStatus, key: string): Record<SyncProvider, ProviderSyncStatus> {
  const project = file.projects[key]?.providers ?? {};
  const global = file.global.providers;
  return {
    claude: mergeStatus(project.claude, undefined),
    codex: mergeStatus(project.codex, global.codex),
    antigravity: mergeStatus(undefined, global.antigravity),
  };
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** `name=size:mtime` for each name, `name=-` for one that is gone. Metadata only. */
async function statEntries(dir: string, names: string[]): Promise<string[]> {
  return Promise.all(names.map(async (name) => {
    try {
      const s = await stat(join(dir, name));
      return `${name}=${s.size}:${s.mtimeMs}`;
    } catch {
      return `${name}=-`;
    }
  }));
}

const digest = (parts: string[]) => createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);

/**
 * What the shared sync reads besides the fixed homes: the Codex homes (accounts included) and the
 * configured projects. The memory host reads no config or database, so the server sends these
 * with every change (`setMemorySyncSources`); until then, `~/.codex`, `CODEX_HOME` and no projects.
 */
export interface MemorySyncSources {
  codexHomes: string[];
  projects: string[];
}

function baseCodexHomes(): string[] {
  const homes = [join(homedir(), ".codex")];
  if (process.env.CODEX_HOME) homes.push(process.env.CODEX_HOME);
  return homes;
}

let sources: MemorySyncSources | null = null;

export function setMemorySyncSources(next: MemorySyncSources): void {
  sources = { codexHomes: [...next.codexHomes], projects: [...next.projects] };
}

/** A sync over its own homes and importers; the server uses the shared `memorySync`. */
export function createMemorySync(deps: MemorySyncDeps = {}) {
  const importers = {
    claude: deps.importers?.claude ?? importClaudeMemories,
    codex: deps.importers?.codex ?? importCodexMemories,
    antigravity: deps.importers?.antigravity ?? importAntigravity,
  };

  let cache: { root: string; file: MemorySyncStatus } | null = null;
  const inflight = new Map<string, Promise<SyncResult>>();
  let chain: Promise<unknown> = Promise.resolve();
  let changeListener: ((change: MemoryChange) => void) | null = null;
  const hooks = new Set<(info: AfterSyncInfo) => unknown>();
  const lastErrors = new Map<string, string | null>();

  async function codexHomes(): Promise<string[]> {
    return [...new Set((deps.codexHomes ?? sources?.codexHomes ?? baseCodexHomes()).map((h) => resolve(h)))];
  }

  /** The status file, read once per memory root and then kept in memory. */
  async function loadStatus(): Promise<MemorySyncStatus> {
    const root = memoryRoot();
    if (cache?.root === root) return cache.file;
    let file = emptyFile();
    try {
      const parsed = JSON.parse(await readFile(join(root, STATUS_FILE), "utf8")) as Partial<MemorySyncStatus>;
      file = {
        fingerprint: parsed.fingerprint ?? {},
        providers: { ...file.providers, ...parsed.providers },
        projects: parsed.projects ?? {},
        global: { providers: parsed.global?.providers ?? {} },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`unreadable ${STATUS_FILE}, starting afresh: ${reason(err)}`);
    }
    cache = { root, file };
    return file;
  }

  async function saveStatus(file: MemorySyncStatus): Promise<void> {
    const root = memoryRoot();
    await mkdir(root, { recursive: true });
    const tmp = join(root, `.${STATUS_FILE}.${process.pid}.tmp`);
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
    await rename(tmp, join(root, STATUS_FILE));
  }

  /** Claude's memory folder and Codex's databases, from metadata only. */
  async function projectFingerprint(projectPath: string, homes: string[]): Promise<string> {
    const claudeDir = await claudeMemoryDir(projectPath, deps.claudeHome);
    const parts = ["claude", claudeDir, ...await statEntries(claudeDir, (await readdirSafe(claudeDir)).sort())];
    for (const home of homes) {
      const dbs = (await readdirSafe(home)).filter((n) => CODEX_DB.test(n)).sort();
      parts.push("codex", home, ...await statEntries(home, dbs));
    }
    return digest(parts);
  }

  /** Codex's summary files and every file of Antigravity's knowledge folder, from metadata only. */
  async function globalFingerprint(homes: string[]): Promise<string> {
    const parts: string[] = [];
    for (const home of homes) {
      parts.push("codex", home, ...await statEntries(home, ["memories/memory_summary.md", "memories_v2/memory_summary.md"]));
    }
    const knowledge = antigravityKnowledgeDir(deps.antigravityHome);
    let entries: string[] = [];
    try {
      entries = (await readdir(knowledge, { recursive: true })).map(String).sort();
    } catch { /* no knowledge folder: no items */ }
    parts.push("antigravity", knowledge, ...await statEntries(knowledge, entries));
    return digest(parts);
  }

  async function runImporter(fn: () => Promise<ImportOutcome>): Promise<ImportOutcome> {
    try {
      const r = await fn();
      return { items: r.items ?? [], skipped: r.skipped ?? [], ...(r.error ? { error: r.error } : {}) };
    } catch (err) {
      return { items: [], skipped: [], error: reason(err) };
    }
  }

  function noteError(where: string, provider: SyncProvider, error: string | null): void {
    const key = `${where}:${provider}`;
    if ((lastErrors.get(key) ?? null) === error) return;
    lastErrors.set(key, error);
    if (error) log.warn(`memory sync: ${provider} (${where}) failed: ${error}`);
    else log.info(`memory sync: ${provider} (${where}) works again`);
  }

  /**
   * Brings one store in line with what the providers returned for it. Returns per-provider
   * status plus how many copies were written and archived.
   */
  async function applyScope(
    scope: MemoryScope,
    projectPath: string | undefined,
    outcomes: Array<{ provider: SyncProvider; outcome: ImportOutcome; skipped: string[] }>,
    syncedAt: string,
  ) {
    const existing = await memoryStore.list(scope, projectPath);
    const byId = new Map<string, MemoryRecord>(existing.map((r) => [r.id, r]));
    const status: Partial<Record<SyncProvider, ProviderSyncStatus>> = {};
    let written = 0;
    let archived = 0;

    for (const { provider, outcome, skipped: baseSkipped } of outcomes) {
      const source = SOURCE[provider];
      const items = outcome.items.filter((i) => i.scope === scope);
      const skipped = [...baseSkipped];
      let redacted = 0;
      for (const item of items) {
        redacted += redactSecrets(item.name).count + redactSecrets(item.description).count + redactSecrets(item.body).count;
        const current = byId.get(item.id);
        if (current && current.source !== source) {
          skipped.push(`${item.id}: a ${current.source} memory already has this id`);
          continue;
        }
        if (current && current.originHash === item.originHash && !current.archived) continue;
        await memoryStore.write({
          id: item.id, scope, projectPath, name: item.name, description: item.description, type: item.type,
          body: item.body, source, origin: item.origin, originHash: item.originHash,
          ...(item.sourceUpdated ? { updated: item.sourceUpdated } : {}),
        }, { caller: "sync" });
        written++;
      }
      if (!outcome.error) {
        const seen = new Set(items.map((i) => i.id));
        for (const record of existing) {
          if (record.source !== source || record.archived || seen.has(record.id)) continue;
          await memoryStore.archive(record.id, scope, projectPath, { caller: "sync" });
          archived++;
        }
      }
      status[provider] = { count: items.length, syncedAt, error: outcome.error ?? null, skipped, redacted };
    }
    return { status, written, archived };
  }

  async function reconcileKeys(projectPath: string, project: boolean, global: boolean): Promise<string[]> {
    const keys: string[] = [];
    try {
      const index = getMemoryIndex();
      if (project) {
        const key = projectMemoryKey(projectPath);
        await index.reconcile(projectMemoryDir(projectPath), "project", key);
        keys.push(key);
      }
      if (global) {
        await index.reconcile(globalMemoryDir(), "global", GLOBAL_MEMORY_KEY);
        keys.push(GLOBAL_MEMORY_KEY);
      }
    } catch (err) {
      log.warn(`memory index reconcile after sync failed: ${reason(err)}`);
    }
    return keys;
  }

  function notify(projectPath: string, keys: string[], scopes: MemoryScope[]): void {
    if (scopes.length && changeListener) {
      try {
        changeListener({ projectPath, scopes });
      } catch (err) {
        log.warn(`memory change listener failed: ${reason(err)}`);
      }
    }
    const info: AfterSyncInfo = { projectPath, keys, changed: scopes.length > 0 };
    for (const hook of hooks) {
      try {
        const r = hook(info);
        if (r instanceof Promise) r.catch((err) => log.warn(`memory afterSync hook failed: ${reason(err)}`));
      } catch (err) {
        log.warn(`memory afterSync hook failed: ${reason(err)}`);
      }
    }
  }

  /** Runs `fn` after every earlier apply, so two syncs never write the same store at once. */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  async function run(projectPath: string, force: { project: boolean; global: boolean }): Promise<SyncResult> {
    const key = projectMemoryKey(projectPath);
    const homes = await codexHomes();
    const [file, projectFp, globalFp] = await Promise.all([
      loadStatus(), projectFingerprint(projectPath, homes), globalFingerprint(homes),
    ]);
    const idle: SyncResult = { projectPath, ran: { project: false, global: false }, written: 0, archived: 0 };
    if (!force.project && !force.global && file.fingerprint[key] === projectFp && file.fingerprint[GLOBAL_MEMORY_KEY] === globalFp) {
      return idle;
    }

    return exclusive(async () => {
      // Decided again in turn: a sync that ran meanwhile may have imported the global sources.
      const needProject = force.project || file.fingerprint[key] !== projectFp;
      const needGlobal = force.global || file.fingerprint[GLOBAL_MEMORY_KEY] !== globalFp;
      if (!needProject && !needGlobal) return idle;

      const syncedAt = new Date().toISOString();
      const none = Promise.resolve<ImportOutcome>({ items: [], skipped: [] });
      const [claude, codex, antigravity] = await Promise.all([
        needProject ? runImporter(() => importers.claude(projectPath, { claudeHome: deps.claudeHome })) : none,
        runImporter(() => importers.codex(projectPath, homes)),
        needGlobal ? runImporter(() => importers.antigravity(projectPath, { antigravityHome: deps.antigravityHome })) : none,
      ]);

      let written = 0;
      let archived = 0;
      const scopes: MemoryScope[] = [];
      if (needProject) {
        const r = await applyScope("project", projectPath, [
          { provider: "claude", outcome: claude, skipped: claude.skipped },
          { provider: "codex", outcome: codex, skipped: codex.skipped },
        ], syncedAt);
        file.projects[key] = { path: resolve(projectPath), providers: r.status };
        file.fingerprint[key] = projectFp;
        written += r.written;
        archived += r.archived;
        if (r.written + r.archived) scopes.push("project");
        for (const p of ["claude", "codex"] as const) noteError(key, p, r.status[p]?.error ?? null);
      }
      if (needGlobal) {
        const r = await applyScope("global", undefined, [
          { provider: "codex", outcome: codex, skipped: [] },
          { provider: "antigravity", outcome: antigravity, skipped: antigravity.skipped },
        ], syncedAt);
        file.global = { providers: r.status };
        file.fingerprint[GLOBAL_MEMORY_KEY] = globalFp;
        written += r.written;
        archived += r.archived;
        if (r.written + r.archived) scopes.push("global");
        for (const p of ["codex", "antigravity"] as const) noteError(GLOBAL_MEMORY_KEY, p, r.status[p]?.error ?? null);
      }
      file.providers = providersOf(file, key);
      await saveStatus(file);

      const keys = await reconcileKeys(projectPath, needProject, needGlobal);
      notify(projectPath, keys, scopes);
      return { projectPath, ran: { project: needProject, global: needGlobal }, written, archived };
    });
  }

  function start(projectPath: string, force: { project: boolean; global: boolean }, after?: Promise<unknown>): Promise<SyncResult> {
    const key = projectMemoryKey(projectPath);
    const p = (after ? after.catch(() => undefined) : Promise.resolve()).then(() => run(projectPath, force));
    inflight.set(key, p);
    const clear = () => { if (inflight.get(key) === p) inflight.delete(key); };
    p.then(clear, clear);
    return p;
  }

  return {
    /**
     * Syncs a project (and the global sources) when any source moved since the last sync;
     * otherwise returns after `stat`s alone. Concurrent calls for one project share one run.
     * `force` imports even when nothing moved (Sync now).
     */
    ensureSynced(projectPath: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
      const running = inflight.get(projectMemoryKey(projectPath));
      if (!opts.force) return running ?? start(projectPath, { project: false, global: false });
      return start(projectPath, { project: true, global: true }, running);
    },

    /**
     * Sync now: every configured project in turn, imported even when unchanged (the global sources
     * once). One project failing does not stop the next.
     */
    async syncAll(): Promise<SyncResult[]> {
      const listed = deps.listProjects ? await deps.listProjects() : sources?.projects ?? [];
      const paths = [...new Set(listed.map((p) => resolve(p)))];
      const results: SyncResult[] = [];
      let globalDone = false;
      for (const projectPath of paths) {
        try {
          const running = inflight.get(projectMemoryKey(projectPath));
          results.push(await start(projectPath, { project: true, global: !globalDone }, running));
          globalDone = true;
        } catch (err) {
          log.warn(`memory sync of ${projectPath} failed: ${reason(err)}`);
          results.push({ projectPath, ran: { project: false, global: false }, written: 0, archived: 0, error: reason(err) });
        }
      }
      return results;
    },

    /** Per-provider status of one project: its Claude and Codex items plus the global Codex and Antigravity ones. */
    async status(projectPath: string): Promise<Record<SyncProvider, ProviderSyncStatus>> {
      return providersOf(await loadStatus(), projectMemoryKey(projectPath));
    },

    /** The whole status file as last written. */
    async statusFile(): Promise<MemorySyncStatus> {
      return structuredClone(await loadStatus());
    },

    /** Called after a sync that created, rewrote or archived a copy (the route broadcasts `memory:changed`). */
    setChangeListener(fn: ((change: MemoryChange) => void) | null): void {
      changeListener = fn;
    },

    /** Runs after every sync that imported, once the index is reconciled. Returns an unsubscribe. */
    afterSync(hook: (info: AfterSyncInfo) => unknown): () => void {
      hooks.add(hook);
      return () => { hooks.delete(hook); };
    },
  };
}

export type MemorySync = ReturnType<typeof createMemorySync>;

/** The memory host's sync over the real homes and the sources the server sent. */
export const memorySync = createMemorySync();

/** Sets the shared sync's change listener (the route's `memory:changed` broadcast). */
export function setMemoryChangeListener(fn: ((change: MemoryChange) => void) | null): void {
  memorySync.setChangeListener(fn);
}
