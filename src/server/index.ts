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
import { initAdapters } from "../services/database/init-adapters.ts";
import { terminalWebSocket } from "./ws/terminal.ts";
import { chatWebSocket } from "./ws/chat.ts";
import { ok, err } from "../types/api.ts";

/** Tee console.log/error to ~/.ppm/ppm.log while preserving terminal output */
async function setupLogFile() {
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const { appendFileSync, mkdirSync, existsSync } = await import("node:fs");

  const ppmDir = resolve(homedir(), ".ppm");
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

  // Capture uncaught errors
  process.on("uncaughtException", (err) => {
    writeLog("FATAL", [`Uncaught exception: ${err.stack ?? err.message}`]);
  });
  process.on("unhandledRejection", (reason) => {
    writeLog("FATAL", [`Unhandled rejection: ${reason}`]);
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

// Auth check endpoint (behind auth middleware)
app.use("/api/*", authMiddleware);
app.get("/api/auth/check", (c) => c.json(ok(true)));

// Filesystem operations (browse, list, read, write) — consolidated in fs-browse route
app.route("/api/fs", fsBrowseRoutes);

// API routes
app.route("/api/settings", settingsRoutes);
app.route("/api/tunnel", tunnelRoutes);
app.route("/api/push", pushRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/project/:projectName", projectScopedRouter);
app.route("/api/postgres", postgresRoutes);
app.route("/api/db", databaseRoutes);
app.route("/api/accounts", accountsRoutes);

// Static files / SPA fallback (non-API routes)
app.route("/", staticRoutes);

export async function startServer(options: {
  port?: string;
  foreground?: boolean;
  daemon?: boolean; // compat, ignored (daemon is now default)
  share?: boolean;
  config?: string;
}) {
  // Load config
  configService.load(options.config);
  const port = parseInt(options.port ?? String(configService.get("port")), 10);
  const host = configService.get("host");

  // Setup log file (both foreground and daemon modes)
  await setupLogFile();

  // Check if port is already in use before starting
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

  const isDaemon = !options.foreground;

  if (isDaemon) {
    const { resolve } = await import("node:path");
    const { homedir } = await import("node:os");
    const { writeFileSync, readFileSync, mkdirSync, existsSync } = await import("node:fs");

    const ppmDir = resolve(homedir(), ".ppm");
    if (!existsSync(ppmDir)) mkdirSync(ppmDir, { recursive: true });
    const pidFile = resolve(ppmDir, "ppm.pid");
    const statusFile = resolve(ppmDir, "status.json");

    // If --share, download cloudflared and start tunnel as independent process
    let shareUrl: string | undefined;
    let tunnelPid: number | undefined;
    if (options.share) {
      const { ensureCloudflared } = await import("../services/cloudflared.service.ts");
      const bin = await ensureCloudflared();

      // Kill any leftover tunnel from previous run
      if (existsSync(statusFile)) {
        try {
          const prev = JSON.parse(readFileSync(statusFile, "utf-8"));
          if (prev.tunnelPid) {
            try { process.kill(prev.tunnelPid); } catch { /* already dead */ }
          }
        } catch {}
      }

      // Spawn new tunnel if no existing one
      if (!shareUrl) {
        console.log("  Starting share tunnel...");
        const { openSync: openFd, writeFileSync: writeFs } = await import("node:fs");
        const tunnelLog = resolve(ppmDir, "tunnel.log");
        // Truncate old log so we only match the new tunnel URL
        writeFs(tunnelLog, "");

        if (process.platform === "win32") {
          // Windows: use PowerShell for detached tunnel process
          const psCmd = [
            `$p = Start-Process -PassThru -WindowStyle Hidden`,
            `-FilePath '${bin.replace(/\\/g, "\\\\")}'`,
            `-ArgumentList 'tunnel','--url','http://localhost:${port}'`,
            `-RedirectStandardError '${tunnelLog.replace(/\\/g, "\\\\")}'`,
            `; Write-Output $p.Id`,
          ].join(" ");
          const result = Bun.spawnSync({
            cmd: ["powershell", "-NoProfile", "-Command", psCmd],
            stdout: "pipe", stderr: "pipe",
          });
          tunnelPid = parseInt(result.stdout.toString().trim(), 10);
          if (isNaN(tunnelPid)) tunnelPid = undefined;
        } else {
          const tfd = openFd(tunnelLog, "a");
          const tunnelProc = Bun.spawn({
            cmd: [bin, "tunnel", "--url", `http://localhost:${port}`],
            stdio: ["ignore", "ignore", tfd],
            env: process.env,
          });
          tunnelProc.unref();
          tunnelPid = tunnelProc.pid;
        }

        // Parse URL from tunnel.log (poll stderr output)
        const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
        const pollStart = Date.now();
        while (Date.now() - pollStart < 30_000) {
          await Bun.sleep(500);
          try {
            const logContent = readFileSync(tunnelLog, "utf-8");
            const match = logContent.match(urlRegex);
            if (match) { shareUrl = match[0]; break; }
          } catch {}
        }
        if (!shareUrl) console.warn("  ⚠  Tunnel started but URL not detected.");
      }
    }

    // Spawn server child process with log file
    const { openSync } = await import("node:fs");
    const logFile = resolve(ppmDir, "ppm.log");
    const logFd = openSync(logFile, "a");
    const { resolve: resolvePath } = await import("node:path");
    const script = resolvePath(import.meta.dir, "index.ts");
    const args = ["__serve__", String(port), host, options.config ?? ""].filter(Boolean);

    let childPid: number;

    if (process.platform === "win32") {
      // Windows: Bun.spawn child may die when parent exits (same job object).
      // Use PowerShell Start-Process to create a truly detached process.
      const bunExe = process.execPath.replace(/\\/g, "\\\\");
      const logEscaped = logFile.replace(/\\/g, "\\\\");
      const errLog = logFile.replace(/\.log$/, ".err.log").replace(/\\/g, "\\\\");
      const argStr = ["run", script, ...args].map((a) => `'${a}'`).join(",");
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
        stdout: "pipe",
        stderr: "pipe",
      });
      childPid = parseInt(result.stdout.toString().trim(), 10);
      if (isNaN(childPid)) {
        console.error("  ✗  Failed to start daemon on Windows.");
        console.error(`     ${result.stderr.toString().trim()}`);
        console.error("     Try: ppm start -f (foreground mode)");
        process.exit(1);
      }
    } else {
      // macOS/Linux: Bun.spawn + unref works fine
      const child = Bun.spawn({
        cmd: [process.execPath, "run", script, ...args],
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
      child.unref();
      childPid = child.pid;
    }

    // Verify daemon is alive after brief startup
    await Bun.sleep(500);
    let alive = false;
    try { process.kill(childPid, 0); alive = true; } catch {}
    if (!alive) {
      console.error("  ✗  Daemon exited immediately after start.");
      console.error("     Check logs: ppm logs");
      console.error("     Or try: ppm start -f (foreground mode)");
      process.exit(1);
    }

    // Write status file with both PIDs
    const status = { pid: childPid, port, host, shareUrl, tunnelPid };
    writeFileSync(statusFile, JSON.stringify(status));
    writeFileSync(pidFile, String(childPid));

    console.log(`  Daemon started (PID: ${childPid})\n`);
    console.log(`  ➜  Local:   http://localhost:${port}/`);
    if (shareUrl) {
      console.log(`  ➜  Share:   ${shareUrl}`);
      if (!configService.get("auth").enabled) {
        console.log(`\n  ⚠  Warning: auth is disabled — your IDE is publicly accessible!`);
        console.log(`     Enable auth in ~/.ppm/config.yaml or restart without --share.`);
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

  // Foreground mode — with WebSocket support
  const server = Bun.serve({
    port,
    hostname: host,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade: /ws/project/:projectName/terminal/:id
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
      perMessageDeflate: false, // Disable compression — Cloudflare tunnels can mangle compressed frames
      open(ws: any) {
        if (ws.data?.type === "health") {
          ws.send(JSON.stringify({ type: "health", status: "ok" }));
        } else if (ws.data?.type === "chat") chatWebSocket.open(ws);
        else terminalWebSocket.open(ws);
      },
      message(ws: any, msg: any) {
        if (ws.data?.type === "health") {
          // Respond to ping with pong
          ws.send(JSON.stringify({ type: "health", status: "ok" }));
        } else if (ws.data?.type === "chat") chatWebSocket.message(ws, msg);
        else terminalWebSocket.message(ws, msg);
      },
      close(ws: any) {
        if (ws.data?.type === "health") return;
        if (ws.data?.type === "chat") chatWebSocket.close(ws);
        else terminalWebSocket.close(ws);
      },
    } as Parameters<typeof Bun.serve>[0] extends { websocket?: infer W } ? W : never,
  });

  // Start background usage polling
  import("../services/claude-usage.service.ts").then(({ startUsagePolling }) => startUsagePolling()).catch(() => {});

  // Start background account token refresh
  import("../services/account.service.ts").then(({ accountService }) => accountService.startAutoRefresh()).catch(() => {});

  console.log(`\n  PPM ready\n`);
  console.log(`  ➜  Local:   http://localhost:${server.port}/`);

  const { networkInterfaces } = await import("node:os");
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`  ➜  Network: http://${net.address}:${server.port}/`);
      }
    }
  }

  // Share tunnel in foreground mode
  if (options.share) {
    try {
      const { tunnelService } = await import("../services/tunnel.service.ts");
      console.log("\n  Starting share tunnel...");
      const shareUrl = await tunnelService.startTunnel(server.port!);
      console.log(`  ➜  Share:   ${shareUrl}`);
      if (!configService.get("auth").enabled) {
        console.log(`\n  ⚠  Warning: auth is disabled — your IDE is publicly accessible!`);
        console.log(`     Enable auth in ~/.ppm/config.yaml or restart without --share.`);
      }
      const qr = await import("qrcode-terminal");
      console.log();
      qr.generate(shareUrl, { small: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗  Share failed: ${msg}`);
    }
  }

  console.log(`\n  Auth: ${configService.get("auth").enabled ? "enabled" : "disabled"}`);
  if (configService.get("auth").enabled) {
    console.log(`  Token: ${configService.get("auth").token}`);
  }
  console.log();

  // Graceful shutdown — stop server + tunnel + DB on exit
  const shutdown = () => {
    try { server.stop(true); } catch {}
    try {
      import("../services/tunnel.service.ts").then(({ tunnelService }) => tunnelService.stopTunnel()).catch(() => {});
    } catch {}
    try {
      import("../services/db.service.ts").then(({ closeDb }) => closeDb()).catch(() => {});
    } catch {}
  };
  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });
  process.on("exit", shutdown);
}

// Internal entry point for daemon child process
if (process.argv.includes("__serve__")) {
  const idx = process.argv.indexOf("__serve__");
  const port = parseInt(process.argv[idx + 1] ?? "8080", 10);
  const host = process.argv[idx + 2] ?? "0.0.0.0";
  const configPath = process.argv[idx + 3] || undefined;

  // Set DB profile for daemon child (detect "dev" from config path)
  const { setDbProfile } = await import("../services/db.service.ts");
  if (configPath && /dev/i.test(configPath)) {
    setDbProfile("dev");
  }

  configService.load(configPath);
  await setupLogFile();

  // Sync externally-started tunnel URL (from `ppm start --share`) into tunnelService
  // so GET /api/tunnel reflects the correct state and Share button doesn't start a duplicate.
  try {
    const { resolve: r } = await import("node:path");
    const { homedir: h } = await import("node:os");
    const { readFileSync: rf } = await import("node:fs");
    const statusFile = r(h(), ".ppm", "status.json");
    const status = JSON.parse(rf(statusFile, "utf-8"));
    if (status.shareUrl) {
      const { tunnelService } = await import("../services/tunnel.service.ts");
      tunnelService.setExternalUrl(status.shareUrl);
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

  console.log(`Server child ready on port ${port}`);
}
