import { Hono } from "hono";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { chatRoutes } from "./chat.ts";
import { gitRoutes } from "./git.ts";
import { fileRoutes } from "./files.ts";
import { sqliteRoutes } from "./sqlite.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const projectScopedRouter = new Hono<Env>();

/** Middleware: resolve :projectName param to absolute project path */
projectScopedRouter.use("*", async (c, next) => {
  const name = c.req.param("projectName");
  if (!name) return c.json({ ok: false, error: "Missing project name" }, 400);
  try {
    const projectPath = resolveProjectPath(name);
    c.set("projectPath", projectPath);
    c.set("projectName", name);
    await next();
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 404);
  }
});

projectScopedRouter.route("/chat", chatRoutes);
projectScopedRouter.route("/git", gitRoutes);
projectScopedRouter.route("/files", fileRoutes);
projectScopedRouter.route("/sqlite", sqliteRoutes);
