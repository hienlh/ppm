import { Hono } from "hono";
import {
  getAllConfigs, getConfigByProjectId,
  upsertConfig, deleteConfig, getDecryptedCredentials,
} from "../../services/jira-config.service.ts";
import { getProjects } from "../../services/db.service.ts";
import { testConnection } from "../../services/jira-api-client.ts";
import { ok, err } from "../../types/api.ts";

export const jiraConfigRoutes = new Hono();

/** GET /projects — list projects with integer IDs for frontend selectors */
jiraConfigRoutes.get("/projects", (c) => {
  return c.json(ok(getProjects()));
});

/** GET / — list all configs */
jiraConfigRoutes.get("/", (c) => {
  return c.json(ok(getAllConfigs()));
});

/** GET /:projectId — get config for project */
jiraConfigRoutes.get("/:projectId", (c) => {
  const projectId = parseInt(c.req.param("projectId"), 10);
  if (isNaN(projectId)) return c.json(err("Invalid projectId"), 400);
  const config = getConfigByProjectId(projectId);
  if (!config) return c.json(err("No Jira config for this project"), 404);
  return c.json(ok(config));
});

/** PUT /:projectId — upsert config (token optional on update) */
jiraConfigRoutes.put("/:projectId", async (c) => {
  const projectId = parseInt(c.req.param("projectId"), 10);
  if (isNaN(projectId)) return c.json(err("Invalid projectId"), 400);
  const body = await c.req.json<{ baseUrl?: string; email?: string; token?: string }>();
  if (!body.baseUrl || !body.email) {
    return c.json(err("baseUrl and email are required"), 400);
  }
  if (!body.baseUrl.startsWith("https://")) {
    return c.json(err("baseUrl must start with https://"), 400);
  }
  // Token required for new configs, optional for updates
  const existing = getConfigByProjectId(projectId);
  if (!existing && !body.token) {
    return c.json(err("token is required for new configs"), 400);
  }
  const config = upsertConfig(projectId, body.baseUrl, body.email, body.token);
  return c.json(ok(config));
});

/** DELETE /:projectId — delete config + cascade */
jiraConfigRoutes.delete("/:projectId", (c) => {
  const projectId = parseInt(c.req.param("projectId"), 10);
  if (isNaN(projectId)) return c.json(err("Invalid projectId"), 400);
  const deleted = deleteConfig(projectId);
  if (!deleted) return c.json(err("Config not found"), 404);
  return c.json(ok({ deleted: true }));
});

/** POST /:projectId/test — test Jira connection */
jiraConfigRoutes.post("/:projectId/test", async (c) => {
  const projectId = parseInt(c.req.param("projectId"), 10);
  if (isNaN(projectId)) return c.json(err("Invalid projectId"), 400);
  const config = getConfigByProjectId(projectId);
  if (!config) return c.json(err("No Jira config for this project"), 404);
  const creds = getDecryptedCredentials(config.id);
  if (!creds) return c.json(err("Failed to decrypt credentials"), 500);
  try {
    await testConnection(creds);
    return c.json(ok({ connected: true }));
  } catch (e: any) {
    return c.json(err(`Connection failed: ${e.message}`), 502);
  }
});
