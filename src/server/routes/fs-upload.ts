import { Hono, type Context } from "hono";
import { err } from "../../types/api.ts";
import { fsErrorBody } from "../../services/fs-ops/fs-error-response.ts";
import { uploadFile } from "../../services/fs-ops/fs-ops-upload.service.ts";

/**
 * Streaming upload door, mounted on the same `/api/fs` prefix as the browse/mutate routes.
 * Split out of `fs-ops.ts` because a request body stream is a very different shape of
 * handler than the JSON in/JSON out routes there.
 */
export const fsUploadRoutes = new Hono();

/**
 * PUT /api/fs/upload?path=<absolute file path>&overwrite=0|1
 *
 * Body: the raw file bytes. Streamed straight to disk (see the service) — never buffered —
 * so there is no per-file size limit here; the host disk is the only bound. Answers 409
 * `EEXIST` when the target exists and `overwrite` was not set, matching every other
 * `/api/fs` mutation's collision contract.
 */
fsUploadRoutes.put("/upload", async (c: Context) => {
  try {
    const path = c.req.query("path");
    if (!path) return c.json(err("path is required"), 400);
    const overwrite = c.req.query("overwrite") === "1";
    const result = await uploadFile(path, c.req.raw.body, overwrite);
    return c.json({ ok: true, data: result }, 201);
  } catch (e) {
    const { body, status } = fsErrorBody(e);
    return c.json(body, status);
  }
});
