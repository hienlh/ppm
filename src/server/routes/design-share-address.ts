import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { getShareAddress } from "../../services/design/share/design-share-address.ts";

/**
 * `/api/design-shares` — what the Share dialog needs outside any one design: the public
 * address links are reachable at, whether the tunnel switch is on, and whether PPM sign-in
 * is (sharing is refused while it is off).
 */

export const designShareAddressRoutes = new Hono();

designShareAddressRoutes.get("/address", (c) => {
  try {
    return c.json(ok(getShareAddress()));
  } catch (e) {
    console.error(`[design] GET /api/design-shares/address: ${(e as Error).message}`);
    return c.json(err("Could not read the public address"), 500);
  }
});
