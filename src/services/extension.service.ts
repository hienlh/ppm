import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { ExtensionManifest, ExtensionInfo, RpcMessage } from "../types/extension.ts";
import { getExtensions, getExtensionById, insertExtension, updateExtension, deleteExtension, deleteExtensionStorage, getExtensionStorage, setExtensionStorageValue } from "./db.service.ts";
import { contributionRegistry } from "./contribution-registry.ts";
import { RpcChannel } from "./extension-rpc.ts";
import { parseManifest, discoverManifests, discoverBundledManifests } from "./extension-manifest.ts";
import { installExtension, removeExtension, devLinkExtension, ensureExtensionsDir } from "./extension-installer.ts";
import { registerVscodeCompatHandlers } from "./extension-rpc-handlers.ts";
import { getPpmDir } from "./ppm-dir.ts";
import { isCompiledBinary } from "./autostart-generator.ts";

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

  // --- Worker lifecycle ---

  private ensureWorker(): { worker: Worker; rpc: RpcChannel } {
    if (this.worker && this.rpc) return { worker: this.worker, rpc: this.rpc };

    this.worker = new Worker(extensionHostWorkerSpec(), { type: "module" });
    this.rpc = new RpcChannel((msg) => this.worker!.postMessage(msg));

    this.rpc.onRequest("storage:set", async (params) => {
      const [extId, scope, key, value] = params as [string, string, string, string | null];
      setExtensionStorageValue(extId, scope, key, value);
      return { ok: true };
    });

    // Register vscode-compat API handlers (commands, window, workspace, fs)
    registerVscodeCompatHandlers(this.rpc);

    this.rpc.onEvent("worker:ready", () => {
      this.workerReady = true;
      console.log("[ExtService] Extension host worker ready");
    });

    this.worker.addEventListener("message", (event: MessageEvent<RpcMessage>) => {
      this.rpc!.handleMessage(event.data);
    });
    this.worker.addEventListener("error", (event) => {
      console.error("[ExtService] Worker error:", event.message);
    });

    return { worker: this.worker, rpc: this.rpc };
  }

  private async terminateWorker(): Promise<void> {
    if (this.rpc) { this.rpc.dispose(); this.rpc = null; }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.workerReady = false;
    this.activatedIds.clear();
    this.activationErrors.clear();
    this.extensionPaths.clear();
    this.bundledIds.clear();
    contributionRegistry.clear();
  }

  // --- Public API ---

  parseManifest(pkg: Record<string, unknown>): ExtensionManifest | null {
    return parseManifest(pkg);
  }

  async discover(): Promise<ExtensionManifest[]> {
    ensureExtensionsDir(resolve(getPpmDir(), "extensions"));

    // Discover bundled extensions from packages/ext-*
    const bundled = await discoverBundledManifests(bundledExtensionsDir());
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

    console.log(`[ExtService] activating ${id} (entry: ${entryPath})`);
    const result = await rpc.sendRequest<{ ok: boolean; error?: string }>(
      "ext:activate", id, entryPath, extDir, storedState, baseUrl, authToken,
    );
    if (!result.ok) {
      this.activationErrors.set(id, result.error ?? "Unknown activation error");
      throw new Error(`Failed to activate ${id}: ${result.error}`);
    }

    this.activationErrors.delete(id);
    this.activatedIds.add(id);
    if (manifest.contributes) contributionRegistry.register(id, manifest.contributes);
    this.broadcastContributions();
    console.log(`[ExtService] activated ${id} successfully`);
  }

  async deactivate(id: string): Promise<void> {
    if (!this.activatedIds.has(id)) return;
    if (this.rpc) {
      try { await this.rpc.sendRequest("ext:deactivate", id); } catch (e) {
        console.error(`[ExtService] Error deactivating ${id}:`, e);
      }
    }
    this.activatedIds.delete(id);
    contributionRegistry.unregister(id);
    this.broadcastContributions();
    console.log(`[ExtService] Deactivated ${id}`);
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
    if (enabled && !this.activatedIds.has(id)) await this.activate(id);
    else if (!enabled && this.activatedIds.has(id)) await this.deactivate(id);
  }

  async devLink(localPath: string): Promise<ExtensionManifest> {
    const manifest = devLinkExtension(localPath, resolve(getPpmDir(), "extensions"));
    // Auto-activate after dev-link (DB record is created with enabled=1)
    if (!this.activatedIds.has(manifest.id)) {
      try { await this.activate(manifest.id); } catch (e) {
        console.error(`[ExtService] Auto-activate after dev-link failed:`, e);
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
    for (const row of getExtensions()) {
      if (!discoveredIds.has(row.id)) {
        console.log(`[ExtService] startup: removing stale DB record for ${row.id}`);
        deleteExtensionStorage(row.id);
        deleteExtension(row.id);
        continue;
      }
      if (row.enabled !== 1) continue;
      console.log(`[ExtService] startup: activating ${row.id}...`);
      try { await this.activate(row.id); } catch (e) {
        this.activationErrors.set(row.id, e instanceof Error ? e.message : String(e));
        console.error(`[ExtService] Failed to activate ${row.id} on startup:`, e);
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.activatedIds]) {
      try { await this.deactivate(id); } catch {}
    }
    await this.terminateWorker();
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
