import { Hono } from "hono";
import { extensionService } from "../../services/extension.service.ts";
import { contributionRegistry } from "../../services/contribution-registry.ts";
import { ok, err } from "../../types/api.ts";

export const extensionRoutes = new Hono();

// GET /api/extensions — list all extensions
extensionRoutes.get("/", (c) => {
  const extensions = extensionService.list();
  return c.json(ok(extensions));
});

// GET /api/extensions/contributions — all contribution points (for UI)
extensionRoutes.get("/contributions", (c) => {
  return c.json(ok(contributionRegistry.getAll()));
});

// GET /api/extensions/:id — get single extension info
extensionRoutes.get("/:id{.+}", (c) => {
  const id = c.req.param("id");
  const ext = extensionService.get(id);
  if (!ext) return c.json(err("Extension not found"), 404);
  return c.json(ok(ext));
});

// POST /api/extensions/install — install extension
extensionRoutes.post("/install", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  if (!body.name) return c.json(err("Missing 'name' field"), 400);

  try {
    const manifest = await extensionService.install(body.name);
    return c.json(ok(manifest), 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json(err(msg), 500);
  }
});

// DELETE /api/extensions/:id — remove extension
extensionRoutes.delete("/:id{.+}", async (c) => {
  const id = c.req.param("id");
  try {
    await extensionService.remove(id);
    return c.json(ok({ removed: id }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json(err(msg), 500);
  }
});

// PATCH /api/extensions/:id — enable/disable
extensionRoutes.patch("/:id{.+}", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({}) as { enabled?: boolean });
  if (body.enabled === undefined) return c.json(err("Missing 'enabled' field"), 400);

  try {
    await extensionService.setEnabled(id, body.enabled);
    const ext = extensionService.get(id);
    return c.json(ok(ext));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json(err(msg), 500);
  }
});
