import { Hono } from "hono";
import { resolve, basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import archiver from "archiver";
import { createDownloadToken } from "../../services/download-token.service.ts";
import { ok, err } from "../../types/api.ts";
import { errorStatus } from "../helpers/error-status.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const downloadRoutes = new Hono<Env>();

/** POST /token — generate a short-lived download token */
downloadRoutes.post("/token", (c) => {
  const token = createDownloadToken();
  return c.json(ok({ token }));
});

/** GET /zip?path=... — stream folder as zip */
downloadRoutes.get("/zip", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const dirPath = c.req.query("path");
    if (!dirPath) return c.json(err("Missing query parameter: path"), 400);

    const absPath = resolve(projectPath, dirPath);
    if (!absPath.startsWith(projectPath + "/") && absPath !== projectPath) {
      return c.json(err("Access denied"), 403);
    }
    if (!existsSync(absPath)) return c.json(err("Directory not found"), 404);

    const stat = statSync(absPath);
    if (!stat.isDirectory()) return c.json(err("Path is not a directory"), 400);

    const folderName = basename(absPath);
    const archive = archiver("zip", { zlib: { level: 5 } });

    archive.glob("**/*", {
      cwd: absPath,
      ignore: [".git/**", "node_modules/**"],
      dot: true,
    });
    archive.finalize();

    // Convert Node stream to web ReadableStream
    const webStream = new ReadableStream({
      start(controller) {
        archive.on("data", (chunk: Buffer) => controller.enqueue(chunk));
        archive.on("end", () => controller.close());
        archive.on("error", (e: Error) => controller.error(e));
      },
    });

    return new Response(webStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${folderName}.zip"`,
      },
    });
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});
