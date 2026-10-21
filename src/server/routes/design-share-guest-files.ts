import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { stat } from "node:fs/promises";
import { err } from "../../types/api.ts";
import { browserFacingHost } from "../helpers/preview-asset-guard.ts";
import { rangeFileResponse } from "../helpers/range-file-response.ts";
import { BRIDGE_NONCE_RE } from "../../shared/design-bridge-protocol.ts";
import { SHARE_PATH_PREFIX } from "../../shared/design-share-types.ts";
import { readDesignFileSafe } from "../../services/design/design-safe-walk.ts";
import { MAX_DESIGN_SOURCE_BYTES } from "../../services/design/source/design-source-file.ts";
import { buildDesignCsp } from "../../services/design/preview/design-csp.ts";
import { renderDesignHtml } from "../../services/design/preview/design-preview-html.ts";
import {
  resolveSnapshotScopedPath, SYSTEMS_DIR_ALIAS, TOKENS_CSS_ALIAS, type ScopedAsset,
} from "../../services/design/preview/design-preview-scope.ts";
import { resolveGuestAlias } from "../../services/design/preview/design-guest-alias.ts";
import { GUEST_BRIDGE_JS } from "../../services/design/bridge/guest-bridge.ts";
import { guestSnapshotManifest, resolveGuestLink } from "../../services/design/share/design-share-guest-link.ts";
import type { ResolvedShareLink } from "../../services/design/share/design-share-resolve.ts";
import { takeShareRead } from "../../services/design/share/design-share-rate-limit.ts";
import { clientKeyOf, invalidJson, invalidPage, tooManyRequests } from "./design-share-guest-shared.ts";

/**
 * `GET /s/<code>/f/<path>`: the files of the version a share link pins, for the reviewer's
 * design frame.
 *
 * `<slug>/<rest>` is read from the pinned snapshot only — never the live design folder, and
 * never another design. `tokens.css` and `systems/<id>/…` go through the guest allow-list
 * (the design's own app's tokens and kit, served live), never through the canvas's general
 * alias, which for the default app reaches every design. HTML gets element ids and the
 * reviewer's bridge, which proposes no writes; everything is served under the design CSP
 * with this link's own file root as its only source.
 */

const isHtml = (path: string): boolean => /\.html?$/i.test(path);

function errorStatus(error: unknown): ContentfulStatusCode {
  const status = (error as { status?: number }).status;
  return status === 403 || status === 413 ? status : 404;
}

async function resolveGuestFile(resolved: ResolvedShareLink, path: string): Promise<ScopedAsset> {
  const { link } = resolved;
  if (path === TOKENS_CSS_ALIAS || path === SYSTEMS_DIR_ALIAS || path.startsWith(`${SYSTEMS_DIR_ALIAS}/`)) {
    return resolveGuestAlias(link, (await guestSnapshotManifest(resolved)).system, path);
  }
  return resolveSnapshotScopedPath(link, link.snapshotId, path);
}

export function registerGuestFileRoutes(app: Hono): void {
  app.get("/:code/f/*", async (c) => {
    const code = c.req.param("code");
    const url = new URL(c.req.url);
    const prefix = `${SHARE_PATH_PREFIX}${code}/f/`;
    if (!url.pathname.startsWith(prefix)) return invalidPage();
    const encoded = url.pathname.slice(prefix.length);
    const retry = takeShareRead("assets", clientKeyOf(c));
    if (retry) return tooManyRequests(c, retry);
    const resolved = await resolveGuestLink(code);
    if (!resolved) return isHtml(encoded) ? invalidPage() : invalidJson(c);

    const n = url.searchParams.get("n");
    const nonce = n && BRIDGE_NONCE_RE.test(n) ? n : null;
    try {
      let path: string;
      try {
        path = decodeURIComponent(encoded);
      } catch {
        return c.json(err("Access denied"), 403);
      }
      const asset = await resolveGuestFile(resolved, path);
      if (!(await stat(asset.abs)).isFile()) return c.json(err("File not found"), 404);
      // Scheme-less, so the source follows the document's real scheme through a tunnel.
      const source = `${browserFacingHost(c.req.header("host"), c.req.url)}${prefix}`;
      const headers: Record<string, string> = {
        // The sandboxed frame is an opaque origin and sends `Origin: null` for module scripts
        // and fonts; `null` answers exactly that, where `*` would answer every site.
        "Access-Control-Allow-Origin": "null",
        "Content-Security-Policy": buildDesignCsp(source),
      };
      const head = c.req.method === "HEAD";
      if (isHtml(asset.abs)) {
        const page = await renderDesignHtml(resolved.link, asset, {
          nonce, withBridge: true, bridgeScript: GUEST_BRIDGE_JS, skipCssGens: true,
        });
        return new Response(head ? null : page.body, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      }
      if (/\.css$/i.test(asset.abs)) {
        const bytes = await readDesignFileSafe(asset.abs, MAX_DESIGN_SOURCE_BYTES);
        return new Response(head ? null : new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "text/css; charset=utf-8" } });
      }
      return rangeFileResponse(asset.abs, c.req.raw, headers);
    } catch (error) {
      const status = errorStatus(error);
      const message = status === 403 ? "Access denied" : status === 413 ? "File too large to preview" : "File not found";
      return c.json(err(message), status);
    }
  });
}
