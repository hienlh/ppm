/**
 * `/api/feature-intros` — the tour's "PPM has new features" part (behind auth). The record is
 * install-wide, so every change is announced on `/ws/global` and other open devices close the
 * question once it is answered anywhere. Logic lives in `services/feature-intros.service.ts`.
 */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { broadcastGlobalEvent } from "../ws/global.ts";
import {
  answerFeatureIntro, featureIntrosView, markFeatureIntroSeenInSettings, settleFeaturesDecidedInSettings, skipFeatureIntro,
  type FeatureIntroChange,
} from "../../services/feature-intros.service.ts";
import { FEATURE_INTROS_CHANGED_EVENT, type FeatureIntrosChangedEvent } from "../../shared/feature-intros.ts";

export function createFeatureIntroRoutes(broadcast: (event: unknown) => void = broadcastGlobalEvent): Hono {
  const routes = new Hono();

  const announce = (event: Omit<FeatureIntrosChangedEvent, "type">) => broadcast({ type: FEATURE_INTROS_CHANGED_EVENT, ...event });

  /**
   * Answers with the feature's state either way. A skip is announced even when the server did not
   * count it (one per window): it still tells every other open tab and device that the question
   * was put off here, so they close it too instead of each adding a skip of their own. An answer
   * or a Settings visit that changed nothing is not announced.
   */
  const reply = (c: Context, id: string, change: FeatureIntroChange, kind: "answer" | "skip" | "seen"): Response => {
    if (!change.ok) return c.json(err(change.error), change.status);
    if (change.changed || kind === "skip") announce({ change: kind, id, answer: change.state.answer });
    return c.json(ok(change.state));
  };

  routes.get("/", (c) => {
    // A switch set in Settings (or by the CLI) before any device asked is the answer: record it
    // and tell the other open devices, which may still be showing the question. The settle is
    // a no-op once recorded, so the reload this event causes everywhere broadcasts nothing.
    if (settleFeaturesDecidedInSettings()) announce({ change: "settings" });
    return c.json(ok(featureIntrosView()));
  });

  routes.post("/:id/answer", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(err("Expected a JSON body"), 400); }
    const answer = (body as { answer?: unknown } | null)?.answer;
    if (answer !== "on" && answer !== "off") return c.json(err('answer must be "on" or "off"'), 400);
    return reply(c, c.req.param("id"), answerFeatureIntro(c.req.param("id"), answer), "answer");
  });

  routes.post("/:id/skip", (c) => reply(c, c.req.param("id"), skipFeatureIntro(c.req.param("id")), "skip"));

  routes.post("/:id/seen-in-settings", (c) => reply(c, c.req.param("id"), markFeatureIntroSeenInSettings(c.req.param("id")), "seen"));

  return routes;
}

export const featureIntroRoutes = createFeatureIntroRoutes();
