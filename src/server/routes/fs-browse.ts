import { Hono } from "hono";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import mammoth from "mammoth";
import { browse, list } from "../../services/fs-browse.service.ts";
import {
  assertAllowed,
  assertNotPpmDir,
  isAllowedPath,
  resolvePath,
} from "../../services/fs-path-guard.service.ts";
import {
  readSystemFile,
  realPathOrSelf,
  writeSystemFile,
} from "../../services/fs-ops/fs-ops-read-write.service.ts";
import { makeDir } from "../../services/fs-ops/fs-ops-mutate.service.ts";
import { fsErrorBody } from "../../services/fs-ops/fs-error-response.ts";
import { isImageExtension } from "../../shared/image-extensions.ts";
import { ok, err } from "../../types/api.ts";
import {
  createDownloadToken,
  consumeDownloadToken,
} from "../../services/download-token.service.ts";

export const fsBrowseRoutes = new Hono();

function fail(e: unknown) {
  return fsErrorBody(e);
}

/** GET /api/fs/browse?path=/some/dir&showHidden=false */
fsBrowseRoutes.get("/browse", async (c) => {
  try {
    const path = c.req.query("path") || undefined;
    const showHidden = c.req.query("showHidden") === "true";
    return c.json(ok(await browse(path, { showHidden })));
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/** GET /api/fs/list?dir=/some/dir — recursive file listing (command palette) */
fsBrowseRoutes.get("/list", (c) => {
  try {
    const dir = c.req.query("dir");
    if (!dir) return c.json(err("dir is required"), 400);
    return c.json(ok(list(dir)));
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/** GET /api/fs/read?path=/some/file — read file outside project */
fsBrowseRoutes.get("/read", async (c) => {
  try {
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("path is required"), 400);
    return c.json(ok(await readSystemFile(filePath)));
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/**
 * POST /api/fs/download/token — body: { path }
 * The token is bound to that one file and spent on first use, so a URL that
 * leaks through history or a proxy log cannot fetch anything else.
 */
fsBrowseRoutes.post("/download/token", async (c) => {
  try {
    const body = await c.req.json<{ path?: string }>().catch(() => ({}) as { path?: string });
    if (!body.path) return c.json(err("path is required"), 400);
    const resolved = resolvePath(body.path);
    assertAllowed(resolved);
    assertNotPpmDir(resolved);
    assertNotPpmDir(await realPathOrSelf(resolved));
    return c.json(ok({ token: createDownloadToken(resolved) }));
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/** GET /api/fs/raw?path=/some/file — serve file as binary (images, downloads) */
fsBrowseRoutes.get("/raw", async (c) => {
  try {
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("path is required"), 400);

    const resolved = resolvePath(filePath);
    const real = await realPathOrSelf(resolved);
    // Images are streamed even from outside the browse whitelist: the chat UI renders images
    // the assistant just read, and those live at arbitrary paths. Limiting the exception to
    // image extensions stops it from becoming an arbitrary-file read. The extension is
    // re-checked after resolving symlinks, so a link named *.png cannot hand out a
    // non-image target.
    if (!isAllowedPath(resolved)) {
      if (!isImageExtension(resolved) || !isImageExtension(real)) {
        return c.json(err("Access denied"), 403);
      }
    }
    assertNotPpmDir(resolved);
    assertNotPpmDir(real);

    // A download token authenticated this request in place of the session, so
    // it must match the file being served and is spent here.
    const dlToken = c.req.query("dl_token");
    if (dlToken && !consumeDownloadToken(dlToken, resolved)) {
      return c.json(err("Download token invalid for this path"), 403);
    }

    const info = await stat(resolved).catch(() => null);
    if (!info) return c.json(err("File not found"), 404);

    const download = c.req.query("download") === "true";
    const filename = basename(resolved) || "download";
    const file = Bun.file(resolved);
    return new Response(file.stream(), {
      headers: {
        "Content-Type": download ? "application/octet-stream" : (file.type || "application/octet-stream"),
        // RFC 5987 form keeps non-ASCII names (and quotes) intact.
        "Content-Disposition": download
          ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
          : "inline",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/** GET /api/fs/docx-html?path=/some/file.docx — convert .docx to HTML via mammoth */
fsBrowseRoutes.get("/docx-html", async (c) => {
  try {
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("path is required"), 400);
    const resolved = resolvePath(filePath);
    assertAllowed(resolved);
    assertNotPpmDir(resolved);
    assertNotPpmDir(await realPathOrSelf(resolved));
    if (!(await stat(resolved).catch(() => null))) return c.json(err("File not found"), 404);

    const arrayBuf = await Bun.file(resolved).arrayBuffer();
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(arrayBuf) });
    return c.json(ok({ html: result.value, warnings: result.messages }));
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/**
 * POST /api/fs/mkdir — create directory { path, gitInit? }
 * `gitInit` defaults to true because the project picker uses this route to
 * create new project folders; the explorer passes false.
 */
fsBrowseRoutes.post("/mkdir", async (c) => {
  try {
    const body = await c.req.json<{ path?: string; gitInit?: boolean }>();
    if (!body.path) return c.json(err("path is required"), 400);

    const { path } = await makeDir(body.path);
    const gitInit = body.gitInit !== false;
    if (gitInit) {
      const git = Bun.spawn(["git", "init", path], { stdout: "ignore", stderr: "ignore" });
      await git.exited;
    }
    return c.json(ok({ path, gitInitialized: gitInit }), 201);
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/** PUT /api/fs/write — write file outside project { path, content } */
fsBrowseRoutes.put("/write", async (c) => {
  try {
    const body = await c.req.json<{ path?: string; content?: string }>();
    if (!body.path || body.content == null) {
      return c.json(err("path and content required"), 400);
    }
    await writeSystemFile(body.path, body.content);
    return c.json(ok(true));
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});
