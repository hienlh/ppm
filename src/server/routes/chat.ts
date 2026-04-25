import { Hono } from "hono";
import { resolve, join, basename } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { renameSession as sdkRenameSession } from "@anthropic-ai/claude-agent-sdk";
import { listSlashItems, searchSlashItems, invalidateCache } from "../../services/slash-items.service.ts";
import { upsertSlashRecent, getSlashRecents } from "../../services/db.service.ts";
import { getCachedUsage, refreshUsageNow } from "../../services/claude-usage.service.ts";
import { getSessionLog } from "../../services/session-log.service.ts";
import { parseJsonlTranscript, validateJsonlPath } from "../../services/jsonl-transcript-parser.ts";
import { getSessionProjectPath, setSessionMetadata, setSessionTitle, getPinnedSessionIds, pinSession, unpinSession, deleteSessionMapping, deleteSessionMetadata, deleteSessionTitle, getAllUnread, clearSessionUnread } from "../../services/db.service.ts";
import { setSessionTag, bulkSetSessionTag, getTagById, getSessionTags, getProjectDefaultTagId } from "../../services/tag.service.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const chatRoutes = new Hono<Env>();

/** GET /chat/slash-items — list available slash commands and skills for the project */
chatRoutes.get("/slash-items", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const q = c.req.query("q");
    let items = listSlashItems(projectPath);
    const recentNames = getSlashRecents(projectPath);
    if (q) items = searchSlashItems(items, q, 20, recentNames);
    return c.json(ok({ items, recentNames }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /chat/slash-items/cache — invalidate cached slash items for this project */
chatRoutes.delete("/slash-items/cache", (c) => {
  try {
    invalidateCache(c.get("projectPath"));
    return c.json(ok({ invalidated: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /chat/slash-recents — record usage of a slash item */
chatRoutes.post("/slash-recents", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { name, type } = await c.req.json<{ name: string; type: string }>();
    if (!name || !type) return c.json(err("name and type required"), 400);
    upsertSlashRecent(projectPath, name, type);
    return c.json(ok({ recorded: true }));
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
    const tagIdParam = c.req.query("tag_id");
    const filterTagId = tagIdParam ? parseInt(tagIdParam, 10) : null;
    const searchQuery = c.req.query("q")?.toLowerCase().trim() || "";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;

    const sessions = await chatService.listSessions(providerId, projectPath, { limit, offset });
    const pinnedIds = getPinnedSessionIds();

    // On first page, fetch pinned sessions that may be outside the current page
    let pinnedSessions: typeof sessions = [];
    if (offset === 0 && pinnedIds.size > 0) {
      const pageIds = new Set(sessions.map((s) => s.id));
      const missingPinnedIds = [...pinnedIds].filter((id) => !pageIds.has(id));
      if (missingPinnedIds.length > 0) {
        // Fetch individual pinned sessions by ID via SDK
        const claudeProvider = providerRegistry.get("claude") as any;
        if (claudeProvider?.getSessionInfoById) {
          const results = await Promise.all(
            missingPinnedIds.map((id) => claudeProvider.getSessionInfoById(id, projectPath)),
          );
          pinnedSessions = results.filter((s: any): s is NonNullable<typeof s> => s != null);
        }
      }
    }

    // Merge and enrich with pin status
    const merged = [...pinnedSessions, ...sessions];
    const seen = new Set<string>();
    const deduped = merged.filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
    const tagMap = getSessionTags(deduped.map((s) => s.id));
    const enriched = deduped.map((s) => ({ ...s, pinned: pinnedIds.has(s.id), tag: tagMap[s.id] ?? null }));

    // Sort: pinned first, then by createdAt desc
    enriched.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Server-side search + tag filter
    let filtered = enriched;
    if (searchQuery) filtered = filtered.filter((s) => (s.title || "").toLowerCase().includes(searchQuery));
    if (filterTagId !== null) filtered = filtered.filter((s) => s.tag?.id === filterTagId);
    const hasMore = sessions.length >= limit;
    return c.json(ok({ sessions: filtered, hasMore }));
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
    // Auto-assign default tag if project has one
    const defaultTagId = getProjectDefaultTagId(projectPath);
    if (defaultTagId) setSessionTag(session.id, defaultTagId, projectPath);
    return c.json(ok(session), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** DELETE /chat/sessions — bulk delete sessions older than N days */
chatRoutes.delete("/sessions", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const providerId = c.req.query("providerId") ?? "claude";
    const olderThanDays = parseInt(c.req.query("olderThanDays") ?? "0", 10);
    if (!olderThanDays || olderThanDays < 1) return c.json(err("olderThanDays must be >= 1"), 400);

    const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
    // Fetch all sessions (paginate through) to find old ones
    const allSessions: { id: string; createdAt: string; providerId: string }[] = [];
    let offset = 0;
    const batchSize = 200;
    while (true) {
      const batch = await chatService.listSessions(providerId, projectPath, { limit: batchSize, offset });
      allSessions.push(...batch);
      if (batch.length < batchSize) break;
      offset += batchSize;
    }

    const pinnedIds = getPinnedSessionIds();
    const toDelete = allSessions.filter((s) =>
      new Date(s.createdAt) < cutoff && !pinnedIds.has(s.id),
    );

    let deleted = 0;
    for (const s of toDelete) {
      try {
        await chatService.deleteSession(s.providerId ?? providerId, s.id);
        deleteSessionMapping(s.id);
        setSessionTag(s.id, null, projectPath);
        deleteSessionMetadata(s.id);
        deleteSessionTitle(s.id);
        unpinSession(s.id);
        deleted++;
      } catch { /* skip individual failures */ }
    }

    return c.json(ok({ deleted, total: toDelete.length }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /chat/sessions/:id — delete a session */
chatRoutes.delete("/sessions/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const providerId = c.req.query("providerId") ?? "claude";
    // Provider-specific cleanup (JSONL, process, etc.)
    await chatService.deleteSession(providerId, id);
    // Shared DB cleanup
    deleteSessionMapping(id); // legacy cleanup
    setSessionTag(id, null, c.get("projectPath"));
    deleteSessionMetadata(id);
    deleteSessionTitle(id);
    unpinSession(id);
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
    const projectPath = c.get("projectPath");
    // Persist to PPM DB (authoritative source for user-set titles)
    setSessionTitle(id, title);
    // Also persist to SDK so Claude Code CLI sees the custom title
    await sdkRenameSession(id, title, { dir: projectPath });
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

/** GET /chat/sessions/unread — get all sessions with unread notifications */
chatRoutes.get("/sessions/unread", (c) => {
  try {
    return c.json(ok(getAllUnread()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /chat/sessions/:id/read — mark a session as read */
chatRoutes.post("/sessions/:id/read", async (c) => {
  try {
    const id = c.req.param("id");
    clearSessionUnread(id);
    // Broadcast to all WS clients so other tabs/devices sync
    const { broadcastGlobalEvent } = await import("../ws/chat.ts");
    broadcastGlobalEvent({ type: "session:unread_changed", sessionId: id, unreadCount: 0, unreadType: null, projectName: "" });
    return c.json(ok({ id, unreadCount: 0 }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PATCH /chat/sessions/bulk-tag — assign tag to multiple sessions (MUST be before /sessions/:id) */
chatRoutes.patch("/sessions/bulk-tag", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { sessionIds, tagId } = await c.req.json<{ sessionIds: string[]; tagId: number | null }>();
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return c.json(err("sessionIds array required"), 400);
    if (sessionIds.length > 100) return c.json(err("Max 100 sessions per bulk operation"), 400);
    if (tagId !== null) {
      const tag = getTagById(tagId);
      if (!tag || tag.projectPath !== projectPath) return c.json(err("Tag not found"), 404);
    }
    bulkSetSessionTag(sessionIds, tagId, projectPath);
    return c.json(ok({ updated: sessionIds.length }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PATCH /chat/sessions/:id/tag — assign a tag to a session */
chatRoutes.patch("/sessions/:id/tag", async (c) => {
  try {
    const id = c.req.param("id");
    const projectPath = c.get("projectPath");
    const { tagId } = await c.req.json<{ tagId: number }>();
    if (tagId == null || typeof tagId !== "number") return c.json(err("tagId is required"), 400);
    const tag = getTagById(tagId);
    if (!tag || tag.projectPath !== projectPath) return c.json(err("Tag not found"), 404);
    setSessionTag(id, tagId, projectPath);
    return c.json(ok({ id, tagId }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /chat/sessions/:id/tag — remove tag from a session */
chatRoutes.delete("/sessions/:id/tag", (c) => {
  try {
    const id = c.req.param("id");
    setSessionTag(id, null, c.get("projectPath"));
    return c.json(ok({ id, tagId: null }));
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

    if (body.messageId) {
      // Mid-fork at a specific message
      if (!provider.forkAtMessage) {
        return c.json(err("Provider does not support forking"), 400);
      }
      try {
        const result = await provider.forkAtMessage(sourceId, body.messageId, {
          title: "Forked Chat", dir: projectPath,
        });
        // Register forked session with provider + DB so it's tracked in memory
        setSessionMetadata(result.sessionId, projectName, projectPath);
        await provider.resumeSession(result.sessionId);
        provider.markAsResumed?.(result.sessionId);
        const forkedSession = {
          id: result.sessionId,
          providerId,
          title: "Forked Chat",
          projectName,
          projectPath,
          createdAt: new Date().toISOString(),
        };
        return c.json(ok({ ...forkedSession, forkedFrom: sourceId }), 201);
      } catch (forkErr) {
        // Message UUID may no longer exist after SDK compaction — fall back to fresh session
        console.warn(`[chat] forkAtMessage failed (message may be compacted): ${(forkErr as Error).message}`);
        const session = await chatService.createSession(providerId, {
          projectName, projectPath, title: "Forked Chat",
        });
        return c.json(ok({ ...session, forkedFrom: sourceId }), 201);
      }
    } else {
      // No messageId (fork at first message) — create a fresh empty session
      const session = await chatService.createSession(providerId, {
        projectName, projectPath, title: "Forked Chat",
      });
      return c.json(ok({ ...session, forkedFrom: sourceId }), 201);
    }
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
  const sessionId = c.req.param("id");
  // Resolve JSONL path: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
  const homedir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const provider = providerRegistry.get("claude") as any;
  // Try in-memory first, fall back to DB-persisted project_path
  const projectPath = provider?.activeSessions?.get(sessionId)?.projectPath
    ?? getSessionProjectPath(sessionId)
    ?? "";
  const encodedCwd = projectPath ? projectPath.replace(/\//g, "-") : "";
  const jsonlDir = encodedCwd ? resolve(homedir, ".claude", "projects", encodedCwd) : "";
  const jsonlPath = jsonlDir ? resolve(jsonlDir, `${sessionId}.jsonl`) : "";
  const jsonlExists = jsonlPath ? existsSync(jsonlPath) : false;
  // PPM session ID == SDK session ID (canonical — see claude-agent-sdk.ts:728).
  // Return both fields so FE debug UI shows them clearly; they are the same value.
  return c.json(ok({
    ppmSessionId: sessionId,
    sdkSessionId: sessionId,
    sessionId,
    jsonlPath: jsonlExists ? jsonlPath : null,
    jsonlDir,
    projectPath,
  }));
});

/** GET /chat/pre-compact-messages — read and parse a JSONL transcript file (for expand-compact feature) */
chatRoutes.get("/pre-compact-messages", async (c) => {
  try {
    const jsonlPath = c.req.query("jsonlPath");
    const beforeUuid = c.req.query("before");
    if (!jsonlPath) return c.json(err("jsonlPath query param required"), 400);
    const validated = validateJsonlPath(jsonlPath);
    const messages = await parseJsonlTranscript(validated, beforeUuid);
    return c.json(ok(messages));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = /not found/i.test(message) ? 404
      : /denied|traversal|Invalid path|too large|Not a regular/i.test(message) ? 403
      : 500;
    return c.json(err(message), status);
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
