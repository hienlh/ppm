import { Hono } from "hono";
import type { Server, ServerWebSocket } from "bun";
import type { PpmConfig } from "../types/config.ts";
import { ProjectService } from "../services/project.service.ts";
import { FileService } from "../services/file.service.ts";
import { terminalService } from "../services/terminal.service.ts";
import { chatService } from "../services/chat.service.ts";
import { configService } from "../services/config.service.ts";
import { createAuthMiddleware } from "./middleware/auth.ts";
import { createProjectRoutes } from "./routes/projects.ts";
import { createFileRoutes } from "./routes/files.ts";
import { createGitRoutes } from "./routes/git.ts";
import { createStaticRoutes } from "./routes/static.ts";
import { terminalWsHandlers } from "./ws/terminal.ts";
import type { TerminalWsData } from "./ws/terminal.ts";
import { chatWsHandlers } from "./ws/chat.ts";
import type { ChatWsData } from "./ws/chat.ts";

type WsData = TerminalWsData | ChatWsData;

export function startServer(config: PpmConfig): { port: number; stop: () => void } {
  const app = new Hono();
  const projectService = new ProjectService(configService);
  const fileService = new FileService(configService);

  app.use("/api/*", createAuthMiddleware(config));
  app.route("/api/projects", createProjectRoutes(projectService));
  app.route("/api/files", createFileRoutes(fileService));
  app.route("/api/git", createGitRoutes());
  app.route("/", createStaticRoutes());

  const server = Bun.serve<WsData>({
    port: config.port,
    hostname: config.host,

    fetch(req, srv: Server<WsData>) {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/ws/terminal/")) {
        const match = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
        if (match) {
          const sessionId = match[1]!;
          const projectPath = url.searchParams.get("project") ?? process.cwd();
          const ok = srv.upgrade(req, {
            data: {
              kind: "terminal" as const,
              sessionId,
              projectPath,
              terminalService,
            },
          });
          return ok ? undefined : new Response("WS upgrade failed", { status: 500 });
        }
      }

      if (url.pathname.startsWith("/ws/chat/")) {
        const match = url.pathname.match(/^\/ws\/chat\/([^/]+)$/);
        if (match) {
          const sessionId = match[1]!;
          const ok = srv.upgrade(req, {
            data: {
              kind: "chat" as const,
              sessionId,
              chatService,
              pendingApprovals: new Map(),
            },
          });
          return ok ? undefined : new Response("WS upgrade failed", { status: 500 });
        }
      }

      return app.fetch(req);
    },

    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "chat") {
          chatWsHandlers.open(ws as ServerWebSocket<ChatWsData>);
        } else {
          terminalWsHandlers.open(ws as ServerWebSocket<TerminalWsData>);
        }
      },

      message(ws: ServerWebSocket<WsData>, data: string | Buffer) {
        if (ws.data.kind === "chat") {
          void chatWsHandlers.message(ws as ServerWebSocket<ChatWsData>, data);
        } else {
          terminalWsHandlers.message(ws as ServerWebSocket<TerminalWsData>, data);
        }
      },

      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "chat") {
          chatWsHandlers.close(ws as ServerWebSocket<ChatWsData>);
        } else {
          terminalWsHandlers.close(ws as ServerWebSocket<TerminalWsData>);
        }
      },
    },
  });

  return {
    port: server.port ?? config.port,
    stop: () => server.stop(),
  };
}
