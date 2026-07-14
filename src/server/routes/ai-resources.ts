/** REST API for managing AI resources (skills, agents, commands) across scopes. */
import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  listAiResources,
  readResource,
  writeResource,
  createResource,
  deleteResource,
  duplicateResource,
  type CreatableScope,
  type CreatableType,
} from "../../services/ai-resources/index.ts";

export const aiResourcesRoutes = new Hono();

const VALID_TYPES = new Set(["skill", "agent", "command"]);
const VALID_SCOPES = new Set(["project", "user"]);

function requireProject(c: { req: { query: (k: string) => string | undefined } }): string {
  return c.req.query("project") ?? "";
}

aiResourcesRoutes.get("/", (c) => {
  try {
    return c.json(ok(listAiResources(requireProject(c))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

aiResourcesRoutes.get("/content", (c) => {
  const path = c.req.query("path");
  if (!path) return c.json(err("path is required"), 400);
  try {
    return c.json(ok({ content: readResource(path, requireProject(c)) }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

aiResourcesRoutes.put("/content", async (c) => {
  const body = await c.req.json<{ project?: string; path?: string; content?: string }>();
  if (!body.path || typeof body.content !== "string") {
    return c.json(err("path and content are required"), 400);
  }
  try {
    writeResource(body.path, body.content, body.project ?? "");
    return c.json(ok(true));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

aiResourcesRoutes.post("/", async (c) => {
  const body = await c.req.json<{ project?: string; type?: string; scope?: string; name?: string }>();
  if (!body.type || !VALID_TYPES.has(body.type)) return c.json(err("valid type is required"), 400);
  if (!body.scope || !VALID_SCOPES.has(body.scope)) return c.json(err("valid scope is required"), 400);
  if (!body.name) return c.json(err("name is required"), 400);
  try {
    const filePath = createResource(
      body.type as CreatableType,
      body.scope as CreatableScope,
      body.name,
      body.project ?? "",
    );
    return c.json(ok({ filePath }), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

aiResourcesRoutes.post("/duplicate", async (c) => {
  const body = await c.req.json<{ project?: string; path?: string; type?: string; scope?: string; name?: string }>();
  if (!body.path) return c.json(err("path is required"), 400);
  if (!body.type || !VALID_TYPES.has(body.type)) return c.json(err("valid type is required"), 400);
  if (!body.scope || !VALID_SCOPES.has(body.scope)) return c.json(err("valid scope is required"), 400);
  if (!body.name) return c.json(err("name is required"), 400);
  try {
    const filePath = duplicateResource(
      body.path,
      body.type as CreatableType,
      body.scope as CreatableScope,
      body.name,
      body.project ?? "",
    );
    return c.json(ok({ filePath }), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

aiResourcesRoutes.delete("/", async (c) => {
  const body = await c.req.json<{ project?: string; path?: string; type?: string }>();
  if (!body.path) return c.json(err("path is required"), 400);
  if (!body.type || !VALID_TYPES.has(body.type)) return c.json(err("valid type is required"), 400);
  try {
    deleteResource(body.path, body.type as CreatableType, body.project ?? "");
    return c.json(ok(true));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});
