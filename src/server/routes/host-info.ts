import { Hono } from "hono";
import { getHostInfo } from "../../services/host-info/host-info.service.ts";
import { ok, err } from "../../types/api.ts";

export const hostInfoRoutes = new Hono();

/** GET /host — cached (60s) server facts: platform, drives, known folders, OS-pinned folders.
 *  `?refresh=true` bypasses the cache. Providers never throw, so this route never 500s on their behalf. */
hostInfoRoutes.get("/host", async (c) => {
  const refresh = c.req.query("refresh") === "true";
  try {
    const info = await getHostInfo({ refresh });
    return c.json(ok(info));
  } catch (e: any) {
    return c.json(err(`Failed to read host info: ${e?.message ?? e}`), 500);
  }
});
