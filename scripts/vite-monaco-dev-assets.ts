/**
 * Monaco under `bun dev:web`.
 *
 * `monaco-adapter.ts` points the AMD loader at `/assets/monaco/vs`, and that path only exists
 * after `bun run build` — `copy-monaco.ts` stages it into `dist/web`. In dev the request fell
 * through to the SPA fallback, which answers `loader.js` with `index.html` as `text/html`; the
 * browser's strict MIME check turns that into a SyntaxError, and every editor and diff tab then
 * spins forever. It reads as a hung component rather than as a missing asset, which is what made
 * it worth a plugin rather than a note in the README — and the jsdelivr default this replaced
 * did work in dev, so it is a regression rather than a gap.
 *
 * The files come straight out of `node_modules` through the same exclusion list the build uses,
 * so dev cannot succeed on a file production does not ship.
 */
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { MONACO_VS, isUnused } from "./monaco-staging.ts";

/** Every file in the AMD build is one of these two; anything an upgrade adds is sent as bytes. */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * The file `pathname` asks for, relative to Monaco's `vs` directory, or null when there is
 * nothing to serve — which leaves the request to Vite and its SPA fallback, exactly as before.
 *
 * Exported for its own test: the traversal guard is the kind of thing that is easy to write and
 * impossible to notice the absence of, and this runs on a dev server that listens on the LAN
 * (`server.host: true`).
 */
export function monacoDevAsset(pathname: string, root = MONACO_VS): { file: string; contentType: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.split("?")[0] ?? "");
  } catch {
    return null; // a malformed escape is not a path
  }
  if (decoded.includes("\0")) return null;
  const file = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (!file.startsWith(root + sep)) return null;
  if (isUnused(file)) return null;
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  return { file, contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream" };
}

export function monacoDevAssets(): Plugin {
  return {
    name: "ppm-monaco-dev-assets",
    apply: "serve",
    configureServer(server) {
      // Connect strips the mounted prefix, so `req.url` here is the path inside `vs/`.
      server.middlewares.use("/assets/monaco/vs", (req, res, next) => {
        const asset = monacoDevAsset(req.url ?? "/");
        if (!asset) return next();
        res.setHeader("Content-Type", asset.contentType);
        createReadStream(asset.file).on("error", next).pipe(res);
      });
    },
  };
}
