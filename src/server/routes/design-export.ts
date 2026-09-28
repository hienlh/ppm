import { Hono } from "hono";
import { posix } from "node:path";
import { err } from "../../types/api.ts";
import { getDesign } from "../../services/design/design-store.service.ts";
import { resolveDesignDir, resolveDesignsRoot } from "../../services/design/design-paths.ts";
import { validateExportEntry } from "../../services/design/export/design-export-entry.ts";
import { createDesignAssetReader } from "../../services/design/export/design-export-asset-reader.ts";
import { buildStandaloneHtml } from "../../services/design/export/design-standalone-html.ts";
import { createDesignZip } from "../../services/design/export/design-zip-export.ts";
import { designFail as fail, type DesignRouteEnv } from "./design-route-helpers.ts";

/**
 * `/api/project/:projectName/designs/:slug/export` — downloads of one design.
 *
 * `GET /zip` streams `<slug>.zip`; `GET /html?entry=` answers one self-contained HTML file
 * (the design's entry page when `entry` is absent), with `X-PPM-Export-Warnings` counting
 * what could not be inlined and `X-PPM-Export-Warning-List` naming the first of them.
 *
 * Both answer `application/octet-stream` as an attachment. The HTML is AI-authored and must
 * never render on PPM's origin, so it is never served as `text/html` here, and the browser
 * saves it from a Blob of the same neutral type rather than navigating to it.
 */

export const designExportRoutes = new Hono<DesignRouteEnv>();

/** Proxies (nginx's default buffer is 4-8 KB for all headers) refuse bigger responses. */
const MAX_WARNING_HEADER = 3000;

/** As many warnings as fit the header budget, URI-encoded JSON. */
function warningHeader(warnings: string[]): string {
  const listed: string[] = [];
  let value = encodeURIComponent("[]");
  for (const w of warnings) {
    const next = encodeURIComponent(JSON.stringify([...listed, w.slice(0, 200)]));
    if (next.length > MAX_WARNING_HEADER) break;
    listed.push(w.slice(0, 200));
    value = next;
  }
  return value;
}

function downloadHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

designExportRoutes.get("/zip", async (c) => {
  const slug = c.req.param("slug") ?? "";
  try {
    const stream = await createDesignZip(c.get("projectPath"), slug);
    return new Response(stream, { headers: downloadHeaders(`${slug}.zip`) });
  } catch (e) {
    return fail(c, e);
  }
});

designExportRoutes.get("/html", async (c) => {
  const slug = c.req.param("slug") ?? "";
  try {
    const projectPath = c.get("projectPath");
    const design = await getDesign(projectPath, slug);
    const designDir = await resolveDesignDir(projectPath, slug);
    const root = await resolveDesignsRoot(projectPath);
    // The slug resolved, so designs/ exists; the null check only satisfies the type.
    if (!root) return c.json(err("Design not found"), 404);
    const entry = validateExportEntry(c.req.query("entry") ?? design.entry, designDir);
    const { html, warnings } = await buildStandaloneHtml(entry.rel, createDesignAssetReader(designDir, root));
    const page = posix.basename(entry.rel).replace(/\.html?$/, "");
    const filename = page === "index" ? `${slug}.html` : `${slug}-${page}.html`;
    return new Response(html, {
      headers: {
        ...downloadHeaders(filename),
        "X-PPM-Export-Warnings": String(warnings.length),
        "X-PPM-Export-Warning-List": warningHeader(warnings),
      },
    });
  } catch (e) {
    return fail(c, e);
  }
});
