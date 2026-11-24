/**
 * `/api/approval-rules` — remembered approvals (behind auth): the kinds of request the user chose
 * to have approved without a card, and the switch that turns the feature on or off.
 *
 * Rules are made only by a person pressing "Allow & remember" on a card (in the chat, on the PPM
 * Assistant's mirror of it, or on Telegram), never here: this route lists them, removes one, and
 * flips the switch. Nothing in it is reachable from an AI's tools.
 */
import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { rememberedApprovals } from "../../services/remembered-approvals/remembered-approvals.service.ts";
import type { RememberedApprovalsState } from "../../shared/remembered-approvals.ts";

const ID_RE = /^[0-9a-f-]{36}$/i;

export function createApprovalRuleRoutes(service = rememberedApprovals): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    const state: RememberedApprovalsState = { enabled: service.enabled(), rules: service.list() };
    return c.json(ok(state));
  });

  routes.put("/enabled", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(err("Expected a JSON body"), 400); }
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") return c.json(err("enabled must be true or false"), 400);
    service.setEnabled(enabled);
    return c.json(ok({ enabled: service.enabled() }));
  });

  routes.delete("/:id", (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id) || !service.remove(id)) return c.json(err("No such rule"), 404);
    return c.json(ok({ removed: id }));
  });

  return routes;
}

export const approvalRuleRoutes = createApprovalRuleRoutes();
