import { Hono } from "hono";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { resolveChatProjectPath } from "../helpers/resolve-chat-project.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import { chatRoutes } from "./chat.ts";
import { tagRoutes } from "./tag-routes.ts";
import { gitRoutes } from "./git.ts";
import { lspRoutes } from "./lsp.ts";
import { fileRoutes } from "./files.ts";
import { workspaceRoutes } from "./workspace.ts";
import { downloadRoutes } from "./file-download.ts";
import { designRoutes } from "./designs.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const projectScopedRouter = new Hono<Env>();

/** True when the request is for the `/chat` sub-router, the only one the Assistant's project reaches. */
function isChatSubRoute(path: string, projectName: string): boolean {
  const segments = path.split("/");
  const at = segments.findIndex((segment) => {
    try { return decodeURIComponent(segment) === projectName; } catch { return false; }
  });
  return at >= 0 && segments[at + 1] === "chat";
}

/** Middleware: resolve :projectName param to absolute project path */
projectScopedRouter.use("*", async (c, next) => {
  const name = c.req.param("projectName");
  if (!name) return c.json({ ok: false, error: "Missing project name" }, 400);
  try {
    // The Assistant's virtual project resolves on the chat routes and nowhere else: no git,
    // file tree, workspace, tags or designs rooted in the PPM dir. Every other route answers
    // it exactly as it answers any unregistered name.
    if (isAssistantProject(name) && !isChatSubRoute(c.req.path, name)) throw new Error(`Project not found: ${name}`);
    const projectPath = isAssistantProject(name) ? resolveChatProjectPath(name) : resolveProjectPath(name);
    c.set("projectPath", projectPath);
    c.set("projectName", name);
    await next();
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 404);
  }
});

projectScopedRouter.route("/chat", chatRoutes);
projectScopedRouter.route("/tags", tagRoutes);
projectScopedRouter.route("/git", gitRoutes);
projectScopedRouter.route("/lsp", lspRoutes);
projectScopedRouter.route("/files", fileRoutes);
projectScopedRouter.route("/workspace", workspaceRoutes);
projectScopedRouter.route("/files/download", downloadRoutes);
projectScopedRouter.route("/designs", designRoutes);
