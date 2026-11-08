/**
 * `/api/feature-intros` — the tour's "PPM has new features" part (behind auth). The record is
 * install-wide, so every change is announced on `/ws/global` and other open devices close the
 * question once it is answered anywhere. Logic lives in `services/feature-intros.service.ts`.
 */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { broadcastGlobalEvent } from "../ws/global.ts";
import {
  answerFeatureIntro, featureIntrosView, markFeatureIntroSeenInSettings, skipFeatureIntro, type FeatureIntroChange,
} from "../../services/feature-intros.service.ts";
import { FEATURE_INTROS_CHANGED_EVENT } from "../../shared/feature-intros.ts";

export function createFeatureIntroRoutes(broadcast: (event: unknown) => void = broadcastGlobalEvent): Hono {
  const routes = new Hono();

  const reply = (c: Context, id: string, change: FeatureIntroChange): Response => {
    if (!change.ok) return c.json(err(change.error), change.status);
    broadcast({ type: FEATURE_INTROS_CHANGED_EVENT, id, answer: change.state.answer });
    return c.json(ok(change.state));
  };

  routes.get("/", (c) => c.json(ok(featureIntrosView())));

  routes.post("/:id/answer", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(err("Expected a JSON body"), 400); }
    const answer = (body as { answer?: unknown } | null)?.answer;
    if (answer !== "on" && answer !== "off") return c.json(err('answer must be "on" or "off"'), 400);
    return reply(c, c.req.param("id"), answerFeatureIntro(c.req.param("id"), answer));
  });

  routes.post("/:id/skip", (c) => reply(c, c.req.param("id"), skipFeatureIntro(c.req.param("id"))));

  routes.post("/:id/seen-in-settings", (c) => reply(c, c.req.param("id"), markFeatureIntroSeenInSettings(c.req.param("id"))));

  return routes;
}

export const featureIntroRoutes = createFeatureIntroRoutes();
