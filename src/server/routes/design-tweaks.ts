import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  StaleTweakGenError, commitTweaks, readDesignTweaks,
} from "../../services/design/design-tweaks-commit.service.ts";
import { designFail as fail, designJsonBody as jsonBody, type DesignRouteEnv } from "./design-route-helpers.ts";

/**
 * `/api/project/:projectName/designs/:slug/tweaks` — the design's tweak controls.
 *
 * `GET` answers with the controls `design.json` declares (and why any were skipped);
 * `POST {entry, gens, values}` writes values into the stylesheets. A stale gen is a 409
 * whose `data` names the file and its current gen, so the canvas can reload and let the
 * user apply again without losing the values they chose.
 */

export const designTweakRoutes = new Hono<DesignRouteEnv>();

designTweakRoutes.get("/", async (c) => {
  try {
    return c.json(ok(await readDesignTweaks(c.get("projectPath"), c.req.param("slug") ?? "")));
  } catch (e) {
    return fail(c, e);
  }
});

designTweakRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await commitTweaks(c.get("projectPath"), c.req.param("slug") ?? "", body)));
  } catch (e) {
    if (e instanceof StaleTweakGenError) {
      return c.json({ ...err(e.message), data: { file: e.file, currentGen: e.currentGen } }, 409);
    }
    return fail(c, e);
  }
});
