import { Hono } from "hono";
import { readShot, shotPngPath } from "../../services/design/shots/design-shots.service.ts";

/**
 * `GET /api/design-shots/<id>.png`: a design screenshot PPM rendered (`design-shots.service.ts`),
 * behind PPM's login like every other route (mounted after `authMiddleware`). Telegram receives
 * the pictures themselves, so nothing outside PPM needs to open this; the card in PPM fetches it
 * with the token. A shot is gone once pruned (seven days).
 */
export const designShotRoutes = new Hono();

designShotRoutes.get("/:file", async (c) => {
  const match = /^([0-9a-f]{32})\.png$/.exec(c.req.param("file"));
  const shot = match ? await readShot(match[1]!) : null;
  if (!shot) return c.text("Not found", 404);
  const file = Bun.file(shotPngPath(shot.id));
  if (!(await file.exists())) return c.text("Not found", 404);
  return new Response(file, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
});
