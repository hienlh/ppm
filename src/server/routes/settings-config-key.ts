import { Hono } from "hono";
import { configService } from "../../services/config.service.ts";
import { prepareConfigWrite } from "../../services/config-write-guard.ts";
import { ok, err } from "../../types/api.ts";
import type { PpmConfig } from "../../types/config.ts";

/**
 * `PUT /api/settings/config-key` `{ key, value }`: what `ppm config set` calls when a server holds
 * the database, so the change lands in the running server's memory and its next save cannot
 * write the old value back. Only plain preferences and (for a person) exposure keys pass
 * (`config-write-guard.ts`); keys with routes of their own are sent there. `X-PPM-AI-Chat: 1`
 * marks a call from a command an AI chat ran, which is advisory: anything can leave it out.
 */
export const settingsConfigKeyRoutes = new Hono();

/** Keys a running server only takes up when it starts again. */
const NEEDS_RESTART = new Set(["port", "host"]);

settingsConfigKeyRoutes.put("/config-key", async (c) => {
  const body = await c.req.json().catch(() => null) as { key?: unknown; value?: unknown } | null;
  if (!body || typeof body.key !== "string" || !body.key || body.value === undefined) {
    return c.json(err("Expected { key, value }"), 400);
  }
  const key = body.key;
  const aiChat = c.req.header("X-PPM-AI-Chat") === "1";
  const prepared = prepareConfigWrite(key, body.value, configService.getAll() as unknown as Record<string, unknown>, { aiChat });
  if (!prepared.ok) return c.json(err(prepared.error), prepared.status);
  const topKey = prepared.topKey as keyof PpmConfig;
  configService.set(topKey, prepared.topValue as PpmConfig[typeof topKey]);
  configService.save();
  let note: string | null = null;
  if (key === "tunnel.enabled") {
    const { requestTunnelReload } = await import("../../services/supervisor-state.ts");
    const reload = requestTunnelReload();
    note = reload === "sent" ? "asked the supervisor to apply the tunnel change" : `takes effect on next start (${reload})`;
  } else if (NEEDS_RESTART.has(key)) {
    note = "takes effect when PPM restarts";
  }
  return c.json(ok({ key, value: prepared.value, note }));
});
