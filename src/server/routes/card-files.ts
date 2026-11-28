import { Hono } from "hono";
import { PREVIEW_MIME_TYPES } from "../../shared/card-files.ts";
import { cardFileOf, cardFilePath, readCardFile } from "../../services/assistant-cards/card-files-store.ts";
import { rangeFileResponse } from "../helpers/range-file-response.ts";

/**
 * `GET /api/card-files/<id>`: PPM's copy of a file a manager put on a report card
 * (`card-files-store.ts`), behind PPM's login like every route mounted after `authMiddleware`. The
 * card fetches it with the token and shows it from a blob URL.
 *
 * The type is the one PPM sniffed from the bytes when it stored the copy, and only a picture,
 * video or PDF is served as itself; anything else is `application/octet-stream`. `?download=1`
 * asks for an attachment. The response may never run as a page on PPM's origin: `nosniff`, a CSP
 * of nothing and `sandbox`, so a PDF viewer or an HTML file opened by hand gets no script and no
 * access to the token.
 */
export const cardFileRoutes = new Hono();

/** `filename*=` per RFC 6266/5987, plus an ASCII fallback for old clients. */
function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** What the viewer page needs to know about a file: its card view, without where it came from. */
cardFileRoutes.get("/:id/info", async (c) => {
  const file = await readCardFile(c.req.param("id"));
  if (!file) return c.json({ ok: false, error: "This file is no longer kept (files stay 30 days)" }, 404);
  return c.json({ ok: true, data: { file: cardFileOf(file), createdAt: file.createdAt } });
});

/**
 * The bytes, with Range: a `<video>` asks for byte ranges to show the length and to seek, so an
 * 83 MB clip starts at once and a seek costs one small request. A `<video src>` cannot send the
 * token as a header, so this route is one of the few that take `?token=` (`middleware/auth.ts`);
 * it takes an id PPM made, never a path.
 */
cardFileRoutes.get("/:id", async (c) => {
  const file = await readCardFile(c.req.param("id"));
  if (!file) return c.text("Not found", 404);
  const path = cardFilePath(file.id);
  if (!(await Bun.file(path).exists())) return c.text("Not found", 404);
  const previewable = (PREVIEW_MIME_TYPES as readonly string[]).includes(file.mime);
  const download = c.req.query("download") === "1" || !previewable;
  return rangeFileResponse(path, c.req.raw, {
    "Content-Disposition": contentDisposition(download ? "attachment" : "inline", file.name),
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  }, previewable ? file.mime : "application/octet-stream");
});
