import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ExtensionManifest, ExtensionInfo, RpcMessage } from "../types/extension.ts";
import { getExtensions, getExtensionById, insertExtension, getExtensionStorage, setExtensionStorageValue } from "./db.service.ts";
import { contributionRegistry } from "./contribution-registry.ts";
import { RpcChannel } from "./extension-rpc.ts";
import { parseManifest, discoverManifests } from "./extension-manifest.ts";
import { installExtension, removeExtension, devLinkExtension, ensureExtensionsDir } from "./extension-installer.ts";
import { registerVscodeCompatHandlers } from "./extension-rpc-handlers.ts";
import { getPpmDir } from "./ppm-dir.ts";

class ExtensionService {
  private worker: Worker | null = null;
  private rpc: RpcChannel | null = null;
  private activatedIds = new Set<string>();
  private workerReady = false;
  private installing = new Set<string>();

  // --- Worker lifecycle ---

  private ensureWorker(): { worker: Worker; rpc: RpcChannel } {
    if (this.worker && this.rpc) return { worker: this.worker, rpc: this.rpc };

    const workerPath = new URL("./extension-host-worker.ts", import.meta.url).href;
    this.worker = new Worker(workerPath, { type: "module" });
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
    contributionRegistry.clear();
  }

  // --- Public API ---

  parseManifest(pkg: Record<string, unknown>): ExtensionManifest | null {
    return parseManifest(pkg);
  }

  async discover(): Promise<ExtensionManifest[]> {
    ensureExtensionsDir(resolve(getPpmDir(), "extensions"));
    return discoverManifests(resolve(getPpmDir(), "extensions"));
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
    const extDir = resolve(resolve(getPpmDir(), "extensions"), "node_modules", id);
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

    // Pass server base URL so extensions can make fetch() calls in the Worker
    const { configService: cfg } = await import("./config.service.ts");
    const port = cfg.get("port") ?? 8080;
    const baseUrl = `http://localhost:${port}`;

    const result = await rpc.sendRequest<{ ok: boolean; error?: string }>(
      "ext:activate", id, entryPath, extDir, storedState, baseUrl,
    );
    if (!result.ok) throw new Error(`Failed to activate ${id}: ${result.error}`);

    this.activatedIds.add(id);
    if (manifest.contributes) contributionRegistry.register(id, manifest.contributes);
    this.broadcastContributions();
    console.log(`[ExtService] Activated ${id}`);
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
    const { updateExtension } = await import("./db.service.ts");
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
      if (!getExtensionById(m.id)) {
        insertExtension({
          id: m.id, version: m.version,
          display_name: m.displayName ?? null, description: m.description ?? null,
          icon: m.icon ?? null, enabled: 1, manifest: JSON.stringify(m),
        });
      }
    }
    for (const row of getExtensions()) {
      if (row.enabled !== 1) continue;
      try { await this.activate(row.id); } catch (e) {
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
  getExtensionsDir(): string { return resolve(getPpmDir(), "extensions"); }

  /** Push current contributions to all connected browser clients */
  private broadcastContributions(): void {
    try {
      const { broadcastExtMsg } = require("../server/ws/extensions.ts");
      broadcastExtMsg({ type: "contributions:update", contributions: contributionRegistry.getAll() });
    } catch {}
  }
}

export const extensionService = new ExtensionService();
