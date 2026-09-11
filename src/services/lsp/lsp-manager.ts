/**
 * Decides how many language servers exist and who shares them.
 *
 * A language server is not a lightweight thing: rust-analyzer builds a crate
 * graph, gopls loads a module's whole type information, tsserver reads every
 * `.d.ts` it can reach. One per open tab would make PPM unusable on exactly the
 * machines it is meant to run on, so sessions are keyed by *server plus root
 * directory* and shared. Ten open TypeScript files in one project share one
 * process; a file in a monorepo package with its own `tsconfig.json` gets its
 * own, because that is a different root and a different set of types.
 *
 * Releasing a session does not stop it. Closing a tab and reopening it is the
 * most common thing a person does, and paying a cold rust-analyzer start each
 * time would be worse than holding the process, so the last release starts a
 * grace timer instead of a shutdown.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { LspSession, type LspSessionState } from "./lsp-session.ts";
import {
  LANGUAGE_SERVERS,
  ancestorDirs,
  candidateCommandPaths,
  lspLanguageForPath,
  type LanguageServerDefinition,
} from "./server-registry.ts";

/** How long a session with no subscribers is kept before being shut down. */
const IDLE_GRACE_MS = 5 * 60 * 1000;

export interface LspHandle {
  session: LspSession;
  /** LSP language id for the file that asked, e.g. `typescriptreact`. */
  language: string;
  /** Key this session is registered under; pass it back to release. */
  key: string;
}

export type LspUnavailableReason = "no-language" | "not-installed" | "failed";

export interface LspUnavailable {
  reason: LspUnavailableReason;
  /** The server that would have served it, when one is known. */
  server?: { id: string; displayName: string; installHint: string };
  message: string;
}

export function isUnavailable(result: LspHandle | LspUnavailable): result is LspUnavailable {
  return "reason" in result;
}

interface Entry {
  session: LspSession;
  subscribers: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export class LspManager {
  private readonly entries = new Map<string, Entry>();
  /** In-flight starts, so two tabs opening at once do not spawn two servers. */
  private readonly starting = new Map<string, Promise<LspSession>>();
  private readonly notificationListeners = new Set<(key: string, method: string, params: unknown) => void>();

  /**
   * The server table to consult. Only the idle grace period and this are
   * parameterised, both so tests get an isolated manager rather than sharing
   * the singleton's live processes between cases.
   */
  constructor(
    private readonly servers: LanguageServerDefinition[] = LANGUAGE_SERVERS,
    private readonly idleGraceMs: number = IDLE_GRACE_MS,
  ) {}

  onNotification(listener: (key: string, method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /**
   * Find the language server for a file and hand back a running session.
   *
   * `subscriber` identifies whoever is holding it, normally a WebSocket id, so
   * releases can be counted without the caller tracking a token.
   */
  async acquire(projectPath: string, filePath: string, subscriber: string): Promise<LspHandle | LspUnavailable> {
    const language = lspLanguageForPath(filePath);
    if (!language) {
      return { reason: "no-language", message: "No language server serves this file type." };
    }

    const candidates = this.servers.filter((server) => server.languages.includes(language));
    if (candidates.length === 0) {
      return { reason: "no-language", message: `No language server is registered for ${language}.` };
    }

    const absoluteFile = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
    const dirs = ancestorDirs(absoluteFile, projectPath);

    let lastMissing: LanguageServerDefinition | null = null;
    for (const definition of candidates) {
      const commandPath = await this.resolveCommand(definition, dirs);
      if (!commandPath) {
        lastMissing = definition;
        continue;
      }
      const rootPath = await this.findRoot(definition, dirs, projectPath);
      const key = `${definition.id} ${rootPath}`;

      try {
        const session = await this.startOrReuse(key, definition, commandPath, rootPath);
        this.subscribe(key, subscriber);
        return { session, language, key };
      } catch (e) {
        return {
          reason: "failed",
          server: { id: definition.id, displayName: definition.displayName, installHint: definition.installHint },
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }

    const missing = lastMissing ?? candidates[0]!;
    return {
      reason: "not-installed",
      server: { id: missing.id, displayName: missing.displayName, installHint: missing.installHint },
      message: `${missing.displayName} is not installed.`,
    };
  }

  private async startOrReuse(
    key: string,
    definition: LanguageServerDefinition,
    commandPath: string,
    rootPath: string,
  ): Promise<LspSession> {
    const existing = this.entries.get(key);
    if (existing && (existing.session.state === "ready" || existing.session.state === "starting")) {
      return existing.session;
    }
    // A crashed or stopped session is dropped rather than handed out, so the
    // next open starts a fresh server instead of failing forever.
    if (existing) this.entries.delete(key);

    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;

    const promise = LspSession.start({
      definition,
      commandPath,
      rootPath,
      onNotification: (method, params) => {
        for (const listener of this.notificationListeners) listener(key, method, params);
      },
      onExit: () => {
        // Drop it so the next acquire starts a new one. Subscribers hear about
        // it through the notification channel the bridge listens on.
        const entry = this.entries.get(key);
        if (entry && entry.session.state !== "ready") this.entries.delete(key);
      },
    })
      .then((session) => {
        this.entries.set(key, { session, subscribers: new Set(), idleTimer: null });
        return session;
      })
      .finally(() => this.starting.delete(key));

    this.starting.set(key, promise);
    return promise;
  }

  private subscribe(key: string, subscriber: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.subscribers.add(subscriber);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  /** Give up one subscriber's hold. The server keeps running for the grace period. */
  release(key: string, subscriber: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.subscribers.delete(subscriber);
    if (entry.subscribers.size > 0 || entry.idleTimer) return;

    entry.idleTimer = setTimeout(() => {
      const current = this.entries.get(key);
      if (!current || current.subscribers.size > 0) return;
      this.entries.delete(key);
      void current.session.dispose();
    }, this.idleGraceMs);
    // A pending reap must not hold the process open at shutdown.
    entry.idleTimer.unref?.();
  }

  /** Drop every hold a subscriber had, for when a socket closes. */
  releaseAll(subscriber: string): void {
    for (const key of [...this.entries.keys()]) this.release(key, subscriber);
  }

  /** Resolve the command, preferring a version the project ships itself. */
  private async resolveCommand(definition: LanguageServerDefinition, dirs: string[]): Promise<string | null> {
    const candidates = candidateCommandPaths(definition.command, dirs);
    for (const candidate of candidates.slice(0, -1)) {
      if (await exists(candidate)) return candidate;
    }
    // The last candidate is the bare command, which means PATH.
    return Bun.which(definition.command);
  }

  /**
   * The nearest ancestor holding one of the server's root markers.
   *
   * Falls back to the project root rather than the file's own directory: a
   * server rooted at a single directory sees no imports and reports every one
   * of them as missing, which looks exactly like a broken install.
   */
  private async findRoot(definition: LanguageServerDefinition, dirs: string[], projectPath: string): Promise<string> {
    for (const dir of dirs) {
      for (const marker of definition.rootMarkers) {
        if (await exists(path.join(dir, marker))) return dir;
      }
    }
    return projectPath;
  }

  /**
   * The session behind a key, or undefined if it has since gone.
   *
   * The bridge holds keys rather than sessions on purpose: a session can crash
   * and be replaced between two messages from the same socket, and a held
   * reference would keep pointing at the dead one.
   */
  sessionFor(key: string): LspSession | undefined {
    return this.entries.get(key)?.session;
  }

  /** What is running, for the status route and the editor's indicator. */
  running(): Array<{ key: string; serverId: string; rootPath: string; state: LspSessionState; subscribers: number }> {
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      serverId: entry.session.definition.id,
      rootPath: entry.session.rootPath,
      state: entry.session.state,
      subscribers: entry.subscribers.size,
    }));
  }

  /**
   * Which of the registered servers this project could actually use.
   *
   * Answers the editor's "why is nothing happening" question directly, with the
   * install command for anything missing.
   */
  async availability(projectPath: string): Promise<
    Array<{ id: string; displayName: string; languages: string[]; installed: boolean; installHint: string }>
  > {
    const dirs = [projectPath];
    return Promise.all(
      this.servers.map(async (definition) => ({
        id: definition.id,
        displayName: definition.displayName,
        languages: definition.languages,
        installed: (await this.resolveCommand(definition, dirs)) !== null,
        installHint: definition.installHint,
      })),
    );
  }

  /**
   * Kill every server now, without the polite handshake.
   *
   * For `gracefulShutdown`, which calls `process.exit` and so cannot await
   * anything. Most language servers do exit on stdin EOF once PPM is gone, but
   * "most" is not a guarantee worth leaving a rust-analyzer resident on.
   */
  killAllSync(): void {
    for (const entry of this.entries.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      try {
        entry.session.kill();
      } catch {
        // Already gone.
      }
    }
    this.entries.clear();
  }

  /** Shut everything down, for when the server process is going away. */
  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await Promise.all(entries.map((entry) => entry.session.dispose()));
  }
}

export const lspManager = new LspManager();
