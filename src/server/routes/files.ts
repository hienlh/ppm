import { Hono } from "hono";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  fileService,
  SecurityError,
  NotFoundError,
  ValidationError,
} from "../../services/file.service.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const fileRoutes = new Hono<Env>();

/** Map error type to HTTP status code */
function errorStatus(e: unknown): ContentfulStatusCode {
  if (e instanceof SecurityError) return 403;
  if (e instanceof NotFoundError) return 404;
  if (e instanceof ValidationError) return 400;
  return 500;
}

/** GET /files/tree?depth=3 */
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

/** GET /files/raw?path=... — serve file directly as binary (for PDF viewer, images, etc.) */
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

    const file = Bun.file(absPath);
    return new Response(file.stream(), {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Content-Disposition": "inline",
      },
    });
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
    const original = fileService.readFile(projectPath, file1);
    const modified = fileService.readFile(projectPath, file2);
    return c.json(ok({ original: original.content, modified: modified.content }));
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

/** GET /files/search?q=...&caseSensitive=false — search file content with grep */
fileRoutes.get("/search", async (c) => {
  const projectPath = c.get("projectPath");
  const q = (c.req.query("q") ?? "").trim();
  const caseSensitive = c.req.query("caseSensitive") === "true";

  if (q.length < 2) return c.json(ok({ results: [], total: 0 }));

  try {
    const EXCLUDE_DIRS = ["node_modules", ".git", "dist", ".next", "build", ".turbo", "coverage", "__pycache__"];
    const excludeDirArgs = EXCLUDE_DIRS.flatMap((d) => ["--exclude-dir", d]);
    const excludeArgs = ["--exclude=*.min.js", "--exclude=*.map", "--exclude=*.lock", "--exclude=bun.lock"];
    const flags = ["-rn", "--max-count=5", "-I", ...(caseSensitive ? [] : ["-i"])];

    const proc = Bun.spawnSync({
      cmd: ["grep", ...flags, ...excludeDirArgs, ...excludeArgs, "--", q, projectPath],
      stdout: "pipe",
      stderr: "pipe",
    });

    const raw = proc.stdout.toString();
    if (!raw.trim()) return c.json(ok({ results: [], total: 0 }));

    // Parse grep output: /abs/path/file.ts:42:content
    const fileMap = new Map<string, { lineNum: number; content: string }[]>();
    for (const line of raw.split("\n")) {
      if (!line) continue;
      // Strip projectPath prefix, then split on first two colons
      const rel = line.startsWith(projectPath) ? line.slice(projectPath.length + 1) : line;
      const firstColon = rel.indexOf(":");
      if (firstColon < 0) continue;
      const secondColon = rel.indexOf(":", firstColon + 1);
      if (secondColon < 0) continue;
      const filePath = rel.slice(0, firstColon);
      const lineNum = parseInt(rel.slice(firstColon + 1, secondColon), 10);
      const content = rel.slice(secondColon + 1).trimEnd();
      if (!filePath || isNaN(lineNum)) continue;
      if (!fileMap.has(filePath)) fileMap.set(filePath, []);
      fileMap.get(filePath)!.push({ lineNum, content });
    }

    const results = Array.from(fileMap.entries()).map(([file, matches]) => ({ file, matches }));
    const total = results.reduce((sum, r) => sum + r.matches.length, 0);
    return c.json(ok({ results, total }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
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
