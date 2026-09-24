import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { stat } from "node:fs/promises";
import { ok, err } from "../../types/api.ts";
import { mapFsError } from "../../services/fs-path-guard.service.ts";
import { browserFacingHost } from "../helpers/preview-asset-guard.ts";
import { rangeFileResponse } from "../helpers/range-file-response.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { BRIDGE_NONCE_RE } from "../../shared/design-bridge-protocol.ts";
import { isValidDesignSlug } from "../../services/design/design-slug.ts";
import { getDesign } from "../../services/design/design-store.service.ts";
import { readDesignFileSafe } from "../../services/design/design-safe-walk.ts";
import { decodeDesignText, MAX_DESIGN_SOURCE_BYTES } from "../../services/design/source/design-source-file.ts";
import { buildDesignCsp } from "../../services/design/preview/design-csp.ts";
import { resolveScopedAsset } from "../../services/design/preview/design-preview-scope.ts";
import { renderDesignHtml } from "../../services/design/preview/design-preview-html.ts";
import { printInjection } from "../../services/design/preview/print-view.ts";
import { EXPIRED_PAGE_CSP, expiredPageHtml } from "../../services/design/preview/expired-page.ts";
import {
  createDesignPreviewTokenStore, isDesignPreviewPurpose, type DesignPreviewCapability,
} from "../../services/design/preview/design-preview-tokens.ts";

/**
 * The design canvas's capability route pair.
 *
 * `api` (behind auth) mints and refreshes a token for one design; `content` (before auth,
 * the iframe has no PPM credentials) serves that design's files under the design CSP. A
 * token is the only credential in the iframe URL, and it reads one design only.
 */

const PREFIX = "/api/design-preview/content";

const BASE_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  // The sandboxed document has an opaque origin and sends `Origin: null` for module scripts
  // and fonts. `null` answers exactly that, where `*` would answer every site on the web.
  "Access-Control-Allow-Origin": "null",
};

function errorStatus(error: unknown): ContentfulStatusCode {
  const status = (error as { status?: number }).status;
  if (status === 403 || status === 413) return status;
  return 404;
}

export function createDesignPreviewRoutes(now: () => number = Date.now) {
  const store = createDesignPreviewTokenStore(now);
  const api = new Hono();
  const content = new Hono();

  // The app's global `cors()` answers `*`, and Hono copies headers set before a handler over
  // the handler's own response, so the value set below would be lost. Re-assert it after.
  content.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "null");
  });

  const urlFor = (cap: DesignPreviewCapability, entry: string): string =>
    `${PREFIX}/${cap.token}/${cap.slug}/${entry.split("/").map(encodeURIComponent).join("/")}`;

  api.post("/", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (!b || typeof b.projectName !== "string" || !b.projectName || !isValidDesignSlug(b.slug)
      || !isDesignPreviewPurpose(b.purpose) || (b.token !== undefined && typeof b.token !== "string")) {
      return c.json(err("projectName, a design slug and purpose (canvas, print or standalone) are required"), 400);
    }
    const slug = b.slug;
    const purpose = b.purpose;
    let projectPath: string;
    try {
      projectPath = resolveProjectPath(b.projectName);
    } catch {
      return c.json(err("Project not found"), 404);
    }
    try {
      const design = await getDesign(projectPath, slug);
      let cap: DesignPreviewCapability;
      let rotated = false;
      if (typeof b.token === "string") {
        if (purpose !== "canvas") return c.json(err("Only a canvas preview can be refreshed"), 400);
        const result = store.refresh(b.token, { projectPath, slug });
        if (!result.ok) {
          return result.reason === "unknown"
            ? c.json(err("Preview expired; mint a new one"), 404)
            : c.json(err("This token belongs to another preview"), 403);
        }
        cap = result.capability;
        rotated = result.rotated;
      } else {
        cap = store.mint({ projectPath, slug }, purpose);
      }
      return c.json(ok({ url: urlFor(cap, design.entry), token: cap.token, expiresAt: cap.idleExpires, rotated }));
    } catch (e) {
      const info = mapFsError(e);
      if (info.status >= 500) console.error(`[design-preview] mint ${slug}: ${info.message}`);
      return c.json(err(info.status === 403 ? "Access denied" : info.message), info.status as ContentfulStatusCode);
    }
  });

  content.get("/:token/*", async (c) => {
    const token = c.req.param("token");
    const url = new URL(c.req.url);
    const encoded = url.pathname.slice(`${PREFIX}/${token}/`.length);
    const n = url.searchParams.get("n");
    const nonce = n && BRIDGE_NONCE_RE.test(n) ? n : null;
    const cap = store.resolve(token);
    if (!cap) {
      if (/\.html?$/i.test(encoded)) {
        return new Response(expiredPageHtml(nonce), {
          status: 404,
          headers: { ...BASE_HEADERS, "Content-Security-Policy": EXPIRED_PAGE_CSP, "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return c.json(err("Preview expired; reopen the design"), 404);
    }
    try {
      const asset = await resolveScopedAsset(cap, encoded);
      if (!(await stat(asset.abs)).isFile()) return c.json(err("File not found"), 404);
      // A scheme-less host source follows the document's actual scheme through tunnels.
      const source = `${browserFacingHost(c.req.header("host"), c.req.url)}${PREFIX}/${token}/`;
      const headers: Record<string, string> = {
        ...BASE_HEADERS,
        "Content-Security-Policy": buildDesignCsp(source, { allowModals: cap.purpose === "print" }),
      };
      const head = c.req.method === "HEAD";
      if (/\.html?$/i.test(asset.abs)) {
        // The token's purpose alone decides what the page gets: the bridge for the canvas, the
        // print style and script for print, nothing for standalone. No query flag changes it.
        const inject = cap.purpose === "print" ? printInjection((await getDesign(cap.projectPath, cap.slug)).kind) : undefined;
        const page = await renderDesignHtml(cap, asset, { nonce, withBridge: cap.purpose === "canvas", inject });
        return new Response(head ? null : page.body, {
          headers: {
            ...headers, "Content-Type": "text/html; charset=utf-8",
            "X-PPM-Gen": page.gen, "X-PPM-Instrumented": page.instrumented ? "1" : "0",
          },
        });
      }
      if (/\.css$/i.test(asset.abs)) {
        const bytes = await readDesignFileSafe(asset.abs, MAX_DESIGN_SOURCE_BYTES);
        // A copy typed over a plain ArrayBuffer, which is what BodyInit accepts.
        return new Response(head ? null : new Uint8Array(bytes), {
          headers: { ...headers, "Content-Type": "text/css; charset=utf-8", "X-PPM-Gen": decodeDesignText(bytes, { lossy: true }).gen },
        });
      }
      return rangeFileResponse(asset.abs, c.req.raw, headers);
    } catch (error) {
      const status = errorStatus(error);
      const message = status === 403 ? "Access denied" : status === 413 ? "File too large to preview" : "Preview asset not found";
      return c.json(err(message), status);
    }
  });

  return { api, content, store };
}

export const designPreviewRoutes = createDesignPreviewRoutes();
