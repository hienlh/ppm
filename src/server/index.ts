import { Hono } from "hono";
import { cors } from "hono/cors";
import { configService } from "../services/config.service.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { projectRoutes } from "./routes/projects.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { staticRoutes } from "./routes/static.ts";
import { projectScopedRouter } from "./routes/project-scoped.ts";
import { terminalWebSocket } from "./ws/terminal.ts";
import { chatWebSocket } from "./ws/chat.ts";
import { ok } from "../types/api.ts";

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

export const app = new Hono();

// CORS for dev
app.use("*", cors());

// Public endpoints (before auth)
app.get("/api/health", (c) => c.json(ok({ status: "running" })));
app.get("/api/info", (c) => c.json(ok({
  version: "0.2.2",
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

// API routes
app.route("/api/settings", settingsRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/project/:projectName", projectScopedRouter);

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

      // Check if tunnel already running (reuse from previous server crash)
      if (existsSync(statusFile)) {
        try {
          const prev = JSON.parse(readFileSync(statusFile, "utf-8"));
          if (prev.tunnelPid && prev.shareUrl) {
            try {
              process.kill(prev.tunnelPid, 0); // Check alive
              console.log(`  Reusing existing tunnel (PID: ${prev.tunnelPid})`);
              shareUrl = prev.shareUrl;
              tunnelPid = prev.tunnelPid;
            } catch { /* tunnel dead, spawn new one */ }
          }
        } catch {}
      }

      // Spawn new tunnel if no existing one
      if (!shareUrl) {
        console.log("  Starting share tunnel...");
        const { openSync: openFd } = await import("node:fs");
        const tunnelLog = resolve(ppmDir, "tunnel.log");
        const tfd = openFd(tunnelLog, "a");
        const tunnelProc = Bun.spawn({
          cmd: [bin, "tunnel", "--url", `http://localhost:${port}`],
          stdio: ["ignore", "ignore", tfd],
          env: process.env,
        });
        tunnelProc.unref();
        tunnelPid = tunnelProc.pid;

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
    const child = Bun.spawn({
      cmd: [
        process.execPath, "run", import.meta.dir + "/index.ts", "__serve__",
        String(port), host, options.config ?? "",
      ],
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();

    // Write status file with both PIDs
    const status = { pid: child.pid, port, host, shareUrl, tunnelPid };
    writeFileSync(statusFile, JSON.stringify(status));
    writeFileSync(pidFile, String(child.pid));

    console.log(`\n  PPM v0.2.2 daemon started (PID: ${child.pid})\n`);
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

  console.log(`\n  PPM v0.2.2 ready\n`);
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
      const shareUrl = await tunnelService.startTunnel(server.port);
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
}

// Internal entry point for daemon child process
if (process.argv.includes("__serve__")) {
  const idx = process.argv.indexOf("__serve__");
  const port = parseInt(process.argv[idx + 1] ?? "8080", 10);
  const host = process.argv[idx + 2] ?? "0.0.0.0";
  const configPath = process.argv[idx + 3] || undefined;

  configService.load(configPath);
  await setupLogFile();

  Bun.serve({
    port,
    hostname: host,
    fetch(req, server) {
      const url = new URL(req.url);

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

  console.log(`Server child ready on port ${port}`);
}
