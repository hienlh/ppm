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
import { resolveBunPath } from "../autostart-generator.ts";
import { canInstall, lspInstallDir, rustupServerPath } from "./lsp-install.ts";
import { LspSession, type LspSessionState } from "./lsp-session.ts";
import {
  LANGUAGE_SERVERS,
  ancestorDirs,
  bundledServerEntry,
  candidateCommandPaths,
  installedBinaryPath,
  installedServerEntry,
  lspLanguageForPath,
  serversSharingInstall,
  type LanguageServerDefinition,
  type LanguageServerInstall,
} from "./server-registry.ts";

/** How long a session with no subscribers is kept before being shut down. */
const IDLE_GRACE_MS = 5 * 60 * 1000;

/**
 * How many language servers may exist at once.
 *
 * A session is started per server *and root directory*, so opening one file in each of a
 * dozen projects starts a dozen servers — and the idle grace above keeps every one of them
 * alive for five minutes after the tab closes. One `typescript-language-server` was 854 MB
 * resident, and PPM is routinely self-hosted on a machine where that is the whole machine.
 */
const MAX_SESSIONS = 6;

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
  server?: {
    id: string;
    displayName: string;
    installHint: string;
    installable: boolean;
    /** What the button would use, so the editor can say what pressing it does. */
    installWith?: "bun" | "go" | "rustup";
  };
  message: string;
}

/**
 * What the editor needs to name a missing server, and to decide whether to offer to install it.
 *
 * `installable` is the host's answer rather than the editor's guess, and it is not the registry's
 * either: `go install` needs a Go on this machine and `rustup component add` needs a rustup, so
 * the same server is installable on one host and a command to copy on the next.
 */
function serverSummary(definition: LanguageServerDefinition): NonNullable<LspUnavailable["server"]> {
  return {
    id: definition.id,
    displayName: definition.displayName,
    installHint: definition.installHint,
    installable: canInstall(definition),
    installWith: definition.install?.with,
  };
}

export function isUnavailable(result: LspHandle | LspUnavailable): result is LspUnavailable {
  return "reason" in result;
}

interface Entry {
  session: LspSession;
  subscribers: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Monotonic, so "least recently used" is exact rather than at the clock's resolution. */
  lastUsed: number;
}

/**
 * The bun that runs a server's entry script.
 *
 * Not `process.execPath`: that is bun only while PPM runs from source. A compiled PPM is its
 * own executable, so spawning it with a script path reaches PPM's *CLI* — the same trap that
 * made a compiled PPM answer `<ppm> x @openai/codex app-server` with "unknown command". `null`
 * on a host with no bun at all, where such a copy cannot be run and must not be called
 * installed.
 */
function bunRuntime(): string | null {
  try {
    return resolveBunPath();
  } catch {
    return null;
  }
}

/**
 * Where a server was found, in the order `resolveCommand` looks.
 *
 * It exists for the Remove button: PPM may delete what PPM installed and nothing else.
 * `project` is the repository's copy, `path` is one the user installed themselves, and
 * `bundled` is PPM's own dependency — removing any of those would be PPM tidying up after
 * someone else, and for `bundled` it would break the TypeScript server a fresh install has.
 */
export type ServerOrigin = "project" | "rustup" | "path" | "ppm" | "bundled";

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
  /**
   * Keys an acquire is currently waiting on, and who is waiting.
   *
   * A session becomes evictable the instant it is stored and stays that way until the acquire
   * that asked for it resumes and subscribes — and resuming takes a turn of the loop, which is
   * long enough for a *different* acquire to finish and sweep the cap. It would find a brand
   * new entry with no subscriber, rank it least-recently-used, and dispose it; the first
   * acquire then subscribed to nothing and handed its tab a session that was already gone.
   * Claiming the key up front makes "asked for" count as "in use", which is what the cap
   * always meant.
   */
  private readonly claims = new Map<string, number>();
  private readonly notificationListeners = new Set<(key: string, method: string, params: unknown) => void>();
  private useCounter = 0;
  /** Set once everything has been shut down; both ways of doing that are terminal. */
  private disposed = false;

  /**
   * The server table to consult. That, the idle grace period and the session cap are
   * parameterised so tests get an isolated manager rather than sharing the singleton's live
   * processes between cases.
   */
  constructor(
    private readonly servers: LanguageServerDefinition[] = LANGUAGE_SERVERS,
    private readonly idleGraceMs: number = IDLE_GRACE_MS,
    private readonly maxSessions: number = MAX_SESSIONS,
    /** Called rather than held, so `PPM_HOME` is read when a server is looked for, not at import. */
    private readonly installDir: () => string = lspInstallDir,
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
      const resolved = await this.resolveCommand(definition, dirs);
      if (!resolved) {
        lastMissing = definition;
        continue;
      }
      const rootPath = await this.findRoot(definition, dirs, projectPath);
      const key = `${definition.id} ${rootPath}`;

      this.claim(key);
      try {
        const session = await this.startOrReuse(key, definition, resolved.command, rootPath);
        // Subscribe *then* trim, so the session this call is about to hand out is never the
        // one the cap takes away.
        if (!this.subscribe(key, subscriber)) {
          // The entry went away while this call was waiting — the server exited on its own, or
          // the idle reaper fired. Reporting that beats handing back a dead session: the tab
          // would take it, ask for capabilities, and answer "no longer running" to every
          // request from then on, with nothing short of closing the tab to recover.
          throw new Error(`${definition.displayName} stopped while starting up.`);
        }
        this.enforceSessionCap();
        return { session, language, key };
      } catch (e) {
        return {
          reason: "failed",
          server: serverSummary(definition),
          message: e instanceof Error ? e.message : String(e),
        };
      } finally {
        this.unclaim(key);
      }
    }

    const missing = lastMissing ?? candidates[0]!;
    return {
      reason: "not-installed",
      server: serverSummary(missing),
      message: `${missing.displayName} is not installed.`,
    };
  }

  private async startOrReuse(
    key: string,
    definition: LanguageServerDefinition,
    command: string[],
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

    // Checked here rather than only at the top of `acquire`: resolving the command and finding
    // the root are several round trips to the filesystem, and a shutdown lands inside them
    // often enough. Spawning now would put a language server behind a process that has already
    // reported itself down.
    if (this.disposed) throw new Error("PPM is shutting down.");

    const promise = LspSession.start({
      definition,
      command,
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
        // A shutdown that ran while this was starting has already emptied `entries`, and
        // storing it now would put a live server into a manager that believes it has none —
        // `killAllSync` runs immediately before `process.exit`, so the server and every
        // `tsserver` it forked would outlive PPM with nothing left holding a handle to them.
        if (this.disposed) {
          void session.dispose();
          return session;
        }
        this.entries.set(key, { session, subscribers: new Set(), idleTimer: null, lastUsed: ++this.useCounter });
        return session;
      })
      .finally(() => this.starting.delete(key));

    this.starting.set(key, promise);
    return promise;
  }

  /**
   * Shut down least-recently-used servers until the cap is met.
   *
   * Only servers with no subscriber are taken. One with an editor open is being used, and the
   * bridge cannot re-open its documents on a session that vanished underneath it — that tab
   * would answer "the language server is no longer running" for every request until it was
   * closed and opened again, which is worse than the memory. So this bounds how many *idle*
   * servers survive their grace period, and the grace period is what made that number
   * unbounded: browsing a dozen projects in five minutes left a dozen servers resident.
   */
  private enforceSessionCap(): void {
    if (this.entries.size <= this.maxSessions) return;
    const idle = [...this.entries.entries()]
      .filter(([key, entry]) => entry.subscribers.size === 0 && !this.claims.has(key))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of idle) {
      if (this.entries.size <= this.maxSessions) return;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.entries.delete(key);
      void entry.session.dispose();
    }
  }

  /**
   * Counted, not a set of subscriber ids.
   *
   * One socket opening two files in the same project — restoring a session's tabs is the
   * ordinary case — makes two concurrent acquires with the same key *and* the same subscriber.
   * A set would dedupe them, so the first to finish would drop the claim while the second was
   * still in flight, leaving it unprotected for exactly the reason the claim exists.
   */
  private claim(key: string): void {
    this.claims.set(key, (this.claims.get(key) ?? 0) + 1);
  }

  private unclaim(key: string): void {
    const holders = this.claims.get(key) ?? 0;
    if (holders > 1) {
      this.claims.set(key, holders - 1);
      return;
    }
    // Deleted rather than left at zero, so `claims.has(key)` alone answers "someone is waiting
    // on this" for the cap sweep.
    this.claims.delete(key);
    // The sweep skips a claimed key rather than deferring it, so whatever it declined to take
    // is still over the cap until something else acquires. Re-running here is what keeps the
    // cap a bound rather than a suggestion.
    this.enforceSessionCap();
  }

  /** False when the entry is gone, i.e. there is no running session to hold. */
  private subscribe(key: string, subscriber: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.lastUsed = ++this.useCounter;
    entry.subscribers.add(subscriber);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    return true;
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

  /**
   * Resolve the command, in the order the answers deserve.
   *
   * The project's own copy first, because a repository pinned to TypeScript 4 has to be
   * analysed by its own server — the same reason VS Code offers "Use Workspace Version".
   * Then rustup, which owns its answer completely (below). Then `PATH`, which is whatever the
   * user deliberately installed. Then PPM's own directory: what the Install button put there,
   * and then the copy PPM ships, which is the floor rather than a preference — it is how a
   * fresh install has a working TypeScript server with nothing else done, and it must never win
   * over either of the two choices someone actually made.
   */
  private async resolveCommand(
    definition: LanguageServerDefinition,
    dirs: string[],
  ): Promise<{ command: string[]; origin: ServerOrigin } | null> {
    const candidates = candidateCommandPaths(definition.command, dirs);
    for (const candidate of candidates.slice(0, -1)) {
      if (await exists(candidate)) return { command: [candidate], origin: "project" };
    }
    // rust-analyzer is a toolchain component rather than a file PPM owns, so rustup is asked
    // where it is — in the file's own directory, so a repository pinning a toolchain gets that
    // toolchain's server. This has to come *before* PATH, because `~/.cargo/bin/rust-analyzer`
    // is a rustup proxy that exists whether or not the component does: found on PATH it reports
    // an installed server, and spawning it prints "unknown binary" and exits, which is a broken
    // server rather than the missing one the Install button is offered for. Costs nothing for
    // every other server — it answers null on sight of a definition that is not rustup's.
    const fromRustup = await rustupServerPath(definition, dirs[0] ?? process.cwd());
    if (fromRustup) return { command: [fromRustup], origin: "rustup" };

    // The last candidate is the bare command, which means PATH.
    const onPath = Bun.which(definition.command);
    if (onPath) return { command: [onPath], origin: "path" };

    // What the Install button built with the host's Go: a real binary in PPM's own directory,
    // spawned as itself.
    const binary = installedBinaryPath(definition, this.installDir());
    if (binary && (await exists(binary))) return { command: [binary], origin: "ppm" };

    // Both of PPM's npm copies are entry scripts rather than npm's `.bin` shims: that shim is
    // `#!/usr/bin/env node`, and someone who installed PPM with bun may have no node at all —
    // which fails as exit code 127 at spawn time, long after the server looked installed.
    for (const [entry, origin] of [
      [installedServerEntry(definition, this.installDir()), "ppm"],
      [bundledServerEntry(definition), "bundled"],
    ] as const) {
      if (!entry || !(await exists(entry))) continue;
      const runtime = bunRuntime();
      return runtime ? { command: [runtime, entry], origin } : null;
    }
    return null;
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
   * Which of the registered servers could actually be used.
   *
   * Answers the editor's "why is nothing happening" question directly, with the install
   * command for anything missing. With no `projectPath` it answers for the *machine* — no
   * project `node_modules/.bin` is consulted — which is what the Settings pane asks, since it
   * is not open on any one project.
   */
  async availability(projectPath?: string): Promise<
    Array<{
      id: string;
      displayName: string;
      languages: string[];
      installed: boolean;
      installHint: string;
      installable: boolean;
      installWith?: LanguageServerInstall["with"];
      origin?: ServerOrigin;
      /** Whether PPM may remove it — that is, whether PPM is what put it there. */
      removable: boolean;
      /** Servers the same removal would also take, because one npm package provides several. */
      alsoRemoves?: string[];
    }>
  > {
    const dirs = projectPath ? [projectPath] : [];
    return Promise.all(
      this.servers.map(async (definition) => {
        const resolved = await this.resolveCommand(definition, dirs);
        const origin = resolved?.origin;
        const removable = origin === "ppm" || origin === "rustup";
        const shared = removable ? serversSharingInstall(definition).map((s) => s.displayName) : [];
        return {
          id: definition.id,
          displayName: definition.displayName,
          languages: definition.languages,
          installed: resolved !== null,
          installHint: definition.installHint,
          installable: canInstall(definition),
          installWith: definition.install?.with,
          origin,
          removable,
          ...(shared.length > 0 ? { alsoRemoves: shared } : {}),
        };
      }),
    );
  }

  /**
   * Stop this server's idle sessions, for an uninstall that is about to delete it.
   *
   * Only the ones nobody is holding. A session with a subscriber is an editor open on it, and
   * taking that away answers every later request with "the language server is no longer
   * running" until the tab is closed and reopened — the same reason `enforceSessionCap` leaves
   * held sessions alone. One that keeps running is running on files it already opened, which
   * is harmless everywhere except Windows, where it is also what refuses the unlink.
   */
  async stopIdle(serverId: string): Promise<void> {
    const doomed = [...this.entries.entries()].filter(
      ([, entry]) => entry.session.definition.id === serverId && entry.subscribers.size === 0,
    );
    for (const [key, entry] of doomed) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.entries.delete(key);
    }
    await Promise.all(doomed.map(([, entry]) => entry.session.dispose()));
  }

  /**
   * Kill every server now, without the polite handshake.
   *
   * For `gracefulShutdown`, which calls `process.exit` and so cannot await
   * anything. Most language servers do exit on stdin EOF once PPM is gone, but
   * "most" is not a guarantee worth leaving a rust-analyzer resident on.
   */
  killAllSync(): void {
    this.disposed = true;
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
    this.disposed = true;
    const entries = [...this.entries.values()];
    const inFlight = [...this.starting.values()];
    this.entries.clear();
    for (const entry of entries) if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await Promise.all([
      ...entries.map((entry) => entry.session.dispose()),
      // A start still in flight is refused the table above, but refusing it does not stop the
      // process it is about to finish spawning. Returning before that one is down would report
      // a clean shutdown with a language server still running behind it.
      ...inFlight.map((starting) => starting.then((session) => session.dispose(), () => undefined)),
    ]);
  }
}

export const lspManager = new LspManager();
