import { Hono } from "hono";
import type { PpmConfig } from "../types/config.ts";
import { ProjectService } from "../services/project.service.ts";
import { configService } from "../services/config.service.ts";
import { createAuthMiddleware } from "./middleware/auth.ts";
import { createProjectRoutes } from "./routes/projects.ts";
import { createStaticRoutes } from "./routes/static.ts";

export function startServer(config: PpmConfig): { port: number; stop: () => void } {
  const app = new Hono();
  const projectService = new ProjectService(configService);

  // Auth middleware for all API routes
  app.use("/api/*", createAuthMiddleware(config));

  // API routes
  app.route("/api/projects", createProjectRoutes(projectService));

  // Static / SPA fallback (non-API routes)
  app.route("/", createStaticRoutes());

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch(req, server) {
      // WebSocket upgrade support
      if (server.upgrade(req)) {
        return undefined;
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "connected", payload: null }));
      },
      message(ws, data) {
        // Forward to Hono or handle directly — placeholder for future use
        ws.send(data);
      },
      close() {},
    },
  });

  return {
    port: server.port ?? config.port,
    stop: () => server.stop(),
  };
}
