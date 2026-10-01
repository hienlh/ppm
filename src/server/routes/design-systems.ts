import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { designFail as fail, designJsonBody as jsonBody, type DesignRouteEnv } from "./design-route-helpers.ts";
import {
  createDesignSystem, deleteDesignSystem, getDesignSystem, listDesignSystems, updateDesignSystem,
} from "../../services/design/design-systems.service.ts";
import { designSystemStaleness } from "../../services/design/design-systems-stale.ts";
import { ensureShowcaseDesign } from "../../services/design/design-systems-showcase.ts";

/**
 * `/api/project/:projectName/designs/systems` — the apps declared for one project, mounted
 * under the design routes so it shares their auth and project-path resolution.
 */
export const designSystemRoutes = new Hono<DesignRouteEnv>();

designSystemRoutes.get("/", async (c) => {
  try {
    return c.json(ok(await listDesignSystems(c.get("projectPath"))));
  } catch (e) {
    return fail(c, e);
  }
});

designSystemRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await createDesignSystem(c.get("projectPath"), body)), 201);
  } catch (e) {
    return fail(c, e);
  }
});

designSystemRoutes.get("/:id", async (c) => {
  try {
    return c.json(ok(await getDesignSystem(c.get("projectPath"), c.req.param("id"))));
  } catch (e) {
    return fail(c, e);
  }
});

designSystemRoutes.patch("/:id", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await updateDesignSystem(c.get("projectPath"), c.req.param("id"), body)));
  } catch (e) {
    return fail(c, e);
  }
});

/** Un-declaring needs `?confirm=<id>`; `&deleteFiles=1` also removes its design-system files. */
designSystemRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (c.req.query("confirm") !== id) return c.json(err("Confirm the removal with ?confirm=<id>"), 400);
  try {
    await deleteDesignSystem(c.get("projectPath"), id, { deleteFiles: c.req.query("deleteFiles") === "1" });
    return c.json(ok({ deleted: id }));
  } catch (e) {
    return fail(c, e);
  }
});

designSystemRoutes.get("/:id/stale", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const system = await getDesignSystem(projectPath, c.req.param("id"));
    return c.json(ok(await designSystemStaleness(projectPath, system)));
  } catch (e) {
    return fail(c, e);
  }
});

/** Get-or-create the app's showcase design, so "Set up design system" always has a tab to open. */
designSystemRoutes.post("/:id/showcase", async (c) => {
  try {
    return c.json(ok(await ensureShowcaseDesign(c.get("projectPath"), c.req.param("id"))));
  } catch (e) {
    return fail(c, e);
  }
});
