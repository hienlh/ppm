import { Hono } from "hono";
import { readShot, shotPngPath } from "../../services/design/shots/design-shots.service.ts";

/**
 * `GET /api/design-shots/<id>.png`: a design screenshot PPM rendered (`design-shots.service.ts`).
 * Mounted before auth, because the link is opened from Telegram on a phone that holds no PPM
 * login. The id — 128 random bits, never listed anywhere — is the only credential, exactly like
 * a share link's code, and it stops working when the shot is pruned (seven days).
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
