import { Hono } from "hono";
import { DIST_DIR } from "./static.ts";
import { ok } from "../../types/api.ts";
import type { DesignShareGuestInfo } from "../../shared/design-share-guest-types.ts";
import { guestSnapshotManifest, resolveGuestLink } from "../../services/design/share/design-share-guest-link.ts";
import { takeShareRead } from "../../services/design/share/design-share-rate-limit.ts";
import {
  GUEST_PAGE_CSP, readGuestPageHtml, SHARE_COMMON_HEADERS,
} from "../../services/design/share/design-share-guest-page.ts";
import { registerGuestFileRoutes } from "./design-share-guest-files.ts";
import { registerGuestCommentRoutes } from "./design-share-guest-comments.ts";
import { clientKeyOf, guestFail, invalidJson, invalidPage, tooManyRequests } from "./design-share-guest-shared.ts";

/**
 * `/s/*`, the public surface of a design share link: the reviewer's page, the link's info,
 * the pinned version's files and its comment threads.
 *
 * Mounted ahead of the global `cors()`, `/api` authentication and the static fallback. So
 * cors never answers `*` or re-wraps a response here (a range body survives), the PPM token
 * is never asked for or seen, and no `/s` path — `/s`, `/s/`, a trailing slash, an unknown
 * sub-path — falls through to the app shell or its service worker: the catch-all at the end
 * answers each of them with the invalid page. A share code grants exactly what these routes
 * serve and nothing else.
 */

export function createDesignShareGuestRoutes(opts: { distDir: string }): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SHARE_COMMON_HEADERS)) c.res.headers.set(name, value);
  });

  registerGuestFileRoutes(app);
  registerGuestCommentRoutes(app);

  app.get("/:code/info", async (c) => {
    const retry = takeShareRead("api", clientKeyOf(c));
    if (retry) return tooManyRequests(c, retry);
    const resolved = await resolveGuestLink(c.req.param("code"));
    if (!resolved) return invalidJson(c);
    try {
      const manifest = await guestSnapshotManifest(resolved);
      const info: DesignShareGuestInfo = {
        linkId: resolved.link.id,
        slug: resolved.link.slug,
        title: manifest.title,
        kind: manifest.kind,
        entry: manifest.entry,
        variants: manifest.variants,
        expiresAt: resolved.link.expiresAt,
        versionCreatedAt: resolved.snapshot.createdAt,
        versionId: resolved.link.snapshotId,
      };
      return c.json(ok(info));
    } catch (e) {
      return guestFail(c, e, resolved.link.id);
    }
  });

  app.get("/:code", async (c) => {
    const retry = takeShareRead("api", clientKeyOf(c));
    if (retry) return tooManyRequests(c, retry);
    if (!(await resolveGuestLink(c.req.param("code")))) return invalidPage();
    const html = await readGuestPageHtml(opts.distDir);
    if (html === null) return c.text("The review page is not built on this server. Run: bun run build:web", 503);
    return new Response(c.req.method === "HEAD" ? null : html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": GUEST_PAGE_CSP },
    });
  });

  app.all("/", () => invalidPage());
  app.all("/*", () => invalidPage());
  return app;
}

export const designShareGuestRoutes = createDesignShareGuestRoutes({ distDir: DIST_DIR });
