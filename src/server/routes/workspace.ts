import { Hono } from "hono";
import { getWorkspace, setWorkspace } from "../../services/db.service.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const workspaceRoutes = new Hono<Env>();

/** GET /workspace — load saved workspace layout */
workspaceRoutes.get("/", (c) => {
  try {
    const projectName = c.get("projectName");
    const row = getWorkspace(projectName);
    if (!row) return c.json(ok(null));
    return c.json(ok({
      layout: JSON.parse(row.layout_json),
      updatedAt: row.updated_at,
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PUT /workspace — save workspace layout */
workspaceRoutes.put("/", async (c) => {
  try {
    const projectName = c.get("projectName");
    const body = await c.req.json<{ layout: unknown }>();
    if (!body.layout) return c.json(err("Missing layout"), 400);
    const updatedAt = setWorkspace(projectName, JSON.stringify(body.layout));
    return c.json(ok({ updatedAt }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
