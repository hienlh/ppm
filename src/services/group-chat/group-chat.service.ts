import {
  getGroup,
  listMembers,
  appendMessage,
  readMessages,
  setGroupStatus,
  setMemberSession,
  setGroupLeaderSession,
} from "./group-chat.store.ts";
import { runReplyBurst } from "./turn-engine.ts";
import { makeEngineRunAgent } from "./agent-runner.ts";
import type { ChatBackend } from "./agent-runner.ts";
import { makeResponderRouter } from "./responder-router.ts";
import { archiveAndDelete } from "./transcript-archive.ts";
import type {
  Group,
  GroupMember,
  GroupMessage,
  AgentTurnResult,
  BurstResult,
  TurnEngineDeps,
} from "../../types/group-chat.ts";
import type { GroupChatServerMessage } from "../../types/group-chat-ws.ts";

type WsClient = { send: (data: string) => void };

interface GroupRuntime {
  abort: AbortController;
  /** Bounded reconnect buffer of the CURRENT burst's events (replayed on reconnect). */
  buffer: GroupChatServerMessage[];
  loop: Promise<BurstResult>;
}

const MAX_BUFFER = 2000;

/** Owns the live runtime for running groups: engine loop (detached), abort
 *  handle per group, WS broadcast + reconnect buffer. Mirrors the chat session
 *  model — FE disconnect does NOT abort the loop. */
class GroupChatService {
  private runtimes = new Map<string, GroupRuntime>();
  /** Connected WS clients per group — PERSISTENT across bursts. Must NOT be tied to a
   *  runtime's lifetime: with re-seed-per-message the runtime is created/destroyed for
   *  every message, and a client stored on the runtime would be orphaned when the burst
   *  ends (missing its own next message until it reconnects). */
  private clients = new Map<string, Set<WsClient>>();
  /** Latest user message received while a burst was running — drained into the next
   *  burst when the current one finishes (single-slot: newer supersedes older). */
  private pendingMessage = new Map<string, GroupMessage>();
  /** Member session ids known created + live THIS server run. Keep-alive: a member's
   *  session is reused (resumed → native memory) across bursts while its id is here.
   *  Cleared on server restart → sessions are recreated fresh (memory reset, accepted). */
  private aliveSessions = new Set<string>();

  // --- test seams (production uses the real provider-backed runner) --------
  private stubbedRunAgent: (() => (m: GroupMember, prompt: string) => Promise<AgentTurnResult>) | null = null;
  private stubbedResponderRouter: (() => NonNullable<TurnEngineDeps["routeNextSpeakers"]>) | null = null;
  private spawnStub = false;

  _setRunAgentFactory(f: () => (m: GroupMember, prompt: string) => Promise<AgentTurnResult>): void {
    this.stubbedRunAgent = f;
  }
  _setResponderRouterFactory(f: (() => NonNullable<TurnEngineDeps["routeNextSpeakers"]>) | null): void {
    this.stubbedResponderRouter = f;
  }
  _setSpawnStub(v: boolean): void { this.spawnStub = v; }
  /** Inject a fake ChatBackend (session/create/send) for lifecycle tests. */
  _setBackend(b: ChatBackend | null): void { this.backendCache = b; this.aliveSessions.clear(); }
  isRunning(groupId: string): boolean { return this.runtimes.has(groupId); }

  // --- lifecycle -----------------------------------------------------------

  /** Handle a user message: persist it as a chat message, then run a bounded reply
   *  burst. If a burst is already running, queue the message (newer supersedes older)
   *  and run it once the current burst finishes. */
  async start(groupId: string, userMessage: string, providerId = "claude"): Promise<void> {
    const { group, members } = this.loadGroup(groupId);
    const msg = appendMessage({
      groupId, fromMember: "user", kind: "chat", summary: userMessage,
      turnIndex: this.nextTurnIndex(groupId),
    });

    if (this.runtimes.has(groupId)) {
      // A burst is in flight — queue this message and surface it in the feed now.
      this.pendingMessage.set(groupId, msg);
      this.emit(groupId, { type: "group_message", message: msg });
      return;
    }
    await this.runBurst(group, members, providerId, msg);
  }

  /** Stop a running group: abort the in-flight turn + mark paused. Cooperative
   *  cancellation halts the loop within one turn (engine checks shouldStop). */
  stop(groupId: string): void {
    const rt = this.runtimes.get(groupId);
    rt?.abort.abort();
    setGroupStatus(groupId, "paused");
  }

  /** Resume after a Stop: re-run a reply burst ONLY when the latest message is an
   *  unanswered user message (i.e. a burst was stopped/errored before replying). If the
   *  last message is an assistant reply, the conversation is already answered → no-op,
   *  so Resume never double-replies to a question that was already handled. */
  async resume(groupId: string, providerId = "claude"): Promise<void> {
    if (this.runtimes.has(groupId)) return;
    const { group, members } = this.loadGroup(groupId);
    const msgs = readMessages(groupId);
    const last = msgs[msgs.length - 1];
    if (!last || last.fromMember !== "user") { setGroupStatus(groupId, "idle"); return; }
    await this.runBurst(group, members, providerId);
  }

  // --- shared loop core ----------------------------------------------------

  private loadGroup(groupId: string): { group: Group; members: GroupMember[] } {
    const group = getGroup(groupId);
    if (!group) throw new Error("group not found");
    const members = listMembers(groupId);
    if (members.length === 0) throw new Error("group has no members");
    return { group, members };
  }

  /** Next sequential turn index for the group's durable bus. */
  private nextTurnIndex(groupId: string): number {
    const prior = readMessages(groupId);
    return (prior[prior.length - 1]?.turnIndex ?? -1) + 1;
  }

  /** Register the runtime, then (async) spawn sessions + run one detached reply burst,
   *  draining any user message queued while the burst ran. Re-seed per message.
   *  The runtime is registered SYNCHRONOUSLY (before the first await) so a message that
   *  arrives during session spawn is queued via start()'s runtimes.has() check — never
   *  run as a second concurrent burst. */
  private async runBurst(
    group: Group, members: GroupMember[], providerId: string,
    initialMessage?: GroupMessage,
  ): Promise<void> {
    const abort = new AbortController();
    // Synchronous registration — no await may precede this (so a message arriving during
    // session spawn is queued, not run as a second concurrent burst).
    const runtime: GroupRuntime = {
      abort, buffer: [],
      loop: Promise.resolve({ reason: "stopped", turns: 0, costUsd: 0 } as BurstResult),
    };
    this.runtimes.set(group.id, runtime);
    setGroupStatus(group.id, "active");
    // Emit the user's message now that the runtime exists (so it lands in the reconnect
    // buffer); persistent clients receive it live regardless of runtime lifetime.
    if (initialMessage) {
      this.emit(group.id, { type: "group_message", message: initialMessage });
    }

    // Dedicated ephemeral router session (cheap-model next-speaker classification) —
    // kept separate from member sessions so router prompts never pollute member history.
    let routerSessionId: string | null = null;

    const loop = (async () => {
      const backend = this.spawnStub ? null : await this.getBackend();
      if (backend) await this.ensureSessions(group, members, backend);
      const runAgent = this.stubbedRunAgent
        ? this.stubbedRunAgent()
        : makeEngineRunAgent(backend!, providerId, abort.signal);

      // Smart responder routing: prefer a stubbed router in tests; otherwise build one over
      // a fresh ephemeral session. Absent → engine falls back to mention-following.
      let routeNextSpeakers: TurnEngineDeps["routeNextSpeakers"];
      if (this.stubbedResponderRouter) {
        routeNextSpeakers = this.stubbedResponderRouter();
      } else if (backend) {
        const rs = await backend.createSession({
          projectPath: group.projectPath, projectName: group.projectName,
          title: `[group:${group.name}] router`,
        });
        routerSessionId = rs.id;
        routeNextSpeakers = makeResponderRouter(backend, providerId, rs.id);
      }

      const deps = {
        runAgent,
        appendMessage,
        readMessages,
        onMessage: (message: GroupMessage) => this.emit(group.id, { type: "group_message", message }),
        onTyping: (member: string) => this.emit(group.id, { type: "typing", member }),
        routeNextSpeakers,
        shouldStop: () => abort.signal.aborted,
      };
      return runReplyBurst(group, members, deps, { cap: group.maxTurns });
    })()
      .then((res) => {
        this.emit(group.id, { type: "group_done", reason: res.reason, turns: res.turns, costUsd: res.costUsd });
        // A user-requested stop keeps the group paused for a later resume;
        // a natural burst end returns the group to idle to wait for the next message.
        setGroupStatus(group.id, res.reason === "stopped" ? "paused" : "idle");
        return res;
      })
      .catch((e) => {
        this.emit(group.id, { type: "error", message: (e as Error).message });
        setGroupStatus(group.id, "idle");
        return { reason: "stopped", turns: 0, costUsd: 0 } as BurstResult;
      })
      .finally(() => {
        // Keep-alive: member sessions are NOT archived per burst — they persist so the
        // next burst resumes them (native memory). Archival happens on group/member delete.
        if (routerSessionId) void this.deleteRouterSession(providerId, routerSessionId);
        this.runtimes.delete(group.id);
        // Drain a message queued mid-burst → run the next burst for it.
        const queued = this.pendingMessage.get(group.id);
        if (queued) {
          this.pendingMessage.delete(group.id);
          void this.runBurst(group, members, providerId);
        }
      });
    runtime.loop = loop;
    // Surface spawn/immediate errors to the caller; burst errors are emitted.
    await Promise.resolve();
  }

  // --- WS wiring -----------------------------------------------------------

  addClient(groupId: string, ws: WsClient): void {
    const group = getGroup(groupId);
    if (group) {
      const members = listMembers(groupId).map((m) => ({
        id: m.id, name: m.name, role: m.role, status: m.status, color: m.color,
      }));
      ws.send(JSON.stringify({ type: "group_state", groupId, status: group.status, members } satisfies GroupChatServerMessage));
    }
    // Register in the persistent per-group client set (survives burst churn).
    let set = this.clients.get(groupId);
    if (!set) { set = new Set(); this.clients.set(groupId, set); }
    set.add(ws);
    // Replay the current burst's buffer so a mid-burst reconnect catches up.
    const rt = this.runtimes.get(groupId);
    if (rt) for (const ev of rt.buffer) ws.send(JSON.stringify(ev));
  }

  removeClient(groupId: string, ws: WsClient): void {
    const set = this.clients.get(groupId);
    set?.delete(ws);
    if (set && set.size === 0) this.clients.delete(groupId);
  }

  private emit(groupId: string, ev: GroupChatServerMessage): void {
    // Buffer into the current burst (for reconnect replay) when one is running.
    const rt = this.runtimes.get(groupId);
    if (rt) {
      rt.buffer.push(ev);
      if (rt.buffer.length > MAX_BUFFER) rt.buffer.shift();
    }
    // Broadcast to all persistent clients — independent of runtime lifetime.
    const set = this.clients.get(groupId);
    if (!set) return;
    const payload = JSON.stringify(ev);
    for (const c of set) {
      try { c.send(payload); } catch { /* dropped client */ }
    }
  }

  // --- provider-backed session lifecycle -----------------------------------

  /** Keep-alive: reuse a member's session while it's live this run (resume → native
   *  memory); otherwise create a fresh one (archiving any stale prior file first). */
  private async ensureSessions(group: Group, members: GroupMember[], backend: ChatBackend): Promise<void> {
    for (const m of members) {
      if (m.sessionId && this.aliveSessions.has(m.sessionId)) {
        if (m.role === "leader") setGroupLeaderSession(group.id, m.sessionId);
        continue; // reuse — the provider resumes it (in-process message count > 0)
      }
      // Not alive this run (new member / post-restart): archive any orphaned old file,
      // then create a fresh session so we never create-with-an-existing-id.
      if (m.sessionId) await archiveAndDelete(m.sessionId, group.name).catch(() => {});
      const session = await backend.createSession({
        projectPath: group.projectPath,
        projectName: group.projectName,
        title: `[group:${group.name}] ${m.name}`,
      });
      setMemberSession(m.id, session.id);
      m.sessionId = session.id;
      this.aliveSessions.add(session.id);
      if (m.role === "leader") setGroupLeaderSession(group.id, session.id);
    }
  }

  /** Archive + delete every member's live session and forget it (on group/member delete). */
  private async archiveMembers(group: Group, members: GroupMember[]): Promise<void> {
    for (const m of members) {
      if (m.sessionId) {
        await archiveAndDelete(m.sessionId, group.name).catch(() => {});
        this.aliveSessions.delete(m.sessionId);
      }
    }
  }

  /** Teardown for group delete: stop any burst, archive all member sessions, drop state. */
  async archiveAndForget(groupId: string): Promise<void> {
    const group = getGroup(groupId);
    if (!group) return;
    this.stop(groupId);
    if (!this.spawnStub) await this.archiveMembers(group, listMembers(groupId));
    this.clients.delete(groupId);
    this.pendingMessage.delete(groupId);
  }

  /** Archive + forget a single member's session (on member removal). */
  async archiveMemberSession(groupName: string, sessionId: string | null): Promise<void> {
    if (!sessionId || this.spawnStub) return;
    await archiveAndDelete(sessionId, groupName).catch(() => {});
    this.aliveSessions.delete(sessionId);
  }

  /** Delete the ephemeral router session (no archive — its transcript is throwaway). */
  private async deleteRouterSession(providerId: string, sessionId: string): Promise<void> {
    try {
      const { chatService } = await import("../chat.service.ts");
      await chatService.deleteSession(providerId, sessionId);
    } catch { /* best-effort cleanup */ }
  }

  private backendCache: ChatBackend | null = null;

  private async getBackend(): Promise<ChatBackend> {
    if (this.backendCache) return this.backendCache;
    // Lazy import keeps the provider registry out of unit tests that stub spawn.
    const { chatService } = await import("../chat.service.ts");
    this.backendCache = {
      createSession: (config) => chatService.createSession(undefined, config),
      // The provider cancels via abortQuery, not opts.signal — the runner's
      // consumer-side signal guard halts the turn, so only permissionMode is
      // forwarded here.
      sendMessage: (pid, sid, prompt, opts) =>
        chatService.sendMessage(pid, sid, prompt, { permissionMode: opts?.permissionMode, model: opts?.model, oneMContext: opts?.oneMContext }),
    };
    return this.backendCache;
  }
}

export const groupChatService = new GroupChatService();
