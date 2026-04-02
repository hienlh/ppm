/**
 * Main-side RPC handlers for vscode-compat API calls from the Worker.
 * Each handler runs in the main process, accessing PPM services directly.
 */
import type { RpcChannel } from "./extension-rpc.ts";
import { contributionRegistry } from "./contribution-registry.ts";

/** Register all vscode-compat RPC handlers on the given RPC channel */
export function registerVscodeCompatHandlers(rpc: RpcChannel): void {
  // --- commands ---
  rpc.onRequest("commands:execute", async (params) => {
    const [command, ...args] = params as [string, ...unknown[]];
    // Try contribution registry commands first (future: route to Worker handler)
    const cmds = contributionRegistry.getCommands();
    const found = cmds.find((c) => c.command === command);
    if (!found) throw new Error(`Command not found: ${command}`);
    // For now, command execution goes back to the Worker (round-trip)
    return { executed: true, command };
  });

  rpc.onRequest("commands:list", async (params) => {
    const [_filterInternal] = params as [boolean];
    return contributionRegistry.getCommands().map((c) => c.command);
  });

  // --- window messages (forwarded to WS clients in Phase 4) ---
  rpc.onRequest("window:showMessage", async (params) => {
    const [level, message, items] = params as [string, string, string[]];
    // Phase 4 will forward to browser via WS. For now, log + return first item.
    console.log(`[Ext:${level}] ${message}`);
    return items.length > 0 ? items[0] : undefined;
  });

  rpc.onRequest("window:showQuickPick", async (params) => {
    const [items, _options] = params as [unknown[], unknown];
    // Phase 4: send to browser, wait for user selection
    console.log("[Ext:quickPick] items:", Array.isArray(items) ? items.length : 0);
    return undefined; // No UI yet
  });

  rpc.onRequest("window:showInputBox", async (params) => {
    const [_options] = params as [unknown];
    console.log("[Ext:inputBox] requested");
    return undefined; // No UI yet
  });

  // --- workspace config ---
  rpc.onRequest("workspace:config:get", async (params) => {
    const [key] = params as [string];
    // Read from PPM config service
    try {
      const { configService } = await import("./config.service.ts");
      const config = configService.getAll() as unknown as Record<string, unknown>;
      return getNestedValue(config, key) ?? null;
    } catch {
      return null;
    }
  });

  rpc.onRequest("workspace:config:update", async (params) => {
    const [key, value, _target] = params as [string, unknown, unknown];
    try {
      const { configService } = await import("./config.service.ts");
      // Only allow extension-scoped config updates (future: dedicated extension config)
      console.log(`[Ext:config] update ${key} = ${JSON.stringify(value)}`);
    } catch {}
    return { ok: true };
  });

  // --- workspace fs ---
  rpc.onRequest("workspace:fs:readFile", async (params) => {
    const [filePath] = params as [string];
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(filePath);
    // Return as base64 for serialization
    return Buffer.from(content).toString("base64");
  });

  rpc.onRequest("workspace:fs:writeFile", async (params) => {
    const [filePath, base64Content] = params as [string, string];
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, Buffer.from(base64Content, "base64"));
    return { ok: true };
  });

  rpc.onRequest("workspace:fs:stat", async (params) => {
    const [filePath] = params as [string];
    const { statSync } = await import("node:fs");
    const stat = statSync(filePath);
    return {
      type: stat.isDirectory() ? 2 : 1, // FileType: File=1, Directory=2
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  });

  rpc.onRequest("workspace:fs:readDirectory", async (params) => {
    const [dirPath] = params as [string];
    const { readdirSync, statSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const entries = readdirSync(dirPath);
    return entries.map((name) => {
      try {
        const full = resolve(dirPath, name);
        const s = statSync(full);
        return [name, s.isDirectory() ? 2 : 1] as [string, number];
      } catch {
        return [name, 0] as [string, number];
      }
    });
  });

  rpc.onRequest("workspace:findFiles", async (params) => {
    const [pattern, maxResults] = params as [string, number];
    // Basic glob implementation using Bun.Glob
    const glob = new Bun.Glob(pattern);
    const results: string[] = [];
    for await (const path of glob.scan({ cwd: "." })) {
      results.push(path);
      if (results.length >= maxResults) break;
    }
    return results;
  });
}

/** Get a nested value from an object by dot-separated key */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
