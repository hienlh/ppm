import { Hono } from "hono";
import { pushService } from "../../services/push-notification.service.ts";
import { ok, err } from "../../types/api.ts";

export const pushRoutes = new Hono();

/** GET /push/vapid-key — return VAPID public key for frontend subscription */
pushRoutes.get("/vapid-key", (c) => {
  try {
    const publicKey = pushService.getVapidPublicKey();
    return c.json(ok({ publicKey }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /push/subscribe — save a push subscription */
pushRoutes.post("/subscribe", async (c) => {
  try {
    const body = await c.req.json<{
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      expirationTime?: number | null;
    }>();

    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return c.json(err("Invalid subscription: missing endpoint or keys"), 400);
    }

    pushService.saveSubscription({
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
      expirationTime: body.expirationTime,
    });

    return c.json(ok(true));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** DELETE /push/subscribe — remove a push subscription by endpoint */
pushRoutes.delete("/subscribe", async (c) => {
  try {
    const body = await c.req.json<{ endpoint?: string }>();
    if (!body.endpoint) {
      return c.json(err("Missing endpoint"), 400);
    }
    pushService.removeSubscription(body.endpoint);
    return c.json(ok(true));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});
