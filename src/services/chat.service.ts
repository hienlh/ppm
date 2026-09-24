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
import { isValidDesignSlug } from "./design/design-slug.ts";
import { scheduleTurnSnapshot } from "./design/design-turn-snapshot.ts";
import { designMcpAccessFor } from "./design/mcp/design-mcp-access.ts";
import { designMcpTokens } from "./design/mcp/design-mcp-tokens.ts";
import { isTerminalAgentStatus } from "../shared/background-agent-status.ts";

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

  async *sendMessage(
    providerId: string,
    sessionId: string,
    message: string,
    opts?: SendMessageOpts,
  ): AsyncIterable<ChatEvent> {
    const provider = providerRegistry.get(providerId);
    if (!provider) {
      yield { type: "error", message: `Provider "${providerId}" not found` };
      return;
    }
    const prepared = await this.prepareSendOptions(providerId, sessionId, message, opts);
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
    const design = await this.resolveDesignOptions(sessionId, opts);
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
   * Instruction text is only ever built from the stored slug: anything a caller put in
   * `designInstructions`/`designSession` is discarded, so no client text reaches the
   * system prompt. A design session has no permission default of its own — an agent that
   * has to read and search the project to design for it would otherwise ask on every file.
   * An explicit caller mode wins (the user picked it), then the mode stored for the session,
   * then the provider's configured default, exactly as for any other chat.
   */
  private async resolveDesignOptions(sessionId: string, opts?: SendMessageOpts): Promise<SendMessageOpts> {
    const { designInstructions: _instructions, designSession: _flag, designMcp: _mcp, ...rest } = opts ?? {};
    const { getSessionDesignSlug, getSessionPermissionMode, getSessionProjectPath } = await import("./db.service.ts");
    const slug = getSessionDesignSlug(sessionId);
    if (!slug || !isValidDesignSlug(slug)) return rest;
    const permissionMode = opts?.permissionMode ?? getSessionPermissionMode(sessionId) ?? undefined;
    const projectPath = this.getSession(sessionId)?.projectPath ?? getSessionProjectPath(sessionId);
    const designMcp = designMcpAccessFor(sessionId, projectPath, slug);
    return {
      ...rest,
      designInstructions: buildDesignInstructions(slug, { checkTool: !!designMcp }),
      designSession: true,
      ...(designMcp ? { designMcp } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    };
  }

  /** Push a live follow-up through the same context policy as sendMessage. */
  async pushMessage(providerId: string, sessionId: string, message: string, opts?: SendMessageOpts): Promise<void> {
    const provider = providerRegistry.get(providerId);
    if (!provider) throw new Error(`Provider "${providerId}" not found`);
    const streaming = provider as typeof provider & {
      pushMessage?: (id: string, content: string, options: SendMessageOpts) => void;
    };
    if (!streaming.pushMessage) return;
    const prepared = await this.prepareSendOptions(providerId, sessionId, message, opts);
    streaming.pushMessage(sessionId,
      provider.supportsSharedContext ? message : withSharedContext(message, prepared.sharedContext),
      { ...prepared, sharedContext: provider.supportsSharedContext ? prepared.sharedContext : undefined });
    this.rememberSharedContext(providerId, sessionId, prepared.sharedContext);
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
