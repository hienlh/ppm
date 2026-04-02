import { Hono } from "hono";
import { resolve, join, basename } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { renameSession as sdkRenameSession } from "@anthropic-ai/claude-agent-sdk";
import { listSlashItems } from "../../services/slash-items.service.ts";
import { getCachedUsage, refreshUsageNow } from "../../services/claude-usage.service.ts";
import { getSessionLog } from "../../services/session-log.service.ts";
import { getSessionMapping, setSessionMapping, setSessionTitle, getPinnedSessionIds, pinSession, unpinSession, deleteSessionMapping, deleteSessionTitle } from "../../services/db.service.ts";
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

/** GET /chat/usage — return cached usage. ?refresh=1 forces fresh fetch first. */
chatRoutes.get("/usage", async (c) => {
  if (c.req.query("refresh")) {
    try { await refreshUsageNow(); } catch { /* use stale cache */ }
  }
  const usage = getCachedUsage();
  return c.json(ok({
    lastFetchedAt: usage.lastFetchedAt,
    fiveHour: usage.session?.utilization,
    sevenDay: usage.weekly?.utilization,
    fiveHourResetsAt: usage.session?.resetsAt,
    sevenDayResetsAt: usage.weekly?.resetsAt,
    session: usage.session,
    weekly: usage.weekly,
    weeklyOpus: usage.weeklyOpus,
    weeklySonnet: usage.weeklySonnet,
    totalCostUsd: usage.totalCostUsd,
    activeAccountId: usage.activeAccountId,
    activeAccountLabel: usage.activeAccountLabel,
  }));
});

/** GET /chat/providers — list available AI providers */
chatRoutes.get("/providers", (c) => {
  try {
    return c.json(ok(providerRegistry.list()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/providers/:providerId/models — list available models for a provider */
chatRoutes.get("/providers/:providerId/models", async (c) => {
  try {
    const providerId = c.req.param("providerId");
    const provider = providerRegistry.get(providerId);
    if (!provider) return c.json(err(`Provider "${providerId}" not found`), 404);
    const models = await provider.listModels?.() ?? [];
    return c.json(ok(models));
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
    // Enrich with pin status
    const pinnedIds = getPinnedSessionIds();
    const enriched = sessions.map((s) => ({ ...s, pinned: pinnedIds.has(s.id) }));
    // Sort: pinned first (by pinned_at implicit via Set order), then unpinned by createdAt
    enriched.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return c.json(ok(enriched));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/sessions/:id/messages — get message history */
chatRoutes.get("/sessions/:id/messages", async (c) => {
  try {
    const id = c.req.param("id");
    const providerId = c.req.query("providerId") ?? "claude";
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
    const providerId = c.req.query("providerId") ?? "claude";
    const sdkId = getSessionMapping(id) ?? id;
    // Provider-specific cleanup (JSONL, process, etc.)
    await chatService.deleteSession(providerId, id);
    // Shared DB cleanup
    deleteSessionMapping(id);
    deleteSessionTitle(sdkId);
    unpinSession(sdkId);
    return c.json(ok({ deleted: id }));
  } catch (e) {
    return c.json(err((e as Error).message), 404);
  }
});

/** PATCH /chat/sessions/:id — rename a session */
chatRoutes.patch("/sessions/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ title?: string }>();
    if (!body.title?.trim()) return c.json(err("title is required"), 400);
    const title = body.title.trim();
    // Resolve PPM UUID → SDK session ID if mapped
    const sdkId = getSessionMapping(id) ?? id;
    const projectPath = c.get("projectPath");
    // Persist to PPM DB (authoritative source for user-set titles)
    setSessionTitle(sdkId, title);
    // Also persist to SDK so Claude Code CLI sees the custom title
    await sdkRenameSession(sdkId, title, { dir: projectPath });
    // Also update in-memory session
    const session = chatService.getSession(id);
    if (session) session.title = title;
    return c.json(ok({ id, title }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PUT /chat/sessions/:id/pin — pin a session */
chatRoutes.put("/sessions/:id/pin", (c) => {
  try {
    const id = c.req.param("id");
    pinSession(id);
    return c.json(ok({ id, pinned: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /chat/sessions/:id/pin — unpin a session */
chatRoutes.delete("/sessions/:id/pin", (c) => {
  try {
    const id = c.req.param("id");
    unpinSession(id);
    return c.json(ok({ id, pinned: false }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /chat/sessions/:id/fork — fork session into a new one (for rewind/branch) */
chatRoutes.post("/sessions/:id/fork", async (c) => {
  try {
    const sourceId = c.req.param("id");
    const projectName = c.get("projectName");
    const projectPath = c.get("projectPath");
    const providerId = c.req.query("providerId") ?? "claude";
    const body = await c.req.json<{ messageId?: string }>().catch(() => ({} as { messageId?: string }));
    const provider = providerRegistry.get(providerId);
    if (!provider) return c.json(err("Provider not found"), 404);

    // Create a new PPM session
    const session = await chatService.createSession(providerId, {
      projectName,
      projectPath,
      title: "Forked Chat",
    });

    if (body.messageId && provider.forkAtMessage) {
      // Mid-fork: immediate SDK fork at specific message
      const result = await provider.forkAtMessage(sourceId, body.messageId, {
        title: session.title, dir: projectPath,
      });
      // Map new PPM id → new SDK session id
      setSessionMapping(session.id, result.sessionId);
      // Mark so next sendMessage uses resume (not create new)
      provider.markAsResumed?.(session.id);
    } else if (provider.setForkSource) {
      // Deferred fork from end (current behavior — full history copy on first msg)
      provider.setForkSource(session.id, sourceId);
    } else {
      return c.json(err("Provider does not support forking"), 400);
    }

    return c.json(ok({ ...session, forkedFrom: sourceId }), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/sessions/:id/logs — get session-level debug logs */
chatRoutes.get("/sessions/:id/logs", (c) => {
  try {
    const id = c.req.param("id");
    const tail = parseInt(c.req.query("tail") ?? "200", 10);
    const logs = getSessionLog(id, tail);
    return c.json(ok({ logs }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/sessions/:id/debug — session debug info (IDs, JSONL path) */
chatRoutes.get("/sessions/:id/debug", (c) => {
  const ppmId = c.req.param("id");
  const sdkId = getSessionMapping(ppmId) ?? ppmId;
  const projectName = c.req.query("project") ?? "";
  // Resolve JSONL path: ~/.claude/projects/<encoded-cwd>/<sdkId>.jsonl
  const homedir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const provider = providerRegistry.get("claude") as any;
  const projectPath = provider?.activeSessions?.get(ppmId)?.projectPath ?? "";
  const encodedCwd = projectPath ? projectPath.replace(/\//g, "-") : "";
  const jsonlDir = encodedCwd ? resolve(homedir, ".claude", "projects", encodedCwd) : "";
  const jsonlPath = jsonlDir ? resolve(jsonlDir, `${sdkId}.jsonl`) : "";
  const jsonlExists = jsonlPath ? existsSync(jsonlPath) : false;
  return c.json(ok({ ppmSessionId: ppmId, sdkSessionId: sdkId, jsonlPath: jsonlExists ? jsonlPath : null, jsonlDir, projectPath }));
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
