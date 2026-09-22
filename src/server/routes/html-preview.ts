import { Hono } from "hono";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertAllowed, assertNotPpmDir, resolvePath } from "../../services/fs-path-guard.service.ts";
import { ok, err } from "../../types/api.ts";
import { rangeFileResponse } from "../helpers/range-file-response.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";

const PREFIX = "/api/html-preview/content";
const TTL = 60 * 60 * 1000;
const MAX_SESSIONS = 128;
const ASSETS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".m4a", ".woff", ".woff2", ".ttf", ".otf", ".vtt"]);
interface PreviewSession { root: string; expires: number }

function denied(): never {
  throw Object.assign(new Error("Preview path is not allowed"), { status: 403 });
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function guardAsset(path: string, root = dirname(path)): void {
  assertAllowed(path);
  assertNotPpmDir(path);
  // Only web assets, never hidden directories, dotenv, database or key files.
  if (relative(root, path).split(/[\\/]/).some((part) => part.startsWith(".")) || !ASSETS.has(extname(path).toLowerCase())) denied();
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
      if (!(await stat(path)).isFile()) return c.json(err("File not found"), 404);
      // Bun reconstructs req.url with its listening port. Preserve the browser's
      // Host through Vite/tunnels; validate before inserting into a CSP directive.
      const requestHost = c.req.header("host") ?? "";
      const host = /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(requestHost)
        ? requestHost : new URL(c.req.url).host;
      // A scheme-less host source follows the document's actual scheme through tunnels.
      const source = `${host}${PREFIX}/${token}/`;
      const policy = ["sandbox allow-scripts", "default-src 'none'", `script-src 'unsafe-inline' ${source}`,
        `style-src 'unsafe-inline' ${source}`, `img-src ${source} data: blob:`,
        `media-src ${source} blob:`, `font-src ${source} data:`, `connect-src ${source}`,
        "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'", "object-src 'none'"].join("; ");
      return rangeFileResponse(path, c.req.raw, {
        "Content-Security-Policy": policy,
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // Module scripts/fonts fetch from the sandbox's opaque origin.
        "Access-Control-Allow-Origin": "*",
      }, /\.html?$/i.test(path) ? "text/html; charset=utf-8" : undefined);
    } catch (error) {
      const status = (error as { status?: number }).status === 403 ? 403 : 404;
      return c.json(err(status === 403 ? "Access denied" : "Preview asset not found"), status);
    }
  });
  return { api, content };
}

export const htmlPreviewRoutes = createHtmlPreviewRoutes();
