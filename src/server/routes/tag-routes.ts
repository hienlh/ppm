import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  getTagsByProject, createTag, updateTag, deleteTag, getTagById,
  setProjectDefaultTag, getProjectDefaultTagId, getTagSessionCounts,
  seedDefaultTags,
} from "../../services/tag.service.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const tagRoutes = new Hono<Env>();

/** GET /tags — list all tags for the project with session counts */
tagRoutes.get("/", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const tags = getTagsByProject(projectPath);
    const counts = getTagSessionCounts(projectPath);
    const defaultTagId = getProjectDefaultTagId(projectPath);
    return c.json(ok({ tags, counts, defaultTagId }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /tags — create a new tag */
tagRoutes.post("/", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { name, color } = await c.req.json<{ name: string; color: string }>();
    if (!name?.trim()) return c.json(err("name is required"), 400);
    if (!color?.trim()) return c.json(err("color is required"), 400);
    const tag = createTag(projectPath, name.trim(), color.trim());
    return c.json(ok(tag), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** PATCH /default-tag — set the project's default tag for new sessions (MUST be before /:id) */
tagRoutes.patch("/default-tag", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { tagId } = await c.req.json<{ tagId: number | null }>();
    if (tagId !== null) {
      const tag = getTagById(tagId);
      if (!tag || tag.projectPath !== projectPath) return c.json(err("Tag not found"), 404);
    }
    setProjectDefaultTag(projectPath, tagId);
    return c.json(ok({ defaultTagId: tagId }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /reset — re-seed default tags (MUST be before /:id) */
tagRoutes.post("/reset", (c) => {
  try {
    seedDefaultTags(c.get("projectPath"));
    return c.json(ok({ reset: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PATCH /tags/:id — update a tag (after literal routes) */
tagRoutes.patch("/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"), 10);
    const tag = getTagById(id);
    if (!tag) return c.json(err("Tag not found"), 404);
    if (tag.projectPath !== c.get("projectPath")) return c.json(err("Tag does not belong to this project"), 403);
    const body = await c.req.json<{ name?: string; color?: string; sortOrder?: number }>();
    updateTag(id, body);
    return c.json(ok({ updated: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /tags/:id — delete a tag (after literal routes) */
tagRoutes.delete("/:id", (c) => {
  try {
    const id = parseInt(c.req.param("id"), 10);
    const tag = getTagById(id);
    if (!tag) return c.json(err("Tag not found"), 404);
    if (tag.projectPath !== c.get("projectPath")) return c.json(err("Tag does not belong to this project"), 403);
    deleteTag(id);
    return c.json(ok({ deleted: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
