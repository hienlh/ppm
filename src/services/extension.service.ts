import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { ExtensionManifest, ExtensionInfo } from "../types/extension.ts";
import { getExtensions, getExtensionById, insertExtension, updateExtension, deleteExtension, deleteExtensionStorage, getExtensionStorage, setExtensionStorageValue } from "./db.service.ts";
import { contributionRegistry } from "./contribution-registry.ts";
import type { RpcChannel } from "./extension-rpc.ts";
import { openWorkerChannel } from "./extension-worker-channel.ts";
import { extensionCallRegistry } from "./extension-api/extension-call-registry.ts";
import { extensionApiDeps } from "./extension-api/index.ts";
import { extensionDataDir } from "./extension-data-dir.ts";
import { parseManifest, discoverManifests, discoverBundledManifests } from "./extension-manifest.ts";
import { installExtension, removeExtension, devLinkExtension, ensureExtensionsDir } from "./extension-installer.ts";
import { registerVscodeCompatHandlers } from "./extension-rpc-handlers.ts";
import { getPpmDir } from "./ppm-dir.ts";
import { isCompiledBinary } from "./autostart-generator.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("ExtService");
/** What the extension host thread prints — the host itself, vscode-compat and every extension —
 *  forwarded from that thread's console (see extension-host-worker.ts). */
const extLog = createLogger("ext");

/**
 * Where the bundled `packages/ext-*` extensions live on disk.
 *
 * They are loaded as source by the extension host, so they ship *beside* the install rather
 * than inside it. Walking up from `import.meta.dir` finds them when PPM runs from source, but
 * a compiled binary reports `/$bunfs/root` — its embedded filesystem — and the same walk lands
 * on `/packages`, an absolute path at the filesystem root that cannot exist. Every bundled
 * extension then vanished with no error and no log line: the panel simply said none were
 * installed. Fall back to the directory holding the executable (`<install>/dist/ppm` →
 * `<install>/packages`).
 */
export function bundledExtensionsDir(
  moduleDir: string = import.meta.dir,
  execPath: string = process.execPath,
): string {
  const fromSource = resolve(moduleDir, "../../packages");
  if (existsSync(fromSource)) return fromSource;
  return resolve(dirname(execPath), "../packages");
}

/**
 * How to name the extension host worker so Bun will actually load it.
 *
 * Neither form works in both modes, which is why this is a branch and not a constant:
 *
 * - `new URL("./extension-host-worker.ts", import.meta.url)` is right from source — it is
 *   anchored to this module, so it survives the service's `WorkingDirectory=~/.ppm`. From a
 *   compiled binary it yields `file:///$bunfs/root/...`, the embedded filesystem, and Bun
 *   refuses to resolve a worker entry point there: the Worker fails to build and dies at once.
 *   `ensureWorker` only null-checks, so every later activation posts to the corpse and reports
 *   `Worker has been terminated`.
 * - A relative specifier is right when compiled — but it resolves against the directory of the
 *   build's *main entry point* (`src/index.ts`), not against this module, so it reads
 *   `./services/...` rather than `./`. Verified at cwd `/`, `~/.ppm` and the binary's own
 *   directory; every other spelling tried (`./extension-host-worker.ts`, `src/services/...`,
 *   the `/$bunfs/` path) is refused. From source the same specifier resolves against cwd, so
 *   it breaks the moment cwd is not this directory, which for the service it never is.
 *
 * The worker also has to be a second entry point of `bun build --compile` (see the `build`
 * script) — a worker referenced only through `new URL` is not pulled into the binary.
 *
 * Compiling this way also keeps the worker's own imports (`@ppm/vscode-compat`) inside the
 * bundle, where loading it off disk would have to resolve them through `node_modules` — which
 * a worker spawned from a compiled binary does not do.
 */
export function extensionHostWorkerSpec(compiled: boolean = isCompiledBinary()): string {
  return compiled
    ? "./services/extension-host-worker.ts"
    : new URL("./extension-host-worker.ts", import.meta.url).href;
}

class ExtensionService {
  private worker: Worker | null = null;
  private rpc: RpcChannel | null = null;
  private activatedIds = new Set<string>();
  private activationErrors = new Map<string, string>();
  private workerReady = false;
  private installing = new Set<string>();
  private extensionPaths = new Map<string, string>();
  private bundledIds = new Set<string>();
  /** Bumped for every worker started; long-running calls are tied to the one that asked. */
  private generation = 0;

  // --- Worker lifecycle ---

  private ensureWorker(): { worker: Worker; rpc: RpcChannel } {
    if (this.worker && this.rpc) return { worker: this.worker, rpc: this.rpc };

    const worker = new Worker(extensionHostWorkerSpec(), { type: "module" });
    const generation = ++this.generation;
    this.worker = worker;
    const rpc = openWorkerChannel(worker, () => this.worker === worker, createLogger("RPC"));
    this.rpc = rpc;
    log.info(`Extension host worker started generation=${generation}`);

    rpc.onRequest("storage:set", async (params) => {
      const [extId, scope, key, value] = params as [string, string, string, string | null];
      setExtensionStorageValue(extId, scope, key, value);
      return { ok: true };
    });

    // Register vscode-compat API handlers (commands, window, workspace, fs)
    registerVscodeCompatHandlers(rpc, extensionApiDeps(generation));

    rpc.onEvent("worker:ready", () => {
      this.workerReady = true;
      log.debug("Extension host worker ready");
    });

    rpc.onEvent("log", (data) => {
      const { level, text } = (data ?? {}) as { level?: unknown; text?: unknown };
      if (typeof text !== "string") return;
      if (level === "debug" || level === "warn" || level === "error") extLog[level](text);
      else extLog.info(text);
    });

    worker.addEventListener("error", (event) => {
      log.error("Worker error:", event.message);
    });
    // The only sign the host thread is gone: an uncaught exception in any extension ends it
    // (code 1), and `terminateWorker` is the one expected way out. Only the current worker
    // dying triggers a rebuild: `terminateWorker` clears `this.worker` before terminating, so
    // the close event it causes (including the one inside recovery) never re-enters it.
    worker.addEventListener("close", (event) => {
      const code = (event as Event & { code?: number }).code;
      if (this.worker === worker) {
        log.error(`Extension host worker exited code=${code} active=${this.activatedIds.size}`);
        // Fails the requests still waiting on it (an activation in progress) now, rather than
        // after their full timeout.
        rpc.dispose();
        void this.recoverWorker("close");
      } else {
        log.debug(`Extension host worker stopped code=${code}`);
      }
    });

    return { worker, rpc };
  }

  private recovering = false;
  private recoveryTimes: number[] = [];
  /** Set when the worker a rebuild just started dies too; the rebuild then goes again. */
  private recoverAgain: string | null = null;

  /**
   * A terminated worker leaves `this.worker` non-null, so every later RPC waits
   * the full timeout and fails. Rebuild the host and re-activate whatever was
   * enabled; bounded so a crash-on-activate extension cannot restart-loop.
   *
   * A worker that dies while a rebuild is re-activating (the crash-on-activate case) is
   * rebuilt by that same call and counts against the same bound, so the host is never
   * left dead without a "giving up" line.
   */
  private async recoverWorker(reason: string): Promise<void> {
    if (this.recovering) {
      this.recoverAgain = reason;
      return;
    }
    this.recovering = true;
    try {
      let next: string | null = reason;
      while (next !== null) {
        this.recoverAgain = null;
        const now = Date.now();
        this.recoveryTimes = this.recoveryTimes.filter((t) => now - t < 5 * 60_000);
        if (this.recoveryTimes.length >= 3) {
          log.error(`Worker ${next} again — 3 recoveries in 5 min, giving up until restart`);
          // Drop the dead host, so an extension enabled later starts a fresh one instead of
          // posting to a thread that no longer exists. The activation errors stay, so the
          // extensions panel still says why each one is down.
          const errors = new Map(this.activationErrors);
          await this.terminateWorker();
          for (const [id, message] of errors) this.activationErrors.set(id, message);
          this.broadcastContributions();
          return;
        }
        this.recoveryTimes.push(now);
        await this.rebuildWorker(next);
        next = this.recoverAgain;
      }
    } finally {
      this.recovering = false;
      this.recoverAgain = null;
    }
  }

  private async rebuildWorker(reason: string): Promise<void> {
    const toReactivate = getExtensions().filter((row) => row.enabled === 1).map((row) => row.id);
    log.warn(`Worker ${reason} — rebuilding host and re-activating ${toReactivate.length} extension(s)`);
    await this.terminateWorker();
    for (const id of toReactivate) {
      // The new host died as well: activating the rest against it would only fail.
      if (this.recoverAgain !== null) break;
      try { await this.activate(id); } catch (e) {
        this.activationErrors.set(id, e instanceof Error ? e.message : String(e));
        log.error(`Failed to re-activate ${id} after worker ${reason}:`, e);
      }
    }
  }

  private async terminateWorker(): Promise<void> {
    // Before the next worker can start: its calls answer nobody once this one is gone.
    const aborted = extensionCallRegistry.endGeneration(this.generation);
    if (aborted > 0) log.info(`aborted ${aborted} extension call(s) of generation ${this.generation}`);
    if (this.rpc) { this.rpc.dispose(); this.rpc = null; }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.workerReady = false;
    this.activatedIds.clear();
    this.activationErrors.clear();
    // `extensionPaths` and `bundledIds` describe what is on disk, not this worker: a rebuild
    // keeps them, or a bundled extension is looked for under node_modules and cannot be
    // re-activated. Only `shutdown` forgets them.
    contributionRegistry.clear();
  }

  // --- Public API ---

  parseManifest(pkg: Record<string, unknown>): ExtensionManifest | null {
    return parseManifest(pkg);
  }

  async discover(): Promise<ExtensionManifest[]> {
    ensureExtensionsDir(resolve(getPpmDir(), "extensions"));

    // Discover bundled extensions from packages/ext-*
    const bundledDir = bundledExtensionsDir();
    // Every bundled extension would vanish without it, and nothing else says so.
    if (!existsSync(bundledDir)) log.warn(`Bundled extensions dir not found: ${bundledDir}`);
    const bundled = await discoverBundledManifests(bundledDir);
    for (const m of bundled) {
      this.extensionPaths.set(m.id, m._dir);
      this.bundledIds.add(m.id);
    }

    // Discover user-installed extensions
    const userExtDir = resolve(getPpmDir(), "extensions");
    const userManifests = await discoverManifests(userExtDir);
    for (const m of userManifests) {
      this.extensionPaths.set(m.id, resolve(userExtDir, "node_modules", m.id));
    }

    // Merge: user overrides bundled if same id (strip _dir to avoid leaking paths)
    const byId = new Map(bundled.map((m) => {
      const { _dir, ...manifest } = m;
      return [m.id, manifest as ExtensionManifest];
    }));
    for (const m of userManifests) byId.set(m.id, m);
    return [...byId.values()];
  }

  async install(name: string): Promise<ExtensionManifest> {
    if (this.installing.has(name)) throw new Error(`Already installing ${name}`);
    this.installing.add(name);
    try {
      return await installExtension(name, resolve(getPpmDir(), "extensions"));
    } finally {
      this.installing.delete(name);
    }
  }

  async remove(id: string): Promise<void> {
    if (this.bundledIds.has(id)) {
      throw new Error(`Cannot remove bundled extension "${id}". Use 'ppm ext disable ${id}' instead.`);
    }
    if (this.activatedIds.has(id)) await this.deactivate(id);
    await removeExtension(id, resolve(getPpmDir(), "extensions"));
    contributionRegistry.unregister(id);
  }

  async activate(id: string): Promise<void> {
    if (this.activatedIds.has(id)) return;

    const row = getExtensionById(id);
    if (!row) throw new Error(`Extension ${id} not found in DB`);
    if (!row.enabled) throw new Error(`Extension ${id} is disabled`);

    const manifest: ExtensionManifest = JSON.parse(row.manifest);
    const extDir = this.extensionPaths.get(id)
      ?? resolve(resolve(getPpmDir(), "extensions"), "node_modules", id);
    const entryPath = resolve(extDir, manifest.main);
    if (!existsSync(entryPath)) throw new Error(`Entry point not found: ${entryPath}`);

    // Created before activate() runs, so an extension can open files there straight away.
    const dataDir = extensionDataDir(id);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const { rpc } = this.ensureWorker();

    // Hydrate persisted state so extensions can read it after activation
    const globalStorage = getExtensionStorage(id, "global");
    const workspaceStorage = getExtensionStorage(id, "workspace");
    const storedState = {
      global: Object.fromEntries(globalStorage.map((r) => [r.key, r.value])),
      workspace: Object.fromEntries(workspaceStorage.map((r) => [r.key, r.value])),
    };

    // Pass server base URL + auth token so extensions can make fetch() calls in the Worker
    const { configService: cfg } = await import("./config.service.ts");
    const port = cfg.get("port") ?? 8080;
    const baseUrl = `http://localhost:${port}`;
    const authConfig = cfg.get("auth");
    const authToken = authConfig?.enabled ? authConfig.token : undefined;

    log.debug(`activating ${id} (entry: ${entryPath})`);
    const result = await rpc.sendRequest<{ ok: boolean; error?: string }>(
      "ext:activate", id, entryPath, extDir, storedState, baseUrl, authToken, dataDir,
    );
    if (!result.ok) {
      this.activationErrors.set(id, result.error ?? "Unknown activation error");
      throw new Error(`Failed to activate ${id}: ${result.error}`);
    }

    this.activationErrors.delete(id);
    this.activatedIds.add(id);
    if (manifest.contributes) contributionRegistry.register(id, manifest.contributes);
    this.broadcastContributions();
    log.info(`activated ${id} successfully`);
  }

  async deactivate(id: string): Promise<void> {
    if (!this.activatedIds.has(id)) return;
    if (this.rpc) {
      try {
        const result = await this.rpc.sendRequest<{ ok: boolean; error?: string }>("ext:deactivate", id);
        // Its deactivate() threw. The host drops the extension all the same, so it is degraded
        // rather than failed — but without this line it read as a clean "Deactivated".
        if (result && !result.ok) log.warn(`deactivate ${id} reported error: ${result.error ?? "unknown"}`);
      } catch (e) {
        log.error(`Error deactivating ${id}:`, e);
      }
    }
    this.activatedIds.delete(id);
    contributionRegistry.unregister(id);
    this.broadcastContributions();
    log.info(`Deactivated ${id}`);
  }

  list(): ExtensionInfo[] {
    return getExtensions().map((row) => ({
      id: row.id,
      version: row.version,
      displayName: row.display_name || row.id,
      description: row.description || "",
      icon: row.icon || "",
      enabled: row.enabled === 1,
      activated: this.activatedIds.has(row.id),
      manifest: JSON.parse(row.manifest) as ExtensionManifest,
    }));
  }

  get(id: string): ExtensionInfo | null {
    const row = getExtensionById(id);
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      displayName: row.display_name || row.id,
      description: row.description || "",
      icon: row.icon || "",
      enabled: row.enabled === 1,
      activated: this.activatedIds.has(row.id),
      manifest: JSON.parse(row.manifest) as ExtensionManifest,
    };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const row = getExtensionById(id);
    if (!row) throw new Error(`Extension ${id} not found`);
    updateExtension(id, { enabled: enabled ? 1 : 0 });
    log.info(`${enabled ? "Enabled" : "Disabled"} ${id}`);
    if (enabled && !this.activatedIds.has(id)) await this.activate(id);
    else if (!enabled && this.activatedIds.has(id)) await this.deactivate(id);
  }

  async devLink(localPath: string): Promise<ExtensionManifest> {
    const manifest = devLinkExtension(localPath, resolve(getPpmDir(), "extensions"));
    // Auto-activate after dev-link (DB record is created with enabled=1)
    if (!this.activatedIds.has(manifest.id)) {
      try { await this.activate(manifest.id); } catch (e) {
        log.error(`Auto-activate after dev-link failed:`, e);
      }
    }
    return manifest;
  }

  async startup(): Promise<void> {
    ensureExtensionsDir(resolve(getPpmDir(), "extensions"));
    const manifests = await this.discover();
    for (const m of manifests) {
      const existing = getExtensionById(m.id);
      if (!existing) {
        insertExtension({
          id: m.id, version: m.version,
          display_name: m.displayName ?? null, description: m.description ?? null,
          icon: m.icon ?? null, enabled: 1, manifest: JSON.stringify(m),
        });
      } else {
        // Always sync manifest from disk so new contributes (keybindings, etc.) are picked up
        updateExtension(m.id, {
          version: m.version,
          display_name: m.displayName ?? null,
          description: m.description ?? null,
          icon: m.icon ?? null,
          manifest: JSON.stringify(m),
        });
      }
    }
    // Clean up stale DB records for extensions no longer on disk
    const discoveredIds = new Set(manifests.map((m) => m.id));
    let failed = 0;
    for (const row of getExtensions()) {
      if (!discoveredIds.has(row.id)) {
        log.info(`startup: removing stale DB record for ${row.id}`);
        deleteExtensionStorage(row.id);
        deleteExtension(row.id);
        continue;
      }
      if (row.enabled !== 1) continue;
      log.debug(`startup: activating ${row.id}...`);
      try { await this.activate(row.id); } catch (e) {
        failed++;
        this.activationErrors.set(row.id, e instanceof Error ? e.message : String(e));
        log.error(`Failed to activate ${row.id} on startup:`, e);
      }
    }
    const bundled = manifests.filter((m) => this.bundledIds.has(m.id)).length;
    log.info(`startup: bundled=${bundled} user=${manifests.length - bundled} activated=${this.activatedIds.size} failed=${failed}`);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.activatedIds]) {
      try { await this.deactivate(id); } catch {}
    }
    await this.terminateWorker();
    this.extensionPaths.clear();
    this.bundledIds.clear();
  }

  isActivated(id: string): boolean { return this.activatedIds.has(id); }
  isBundled(id: string): boolean { return this.bundledIds.has(id); }
  getExtensionsDir(): string { return resolve(getPpmDir(), "extensions"); }
  getActivationErrors(): Map<string, string> { return new Map(this.activationErrors); }

  /** Push current contributions to all connected browser clients */
  private broadcastContributions(): void {
    try {
      const { broadcastExtMsg } = require("../server/ws/extensions.ts");
      const contributions = contributionRegistry.getAll();
      broadcastExtMsg(this.activationErrors.size > 0
        ? { type: "contributions:update", contributions, activationErrors: Object.fromEntries(this.activationErrors) }
        : { type: "contributions:update", contributions },
      );
    } catch {}
  }
}

export const extensionService = new ExtensionService();
