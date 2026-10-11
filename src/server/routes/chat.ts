import { Hono } from "hono";
import { resolve, join, basename } from "node:path";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { countLines } from "../../services/file-lines.ts";
import { ensureUploadsDir, resolveUploadPath } from "../../services/chat-upload-storage.service.ts";
import { chatService } from "../../services/chat.service.ts";
import { createProjectChatSession } from "../../services/chat-session-create.ts";
import { isValidDesignSlug } from "../../services/design/design-slug.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import { draftService } from "../../services/draft.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { renameSession as sdkRenameSession } from "@anthropic-ai/claude-agent-sdk";
import { searchSlashItems, invalidateCache } from "../../services/slash-items.service.ts";
import { invalidateSdkCommands } from "../../services/slash-discovery/sdk-commands.ts";
import { listSlashItemsForProvider } from "../../services/slash-items-for-provider.ts";
import { readUsageSnapshot } from "../../services/chat-usage-snapshot.service.ts";
import { chatPrepareRoutes } from "./chat-prepare.ts";
import { chatFileChangesRoutes } from "./chat-file-changes.ts";
import { deleteSessionBaselines } from "../../services/session-file-baselines/session-file-baselines.service.ts";
import { upsertSlashRecent, getSlashRecents, listTurnUsage, getSessionProvider, getSessionDesignSlugs, copySessionForkSettings } from "../../services/db.service.ts";
import type { TurnUsage } from "../../shared/turn-usage.ts";
import { refreshUsageNow } from "../../services/claude-usage.service.ts";
import { bindPickedAccount, bindRefusalReason } from "../../services/picked-account-binding.ts";
import { getSessionLog } from "../../services/session-log.service.ts";
import { parseJsonlTranscript, validateJsonlPath } from "../../services/jsonl-transcript-parser.ts";
import { parseCompactSegment } from "../../services/compact-segment.ts";
import { aggregateTasks } from "../../services/task-status-aggregator.ts";
import { MANY_IMAGE_DIMENSION_LIMIT, type StripMode } from "../../services/transcript-images.ts";
import { auditTranscriptImagesFile, stripTranscriptImagesFile } from "../../services/transcript-images-file.ts";
import { listCodexAccounts } from "../../services/codex-account.service.ts";
import { codexUsageSource } from "../../providers/codex-app-server/codex-usage-source.ts";
import { invalidateUsage, refreshUsage, registerUsageSource } from "../../services/provider-usage/usage-registry.ts";
import { findRolloutByThreadId } from "../../providers/codex-app-server/codex-history.ts";
import { getSessionProjectPath, setSessionMetadata, setSessionTitle, getSessionTitle, getPinnedSessionIds, pinSession, unpinSession, deleteSessionMapping, deleteSessionMetadata, deleteSessionTitle, getAllUnread, clearSessionUnread, setSessionUnread } from "../../services/db.service.ts";
import { setSessionTag, bulkSetSessionTag, getTagById } from "../../services/tag.service.ts";
import { recordBranch, resolveVersionGroup, hasChildren, deleteBranchesFor } from "../../services/session-branch.service.ts";
import { listProjectSessions, searchProjectChats } from "../../services/chat-session-queries.service.ts";
import { readSessionHistory } from "../../services/chat-history-read.service.ts";
import { parseHistoryPageQuery } from "./chat-history-page.ts";
import { ok, err } from "../../types/api.ts";
import { VALID_PERMISSION_MODES } from "../../types/config.ts";
import { THINKING_ADAPTIVE, VALID_EFFORT_VALUES } from "../../providers/claude-agent-sdk-query-options.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("chat");

type Env = { Variables: { projectPath: string; projectName: string } };

export const chatRoutes = new Hono<Env>();

chatRoutes.route("/prepare", chatPrepareRoutes);
chatRoutes.route("/", chatFileChangesRoutes);

/** GET /chat/slash-items — list available slash commands and skills for the project */
chatRoutes.get("/slash-items", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const q = c.req.query("q");
    const sessionId = c.req.query("sessionId") || undefined;
    // A brand-new tab has no DB row yet, so the client's own view of which
    // provider it is on wins; the stored value is the fallback for reloads.
    const providerId = c.req.query("providerId")
      || (sessionId ? getSessionProvider(sessionId) : null)
      || undefined;

    let items = await listSlashItemsForProvider(projectPath, providerId, sessionId);
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
    invalidateSdkCommands(c.get("projectPath"));
    for (const { id } of providerRegistry.listAll()) {
      providerRegistry.get(id)?.invalidateSkillsCache?.();
    }
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

/**
 * GET /chat/usage — return cached usage. ?refresh=1 forces fresh fetch first.
 *
 * `?accountId=` is honoured for Claude only when `?session=` is absent: a session's binding
 * is authoritative once it exists, but a brand-new tab that has already claimed an account
 * (via `/chat/prepare` or `/api/accounts/pick`) has no session to bind it to yet, and its
 * usage chip must show the account it will actually run on.
 */
chatRoutes.get("/usage", async (c) => {
  const providerId = c.req.query("providerId");
  const sessionId = c.req.query("session");
  const accountId = c.req.query("accountId");
  if (c.req.query("refresh")) {
    if (providerId && providerId !== "claude") {
      const provider = providerRegistry.get(providerId);
      if (provider?.getUsage) {
        if (providerId === "codex") {
          // A memory-only invalidation promotes an old database snapshot on the next read.
          // Fetch every account live; parallel reads stay within the client's 30s timeout.
          registerUsageSource(codexUsageSource);
          const accounts = codexUsageSource.listAccountIds();
          const ids = accounts.length > 0 ? accounts : [""];
          await Promise.all(ids.map((id) => refreshUsage("codex", id)));
        } else {
          invalidateUsage(providerId);
        }
      }
    } else {
      try { await refreshUsageNow(); } catch { /* use stale cache */ }
    }
  }
  return c.json(ok(await readUsageSnapshot(providerId, { sessionId, accountId })));
});

/** GET /chat/providers — list available AI providers */
chatRoutes.get("/providers", (c) => {
  try {
    // The capabilities ride along so a client offering design or Assistant sessions can list
    // only the providers that will actually deliver the instructions and enforce the policy.
    return c.json(ok(providerRegistry.listWithCapabilities()));
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
    const tagIdParam = c.req.query("tag_id");
    const result = await listProjectSessions(c.get("projectPath"), {
      providerId: c.req.query("providerId"),
      tagId: tagIdParam ? parseInt(tagIdParam, 10) : null,
      query: c.req.query("q")?.toLowerCase().trim() || "",
      limit: Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200),
      offset: parseInt(c.req.query("offset") ?? "0", 10) || 0,
    });
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/search — unified title + full-text content search for a project */
chatRoutes.get("/search", async (c) => {
  try {
    const rawQuery = c.req.query("q")?.trim() || "";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "30", 10) || 30, 100);
    return c.json(ok(await searchProjectChats(c.get("projectPath"), rawQuery, limit)));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * The design a session belongs to, if any. A chat tab asks on open: every surface that opens
 * sessions as plain chats (a notification, a search hit, a link) would otherwise take a design
 * session out of design mode, and this lets the tab hand itself over to the design tab.
 */
chatRoutes.get("/sessions/:id/design", (c) => {
  const id = c.req.param("id");
  return c.json(ok({ designSlug: getSessionDesignSlugs([id])[id] ?? null }));
});

/** GET /chat/sessions/:id/messages — one page of a session's message history */
chatRoutes.get("/sessions/:id/messages", async (c) => {
  try {
    const providerId = c.req.query("providerId") ?? "claude";
    const query = parseHistoryPageQuery((name) => c.req.query(name));
    return c.json(ok(await readSessionHistory(providerId, c.req.param("id"), query)));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /chat/prewarm — a new-chat tab is open here: start the process its first message
 * will run on, taking the picks that message will carry. The body is read the way the chat
 * socket reads that message, since a spare is only used when the two agree. Answered at once;
 * a request nothing can be started for (another provider, a small host, no claimed account)
 * just starts nothing.
 */
chatRoutes.post("/prewarm", async (c) => {
  const projectPath = c.get("projectPath");
  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const { providerId, accountId, permissionMode, model, effort, thinking } = body;
  const opts = {
    ...(VALID_PERMISSION_MODES.includes(permissionMode as never) && { permissionMode: permissionMode as string }),
    ...(typeof model === "string" && model && { model }),
    ...(VALID_EFFORT_VALUES.includes(effort as never) && { effort: effort as string }),
    ...(typeof thinking === "boolean" && { thinkingBudget: thinking ? THINKING_ADAPTIVE : 0 }),
  };
  void chatService
    .prewarm(typeof providerId === "string" ? providerId : undefined, {
      projectPath,
      accountId: typeof accountId === "string" ? accountId : undefined,
      opts,
    })
    .catch((e) => log.warn(`prewarm failed: ${(e as Error).message}`));
  return c.json(ok({ accepted: true }), 202);
});

/** POST /chat/sessions — create a new session for the project in context */
chatRoutes.post("/sessions", async (c) => {
  try {
    const projectName = c.get("projectName");
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ providerId?: string; title?: string; clearedFrom?: string; accountId?: string; designSlug?: unknown; assistant?: unknown }>();
    // An Assistant session lives only in the Assistant's virtual project, and every session
    // there is one (`chatService.createSession` marks it); the flag only has to agree.
    const assistant = isAssistantProject(projectName);
    if (body.assistant !== undefined && body.assistant !== assistant) {
      return c.json(err(assistant
        ? "Every session in the PPM Assistant project is an Assistant session"
        : "Assistant sessions can only be created in the PPM Assistant project"), 400);
    }
    // A design session is only created on a provider that will carry its instructions;
    // anywhere else it would silently be an ordinary chat that believes it is not.
    const designSlug = body.designSlug;
    if (assistant && designSlug !== undefined && designSlug !== null) {
      return c.json(err("An Assistant session cannot be a design session"), 400);
    }
    if (designSlug !== undefined && designSlug !== null) {
      if (!isValidDesignSlug(designSlug)) return c.json(err("Invalid designSlug"), 400);
      const provider = body.providerId ? providerRegistry.get(body.providerId) : providerRegistry.getDefault();
      if (!provider) return c.json(err(`Provider "${body.providerId}" not found`), 400);
      if (!provider.supportsDesignInstructions) {
        return c.json(err(`Provider "${provider.id}" does not support design sessions`), 400);
      }
    }
    const session = await createProjectChatSession({
      providerId: body.providerId,
      projectName,
      projectPath,
      title: body.title,
      // A design or Assistant session spawns with its own instructions, so a spare would not fit it.
      adoptWarmSpare: !isValidDesignSlug(designSlug) && !assistant,
      ...(typeof body.clearedFrom === "string" && body.clearedFrom ? { clearedFrom: body.clearedFrom } : {}),
      ...(isValidDesignSlug(designSlug) ? { designSlug } : {}),
      ...(typeof body.accountId === "string" && body.accountId ? { accountId: body.accountId } : {}),
    });
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
      new Date(s.createdAt) < cutoff && !pinnedIds.has(s.id) && !hasChildren(s.id),
    );

    let deleted = 0;
    let firstFailure: string | undefined;
    for (const s of toDelete) {
      try {
        await chatService.deleteSession(s.providerId ?? providerId, s.id);
        deleteSessionMapping(s.id);
        setSessionTag(s.id, null, projectPath);
        deleteSessionMetadata(s.id);
        deleteSessionTitle(s.id);
        unpinSession(s.id);
        deleteBranchesFor(s.id);
        deleteSessionBaselines(s.id);
        try { draftService.delete(projectPath, s.id); } catch { /* ignore */ }
        deleted++;
      } catch (e) {
        // Skipped, as before. One WARN per failure would repeat for every session a single fault
        // reaches, so each is DEBUG and the summary below says how many and the first one.
        const msg = (e as Error).message;
        log.debug(`bulk delete session=${s.id} failed: ${msg}`);
        firstFailure ??= `session=${s.id}: ${msg}`;
      }
    }
    // Clean up any orphaned drafts left behind
    try { draftService.deleteOrphaned(); } catch { /* ignore */ }

    const summary = `bulk-deleted ${deleted}/${toDelete.length} sessions older than ${olderThanDays}d provider=${providerId} project=${c.get("projectName")}`;
    if (firstFailure) log.warn(`${summary} — ${toDelete.length - deleted} failed, first ${firstFailure}`);
    else log.info(summary);
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
    // Leaf-only: a session with edited versions branched from it cannot be
    // deleted (would orphan its children). Reparenting is out of scope.
    if (hasChildren(id)) {
      return c.json(err("Cannot delete: this session has edited versions branched from it"), 409);
    }
    // Provider-specific cleanup (JSONL, process, etc.)
    await chatService.deleteSession(providerId, id);
    // Shared DB cleanup
    deleteSessionMapping(id); // legacy cleanup
    setSessionTag(id, null, c.get("projectPath"));
    deleteSessionMetadata(id);
    deleteSessionTitle(id);
    unpinSession(id);
    deleteBranchesFor(id);
    deleteSessionBaselines(id);
    // Fire-and-forget draft cleanup
    try { draftService.delete(c.get("projectPath"), id); } catch { /* ignore */ }
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
    // Codex owns its rollout title and has no Claude SDK session to rename.
    // PPM's title table is the authoritative title for both providers.
    if (getSessionProvider(id) !== "codex") {
      await sdkRenameSession(id, title, { dir: projectPath });
    }
    // Also update in-memory session
    const session = chatService.getSession(id);
    if (session) session.title = title;
    return c.json(ok({ id, title }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * PUT /chat/sessions/:id/account — move a live session onto an account the user picked.
 *
 * Unlike the same choice made at session creation, this one answers: the user is looking at
 * a panel and pressed something, so a silently ignored pick would read as a broken button.
 *
 * Worth knowing before calling: the prompt cache is scoped per account, so moving a session
 * mid-conversation re-sends its whole transcript as a cache write rather than a read. On a
 * long session that is a real cost, not a formality.
 */
chatRoutes.put("/sessions/:id/account", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ accountId?: string }>().catch(() => ({} as { accountId?: string }));
  if (!body.accountId) return c.json(err("accountId is required"), 400);
  const providerId = getSessionProvider(sessionId) ?? "claude";
  if (!bindPickedAccount(sessionId, providerId, body.accountId)) {
    return c.json(err(bindRefusalReason(providerId, body.accountId)), 400);
  }
  // A subprocess already running keeps serving the account it was spawned with however the
  // binding reads: Codex's app-server runs under that account's CODEX_HOME, and Claude's CLI
  // holds that account's token in its environment while follow-ups are pushed straight into
  // it, so the binding is only read when a subprocess starts. Either way the switch appeared
  // to do nothing until something else happened to kill it. Dropping it while idle makes the
  // next message respawn on the account the user just picked.
  const { listRunningSessions, dropIdleSubprocess, hasBackgroundWork } = await import("../ws/chat.ts");
  // Never mid-turn — the answer being streamed would be lost — and never under a background
  // agent or shell, which dies with the subprocess. Either way the switch waits for the next
  // subprocess instead.
  if (!listRunningSessions().some((s) => s.sessionId === sessionId) && !hasBackgroundWork(sessionId)) {
    dropIdleSubprocess(
      sessionId,
      "account_switch",
      "Subprocess released: the session was moved to another account",
    );
  }
  return c.json(ok({ accountId: body.accountId }));
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

/**
 * GET /chat/sessions/running — sessions in this project with a turn in flight.
 *
 * Lets the frontend show the tab-strip spinner and title indicator for a running
 * session whose chat tab is not mounted (tabs mount lazily). Reads the in-memory
 * WS session registry, so it is O(active sessions) with no DB access.
 * Static `running` segment mirrors `/sessions/unread` above.
 */
chatRoutes.get("/sessions/running", async (c) => {
  try {
    const { listRunningSessions } = await import("../ws/chat.ts");
    return c.json(ok(listRunningSessions(c.get("projectName"))));
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

/** POST /chat/sessions/:id/unread — manually mark a session as unread (Gmail-style; clears on open).
 *  Body { projectName } is persisted + broadcast so the unread is clearable cross-device. */
chatRoutes.post("/sessions/:id/unread", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as { projectName?: string };
    const projectName = body.projectName ?? "";
    const title = getSessionTitle(id);
    setSessionUnread(id, "done", title, projectName || null);
    // Broadcast to all WS clients so other tabs/devices sync
    const { broadcastGlobalEvent } = await import("../ws/chat.ts");
    broadcastGlobalEvent({ type: "session:unread_changed", sessionId: id, unreadCount: 1, unreadType: "done", projectName, sessionTitle: title, manual: true });
    return c.json(ok({ id, unreadCount: 1 }));
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
    // "edit" = same-tab edit-message (a version of the same conversation) — must
    // keep the original title. Anything else is an explicit fork, which may keep
    // the provider's own "(fork)"-suffixed name.
    const isEdit = c.req.query("mode") === "edit";
    const body = await c.req.json<{ messageId?: string }>().catch(() => ({} as { messageId?: string }));
    const provider = providerRegistry.get(providerId);
    if (!provider) return c.json(err("Provider not found"), 404);

    // Inherit the source session's title so fork/edit keeps the same title
    // instead of resetting to "Forked Chat". A user-set PPM title overlays the
    // SDK title (session_titles is authoritative); when absent, the SDK fork
    // naturally inherits the source's summary/firstPrompt from the copied prefix.
    const inheritedTitle = getSessionTitle(sourceId);

    if (body.messageId) {
      // Mid-fork at a specific message
      if (!provider.forkAtMessage) {
        return c.json(err("Provider does not support forking"), 400);
      }
      try {
        const result = await provider.forkAtMessage(sourceId, body.messageId, {
          title: inheritedTitle ?? undefined, dir: projectPath,
        });
        // Register forked session with provider + DB so it's tracked in memory
        setSessionMetadata(result.sessionId, projectName, projectPath);
        // Before the resume below: a fork of a design or Assistant chat must stay one.
        copySessionForkSettings(sourceId, result.sessionId);
        // Persist the inherited user-set title so the collapsed-tree head shows
        // it regardless of the SDK-derived summary.
        if (inheritedTitle) setSessionTitle(result.sessionId, inheritedTitle);
        await provider.resumeSession(result.sessionId);
        provider.markAsResumed?.(result.sessionId);
        // Persist the branch link (edit-message tree). Best-effort: a branch
        // bookkeeping failure must not break the fork the user just performed.
        try {
          // Anchor on the divergent message's user-ordinal (stable across forks).
          // The edited message is the first user message after the fork point;
          // its ordinal = (user messages up to & including the fork point) + 1.
          const parentMsgs = await chatService.getMessages(providerId, sourceId);
          const k = parentMsgs.findIndex((m) => (m.sdkUuid ?? m.id) === body.messageId);
          const userUpToFork = parentMsgs.slice(0, k + 1).filter((m) => m.role === "user").length;
          const forkOrdinal = userUpToFork + 1;
          // All edits of the same message share an identical prefix, so they must
          // be siblings under ONE common parent — the original version at this
          // ordinal. Editing the currently-viewed version would otherwise chain
          // forks (A→B→C), fragmenting them into pairwise groups that resolve to
          // partial, inconsistent version counts. Re-parent onto the group root.
          const existingGroup = resolveVersionGroup(sourceId, forkOrdinal);
          const versionParent = existingGroup ? existingGroup.ids[0]! : sourceId;
          // An explicit fork is a separate thread, not another version of this
          // one: recording it as `edit` would let the history list collapse it
          // together with its source and show only whichever was touched last.
          recordBranch(result.sessionId, versionParent, body.messageId, forkOrdinal, isEdit ? "edit" : "fork");
          // Edit versions must show the group root's clean title — codex names a
          // forked thread "<title> (fork)", so without this the suffix compounds
          // ("Hello (fork) (fork)") across repeated edits. Pin the PPM title.
          if (isEdit) {
            let rootTitle = getSessionTitle(versionParent);
            if (!rootTitle && (provider as any).getSessionInfoById) {
              rootTitle = (await (provider as any).getSessionInfoById(versionParent, projectPath).catch(() => null))?.title ?? null;
            }
            if (rootTitle) setSessionTitle(result.sessionId, rootTitle);
          }
        } catch (branchErr) {
          log.warn(`recordBranch failed: ${(branchErr as Error).message}`);
        }
        const forkedSession = {
          id: result.sessionId,
          providerId,
          title: inheritedTitle ?? "Forked Chat",
          projectName,
          projectPath,
          createdAt: new Date().toISOString(),
        };
        return c.json(ok({ ...forkedSession, forkedFrom: sourceId }), 201);
      } catch (forkErr) {
        // SDK forkSession throws when upToMessageId is invalid or missing from the
        // source JSONL (e.g., ghost uuid never persisted, message belongs to another session).
        // Surface as 400 instead of silently creating an empty session — FE can show a toast
        // and let the user pick a different fork point.
        const msg = (forkErr as Error).message;
        log.warn(`forkAtMessage failed: ${msg}`);
        return c.json(err(`Cannot fork at message: ${msg}`), 400);
      }
    } else {
      // No messageId (fork at first message) — create a fresh empty session
      const session = await chatService.createSession(providerId, {
        projectName, projectPath, title: inheritedTitle ?? "Forked Chat",
      });
      if (inheritedTitle) setSessionTitle(session.id, inheritedTitle);
      copySessionForkSettings(sourceId, session.id);
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

/**
 * Resolve a session's SDK JSONL transcript path: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * Tries the in-memory active session first, then the DB-persisted project_path.
 */
function resolveSessionJsonlPath(sessionId: string): { jsonlPath: string; jsonlDir: string; projectPath: string; exists: boolean } {
  const homedir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const providerId = getSessionProvider(sessionId);
  const storedProjectPath = getSessionProjectPath(sessionId) ?? "";
  if (providerId === "codex") {
    const dirs = [
      ...listCodexAccounts().map((account) => join(account.home, "sessions")),
      ...(homedir ? [resolve(homedir, ".codex", "sessions")] : []),
    ];
    for (const dir of dirs) {
      const found = findRolloutByThreadId(dir, sessionId, storedProjectPath || undefined);
      if (found) return { jsonlPath: found, jsonlDir: dir, projectPath: storedProjectPath, exists: true };
    }
    return { jsonlPath: "", jsonlDir: "", projectPath: storedProjectPath, exists: false };
  }
  const provider = providerRegistry.get("claude") as any;
  const projectPath = provider?.activeSessions?.get(sessionId)?.projectPath
    ?? storedProjectPath
    ?? "";
  const projectsRoot = homedir ? resolve(homedir, ".claude", "projects") : "";
  // SDK encodes cwd by replacing path separators + drive colon with "-".
  const encodedCwd = projectPath ? projectPath.replace(/[/\\:]/g, "-") : "";
  let jsonlDir = encodedCwd && projectsRoot ? resolve(projectsRoot, encodedCwd) : "";
  let jsonlPath = jsonlDir ? resolve(jsonlDir, `${sessionId}.jsonl`) : "";
  let exists = jsonlPath ? existsSync(jsonlPath) : false;
  // Fallback: the SDK dir name can differ from the stored project_path (drive-letter case,
  // encoding drift). sessionId is a unique UUID, so locate the transcript by scanning project dirs.
  if (!exists && projectsRoot && existsSync(projectsRoot)) {
    for (const dir of readdirSync(projectsRoot)) {
      const candidate = resolve(projectsRoot, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        jsonlDir = resolve(projectsRoot, dir);
        jsonlPath = candidate;
        exists = true;
        break;
      }
    }
  }
  return { jsonlPath, jsonlDir, projectPath, exists };
}

/** GET /chat/sessions/:id/debug — session debug info (IDs, JSONL path) */
chatRoutes.get("/sessions/:id/debug", async (c) => {
  const sessionId = c.req.param("id");
  const { jsonlPath, jsonlDir, projectPath, exists } = resolveSessionJsonlPath(sessionId);
  // Transcript weight: file size + record count (1 JSONL line = 1 event record).
  // Line count skipped above 64MB so the debug button stays snappy on huge files.
  //
  // `countLines` rather than `readFileSync(path, "utf8")` plus a `charCodeAt`
  // walk. Not for speed — both are 53 ms on a 35 MB transcript — but because
  // the old one held the loop for every one of those milliseconds, and this one
  // hands it back nine times. The yields inside it are explicit `setTimeout`s
  // and have to be: awaiting the stream alone resolves as microtasks and blocks
  // just as hard. See `file-lines.ts`.
  let jsonlSizeBytes: number | null = null;
  let jsonlLines: number | null = null;
  if (exists && jsonlPath) {
    try {
      const st = statSync(jsonlPath);
      jsonlSizeBytes = st.size;
      if (st.size <= 64 * 1024 * 1024) jsonlLines = await countLines(jsonlPath);
    } catch { /* stat/read failure — omit weight fields */ }
  }
  // PPM session ID == SDK session ID (canonical — see claude-agent-sdk.ts:728).
  // Return both fields so FE debug UI shows them clearly; they are the same value.
  return c.json(ok({
    ppmSessionId: sessionId,
    sdkSessionId: sessionId,
    providerId: getSessionProvider(sessionId) ?? "claude",
    sessionId,
    jsonlPath: exists ? jsonlPath : null,
    jsonlDir,
    projectPath,
    jsonlSizeBytes,
    jsonlLines,
  }));
});

/**
 * GET /chat/sessions/:id/usage — per-turn token split, newest first.
 *
 * The transcript is replayed every turn, so the cache hit rate on it is what separates a
 * cheap turn from an expensive one. Serving the history lets a costly session be compared
 * against its own cheaper turns instead of guessed at.
 */
chatRoutes.get("/sessions/:id/usage", (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 30, 200);
  const rows = listTurnUsage(c.req.param("id"), limit);
  return c.json(ok({
    turns: rows.map((r) => ({
      id: r.id,
      recordedAt: r.recorded_at,
      usage: {
        model: r.model ?? "unknown",
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cacheWriteTokens: r.cache_write_tokens,
        contextWindow: r.context_window ?? 0,
        costUsd: r.cost_usd ?? 0,
        cacheHitRate: cacheHitRateOf(r),
        coldStart: r.cold_start === 1,
        ...(r.cold_reason && { coldReason: r.cold_reason }),
        ...(r.account_id && { accountId: r.account_id }),
        ...(r.account_label && { accountLabel: r.account_label }),
      } satisfies TurnUsage,
    })),
  }));
});

/** Recompute from stored counts — the rate is derived, so it is never persisted. */
function cacheHitRateOf(r: { input_tokens: number; cache_read_tokens: number; cache_write_tokens: number }): number {
  const prefix = r.input_tokens + r.cache_read_tokens + r.cache_write_tokens;
  return prefix > 0 ? r.cache_read_tokens / prefix : 0;
}

/**
 * Locate a session transcript, or explain why that was not possible.
 *
 * The id becomes a filename, and the strip route writes to what this returns, so anything
 * that is not a plain session id is refused before it can reach into another directory.
 *
 * No size limit: both routes stream the file a record at a time, so a transcript costs one
 * line of memory rather than its whole length. The cap that used to live here turned the
 * cleanup off for exactly the transcripts big enough to need it.
 */
function locateTranscript(sessionId: string): { path: string } | { error: string; status: 400 | 404 } {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) return { error: "Invalid session id", status: 400 };
  const { jsonlPath, exists } = resolveSessionJsonlPath(sessionId);
  if (!exists || !jsonlPath) return { error: "Transcript not found for this session", status: 404 };
  return { path: jsonlPath };
}

/** GET /chat/sessions/:id/images — count the image payloads the transcript replays every turn */
chatRoutes.get("/sessions/:id/images", async (c) => {
  try {
    const found = locateTranscript(c.req.param("id"));
    if ("error" in found) return c.json(err(found.error), found.status);
    const audit = await auditTranscriptImagesFile(found.path);
    return c.json(ok({ ...audit, limit: MANY_IMAGE_DIMENSION_LIMIT }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /chat/sessions/:id/images/strip — replace image payloads with their placeholder text.
 *
 * A turn in flight is refused outright, since the record it is midway through appending
 * would be lost by the rewrite.
 *
 * `includeAttachments` also clears images the user attached to their own messages. It is
 * opt-in because an attachment that arrived without an uploaded copy has no other source, but
 * it has to be reachable: one oversized attachment makes every later turn of the session fail,
 * and nothing else can remove it. Attachments PPM sent itself keep a copy in the uploads
 * directory, with the path still in the message text, so those stay readable afterwards.
 */
chatRoutes.post("/sessions/:id/images/strip", async (c) => {
  try {
    const sessionId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const mode: StripMode = (body as { mode?: unknown }).mode === "all" ? "all" : "oversized";
    const includeAttachments = (body as { includeAttachments?: unknown }).includeAttachments === true;

    const { listRunningSessions, dropIdleSubprocess } = await import("../ws/chat.ts");
    if (listRunningSessions().some((s) => s.sessionId === sessionId)) {
      return c.json(err("Session is running — wait for the turn to finish"), 409);
    }

    const found = locateTranscript(sessionId);
    if ("error" in found) return c.json(err(found.error), found.status);

    // A subprocess that is merely idle is not "running", but it still holds the conversation
    // in memory — including the image being stripped. Leaving it alive means the next turn
    // re-sends the oversized attachment from memory and fails exactly as before, which is the
    // failure this endpoint exists to clear. Drop it so the turn is rebuilt from the file we
    // are about to rewrite.
    dropIdleSubprocess(
      sessionId,
      "transcript_rewritten",
      "Subprocess released: the transcript was rewritten, so the next turn is rebuilt from disk",
    );

    const result = await stripTranscriptImagesFile(found.path, mode, { includeAttachments });
    log.info(`session=${sessionId} stripped ${result.removed} images (${result.bytesFreed} B) mode=${mode} attachments=${includeAttachments}`);
    return c.json(ok({
      removed: result.removed,
      bytesFreed: result.bytesFreed,
      remaining: { ...result.remaining, limit: MANY_IMAGE_DIMENSION_LIMIT },
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * GET /chat/sessions/:id/tasks — rebuild Claude Task* state from the FULL session JSONL.
 * Reading the whole file (not the FE's paginated window) means a TaskUpdate whose TaskCreate
 * scrolled out of view is still resolved. Fresh/unknown session -> [] (not an error).
 */
chatRoutes.get("/sessions/:id/tasks", async (c) => {
  try {
    const sessionId = c.req.param("id");
    const { jsonlPath, exists } = resolveSessionJsonlPath(sessionId);
    if (!exists) return c.json(ok([]));
    const validated = validateJsonlPath(jsonlPath);
    const messages = await parseJsonlTranscript(validated);
    return c.json(ok(aggregateTasks(messages)));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = /not found/i.test(message) ? 404
      : /denied|traversal|Invalid path|too large|Not a regular/i.test(message) ? 403
      : 500;
    return c.json(err(message), status);
  }
});

/** GET /chat/pre-compact-messages — read and parse a JSONL transcript file (for expand-compact feature) */
chatRoutes.get("/pre-compact-messages", async (c) => {
  try {
    const jsonlPath = c.req.query("jsonlPath");
    const beforeUuid = c.req.query("before");
    if (!jsonlPath) return c.json(err("jsonlPath query param required"), 400);
    // Codex rollouts live under ~/.codex/sessions (different format + jail than Claude JSONL).
    const { isCodexRolloutPath, getCodexPreCompactMessages } = await import("../../providers/codex-app-server/codex-history.ts");
    if (isCodexRolloutPath(jsonlPath)) {
      const messages = getCodexPreCompactMessages(jsonlPath, c.get("projectPath"), beforeUuid);
      return c.json(ok(messages));
    }
    // No bound on the file. `parseCompactSegment` scans it as bytes, streamed, from
    // the start to the `before` record (to the end when no record has that uuid),
    // and parses only the segment it finds there, which is what it bounds. A 543MB
    // transcript answered "File too large" to every scroll up while its segments were 3MB.
    const validated = validateJsonlPath(jsonlPath, Number.POSITIVE_INFINITY);
    // One compaction segment per request: the client walks further back by
    // expanding the summary that arrives at the head of each one.
    const messages = await parseCompactSegment(validated, beforeUuid);
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

    const uploadDir = ensureUploadsDir();

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

/**
 * DELETE /chat/uploads/:filename — discard an upload that was never sent.
 *
 * Removing an attachment from the composer used to leave its uploaded file behind with
 * nothing referencing it, and uploads are kept indefinitely because chat history points at
 * them. Only a file the user just abandoned is deletable this way; one already named in a
 * message is reachable from the transcript and is not this route's business.
 */
chatRoutes.delete("/uploads/:filename", async (c) => {
  try {
    const filename = c.req.param("filename");
    if (!filename || filename.includes("/") || filename.includes("..")) {
      return c.json(err("Invalid filename"), 400);
    }
    const filePath = resolveUploadPath(filename);
    // Already gone is the outcome the caller wanted, so it is not an error.
    if (filePath) await unlink(filePath).catch(() => {});
    return c.json(ok({ deleted: true }));
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
    // Reads the durable location first, then the legacy temp dir so images in
    // older conversations keep resolving.
    const filePath = resolveUploadPath(filename);
    if (!filePath) return c.json(err("Not found"), 404);

    const file = Bun.file(filePath);
    // Uploads are write-once: each upload mints a fresh id prefix (see POST
    // /chat/upload) and the file is never rewritten, so it is safe to cache
    // forever. Without this every chat tab mount re-downloaded the full image —
    // measured at 2.8 MB of a 3.1 MB tab-open payload for a single 1.4 MB PNG.
    const etag = `"${filename}-${file.size}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(file.stream(), {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: etag,
      },
    });
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ---------------------------------------------------------------------------
// Draft endpoints — auto-save / restore chat input per session
// ---------------------------------------------------------------------------

/** GET /chat/drafts/:sessionId — load draft for a session (or null) */
chatRoutes.get("/drafts/:sessionId", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const sessionId = c.req.param("sessionId");
    const draft = draftService.get(projectPath, sessionId);
    return c.json(ok(draft));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PUT /chat/drafts/:sessionId — upsert draft content + attachments */
chatRoutes.put("/drafts/:sessionId", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ content?: string; attachments?: string }>();
    const content = typeof body.content === "string" ? body.content : "";
    const attachments = typeof body.attachments === "string" ? body.attachments : undefined;
    draftService.upsert(projectPath, sessionId, content, attachments);
    return c.json(ok({ saved: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /chat/drafts/:sessionId — remove draft */
chatRoutes.delete("/drafts/:sessionId", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const sessionId = c.req.param("sessionId");
    draftService.delete(projectPath, sessionId);
    return c.json(ok({ deleted: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
