/**
 * Main-side RPC handlers for vscode-compat API calls from the Worker.
 * Each handler runs in the main process, accessing PPM services directly.
 * UI-facing calls are forwarded to browser clients via the WS bridge.
 */
import type { RpcChannel } from "./extension-rpc.ts";
import { contributionRegistry } from "./contribution-registry.ts";
import { broadcastExtMsg, requestFromBrowser } from "../server/ws/extensions.ts";

let requestIdCounter = 0;
function nextRequestId(): string {
  return `req_${++requestIdCounter}_${Date.now()}`;
}

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

  // --- window messages (forwarded to browser via WS bridge) ---
  rpc.onRequest("window:showMessage", async (params) => {
    const [level, message, items] = params as [string, string, string[]];
    console.log(`[Ext:${level}] ${message}`);
    if (items.length > 0) {
      const requestId = nextRequestId();
      const action = await requestFromBrowser<string | null>(
        { type: "notification", id: requestId, level: level as "info" | "warn" | "error", message, actions: items },
        requestId,
      );
      return action ?? undefined;
    }
    // No action items — just broadcast notification
    broadcastExtMsg({ type: "notification", id: nextRequestId(), level: level as "info" | "warn" | "error", message });
    return undefined;
  });

  rpc.onRequest("window:showQuickPick", async (params) => {
    const [items, options] = params as [unknown[], unknown];
    const requestId = nextRequestId();
    const selected = await requestFromBrowser<unknown[] | null>(
      {
        type: "quickpick:show", requestId,
        items: items as { label: string; description?: string; detail?: string; picked?: boolean }[],
        options: (options ?? {}) as { placeholder?: string; canPickMany?: boolean },
      },
      requestId,
    );
    return selected;
  });

  rpc.onRequest("window:showInputBox", async (params) => {
    const [options] = params as [unknown];
    const requestId = nextRequestId();
    const value = await requestFromBrowser<string | null>(
      {
        type: "inputbox:show", requestId,
        options: (options ?? {}) as { prompt?: string; value?: string; placeholder?: string; password?: boolean },
      },
      requestId,
    );
    return value;
  });

  // --- status bar (forwarded to browser via WS bridge) ---
  rpc.onRequest("window:statusbar:update", async (params) => {
    const [item] = params as [{ id: string; text: string; tooltip?: string; command?: string; alignment: "left" | "right"; priority: number; extensionId?: string }];
    broadcastExtMsg({ type: "statusbar:update", item });
    return { ok: true };
  });

  rpc.onRequest("window:statusbar:remove", async (params) => {
    const [itemId] = params as [string];
    broadcastExtMsg({ type: "statusbar:remove", itemId });
    return { ok: true };
  });

  // --- webview panels (forwarded to browser via WS bridge) ---
  rpc.onRequest("window:webview:create", async (params) => {
    const [panelId, extensionId, viewType, title] = params as [string, string, string, string];
    broadcastExtMsg({ type: "webview:create", panelId, extensionId, viewType, title });
    return { ok: true };
  });

  rpc.onRequest("window:webview:html", async (params) => {
    const [panelId, html] = params as [string, string];
    broadcastExtMsg({ type: "webview:html", panelId, html });
    return { ok: true };
  });

  rpc.onRequest("window:webview:dispose", async (params) => {
    const [panelId] = params as [string];
    broadcastExtMsg({ type: "webview:dispose", panelId });
    return { ok: true };
  });

  rpc.onRequest("window:webview:postMessage", async (params) => {
    const [panelId, message] = params as [string, unknown];
    broadcastExtMsg({ type: "webview:postMessage", panelId, message });
    return { ok: true };
  });

  // --- open PPM tab (generic, any extension can use) ---
  rpc.onRequest("window:openTab", async (params) => {
    const [tabType, title, projectId, metadata] = params as [
      string, string, string | null, Record<string, unknown> | undefined,
    ];
    broadcastExtMsg({ type: "tab:open", tabType, title, projectId, closable: true, metadata });
    return { ok: true };
  });

  // --- switch PPM project ---
  rpc.onRequest("window:switchProject", async (params) => {
    const [projectName] = params as [string];
    broadcastExtMsg({ type: "project:switch", projectName });
    return { ok: true };
  });

  // --- tree views (forwarded to browser via WS bridge) ---
  rpc.onRequest("window:tree:update", async (params) => {
    const [viewId, items] = params as [string, unknown[]];
    broadcastExtMsg({ type: "tree:update", viewId, items: items as any });
    return { ok: true };
  });

  rpc.onRequest("window:tree:refresh", async (params) => {
    const [viewId] = params as [string];
    broadcastExtMsg({ type: "tree:refresh", viewId });
    return { ok: true };
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
      configService.set(key as any, value);
    } catch (e) {
      console.error(`[Ext:config] update error for ${key}:`, e);
    }
    return { ok: true };
  });

  // --- workspace fs (path-restricted) ---

  /** Validate path is within allowed roots. Throws if path escapes. */
  async function assertSafePath(filePath: string): Promise<string> {
    const { resolve, relative } = await import("node:path");
    const resolved = resolve(filePath);
    // Allow: CWD, ~/.ppm/extensions/, and all registered project paths
    const { getPpmDir } = await import("./ppm-dir.ts");
    const { configService } = await import("./config.service.ts");
    const projectPaths = configService.get("projects").map((p: { path: string }) => resolve(p.path));
    const allowedRoots = [resolve(process.cwd()), resolve(getPpmDir(), "extensions"), ...projectPaths];
    const isSafe = allowedRoots.some((root) => {
      const rel = relative(root, resolved);
      return !rel.startsWith("..") && !rel.startsWith("/");
    });
    if (!isSafe) throw new Error(`Path outside allowed scope: ${filePath}`);
    return resolved;
  }

  rpc.onRequest("workspace:fs:readFile", async (params) => {
    const [filePath] = params as [string];
    const safePath = await assertSafePath(filePath);
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(safePath);
    return Buffer.from(content).toString("base64");
  });

  rpc.onRequest("workspace:fs:writeFile", async (params) => {
    const [filePath, base64Content] = params as [string, string];
    const safePath = await assertSafePath(filePath);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(safePath, Buffer.from(base64Content, "base64"));
    return { ok: true };
  });

  rpc.onRequest("workspace:fs:stat", async (params) => {
    const [filePath] = params as [string];
    const safePath = await assertSafePath(filePath);
    const { statSync } = await import("node:fs");
    const stat = statSync(safePath);
    return {
      type: stat.isDirectory() ? 2 : 1,
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  });

  rpc.onRequest("workspace:fs:readDirectory", async (params) => {
    const [dirPath] = params as [string];
    const safePath = await assertSafePath(dirPath);
    const { readdirSync, statSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const entries = readdirSync(safePath);
    return entries.map((name) => {
      try {
        const full = resolve(safePath, name);
        const s = statSync(full);
        return [name, s.isDirectory() ? 2 : 1] as [string, number];
      } catch {
        return [name, 0] as [string, number];
      }
    });
  });

  rpc.onRequest("workspace:findFiles", async (params) => {
    const [pattern, maxResults] = params as [string, number];
    const glob = new Bun.Glob(pattern);
    const results: string[] = [];
    for await (const path of glob.scan({ cwd: process.cwd() })) {
      results.push(path);
      if (results.length >= maxResults) break;
    }
    return results;
  });

  // --- process spawn (for extensions needing subprocess access) ---

  const ALLOWED_SPAWN_COMMANDS = new Set(["git", "node", "bun", "npx", "sqlite3"]);
  const BLOCKED_ENV_KEYS = new Set(["PATH", "HOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "LD_LIBRARY_PATH"]);

  rpc.onRequest("process:spawn", async (params) => {
    const [cmd, args, cwd, options] = params as [string, string[], string, { timeout?: number; env?: Record<string, string> }?];

    // Security: command allowlist
    const baseName = cmd.split("/").pop() || cmd;
    if (!ALLOWED_SPAWN_COMMANDS.has(baseName)) {
      throw new Error(`process:spawn: command "${cmd}" not allowed. Allowed: ${[...ALLOWED_SPAWN_COMMANDS].join(", ")}`);
    }

    // Security: CWD must be within allowed roots
    const safeCwd = await assertSafePath(cwd);

    // Security: block dangerous env overrides
    const safeEnv = { ...process.env };
    if (options?.env) {
      for (const [key, val] of Object.entries(options.env)) {
        if (!BLOCKED_ENV_KEYS.has(key)) safeEnv[key] = val;
      }
    }

    const timeout = options?.timeout ?? 30_000;
    const proc = Bun.spawn([cmd, ...args], {
      cwd: safeCwd,
      stdout: "pipe",
      stderr: "pipe",
      env: safeEnv,
    });

    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      return { stdout, stderr, exitCode };
    } catch (e) {
      clearTimeout(timer);
      throw new Error(`process:spawn failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
