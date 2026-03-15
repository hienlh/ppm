import { Hono } from "hono";
import { resolve, join, basename } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { listSlashItems } from "../../services/slash-items.service.ts";
import { fetchClaudeUsage } from "../../services/claude-usage.service.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const chatRoutes = new Hono<Env>();

/** GET /chat/slash-items — list available slash commands and skills for the project */
chatRoutes.get("/slash-items", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const items = listSlashItems(projectPath);
    return c.json(ok(items));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/usage — get current usage/rate-limit info via ccburn */
chatRoutes.get("/usage", async (c) => {
  try {
    const usage = await fetchClaudeUsage();
    return c.json(ok({
      fiveHour: usage.session?.utilization,
      sevenDay: usage.weekly?.utilization,
      fiveHourResetsAt: usage.session?.resetsAt,
      sevenDayResetsAt: usage.weekly?.resetsAt,
      // Extra detail for popup
      session: usage.session,
      weekly: usage.weekly,
      weeklyOpus: usage.weeklyOpus,
      weeklySonnet: usage.weeklySonnet,
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/providers — list available AI providers */
chatRoutes.get("/providers", (c) => {
  try {
    return c.json(ok(providerRegistry.list()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/sessions — list chat sessions filtered by project from context */
chatRoutes.get("/sessions", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const providerId = c.req.query("providerId");
    const sessions = await chatService.listSessions(providerId, projectPath);
    return c.json(ok(sessions));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/sessions/:id/messages — get message history */
chatRoutes.get("/sessions/:id/messages", async (c) => {
  try {
    const id = c.req.param("id");
    const providerId = c.req.query("providerId") ?? "claude-sdk";
    const messages = await chatService.getMessages(providerId, id);
    return c.json(ok(messages));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /chat/sessions — create a new session for the project in context */
chatRoutes.post("/sessions", async (c) => {
  try {
    const projectName = c.get("projectName");
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ providerId?: string; title?: string }>();
    const session = await chatService.createSession(body.providerId, {
      projectName,
      projectPath,
      title: body.title,
    });
    return c.json(ok(session), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** DELETE /chat/sessions/:id — delete a session */
chatRoutes.delete("/sessions/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const providerId = c.req.query("providerId") ?? "claude-sdk";
    await chatService.deleteSession(providerId, id);
    return c.json(ok({ deleted: id }));
  } catch (e) {
    return c.json(err((e as Error).message), 404);
  }
});

/** POST /chat/upload — upload files for chat attachments, returns server-side paths */
chatRoutes.post("/upload", async (c) => {
  try {
    const body = await c.req.parseBody({ all: true });
    const files = Array.isArray(body["files"]) ? body["files"] : body["files"] ? [body["files"]] : [];
    if (files.length === 0) return c.json(err("No files provided"), 400);

    const uploadDir = resolve(tmpdir(), "ppm-uploads");
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

    const results: Array<{ name: string; path: string; type: string; size: number }> = [];
    for (const entry of files) {
      if (!(entry instanceof File)) continue;
      const id = crypto.randomUUID().slice(0, 8);
      const safeName = entry.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const dest = join(uploadDir, `${id}-${safeName}`);
      const buf = await entry.arrayBuffer();
      await Bun.write(dest, buf);
      results.push({ name: entry.name, path: dest, type: entry.type, size: entry.size });
    }
    return c.json(ok(results), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/uploads/:filename — serve uploaded files (images, etc.) for preview */
chatRoutes.get("/uploads/:filename", async (c) => {
  try {
    const filename = c.req.param("filename");
    // Sanitize: only allow simple filenames, no path traversal
    if (!filename || filename.includes("/") || filename.includes("..")) {
      return c.json(err("Invalid filename"), 400);
    }
    const uploadDir = resolve(tmpdir(), "ppm-uploads");
    const filePath = join(uploadDir, filename);
    if (!existsSync(filePath)) return c.json(err("Not found"), 404);

    const file = Bun.file(filePath);
    return new Response(file.stream(), {
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
