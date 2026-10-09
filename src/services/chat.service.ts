import { providerRegistry } from "../providers/registry.ts";
import { configService } from "./config.service.ts";
import { buildSharedProviderContext } from "./provider-shared-context.ts";
import { joinSharedContextEntries, stripSharedContext, withSharedContext } from "../shared/provider-context.ts";
import { SharedContextSnapshots, type SharedContextPart } from "./shared-context-snapshots.ts";
import { uiSummaryContextEntry } from "./assistant/assistant-ui-summary.ts";
import type {
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
  SendMessageOpts,
  PrewarmInput,
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
import { tabToolsMcpAccessFor, tabToolsMcpTokens } from "./tab-tools-mcp/tab-tools-mcp-tokens.ts";
import { tabOpenBroker } from "./tab-tools-mcp/tab-open-broker.ts";
import { isTerminalAgentStatus } from "../shared/background-agent-status.ts";
import { isAssistantProject } from "../shared/assistant-project.ts";
import { isAssistantSession, isAssistantWorkDir } from "./assistant/assistant-session.ts";
import { ASSISTANT_READ_TOOLS_SECTION, ASSISTANT_UI_SECTION, buildAssistantInstructions } from "./assistant/assistant-instructions.ts";
import { assistantMcpAccessFor, assistantMcpTokens } from "./assistant-mcp/assistant-mcp-tokens.ts";
import { ensureAssistantWorkDir } from "./assistant/assistant-work-dir.ts";
import { TraceRun, traceAbort, traceApproval, traceFollowUp } from "./session-trace/trace-recorder.ts";
import type { TraceOrigin } from "../shared/session-trace.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("chat");
const designLog = createLogger("design");

/** What a caller passes to send: the provider's options plus which door the run came through. */
export type ChatSendOpts = SendMessageOpts & { origin?: TraceOrigin };

/** The shared-context entries one message carried, by entry. */
type SentContext = Partial<Record<SharedContextPart, string>>;

/**
 * What the "turn start" / "turn end" log lines need about one run, which can span many turns.
 * Kept for those lines only — the session trace holds the turns themselves.
 */
interface TurnLog {
  /** The id the run answers to now: a provider may migrate it mid-run. */
  sessionId: string;
  providerId: string;
  origin: string;
  /**
   * When the running turn was asked for; null between turns. A follow-up sent mid-turn leaves
   * it alone: the provider may fold it into the running turn, so it cannot be told apart from
   * one that runs next, and that turn's end line goes without a duration rather than a wrong one.
   */
  startedAt: number | null;
  /** Why PPM stopped the running turn. */
  abortReason?: string;
  /** The first error the running turn reported. */
  firstError?: string;
}

function logTurnStart(sessionId: string, providerId: string, origin: TraceOrigin | undefined, stream: "new" | "live" | "none", opts: SendMessageOpts): void {
  const images = (opts.images?.length ?? 0) + (opts.imagePaths?.length ?? 0);
  log.info(`turn start session=${sessionId} provider=${providerId} origin=${origin ?? "unknown"} stream=${stream} model=${opts.model ?? "default"} images=${images}`);
}

/** Every turn of every provider and origin ends in this line, at the level its result deserves. */
function logTurnEnd(turn: TurnLog, result: string, done?: { numTurns?: number; contextWindowPct?: number }): void {
  const line = `turn end session=${turn.sessionId} provider=${turn.providerId} origin=${turn.origin} result=${result}`
    + (result === "aborted" && turn.abortReason ? ` reason=${turn.abortReason}` : "")
    + (done?.numTurns != null ? ` turns=${done.numTurns}` : "")
    + (turn.startedAt !== null ? ` durationMs=${Date.now() - turn.startedAt}` : "")
    + (done?.contextWindowPct != null ? ` ctx=${done.contextWindowPct}%` : "")
    + (turn.firstError && result !== "aborted" ? ` error=${JSON.stringify(turn.firstError)}` : "");
  if (result === "success" || result === "aborted") log.info(line);
  else if (result === "error_max_turns" || result === "error_max_budget_usd" || result === "consumer_closed") log.warn(line);
  else log.error(line);
}

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
  private sharedSnapshots = new SharedContextSnapshots();
  /** Runs in flight, by every id they answer to — read only by the turn log lines. */
  private turnLogs = new Map<string, TurnLog>();

  private rememberSharedContext(providerId: string, sessionId: string, sent: SentContext): void {
    this.sharedSnapshots.remember(`${providerId}:${sessionId}`, sent);
  }

  invalidateSharedContext(providerId: string, sessionId: string): void {
    this.sharedSnapshots.forget(`${providerId}:${sessionId}`);
  }
  async createSession(
    providerId?: string,
    config: SessionConfig = {},
  ): Promise<Session> {
    const provider = providerId
      ? providerRegistry.get(providerId)
      : providerRegistry.getDefault();
    if (!provider) throw new Error(`Provider "${providerId}" not found`);
    // Every session in the Assistant's virtual project is an Assistant session, whichever
    // door created it (the new-chat route, a fork, a script).
    const assistant = isAssistantProject(config.projectName);
    if (assistant && !provider.supportsAssistantSessions) {
      throw new Error(`Provider "${provider.id}" does not support PPM Assistant sessions`);
    }
    // A warm spare was spawned with an ordinary chat's prompt and permissions.
    const session = await provider.createSession(assistant ? { ...config, adoptWarmSpare: false } : config);
    const { setSessionProvider, setSessionAssistant } = await import("./db.service.ts");
    // Not best-effort, unlike the provider row below: an Assistant session without its mark
    // would only be recognised by its working directory.
    if (assistant) setSessionAssistant(session.id);
    // Persist provider ownership so the WS routes follow-ups correctly across restarts.
    try {
      setSessionProvider(session.id, provider.id);
    } catch { /* non-fatal */ }
    return session;
  }

  /** Start the process the next new chat in a project will run on, where the provider can. */
  async prewarm(providerId: string | undefined, input: PrewarmInput): Promise<void> {
    // An Assistant session never adopts a spare, so one started for it would only idle.
    if (isAssistantWorkDir(input.projectPath)) return;
    const provider = providerId ? providerRegistry.get(providerId) : providerRegistry.getDefault();
    await provider?.prewarm?.(input);
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
    tabToolsMcpTokens.revoke(sessionId);
    assistantMcpTokens.revoke(sessionId);
    tabOpenBroker.forget(sessionId);
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
    // A run already streaming this session takes the message as a follow-up — the provider
    // pushes it into that stream — and that run's events are the ones that end the turn.
    const live = this.turnLogs.get(sessionId);
    logTurnStart(sessionId, providerId, origin, live ? "live" : "new", sendOpts);
    let turn: TurnLog | null = null;
    if (!live) {
      turn = { sessionId, providerId, origin: origin ?? "unknown", startedAt: Date.now() };
      this.turnLogs.set(sessionId, turn);
    } else if (live.startedAt === null) {
      live.startedAt = Date.now();
    }
    let outcome: "completed" | "consumer_closed" | "failed" = "consumer_closed";
    try {
      yield* this.streamRun(run, turn, providerId, sessionId, message, sendOpts);
      outcome = "completed";
    } catch (e) {
      run.fail(e);
      outcome = "failed";
      log.error(`session=${sessionId} provider=${providerId} origin=${origin ?? "unknown"} run failed:`, e);
      throw e;
    } finally {
      run.end(outcome);
      if (turn) this.endTurnLog(turn, outcome);
    }
  }

  /** Follow one run's events for its turn log lines. Observes only, like the trace. */
  private observeTurn(turn: TurnLog, event: ChatEvent): void {
    if (event.type === "error") {
      turn.firstError ??= String(event.message).slice(0, 200);
      return;
    }
    const migratedTo = event.type === "session_migrated" ? event.newSessionId : event.type === "done" ? event.sessionId : undefined;
    if (migratedTo && migratedTo !== turn.sessionId) {
      // Follow-ups and aborts arrive under the new id from here on.
      this.turnLogs.set(migratedTo, turn);
      turn.sessionId = migratedTo;
    }
    if (event.type !== "done") return;
    const sub = event.resultSubtype;
    logTurnEnd(turn, turn.abortReason ? "aborted" : sub && sub !== "success" ? sub : turn.firstError ? "error" : "success", event);
    turn.startedAt = null;
    turn.abortReason = undefined;
    turn.firstError = undefined;
  }

  /** The run is over: forget it, and close a turn it left open — one that never got its `done`. */
  private endTurnLog(turn: TurnLog, outcome: "completed" | "consumer_closed" | "failed"): void {
    for (const [id, t] of this.turnLogs) if (t === turn) this.turnLogs.delete(id);
    // A failed run said how it ended in "run failed".
    if (turn.startedAt === null || outcome === "failed") return;
    // no_done: the provider returned mid-turn without saying how the turn went.
    logTurnEnd(turn, turn.abortReason ? "aborted" : outcome === "consumer_closed" ? "consumer_closed" : turn.firstError ? "error" : "no_done");
  }

  private async *streamRun(
    run: TraceRun,
    turn: TurnLog | null,
    providerId: string,
    sessionId: string,
    message: string,
    opts: SendMessageOpts,
  ): AsyncIterable<ChatEvent> {
    const provider = providerRegistry.get(providerId);
    if (!provider) {
      const event: ChatEvent = { type: "error", message: `Provider "${providerId}" not found` };
      run.observe(event);
      if (turn) this.observeTurn(turn, event);
      yield event;
      return;
    }
    const { opts: prepared, sent } = await this.prepareSend(providerId, sessionId, message, opts);
    run.contextAdded(prepared.sharedContext, provider.supportsSharedContext ? "provider" : "message");
    this.rememberSharedContext(providerId, sessionId, sent);
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
            log.warn(`could not record session migration: ${(e as Error).message}`);
          }
        }
        const migratedId = event.type === "session_migrated" ? event.newSessionId : event.type === "done" ? event.sessionId : undefined;
        if (migratedId && migratedId !== activeSessionId) {
          this.sharedSnapshots.move(`${providerId}:${activeSessionId}`, `${providerId}:${migratedId}`);
          activeSessionId = migratedId;
        }
        if (endsDesignWork(event)) {
          // Not awaited: the snapshot is debounced and must never hold up or fail the turn.
          scheduleTurnSnapshot(activeSessionId, this.getSession(activeSessionId)?.projectPath);
        }
        run.observe(event);
        if (turn) this.observeTurn(turn, event);
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
    return (await this.prepareSend(providerId, sessionId, message, opts)).opts;
  }

  /**
   * {@link prepareSendOptions}, plus the shared-context entries the message carries, which the
   * caller records once the message is on its way so an unchanged entry is not sent again.
   */
  private async prepareSend(
    providerId: string,
    sessionId: string,
    message: string,
    opts?: SendMessageOpts,
  ): Promise<{ opts: SendMessageOpts; sent: SentContext }> {
    if (!providerRegistry.get(providerId)) throw new Error(`Provider "${providerId}" not found`);
    const { uiSummary, ...callerOpts } = opts ?? {};
    // Like the design fields, the tab tools are only ever server-built. An Assistant session is
    // never also a design session: its policy replaces the design one outright.
    const { tabToolsMcp: _tabTools, ...design } = this.resolveAssistantOptions(providerId, sessionId, callerOpts)
      ?? await this.resolveDesignOptions(providerId, sessionId, callerOpts);
    // A design session checks its canvas with `design_check` instead; the Assistant gets
    // tools of its own that drive the UI.
    const tabToolsMcp = configService.get("ai").tab_tools === true && !design.designSession && !design.assistantSession
      ? tabToolsMcpAccessFor(sessionId) : null;
    const key = `${providerId}:${sessionId}`;
    const sharing = configService.get("ai").share_provider_context !== false;
    if (/^\s*\/(compact|clear|new)(\s|$)/i.test(message)) this.sharedSnapshots.forget(key);
    else if (!sharing) this.sharedSnapshots.forget(key, "shared");
    // Slash commands belong to the runtime parser. A context prefix would turn
    // /compact (or a provider skill) into an ordinary prompt.
    const slash = message.trimStart().startsWith("/");
    let shared: string | undefined;
    if (sharing && !slash) {
      const { getSessionProjectPath } = await import("./db.service.ts");
      const projectPath = this.getSession(sessionId)?.projectPath ?? getSessionProjectPath(sessionId);
      if (projectPath) {
        const providers = providerRegistry.listAll().flatMap(({ id }) => {
          const item = providerRegistry.get(id);
          return item ? [item] : [];
        });
        shared = await buildSharedProviderContext(projectPath, providers, { recipientProviderId: providerId });
        if (this.sharedSnapshots.unchanged(key, "shared", shared)) shared = undefined;
      }
    }
    // What the Assistant's user is looking at rides in the same block, whatever the sharing
    // setting says: it is how the Assistant knows which screen it is talking about.
    let ui: string | undefined;
    if (design.assistantSession && !slash) {
      ui = uiSummaryContextEntry(uiSummary);
      if (ui && this.sharedSnapshots.unchanged(key, "ui", ui)) ui = undefined;
    }
    const sharedContext = joinSharedContextEntries(shared, ui);
    return { opts: { ...design, ...(tabToolsMcp ? { tabToolsMcp } : {}), sharedContext }, sent: { shared, ui } };
  }

  /**
   * Assistant identity for this turn, or null for any other session. Resolved here for the
   * same reason as the design identity below: every caller sends through this service.
   *
   * The instructions are server-built and every caller-supplied Assistant or design field is
   * dropped. The permission mode is forced to `default` whatever the caller or the stored
   * session asks for — the Assistant's policy, not the composer's mode, decides what runs
   * unasked, and `default` is the mode in which both providers consult that policy. A provider
   * that cannot enforce it refuses the turn instead of running it as an ordinary chat.
   */
  private resolveAssistantOptions(providerId: string, sessionId: string, opts?: SendMessageOpts): SendMessageOpts | null {
    if (!isAssistantSession(sessionId, this.getSession(sessionId)?.projectPath)) return null;
    if (!providerRegistry.get(providerId)?.supportsAssistantSessions) {
      throw new Error(`Provider "${providerId}" does not support PPM Assistant sessions`);
    }
    // A provider falls back to the home directory for a cwd that does not exist, which would
    // file the session under another directory's history and judge its paths from there.
    ensureAssistantWorkDir();
    const {
      designInstructions: _design, designSession: _designFlag, designMcp: _designMcp,
      assistantInstructions: _instructions, assistantSession: _flag, assistantMcp: _assistantMcp,
      permissionMode: _mode, ...rest
    } = opts ?? {};
    // No endpoint (a process that serves no HTTP) means no tools, and instructions that
    // describe none.
    const assistantMcp = assistantMcpAccessFor(sessionId);
    return {
      ...rest,
      assistantInstructions: buildAssistantInstructions({ sections: assistantMcp ? [ASSISTANT_READ_TOOLS_SECTION, ASSISTANT_UI_SECTION] : [] }),
      assistantSession: true,
      ...(assistantMcp ? { assistantMcp } : {}),
      permissionMode: "default",
    };
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
    const {
      designInstructions: _instructions, designSession: _flag, designMcp: _mcp,
      assistantInstructions: _assistant, assistantSession: _assistantFlag, assistantMcp: _assistantMcp, ...rest
    } = opts ?? {};
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
        designLog.warn(`could not prepare the showcase for ${system.id}: ${(e as Error).message}`);
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
    const { opts: prepared, sent } = await this.prepareSend(providerId, sessionId, message, sendOpts);
    // Written before the push, so the input precedes every event it causes in the trace.
    traceFollowUp(sessionId, providerId, message, {
      ...sendOpts,
      origin,
      sharedContext: prepared.sharedContext,
      contextVia: provider.supportsSharedContext ? "provider" : "message",
    });
    // stream=none: no run of this process is streaming the session, so nothing will end the turn.
    const live = this.turnLogs.get(sessionId);
    logTurnStart(sessionId, providerId, origin, live ? "live" : "none", sendOpts);
    streaming.pushMessage(sessionId,
      provider.supportsSharedContext ? message : withSharedContext(message, prepared.sharedContext),
      { ...prepared, sharedContext: provider.supportsSharedContext ? prepared.sharedContext : undefined });
    if (live && live.startedAt === null) live.startedAt = Date.now();
    this.rememberSharedContext(providerId, sessionId, sent);
  }

  /**
   * Stop a session's query. An input to the run like a message is, so it goes through here
   * rather than straight to the provider — otherwise the trace shows a turn that just stops.
   */
  abortQuery(providerId: string, sessionId: string, reason: string, origin?: TraceOrigin): void {
    const provider = providerRegistry.get(providerId);
    if (!provider?.abortQuery) return;
    // Stopping a turn is news; tearing down an idle subprocess is said by whoever asked for it.
    const turn = this.turnLogs.get(sessionId);
    if (turn && turn.startedAt !== null) {
      turn.abortReason ??= reason;
      log.info(`session=${sessionId} abort reason=${reason} origin=${origin ?? "unknown"}`);
    } else {
      log.debug(`session=${sessionId} abort reason=${reason} origin=${origin ?? "unknown"} (no turn running)`);
    }
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
