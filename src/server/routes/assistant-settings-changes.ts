import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { getAssistantSettings } from "../../services/assistant/assistant-settings.service.ts";
import { listSettingChanges } from "../../services/assistant-settings-tools/settings-change-log.ts";
import { undoBlockFor, undoSettingChange } from "../../services/assistant-settings-tools/settings-apply.ts";
import type { SettingChangesList, SettingChangeView } from "../../shared/assistant-settings-changes.ts";

/**
 * `/api/assistant/settings-changes`: Settings → PPM Assistant → Changes. The list of settings the
 * Assistant changed, and Undo — the user's own press, so no card: it goes through the same pane
 * routes the tool used, compare-and-set like every write (a value changed since is left alone).
 * Behind PPM's login like the rest of `/api/assistant`.
 */
export const assistantSettingsChangesRoutes = new Hono();

assistantSettingsChangesRoutes.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 200);
  const rows = listSettingChanges({ limit: Number.isInteger(limit) ? limit : 200 });
  const changes: SettingChangeView[] = await Promise.all(rows.map(async (row) => ({ ...row, undo: await undoBlockFor(row).catch(() => null) })));
  const body: SettingChangesList = { enabled: getAssistantSettings().settings_tools === true, changes };
  return c.json(ok(body));
});

assistantSettingsChangesRoutes.post("/:id/undo", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json(err("Unknown change"), 404);
  // Loaded here, not at the top: the family dispatcher reaches every tool family's handlers.
  const { routeCallerFor } = await import("../../services/assistant-mcp/assistant-tool-family.ts");
  const out = await undoSettingChange(id, { callRoute: routeCallerFor("settings"), approval: "user", origin: "ppm", sessionId: null });
  if (!out.ok) return c.json(err(out.error), out.block ? 409 : 404);
  return c.json(ok({ change: out.row, undone: out.undone }));
});
