/**
 * Services page routes, mounted under /api/system behind auth.
 *
 *   GET  /services                        both scopes in one snapshot
 *   GET  /services/:scope/:unit           details plus this boot's journal
 *   POST /services/:scope/:unit/:action   guarded start/stop/restart/enable/disable
 *
 * The action route is the only one that changes anything, and it is guarded
 * twice: the cross-origin header pair, then PPM's own refusals (which is the
 * SAME function that produced each row's `refused` map, so a greyed-out button
 * and a 403 always agree).
 */
import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import type { ServiceAction, ServiceScope } from "../../types/system-services.ts";
import { SERVICE_ACTIONS } from "../../types/system-services.ts";
import {
  collectServices, createSystemdServices, runServiceAction, serviceDetails,
  ServiceActionRefused, type SystemdDeps,
} from "../../services/system-services/systemd-collector.ts";
import { isPlausibleUnitName } from "../../services/system-services/service-guard.ts";
import { crossOriginRefusal } from "./cross-origin-guard.ts";

const SCOPES: readonly string[] = ["system", "user"];
const isScope = (value: string): value is ServiceScope => SCOPES.includes(value);

export function createSystemServiceRoutes(deps: SystemdDeps = createSystemdServices()): Hono {
  const routes = new Hono();

  routes.get("/services", async (c) => c.json(ok(await collectServices(deps))));

  routes.get("/services/:scope/:unit", async (c) => {
    const scope = c.req.param("scope") ?? "";
    const unit = c.req.param("unit") ?? "";
    if (!isScope(scope)) return c.json(err("Scope must be system or user"), 400);
    if (!isPlausibleUnitName(unit)) return c.json(err("Not a unit name"), 400);
    const details = await serviceDetails(unit, scope, deps);
    if (!details) return c.json(err(`No unit named ${unit}`), 404);
    return c.json(ok(details));
  });

  routes.post("/services/:scope/:unit/:action", async (c) => {
    const refusal = crossOriginRefusal(c);
    if (refusal) return c.json(err(refusal), 400);

    const scope = c.req.param("scope") ?? "";
    const unit = c.req.param("unit") ?? "";
    const action = c.req.param("action") ?? "";
    if (!isScope(scope)) return c.json(err("Scope must be system or user"), 400);
    if (!isPlausibleUnitName(unit)) return c.json(err("Not a unit name"), 400);
    if (!SERVICE_ACTIONS.includes(action as ServiceAction)) {
      return c.json(err(`Action must be one of ${SERVICE_ACTIONS.join("|")}`), 400);
    }

    // Audit line: unit, scope, action and outcome only. No command lines and no
    // journal text — the tail of ~/.ppm/ppm.log is served unauthenticated.
    const prefix = `[SystemServices] ${action} ${scope}/${unit}`;
    try {
      const result = await runServiceAction(unit, scope, action as ServiceAction, deps);
      console.log(`${prefix} -> done`);
      return c.json(ok(result));
    } catch (e) {
      if (e instanceof ServiceActionRefused) {
        console.log(`${prefix} -> refused: ${e.message}`);
        return c.json(err(e.message), 403);
      }
      const message = (e as Error)?.message ?? "Action failed";
      console.log(`${prefix} -> failed: ${message}`);
      return c.json(err(message), 500);
    }
  });

  return routes;
}

export const systemServiceRoutes = createSystemServiceRoutes();
