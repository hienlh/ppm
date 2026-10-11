import { Hono } from "hono";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolvePath } from "../../services/fs-path-guard.service.ts";
import { ok, err } from "../../types/api.ts";
import { browserFacingHost, guardPreviewAsset as guardAsset, isInsideRoot as inside, previewDenied as denied } from "../helpers/preview-asset-guard.ts";
import { rangeFileResponse } from "../helpers/range-file-response.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { assertNotAssistantProject } from "../helpers/resolve-chat-project.ts";
import { buildDesignCsp } from "../../services/design/preview/design-csp.ts";
import { injectPlain } from "../../services/design/preview/design-preview-html.ts";
import { decodeDesignText } from "../../services/design/source/design-source-file.ts";
import { readDesignFileSafe } from "../../services/design/design-safe-walk.ts";
import { htmlPreviewBridgeTag } from "../../services/design/bridge/html-preview-bridge.ts";
import { BRIDGE_NONCE_RE } from "../../shared/design-bridge-protocol.ts";

const PREFIX = "/api/html-preview/content";
const TTL = 60 * 60 * 1000;
const MAX_SESSIONS = 128;
/** Pages up to this size get the bridge; a bigger one is served as it is, unchecked. */
export const MAX_BRIDGED_HTML_BYTES = 32 * 1024 * 1024;
interface PreviewSession { root: string; expires: number }

/**
 * An HTML page with the preview bridge as the first thing in its `<head>`, so the page's
 * errors and failed loads reach the PPM tab showing it, and the AI's `open_preview` tool can
 * ask that tab how the page rendered. `nonce` is the load's own, from `?n=`.
 */
async function bridgedPage(path: string, root: string, size: number, nonce: string | null): Promise<string | null> {
  if (size > MAX_BRIDGED_HTML_BYTES) return null;
  // Through the open handle, so the file read is the regular file that was checked.
  const bytes = await readDesignFileSafe(path, MAX_BRIDGED_HTML_BYTES);
  // A UTF-16 page (Windows PowerShell's Out-File writes one) is read by the browser from its
  // byte-order mark; decoded as UTF-8 here it would be served as noise. It goes out as it is.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return null;
  const { text, gen } = decodeDesignText(bytes, { lossy: true });
  const file = relative(root, path).split(sep).join("/");
  return injectPlain(text, htmlPreviewBridgeTag({ nonce, gen, file }));
}

/** Independent capability store per router pair; no session credentials enter iframe URLs. */
export function createHtmlPreviewRoutes(now = Date.now) {
  const sessions = new Map<string, PreviewSession>();
  const api = new Hono();
  const content = new Hono();

  api.post("/", async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body.filePath !== "string" || !body.filePath ||
        (body.projectName !== undefined && typeof body.projectName !== "string")) {
        return c.json(err("filePath and optional projectName are required"), 400);
      }
      let candidate: string;
      if (isAbsolute(body.filePath) || body.filePath.startsWith("~")) {
        candidate = resolvePath(body.filePath);
      } else {
        if (!body.projectName) return c.json(err("projectName is required for relative paths"), 400);
        assertNotAssistantProject(body.projectName);
        const projectRoot = resolveProjectPath(body.projectName);
        candidate = resolve(projectRoot, body.filePath);
        if (!inside(projectRoot, candidate)) denied();
        if (!inside(await realpath(projectRoot), await realpath(candidate))) denied();
      }
      guardAsset(candidate);
      const path = await realpath(candidate);
      guardAsset(path);
      if (!/\.html?$/i.test(path)) return c.json(err("Preview requires an HTML file"), 400);
      if (!(await stat(path)).isFile()) return c.json(err("File not found"), 404);
      for (const [token, session] of sessions) if (session.expires <= now()) sessions.delete(token);
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      const token = crypto.randomUUID();
      sessions.set(token, { root: dirname(path), expires: now() + TTL });
      return c.json(ok({ url: `${PREFIX}/${token}/${encodeURIComponent(basename(path))}` }));
    } catch (error) {
      const status = (error as { status?: number; code?: string }).status === 403 ? 403 :
        (error as { code?: string }).code === "ENOENT" ? 404 : 400;
      return c.json(err(status === 403 ? "Access denied" : "Cannot preview this file"), status);
    }
  });

  content.get("/:token/*", async (c) => {
    const token = c.req.param("token");
    const session = sessions.get(token);
    if (!session || session.expires <= now()) {
      sessions.delete(token);
      return c.json(err("Preview expired; refresh to reopen"), 404);
    }
    try {
      const encoded = new URL(c.req.url).pathname.slice(`${PREFIX}/${token}/`.length);
      const asset = decodeURIComponent(encoded);
      if (!asset || asset.includes("\\") || asset.includes("\0") || asset.includes(":")) denied();
      const candidate = resolve(session.root, asset);
      if (!inside(session.root, candidate)) denied();
      guardAsset(candidate, session.root);
      const path = await realpath(candidate);
      if (!inside(session.root, path)) denied();
      guardAsset(path, session.root);
      const info = await stat(path);
      if (!info.isFile()) return c.json(err("File not found"), 404);
      const host = browserFacingHost(c.req.header("host"), c.req.url);
      // A scheme-less host source follows the document's actual scheme through tunnels.
      const source = `${host}${PREFIX}/${token}/`;
      const headers = {
        // The design canvas's policy: the same sandbox, plus scripts, styles, fonts and images
        // from the design CDNs, with `connect-src` still limited to the preview's own files.
        "Content-Security-Policy": buildDesignCsp(source),
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // Module scripts/fonts fetch from the sandbox's opaque origin.
        "Access-Control-Allow-Origin": "*",
      };
      const html = /\.html?$/i.test(path);
      if (html) {
        const n = new URL(c.req.url).searchParams.get("n");
        const page = await bridgedPage(path, session.root, info.size, n && BRIDGE_NONCE_RE.test(n) ? n : null);
        if (page !== null) {
          return new Response(c.req.method === "HEAD" ? null : page, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
        }
      }
      return rangeFileResponse(path, c.req.raw, headers, html ? "text/html; charset=utf-8" : undefined);
    } catch (error) {
      const status = (error as { status?: number }).status === 403 ? 403 : 404;
      return c.json(err(status === 403 ? "Access denied" : "Preview asset not found"), status);
    }
  });
  return { api, content };
}

export const htmlPreviewRoutes = createHtmlPreviewRoutes();
