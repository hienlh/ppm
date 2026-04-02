import { Hono } from "hono";
import { cors } from "hono/cors";
import { configService } from "../services/config.service.ts";
import { VERSION } from "../version.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { projectRoutes } from "./routes/projects.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { pushRoutes } from "./routes/push.ts";
import { tunnelRoutes } from "./routes/tunnel.ts";
import { staticRoutes } from "./routes/static.ts";
import { projectScopedRouter } from "./routes/project-scoped.ts";
import { postgresRoutes } from "./routes/postgres.ts";
import { databaseRoutes } from "./routes/database.ts";
import { fsBrowseRoutes } from "./routes/fs-browse.ts";
import { accountsRoutes } from "./routes/accounts.ts";
import { proxyRoutes } from "./routes/proxy.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { browserPreviewRoutes } from "./routes/browser-preview.ts";
import { initAdapters } from "../services/database/init-adapters.ts";
import { terminalWebSocket } from "./ws/terminal.ts";
import { chatWebSocket } from "./ws/chat.ts";
import { ok, err } from "../types/api.ts";

/** Tee console.log/error to ~/.ppm/ppm.log while preserving terminal output */
async function setupLogFile() {
  // Guard: prevent re-wrapping console on hot-reload (bun --hot re-executes the module)
  if ((globalThis as any).__PPM_LOG_SETUP__) return;
  (globalThis as any).__PPM_LOG_SETUP__ = true;

  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const { appendFileSync, mkdirSync, existsSync } = await import("node:fs");

  const ppmDir = process.env.PPM_HOME || resolve(homedir(), ".ppm");
  if (!existsSync(ppmDir)) mkdirSync(ppmDir, { recursive: true });
  const logPath = resolve(ppmDir, "ppm.log");

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  /** Redact tokens, passwords, API keys, and other sensitive values from log output */
  const redact = (text: string): string =>
    text
      .replace(/Token:\s*\S+/gi, "Token: [REDACTED]")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/password['":\s]+\S+/gi, "password: [REDACTED]")
      .replace(/api[_-]?key['":\s]+\S+/gi, "api_key: [REDACTED]")
      .replace(/ANTHROPIC_API_KEY=\S+/gi, "ANTHROPIC_API_KEY=[REDACTED]")
      .replace(/secret['":\s]+\S+/gi, "secret: [REDACTED]");

  const writeLog = (level: string, args: unknown[]) => {
    const ts = new Date().toISOString();
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    try { appendFileSync(logPath, `[${ts}] [${level}] ${redact(msg)}\n`); } catch {}
  };

  console.log = (...args: unknown[]) => { origLog(...args); writeLog("INFO", args); };
  console.error = (...args: unknown[]) => { origError(...args); writeLog("ERROR", args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); writeLog("WARN", args); };

  // Capture uncaught errors — count-based exit for supervisor restart
  let exceptionCount = 0;
  let lastExceptionTime = 0;

  const handleFatalError = (label: string, detail: string) => {
    writeLog("FATAL", [`${label}: ${detail}`]);
    const now = Date.now();
    if (now - lastExceptionTime < 60_000) exceptionCount++;
    else exceptionCount = 1;
    lastExceptionTime = now;

    // 3+ fatal errors in 1 minute → exit and let supervisor restart fresh
    if (exceptionCount >= 3) {
      writeLog("FATAL", ["Too many errors in 1 min, exiting for supervisor restart"]);
      process.exit(1);
    }
  };

  process.on("uncaughtException", (err) => {
    handleFatalError("Uncaught exception", err.stack ?? err.message);
  });
  process.on("unhandledRejection", (reason) => {
    handleFatalError("Unhandled rejection", String(reason));
  });
}

// Register database adapters at module load time
initAdapters();

export const app = new Hono();

// CORS for dev
app.use("*", cors());

// Public endpoints (before auth)
app.get("/api/health", (c) => c.json(ok({ status: "running" })));
app.get("/api/info", (c) => c.json(ok({
  version: VERSION,
  device_name: configService.get("device_name") || null,
})));

// Public: recent logs for bug reports (last 30 lines)
app.get("/api/logs/recent", async (c) => {
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const { existsSync, readFileSync } = await import("node:fs");
  const logFile = resolve(homedir(), ".ppm", "ppm.log");
  if (!existsSync(logFile)) return c.json(ok({ logs: "" }));
  const content = readFileSync(logFile, "utf-8");
  const lines = content.split("\n").slice(-30).join("\n").trim();
  // Double-redact in case old logs have unredacted content
  const redacted = lines
    .replace(/Token:\s*\S+/gi, "Token: [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/password['":\s]+\S+/gi, "password: [REDACTED]")
    .replace(/api[_-]?key['":\s]+\S+/gi, "api_key: [REDACTED]")
    .replace(/ANTHROPIC_API_KEY=\S+/gi, "ANTHROPIC_API_KEY=[REDACTED]")
    .replace(/secret['":\s]+\S+/gi, "secret: [REDACTED]");
  return c.json(ok({ logs: redacted }));
});

// Dev-only: crash endpoint for testing health check UI
if (process.env.NODE_ENV !== "production") {
  app.get("/api/debug/crash", () => { process.exit(1); });
}

// Proxy routes — before auth middleware (uses own auth key)
app.route("/proxy", proxyRoutes);

// Auth check endpoint (behind auth middleware)
app.use("/api/*", authMiddleware);
app.get("/api/auth/check", (c) => c.json(ok(true)));

// Browser preview reverse proxy — proxies to localhost:<port> for iframe embedding
app.route("/api/preview", browserPreviewRoutes);

// Filesystem operations (browse, list, read, write) — consolidated in fs-browse route
app.route("/api/fs", fsBrowseRoutes);

// API routes
app.route("/api/settings", settingsRoutes);
app.route("/api/settings/mcp", mcpRoutes);
app.route("/api/tunnel", tunnelRoutes);
app.route("/api/push", pushRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/project/:projectName", projectScopedRouter);
app.route("/api/postgres", postgresRoutes);
app.route("/api/db", databaseRoutes);
app.route("/api/accounts", accountsRoutes);

// Extensions management
import { extensionRoutes } from "./routes/extensions.ts";
app.route("/api/extensions", extensionRoutes);

// Upgrade routes (check for updates, apply upgrade)
import { upgradeRoutes } from "./routes/upgrade.ts";
app.route("/api/upgrade", upgradeRoutes);

// Cloud device registry
import { cloudRoutes } from "./routes/cloud.ts";
app.route("/api/cloud", cloudRoutes);

// Static files / SPA fallback (non-API routes)
app.route("/", staticRoutes);

export async function startServer(options: {
  port?: string;
  share?: boolean;
  config?: string;
  profile?: string;
}) {
  // Tunnel always enabled — cloudflared shares the server publicly
  options.share = true;

  // Load config
  configService.load(options.config);
  const port = parseInt(options.port ?? String(configService.get("port")), 10);
  const host = configService.get("host");

  await setupLogFile();

  // Bootstrap CLI providers (checks binary availability)
  const { bootstrapProviders } = await import("../providers/registry.ts");
  await bootstrapProviders();

  // Check if port is already in use before spawning supervisor
  const portInUse = await new Promise<boolean>((resolve) => {
    const net = require("node:net") as typeof import("node:net");
    const tester = net.createServer()
      .once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "EADDRINUSE");
      })
      .once("listening", () => {
        tester.close(() => resolve(false));
      })
      .listen(port, host);
  });
  if (portInUse) {
    console.error(`\n  ✗  Port ${port} is already in use.`);
    console.error(`     Run 'ppm stop' first or use a different port with --port.\n`);
    process.exit(1);
  }

  {
    const { resolve } = await import("node:path");
    const { homedir } = await import("node:os");
    const { writeFileSync, readFileSync, mkdirSync, existsSync, openSync } = await import("node:fs");
    const { isCompiledBinary } = await import("../services/autostart-generator.ts");

    const ppmDir = process.env.PPM_HOME || resolve(homedir(), ".ppm");
    if (!existsSync(ppmDir)) mkdirSync(ppmDir, { recursive: true });
    const pidFile = resolve(ppmDir, "ppm.pid");
    const statusFile = resolve(ppmDir, "status.json");

    // Kill any leftover processes from previous run
    if (existsSync(statusFile)) {
      try {
        const prev = JSON.parse(readFileSync(statusFile, "utf-8"));
        if (prev.supervisorPid) { try { process.kill(prev.supervisorPid); } catch {} }
        else if (prev.pid) { try { process.kill(prev.pid); } catch {} }
        if (prev.tunnelPid) { try { process.kill(prev.tunnelPid); } catch {} }
      } catch {}
    }

    // Pre-download cloudflared if --share (so supervisor doesn't need to)
    if (options.share) {
      console.log("  Ensuring cloudflared is available...");
      const { ensureCloudflared } = await import("../services/cloudflared.service.ts");
      await ensureCloudflared();
    }

    // Spawn supervisor process (manages server + tunnel children)
    const isCompiledBin = isCompiledBinary();
    const logFile = resolve(ppmDir, "ppm.log");
    const logFd = openSync(logFile, "a");
    const supervisorScript = resolve(import.meta.dir, "..", "services", "supervisor.ts");

    const superviseArgs = [
      "__supervise__", String(port), host,
      options.config ?? "", options.profile ?? "",
    ];
    if (options.share) superviseArgs.push("--share");
    // Strip trailing empty args (before --share flag)
    while (superviseArgs.length > 1 && superviseArgs[superviseArgs.length - 1] === "") superviseArgs.pop();

    let supervisorPid: number;

    if (process.platform === "win32") {
      const bunExe = process.execPath.replace(/\\/g, "\\\\");
      const logEscaped = logFile.replace(/\\/g, "\\\\");
      const errLog = logFile.replace(/\.log$/, ".err.log").replace(/\\/g, "\\\\");
      const winArgs = isCompiledBin ? superviseArgs : ["run", supervisorScript, ...superviseArgs];
      const argStr = winArgs.map((a) => `'${a || "_"}'`).join(",");
      const psCmd = [
        `$p = Start-Process -PassThru -WindowStyle Hidden`,
        `-FilePath '${bunExe}'`,
        `-ArgumentList ${argStr}`,
        `-RedirectStandardOutput '${logEscaped}'`,
        `-RedirectStandardError '${errLog}'`,
        `; Write-Output $p.Id`,
      ].join(" ");
      const result = Bun.spawnSync({
        cmd: ["powershell", "-NoProfile", "-Command", psCmd],
        stdout: "pipe", stderr: "pipe",
      });
      supervisorPid = parseInt(result.stdout.toString().trim(), 10);
      if (isNaN(supervisorPid)) {
        console.error("  ✗  Failed to start supervisor on Windows.");
        console.error(`     ${result.stderr.toString().trim()}`);
        process.exit(1);
      }
    } else {
      const cmd = isCompiledBin
        ? [process.execPath, ...superviseArgs]
        : [process.execPath, "run", supervisorScript, ...superviseArgs];
      const child = Bun.spawn({
        cmd,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
      child.unref();
      supervisorPid = child.pid;
    }

    // Wait for supervisor to start server child (poll status.json for pid)
    const startWait = Date.now();
    let serverPid: number | null = null;
    while (Date.now() - startWait < 10_000) {
      await Bun.sleep(500);
      // Check supervisor is still alive
      try { process.kill(supervisorPid, 0); } catch {
        console.error("  ✗  Supervisor exited immediately after start.");
        console.error("     Check logs: ppm logs");
        process.exit(1);
      }
      // Check if server PID appeared in status.json
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        if (data.pid && data.supervisorPid) {
          serverPid = data.pid;
          break;
        }
      } catch {}
    }

    if (!serverPid) {
      console.error("  ✗  Server did not start within 10 seconds.");
      console.error("     Check logs: ppm logs");
      try { process.kill(supervisorPid); } catch {}
      process.exit(1);
    }

    // Read final status for share URL
    let shareUrl: string | null = null;
    if (options.share) {
      // Give tunnel a bit more time to establish
      const tunnelWait = Date.now();
      while (Date.now() - tunnelWait < 35_000) {
        await Bun.sleep(500);
        try {
          const data = JSON.parse(readFileSync(statusFile, "utf-8"));
          if (data.shareUrl) { shareUrl = data.shareUrl; break; }
        } catch {}
      }
      if (!shareUrl) console.warn("  ⚠  Tunnel started but URL not detected yet. Check: ppm status");
    }

    console.log(`  Supervisor started (PID: ${supervisorPid}, server PID: ${serverPid})\n`);
    console.log(`  ➜  Local:   http://localhost:${port}/`);
    if (shareUrl) {
      console.log(`  ➜  Share:   ${shareUrl}`);
      if (!configService.get("auth").enabled) {
        console.log(`\n  ⚠  Warning: auth is disabled — your IDE is publicly accessible!`);
        console.log(`     Enable auth: run 'ppm config set auth.enabled true' or restart without --share.`);
      }
      const qr = await import("qrcode-terminal");
      console.log();
      qr.generate(shareUrl, { small: true });
    }

    console.log(`  Commands:`);
    console.log(`    ppm restart   Reload config (keeps tunnel URL)`);
    console.log(`    ppm stop      Stop server & tunnel`);
    console.log(`    ppm logs -f   Follow server logs`);
    console.log();

    process.exit(0);
  }
}

// Internal entry point for daemon child process
if (process.argv.includes("__serve__")) {
  const idx = process.argv.indexOf("__serve__");
  const port = parseInt(process.argv[idx + 1] ?? "8080", 10);
  const host = process.argv[idx + 2] ?? "0.0.0.0";
  const configPath = process.argv[idx + 3] && process.argv[idx + 3] !== "_" ? process.argv[idx + 3] : undefined;
  const profileArg = process.argv[idx + 4] && process.argv[idx + 4] !== "_" ? process.argv[idx + 4] : undefined;

  // Set DB profile for daemon child — explicit --profile takes priority over config-path detection
  const { setDbProfile } = await import("../services/db.service.ts");
  if (profileArg) {
    setDbProfile(profileArg);
  } else if (configPath && /dev/i.test(configPath)) {
    setDbProfile("dev");
  }

  configService.load(configPath);
  await setupLogFile();

  // Sync externally-started tunnel URL + PID into tunnelService
  // so GET /api/tunnel reflects the correct state and Share button doesn't start a duplicate.
  // Also write server version to status.json so supervisor heartbeat reports the actual running version.
  try {
    const { resolve: r } = await import("node:path");
    const { homedir: h } = await import("node:os");
    const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
    const statusFile = r(h(), ".ppm", "status.json");
    const status = JSON.parse(rf(statusFile, "utf-8"));
    // Write running server version — source of truth for heartbeat
    status.serverVersion = VERSION;
    wf(statusFile, JSON.stringify(status));
    if (status.shareUrl) {
      const { tunnelService } = await import("../services/tunnel.service.ts");
      tunnelService.setExternalUrl(status.shareUrl);
      if (status.tunnelPid) tunnelService.setExternalPid(status.tunnelPid);
    }
  } catch { /* status.json missing or no shareUrl — normal */ }

  Bun.serve({
    port,
    hostname: host,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws/health") {
        const upgraded = server.upgrade(req, { data: { type: "health" } });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/ws/project/")) {
        const parts = url.pathname.split("/");
        const projectName = parts[3] ?? "";
        const wsType = parts[4] ?? "";
        const id = parts[5] ?? "";

        if (wsType === "terminal") {
          const upgraded = server.upgrade(req, {
            data: { type: "terminal", id, projectName },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (wsType === "chat") {
          const sessionId = id;
          const upgraded = server.upgrade(req, {
            data: { type: "chat", sessionId, projectName },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
      }

      return app.fetch(req, server);
    },
    websocket: {
      idleTimeout: 960,
      sendPong: true,
      perMessageDeflate: false,
      open(ws: any) {
        if (ws.data?.type === "chat") chatWebSocket.open(ws);
        else terminalWebSocket.open(ws);
      },
      message(ws: any, msg: any) {
        if (ws.data?.type === "chat") chatWebSocket.message(ws, msg);
        else terminalWebSocket.message(ws, msg);
      },
      close(ws: any) {
        if (ws.data?.type === "chat") chatWebSocket.close(ws);
        else terminalWebSocket.close(ws);
      },
    } as Parameters<typeof Bun.serve>[0] extends { websocket?: infer W } ? W : never,
  });

  // Start background account token refresh in daemon child
  import("../services/account.service.ts").then(({ accountService }) => accountService.startAutoRefresh()).catch(() => {});

  // Start background usage limit polling (every 5 min)
  import("../services/claude-usage.service.ts").then(({ startUsagePolling }) => startUsagePolling()).catch(() => {});

  // Discover + activate enabled extensions
  import("../services/extension.service.ts").then(({ extensionService }) => extensionService.startup()).catch((e) => {
    console.error("[ExtService] Startup error:", e);
  });

  console.log(`Server child ready on port ${port}`);
}
