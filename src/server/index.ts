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

export const app = new Hono();

// CORS for dev
app.use("*", cors());

// Health check (before auth)
app.get("/api/health", (c) => c.json(ok({ status: "running" })));

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

  const isDaemon = !options.foreground;

  if (isDaemon) {
    const { resolve } = await import("node:path");
    const { homedir } = await import("node:os");
    const { writeFileSync, readFileSync, mkdirSync, existsSync } = await import("node:fs");

    const ppmDir = resolve(homedir(), ".ppm");
    if (!existsSync(ppmDir)) mkdirSync(ppmDir, { recursive: true });
    const pidFile = resolve(ppmDir, "ppm.pid");
    const statusFile = resolve(ppmDir, "status.json");

    // If --share, download cloudflared in parent (shows progress to user)
    if (options.share) {
      const { ensureCloudflared } = await import("../services/cloudflared.service.ts");
      await ensureCloudflared();
    }

    // Spawn child process
    const child = Bun.spawn({
      cmd: [
        process.execPath, "run", import.meta.dir + "/index.ts", "__serve__",
        String(port), host, options.config ?? "", options.share ? "share" : "",
      ],
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    child.unref();
    writeFileSync(pidFile, String(child.pid));

    // Poll for status.json (child writes it when ready)
    const startTime = Date.now();
    let status: { pid: number; port: number; host: string; shareUrl?: string } | null = null;
    while (Date.now() - startTime < 30_000) {
      if (existsSync(statusFile)) {
        try {
          status = JSON.parse(readFileSync(statusFile, "utf-8"));
          break;
        } catch { /* file not fully written yet */ }
      }
      await Bun.sleep(200);
    }

    if (status) {
      console.log(`\n  PPM daemon started (PID: ${status.pid})\n`);
      console.log(`  ➜  Local:   http://localhost:${status.port}/`);
      if (status.shareUrl) {
        console.log(`  ➜  Share:   ${status.shareUrl}`);
        if (!configService.get("auth").enabled) {
          console.log(`\n  ⚠  Warning: auth is disabled — your IDE is publicly accessible!`);
          console.log(`     Enable auth in ~/.ppm/config.yaml or restart without --share.`);
        }
        const qr = await import("qrcode-terminal");
        console.log();
        qr.generate(status.shareUrl, { small: true });
      }
    } else {
      console.log(`\n  PPM daemon started (PID: ${child.pid}) but status not confirmed.`);
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

  console.log(`\n  PPM v0.2.0 ready\n`);
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
  const shareFlag = process.argv[idx + 4] === "share";

  configService.load(configPath);

  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const { writeFileSync, unlinkSync } = await import("node:fs");

  const statusFile = resolve(homedir(), ".ppm", "status.json");
  const pidFile = resolve(homedir(), ".ppm", "ppm.pid");

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

  // Start tunnel if --share was passed (eagerly import so cleanup doesn't race)
  let shareUrl: string | undefined;
  const tunnel = shareFlag
    ? (await import("../services/tunnel.service.ts")).tunnelService
    : null;
  if (tunnel) {
    try {
      shareUrl = await tunnel.startTunnel(port);
    } catch { /* non-fatal: server runs without share URL */ }
  }

  // Write status file for parent to read
  writeFileSync(statusFile, JSON.stringify({ pid: process.pid, port, host, shareUrl }));

  // Cleanup on exit
  const cleanup = () => {
    try { unlinkSync(statusFile); } catch {}
    try { unlinkSync(pidFile); } catch {}
    tunnel?.stopTunnel();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
