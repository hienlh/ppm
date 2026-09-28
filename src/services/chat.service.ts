import { providerRegistry } from "../providers/registry.ts";
import { configService } from "./config.service.ts";
import { createHash } from "node:crypto";
import { buildSharedProviderContext } from "./provider-shared-context.ts";
import { stripSharedContext, withSharedContext } from "../shared/provider-context.ts";
import type {
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
  SendMessageOpts,
} from "../providers/provider.interface.ts";
import { compareSessionsByActivity } from "../types/chat.ts";
import { buildDesignInstructions } from "./design/design-instructions.ts";
import { resolveSystemForDesign } from "./design/design-systems.service.ts";
import { ensureShowcaseDesign } from "./design/design-systems-showcase.ts";
import { userDesignSectionFor } from "./design/design-user-section.ts";
import { isValidDesignSlug } from "./design/design-slug.ts";
import { scheduleTurnSnapshot } from "./design/design-turn-snapshot.ts";
import { designMcpAccessFor } from "./design/mcp/design-mcp-access.ts";
import { designMcpTokens } from "./design/mcp/design-mcp-tokens.ts";
import { isTerminalAgentStatus } from "../shared/background-agent-status.ts";
import { TraceRun, traceAbort, traceApproval, traceFollowUp } from "./session-trace/trace-recorder.ts";
import type { TraceOrigin } from "../shared/session-trace.ts";

/** What a caller passes to send: the provider's options plus which door the run came through. */
export type ChatSendOpts = SendMessageOpts & { origin?: TraceOrigin };

/**
 * Events after which a design session's files may have settled: the end of a turn, and a
 * background task (which can keep writing after the turn's `done`) reaching a final state.
 */
function endsDesignWork(event: ChatEvent): boolean {
  if (event.type === "done") return true;
  if (event.type !== "system" || event.subtype !== "task_notification") return false;
  const status = (event as { taskStatus?: string }).taskStatus;
  return isTerminalAgentStatus(status) || status === "killed";
}

class ChatService {
  // Delivery hints only: a restart/eviction safely sends a fresh snapshot.
  private sharedSnapshots = new Map<string, string>();

  private rememberSharedContext(providerId: string, sessionId: string, context?: string): void {
    if (!context) return;
    const key = `${providerId}:${sessionId}`;
    this.sharedSnapshots.delete(key);
    this.sharedSnapshots.set(key, createHash("sha256").update(context).digest("hex"));
    if (this.sharedSnapshots.size > 512) this.sharedSnapshots.delete(this.sharedSnapshots.keys().next().value!);
  }

  invalidateSharedContext(providerId: string, sessionId: string): void {
    this.sharedSnapshots.delete(`${providerId}:${sessionId}`);
  }
  async createSession(
    providerId?: string,
    config: SessionConfig = {},
  ): Promise<Session> {
    const provider = providerId
      ? providerRegistry.get(providerId)
      : providerRegistry.getDefault();
    if (!provider) throw new Error(`Provider "${providerId}" not found`);
    const session = await provider.createSession(config);
    // Persist provider ownership so the WS routes follow-ups correctly across restarts.
    try {
      const { setSessionProvider } = await import("./db.service.ts");
      setSessionProvider(session.id, provider.id);
    } catch { /* non-fatal */ }
    return session;
  }

  async resumeSession(
    providerId: string,
    sessionId: string,
  ): Promise<Session> {
    const provider = providerRegistry.get(providerId);
    if (!provider) throw new Error(`Provider "${providerId}" not found`);
    this.invalidateSharedContext(providerId, sessionId);
    return provider.resumeSession(sessionId);
  }

  async listSessions(providerId?: string, dir?: string, opts?: { limit?: number; offset?: number }): Promise<SessionInfo[]> {
    if (providerId) {
      const provider = providerRegistry.get(providerId);
      if (!provider) throw new Error(`Provider "${providerId}" not found`);
      if (dir && provider.listSessionsByDir) {
        return provider.listSessionsByDir(dir, opts);
      }
      return provider.listSessions();
    }
    // Aggregate from all providers
    const all: SessionInfo[] = [];
    for (const info of providerRegistry.listAll()) {
      const provider = providerRegistry.get(info.id);
      if (provider) {
        if (dir && provider.listSessionsByDir) {
          all.push(...await provider.listSessionsByDir(dir, opts));
        } else {
          all.push(...await provider.listSessions());
        }
      }
    }
    return all.sort(compareSessionsByActivity);
  }

  async deleteSession(
    providerId: string,
    sessionId: string,
  ): Promise<void> {
    const provider = providerRegistry.get(providerId);
    if (!provider) throw new Error(`Provider "${providerId}" not found`);
    this.invalidateSharedContext(providerId, sessionId);
    designMcpTokens.revoke(sessionId);
    return provider.deleteSession(sessionId);
  }

  /**
   * The one door every run goes through — WebSocket, scheduler, bots, group chat, Jira, CLI —
   * which is why it is also where a run is written to the session trace. The trace observes
   * and never alters: every event is yielded exactly as the provider produced it.
   */
  async *sendMessage(
    providerId: string,
    sessionId: string,
    message: string,
    opts?: ChatSendOpts,
  ): AsyncIterable<ChatEvent> {
    const { origin, ...sendOpts } = opts ?? {};
    const run = new TraceRun({ sessionId, providerId, origin, message, opts: sendOpts });
    let outcome: "completed" | "consumer_closed" | "failed" = "consumer_closed";
    try {
      yield* this.streamRun(run, providerId, sessionId, message, sendOpts);
      outcome = "completed";
    } catch (e) {
      run.fail(e);
      outcome = "failed";
      throw e;
    } finally {
      run.end(outcome);
    }
  }

  private async *streamRun(
    run: TraceRun,
    providerId: string,
    sessionId: string,
    message: string,
    opts: SendMessageOpts,
  ): AsyncIterable<ChatEvent> {
    const provider = providerRegistry.get(providerId);
    if (!provider) {
      const event: ChatEvent = { type: "error", message: `Provider "${providerId}" not found` };
      run.observe(event);
      yield event;
      return;
    }
    const prepared = await this.prepareSendOptions(providerId, sessionId, message, opts);
    run.contextAdded(prepared.sharedContext, provider.supportsSharedContext ? "provider" : "message");
    this.rememberSharedContext(providerId, sessionId, prepared.sharedContext);
    let finished = false;
    let activeSessionId = sessionId;
    try {
      for await (const event of provider.sendMessage(sessionId,
        provider.supportsSharedContext ? message : withSharedContext(message, prepared.sharedContext),
        { ...prepared, sharedContext: provider.supportsSharedContext ? prepared.sharedContext : undefined })) {
        if (event.type === "error" || (event.type === "done" && event.resultSubtype?.startsWith("error")) || (event.type === "system" && event.subtype === "compact_done")) {
          this.invalidateSharedContext(providerId, activeSessionId);
        }
        if (event.type === "session_migrated" && event.newSessionId !== event.oldSessionId) {
          // Carries the design slug and stored mode (with model/effort) to the provider's
          // real id for callers that are not the WebSocket, which records this itself —
          // the copy keeps whatever the destination already has, so doing both is safe.
          try {
            const { setSessionMigratedTo } = await import("./db.service.ts");
            setSessionMigratedTo(event.oldSessionId, event.newSessionId);
          } catch (e) {
            console.warn(`[chat] could not record session migration: ${(e as Error).message}`);
          }
        }
        const migratedId = event.type === "session_migrated" ? event.newSessionId : event.type === "done" ? event.sessionId : undefined;
        if (migratedId && migratedId !== activeSessionId) {
          const snapshot = this.sharedSnapshots.get(`${providerId}:${activeSessionId}`);
          if (snapshot) {
            this.sharedSnapshots.set(`${providerId}:${migratedId}`, snapshot);
            this.invalidateSharedContext(providerId, activeSessionId);
          }
          activeSessionId = migratedId;
        }
        if (endsDesignWork(event)) {
          // Not awaited: the snapshot is debounced and must never hold up or fail the turn.
          scheduleTurnSnapshot(activeSessionId, this.getSession(activeSessionId)?.projectPath);
        }
        run.observe(event);
        yield event;
      }
      finished = true;
    } finally {
      if (!finished) this.invalidateSharedContext(providerId, activeSessionId);
    }
  }

  /** Prepare context for both a new stream and a live stream's follow-up turn. */
  async prepareSendOptions(
    providerId: string,
    sessionId: string,
    message: string,
    opts?: SendMessageOpts,
  ): Promise<SendMessageOpts> {
    if (!providerRegistry.get(providerId)) throw new Error(`Provider "${providerId}" not found`);
    const design = await this.resolveDesignOptions(providerId, sessionId, opts);
    let sharedContext: string | undefined;
    if (configService.get("ai").share_provider_context === false || /^\s*\/(compact|clear|new)(\s|$)/i.test(message)) {
      this.invalidateSharedContext(providerId, sessionId);
    }
    // Slash commands belong to the runtime parser. A context prefix would turn
    // /compact (or a provider skill) into an ordinary prompt.
    if (configService.get("ai").share_provider_context !== false && !message.trimStart().startsWith("/")) {
      const { getSessionProjectPath } = await import("./db.service.ts");
      const projectPath = this.getSession(sessionId)?.projectPath ?? getSessionProjectPath(sessionId);
      if (projectPath) {
        const providers = providerRegistry.listAll().flatMap(({ id }) => {
          const item = providerRegistry.get(id);
          return item ? [item] : [];
        });
        sharedContext = await buildSharedProviderContext(projectPath, providers, { recipientProviderId: providerId });
        const hash = createHash("sha256").update(sharedContext).digest("hex");
        if (this.sharedSnapshots.get(`${providerId}:${sessionId}`) === hash) sharedContext = undefined;
      }
    }
    return { ...design, sharedContext };
  }

  /**
   * Design identity for this turn, resolved here because every caller — the WebSocket, the
   * CLI, the scheduler, group chat, the bots — sends through this service, and a design
   * session reached by any of them must get its instructions.
   *
   * Instruction text is only ever built from the stored slug and the owner's saved design
   * instructions: anything a caller put in `designInstructions`/`designSession` is
   * discarded, so no per-message client text reaches the system prompt. The saved
   * instructions' skill mentions are resolved against the skills this provider can load for
   * this project. A design session has no permission default of its own — an agent that
   * has to read and search the project to design for it would otherwise ask on every file.
   * An explicit caller mode wins (the user picked it), then the mode stored for the session,
   * then the provider's configured default, exactly as for any other chat.
   */
  private async resolveDesignOptions(providerId: string, sessionId: string, opts?: SendMessageOpts): Promise<SendMessageOpts> {
    const { designInstructions: _instructions, designSession: _flag, designMcp: _mcp, ...rest } = opts ?? {};
    const { getSessionDesignSlug, getSessionPermissionMode, getSessionProjectPath } = await import("./db.service.ts");
    const slug = getSessionDesignSlug(sessionId);
    if (!slug || !isValidDesignSlug(slug)) return rest;
    const permissionMode = opts?.permissionMode ?? getSessionPermissionMode(sessionId) ?? undefined;
    const projectPath = this.getSession(sessionId)?.projectPath ?? getSessionProjectPath(sessionId);
    const designMcp = designMcpAccessFor(sessionId, projectPath, slug);
    const userSection = await userDesignSectionFor({ providerId, sessionId, projectPath, slug });
    const system = projectPath
      ? await resolveSystemForDesign(projectPath, slug)
      : { id: "default", label: "Default", root: ".", platform: "web" as const, hasDesignMd: true };
    if (projectPath && !system.hasDesignMd) {
      // The instructions below are about to tell the agent it may write the showcase's
      // index.html: make sure that design's folder and manifest exist first, server-side,
      // so the agent only ever has to write the page itself.
      try {
        await ensureShowcaseDesign(projectPath, system.id);
      } catch (e) {
        console.warn(`[design] could not prepare the showcase for ${system.id}: ${(e as Error).message}`);
      }
    }
    return {
      ...rest,
      designInstructions: buildDesignInstructions(slug, system, { checkTool: !!designMcp, userSection }),
      designSession: true,
      ...(designMcp ? { designMcp } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    };
  }

  /** Push a live follow-up through the same context policy as sendMessage. */
  async pushMessage(providerId: string, sessionId: string, message: string, opts?: ChatSendOpts): Promise<void> {
    const provider = providerRegistry.get(providerId);
    if (!provider) throw new Error(`Provider "${providerId}" not found`);
    const streaming = provider as typeof provider & {
      pushMessage?: (id: string, content: string, options: SendMessageOpts) => void;
    };
    if (!streaming.pushMessage) return;
    const { origin, ...sendOpts } = opts ?? {};
    const prepared = await this.prepareSendOptions(providerId, sessionId, message, sendOpts);
    // Written before the push, so the input precedes every event it causes in the trace.
    traceFollowUp(sessionId, providerId, message, {
      ...sendOpts,
      origin,
      sharedContext: prepared.sharedContext,
      contextVia: provider.supportsSharedContext ? "provider" : "message",
    });
    streaming.pushMessage(sessionId,
      provider.supportsSharedContext ? message : withSharedContext(message, prepared.sharedContext),
      { ...prepared, sharedContext: provider.supportsSharedContext ? prepared.sharedContext : undefined });
    this.rememberSharedContext(providerId, sessionId, prepared.sharedContext);
  }

  /**
   * Stop a session's query. An input to the run like a message is, so it goes through here
   * rather than straight to the provider — otherwise the trace shows a turn that just stops.
   */
  abortQuery(providerId: string, sessionId: string, reason: string, origin?: TraceOrigin): void {
    const provider = providerRegistry.get(providerId);
    if (!provider?.abortQuery) return;
    traceAbort(sessionId, providerId, reason, origin);
    provider.abortQuery(sessionId, reason);
  }

  /** Answer an approval request or a question, and record the answer in the trace. */
  resolveApproval(
    providerId: string,
    sessionId: string,
    requestId: string,
    approved: boolean,
    data?: unknown,
    extra: { reason?: string; origin?: TraceOrigin } = {},
  ): void {
    const provider = providerRegistry.get(providerId);
    if (typeof provider?.resolveApproval !== "function") return;
    traceApproval(sessionId, providerId, requestId, approved, { data, ...extra });
    provider.resolveApproval(requestId, approved, data);
  }

  /** Look up a session across all providers (for WS handler) */
  getSession(sessionId: string): Session | null {
    for (const info of providerRegistry.listAll()) {
      const provider = providerRegistry.get(info.id);
      if (!provider) continue;
      // Use internal sessions Map — SDK stores {meta, sdk}, others store Session directly
      const sessions = (provider as any).sessions ?? (provider as any).activeSessions;
      if (sessions instanceof Map && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId);
        if (entry && typeof entry === "object" && "meta" in entry) {
          return (entry as { meta: Session }).meta;
        }
        return entry as Session ?? null;
      }
    }
    return null;
  }

  async getMessages(providerId: string, sessionId: string): Promise<ChatMessage[]> {
    const provider = providerRegistry.get(providerId);
    if (!provider) return [];
    const messages = await provider.getMessages?.(sessionId) ?? [];
    return messages.map((message) => message.role === "user"
      ? { ...message, content: stripSharedContext(message.content) }
      : message);
  }

  /** Whole transcript rather than the resumable conversation, for the search index.
   *  Falls back to the conversation for a provider that draws no distinction. */
  async getFullMessages(providerId: string, sessionId: string): Promise<ChatMessage[]> {
    const provider = providerRegistry.get(providerId);
    if (!provider) return [];
    if (provider.getFullMessages) return await provider.getFullMessages(sessionId);
    return await provider.getMessages?.(sessionId) ?? [];
  }
}

export const chatService = new ChatService();
