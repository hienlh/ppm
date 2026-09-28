import { searchProjectContent, ProjectSearchError } from "../../services/project-content-search.service";
import { Hono } from "hono";
import { resolve, isAbsolute } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileService, SecurityError, NotFoundError, ValidationError } from "../../services/file.service.ts";
import { readSystemFileSync } from "../../services/fs-browse.service.ts";
import { ok, err } from "../../types/api.ts";
import { errorStatus } from "../helpers/error-status.ts";
import { rangeFileResponse } from "../helpers/range-file-response.ts";
import { handleMediaProbe, handleMediaTranscode, handleMediaTranscodeStop } from "../helpers/media-route-handlers.ts";
import mammoth from "mammoth";

type Env = { Variables: { projectPath: string; projectName: string } };

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_UPLOAD_FILES = 20;

export const fileRoutes = new Hono<Env>();


/**
 * GET /files/list?path=<relPath>
 * Returns one directory level of entries with type and gitignore flag.
 * Applies filesExclude patterns. path defaults to "" (project root).
 */
fileRoutes.get("/list", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const relPath = (c.req.query("path") ?? "").trim();
    // Reject path traversal attempts early
    if (relPath.includes("..")) return c.json(err("Invalid path: traversal not allowed"), 400);
    const entries = fileService.listDir(projectPath, relPath);
    return c.json(ok(entries));
  } catch (e) {
    if (e instanceof SecurityError) return c.json(err((e as Error).message), 403);
    if (e instanceof NotFoundError) return c.json(err((e as Error).message), 404);
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/**
 * POST /files/list-batch  body: { paths: string[] }  (max 50)
 * Lists multiple directory levels in one round-trip (expanded-state restore,
 * deep expand). Per-path errors are returned inline, not as request failures.
 */
fileRoutes.post("/list-batch", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json().catch(() => null) as { paths?: unknown } | null;
    const paths = body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return c.json(err("paths must be a non-empty array"), 400);
    }
    if (paths.length > 50) return c.json(err("paths: max 50 per request"), 400);
    if (paths.some((p) => typeof p !== "string" || p.includes(".."))) {
      return c.json(err("Invalid path in batch"), 400);
    }
    const results = fileService.listDirBatch(projectPath, (paths as string[]).map((p) => p.trim()));
    return c.json(ok(results));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/**
 * GET /files/index
 * Returns flat array of all project files {path, name} for palette/search.
 * Result is cached; cache is invalidated on file change events.
 */
fileRoutes.get("/index", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const entries = fileService.buildIndex(projectPath);
    return c.json(ok(entries));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/**
 * @deprecated Use /files/list for lazy-load tree instead.
 * GET /files/tree?depth=3
 */
fileRoutes.get("/tree", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const depth = parseInt(c.req.query("depth") ?? "3", 10);
    const tree = fileService.getTree(projectPath, depth);
    return c.json(ok(tree));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /files/raw?path=...&download=true — serve file directly as binary (for PDF viewer, images, downloads) */
fileRoutes.get("/raw", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("Missing query parameter: path"), 400);

    // Resolve safely (reuse service's security check)
    const absPath = resolve(projectPath, filePath);
    if (!absPath.startsWith(projectPath)) {
      return c.json(err("Access denied"), 403);
    }
    if (!existsSync(absPath)) return c.json(err("File not found"), 404);

    const download = c.req.query("download") === "true";
    const filename = filePath.split("/").pop() ?? "download";

    // Range-aware so <video>/<audio>/pdf.js can seek instead of buffering the whole file.
    return rangeFileResponse(
      absPath,
      c.req.raw,
      { "Content-Disposition": download ? `attachment; filename="${filename}"` : "inline" },
      download ? "application/octet-stream" : undefined,
    );
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** Resolve `?path=` inside the project or return the error response to send. */
function resolveProjectFile(c: { get(k: "projectPath"): string; req: { query(k: string): string | undefined } }): string | Response {
  const projectPath = c.get("projectPath");
  const filePath = c.req.query("path");
  if (!filePath) return Response.json(err("Missing query parameter: path"), { status: 400 });
  const absPath = resolve(projectPath, filePath);
  if (!absPath.startsWith(projectPath)) return Response.json(err("Access denied"), { status: 403 });
  if (!existsSync(absPath)) return Response.json(err("File not found"), { status: 404 });
  return absPath;
}

/** GET /files/probe?path=... — codec/duration facts + whether ffmpeg transcoding is available */
fileRoutes.get("/probe", async (c) => {
  try {
    const abs = resolveProjectFile(c);
    return abs instanceof Response ? abs : await handleMediaProbe(abs);
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /files/transcode?path=...&start=<sec> — ffmpeg → fragmented MP4 for videos the browser cannot decode */
fileRoutes.get("/transcode", async (c) => {
  try {
    const abs = resolveProjectFile(c);
    return abs instanceof Response ? abs : await handleMediaTranscode(abs, c.req.raw, c.req.query("start"), c.req.query("sid"));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** DELETE /files/transcode?sid=... — stop the player's ffmpeg job (unmount, tab close) */
fileRoutes.delete("/transcode", (c) => handleMediaTranscodeStop(c.req.query("sid")));

/** GET /files/docx-html?path=... — convert project .docx to HTML via mammoth */
fileRoutes.get("/docx-html", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("Missing query parameter: path"), 400);

    const absPath = resolve(projectPath, filePath);
    if (!absPath.startsWith(projectPath)) return c.json(err("Access denied"), 403);
    if (!existsSync(absPath)) return c.json(err("File not found"), 404);

    const arrayBuf = await Bun.file(absPath).arrayBuffer();
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(arrayBuf) });
    return c.json(ok({ html: result.value, warnings: result.messages }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /files/read?path=... */
fileRoutes.get("/read", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json(err("Missing query parameter: path"), 400);
    }
    const result = fileService.readFile(projectPath, filePath);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** PUT /files/write — body: { path, content } */
fileRoutes.put("/write", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ path: string; content: string }>();
    if (!body.path || body.content === undefined) {
      return c.json(err("Missing required fields: path, content"), 400);
    }
    fileService.writeFile(projectPath, body.path, body.content);
    return c.json(ok({ written: body.path }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /files/create — body: { path, type } */
fileRoutes.post("/create", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ path: string; type: "file" | "directory" }>();
    if (!body.path || !body.type) {
      return c.json(err("Missing required fields: path, type"), 400);
    }
    fileService.createFile(projectPath, body.path, body.type);
    return c.json(ok({ created: body.path, type: body.type }), 201);
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /files/upload — upload files from OS drag-drop into project directory */
fileRoutes.post("/upload", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.parseBody({ all: true });
    const targetDir = String(body["targetDir"] ?? "");
    const rawFiles = body["files"];
    const files = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];

    if (files.length === 0) return c.json(err("No files provided"), 400);
    if (files.length > MAX_UPLOAD_FILES) return c.json(err(`Max ${MAX_UPLOAD_FILES} files per upload`), 400);

    const absTargetDir = resolve(projectPath, targetDir);
    if (!absTargetDir.startsWith(projectPath)) return c.json(err("Access denied"), 403);
    if (!existsSync(absTargetDir)) mkdirSync(absTargetDir, { recursive: true });

    const uploaded: { name: string; path: string; size: number }[] = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;
      if (file.size > MAX_UPLOAD_SIZE) {
        return c.json(err(`File "${file.name}" exceeds 50MB limit`), 400);
      }
      const safeName = file.name.replace(/[/\\]/g, "_");
      const absPath = resolve(absTargetDir, safeName);
      if (!absPath.startsWith(projectPath)) return c.json(err("Access denied"), 403);
      await Bun.write(absPath, file);
      uploaded.push({ name: safeName, path: absPath.slice(projectPath.length + 1).split("\\").join("/"), size: file.size });
    }

    return c.json(ok({ uploaded }), 201);
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** DELETE /files/delete — body: { path } */
fileRoutes.delete("/delete", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ path: string }>();
    if (!body.path) {
      return c.json(err("Missing required field: path"), 400);
    }
    fileService.deleteFile(projectPath, body.path);
    return c.json(ok({ deleted: body.path }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /files/compare?file1=path1&file2=path2 */
fileRoutes.get("/compare", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const file1 = c.req.query("file1");
    const file2 = c.req.query("file2");
    if (!file1 || !file2) {
      return c.json(err("Missing query parameters: file1, file2"), 400);
    }
    // Support absolute paths (files outside project, e.g. /tmp/)
    const readSide = (p: string) =>
      isAbsolute(p) ? readSystemFileSync(p).content : fileService.readFile(projectPath, p).content;
    const original = readSide(file1);
    const modified = readSide(file2);
    return c.json(ok({ original, modified }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /files/rename — body: { oldPath, newPath } */
fileRoutes.post("/rename", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ oldPath: string; newPath: string }>();
    if (!body.oldPath || !body.newPath) {
      return c.json(err("Missing required fields: oldPath, newPath"), 400);
    }
    fileService.renameFile(projectPath, body.oldPath, body.newPath);
    return c.json(ok({ renamed: { from: body.oldPath, to: body.newPath } }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /files/resolve?name=filename — resolve filename to project path(s) */
fileRoutes.get("/resolve", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const name = c.req.query("name");
    if (!name || name.includes("/") || name.includes("\\")) {
      return c.json(err("Invalid filename"), 400);
    }
    const matches = fileService.resolveFilename(projectPath, name);
    return c.json(ok({ matches }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /files/search ? bounded, asynchronous project content search. */
fileRoutes.get("/search", async (c) => {
  try {
    const result = await searchProjectContent(c.get("projectPath"), {
      query: (c.req.query("q") ?? "").trim(),
      caseSensitive: c.req.query("caseSensitive") === "true",
      wholeWord: c.req.query("wholeWord") === "true",
      regex: c.req.query("regex") === "true",
      include: (c.req.query("include") ?? "").trim(),
    });
    return c.json(ok(result));
  } catch (error) {
    return c.json(err((error as Error).message), error instanceof ProjectSearchError ? error.status : 500);
  }
});

/** POST /files/move — body: { source, destination } */
fileRoutes.post("/move", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ source: string; destination: string }>();
    if (!body.source || !body.destination) {
      return c.json(err("Missing required fields: source, destination"), 400);
    }
    fileService.moveFile(projectPath, body.source, body.destination);
    return c.json(ok({ moved: { from: body.source, to: body.destination } }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /files/copy — body: { source, destination } */
fileRoutes.post("/copy", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ source: string; destination: string }>();
    if (!body.source || !body.destination) {
      return c.json(err("Missing required fields: source, destination"), 400);
    }
    fileService.copyFile(projectPath, body.source, body.destination);
    return c.json(ok({ copied: { from: body.source, to: body.destination } }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});
