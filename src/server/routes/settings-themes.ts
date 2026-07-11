import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { importThemes, type ImportSource } from "../../services/theme-import/import-service.ts";
import { listThemes, deleteTheme, renameTheme } from "../../services/theme-import/theme-repo.ts";
import { sanitizeName } from "../../services/theme-import/validate-theme.ts";

/** Imported-theme management. Mounted under /api/settings/themes (same auth as other settings routes). */
export const settingsThemesRoutes = new Hono();

const VALID_SOURCES: ImportSource[] = ["json", "url", "vsix", "upload"];

/** GET /api/settings/themes — list imported themes */
settingsThemesRoutes.get("/", (c) => {
  return c.json(ok(listThemes()));
});

/** POST /api/settings/themes — import from json/url/vsix/upload */
settingsThemesRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json<{ source?: string; value?: string; name?: string }>();
    if (!body.source || !VALID_SOURCES.includes(body.source as ImportSource)) {
      return c.json(err("source must be one of: json, url, vsix, upload"), 400);
    }
    if (typeof body.value !== "string" || body.value.length === 0) {
      return c.json(err("value is required"), 400);
    }
    const themes = await importThemes({
      source: body.source as ImportSource,
      value: body.value,
      name: body.name,
    });
    return c.json(ok({ themes }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** DELETE /api/settings/themes/:id — remove an imported theme */
settingsThemesRoutes.delete("/:id", (c) => {
  const id = c.req.param("id");
  if (!id.startsWith("custom-")) return c.json(err("Cannot delete a built-in theme"), 400);
  const removed = deleteTheme(id);
  if (!removed) return c.json(err("Theme not found"), 404);
  return c.json(ok({ deleted: id }));
});

/** PATCH /api/settings/themes/:id — rename an imported theme */
settingsThemesRoutes.patch("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id.startsWith("custom-")) return c.json(err("Cannot rename a built-in theme"), 400);
    const body = await c.req.json<{ name?: string }>();
    const name = sanitizeName(body.name);
    const updated = renameTheme(id, name);
    if (!updated) return c.json(err("Theme not found"), 404);
    return c.json(ok(updated));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});
