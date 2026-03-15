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
  daemon?: boolean;
  config?: string;
}) {
  // Load config
  configService.load(options.config);
  const port = parseInt(options.port ?? String(configService.get("port")), 10);
  const host = configService.get("host");

  if (options.daemon) {
    // Daemon mode: spawn detached child process, write PID file
    const { resolve } = await import("node:path");
    const { homedir } = await import("node:os");
    const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");

    const ppmDir = resolve(homedir(), ".ppm");
    if (!existsSync(ppmDir)) mkdirSync(ppmDir, { recursive: true });
    const pidFile = resolve(ppmDir, "ppm.pid");

    const child = Bun.spawn({
      cmd: ["bun", "run", import.meta.dir + "/index.ts", "__serve__", String(port), host, options.config ?? ""],
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });

    // Unref so parent can exit
    child.unref();
    writeFileSync(pidFile, String(child.pid));
    console.log(`PPM daemon started (PID: ${child.pid}) on http://${host}:${port}`);
    console.log(`PID file: ${pidFile}`);
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
        // parts: ["", "ws", "project", projectName, type, id]
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

      // Fall through to Hono for all other requests
      return app.fetch(req, server);
    },
    websocket: {
      idleTimeout: 960, // 16 minutes — keepalive ping handles liveness
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

  console.log(`\n  PPM v0.1.5 ready\n`);
  console.log(`  ➜  Local:   http://localhost:${server.port}/`);

  // List all network interfaces
  const { networkInterfaces } = await import("node:os");
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`  ➜  Network: http://${net.address}:${server.port}/`);
      }
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

  Bun.serve({
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
}
