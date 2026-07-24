import {
  getGroup,
  listMembers,
  appendMessage,
  readMessages,
  setGroupStatus,
  setMemberSession,
  setGroupLeaderSession,
} from "./group-chat.store.ts";
import { runGroupTurnLoop } from "./turn-engine.ts";
import { makeEngineRunAgent } from "./agent-runner.ts";
import type { ChatBackend } from "./agent-runner.ts";
import { archiveAndDelete } from "./transcript-archive.ts";
import type {
  Group,
  GroupMember,
  GroupMessage,
  AgentTurnResult,
  TurnLoopResult,
} from "../../types/group-chat.ts";
import type { GroupChatServerMessage } from "../../types/group-chat-ws.ts";

type WsClient = { send: (data: string) => void };

interface GroupRuntime {
  abort: AbortController;
  clients: Set<WsClient>;
  /** Bounded reconnect buffer of emitted server events. */
  buffer: GroupChatServerMessage[];
  loop: Promise<TurnLoopResult>;
}

const MAX_BUFFER = 2000;

/** Owns the live runtime for running groups: engine loop (detached), abort
 *  handle per group, WS broadcast + reconnect buffer. Mirrors the chat session
 *  model — FE disconnect does NOT abort the loop. */
class GroupChatService {
  private runtimes = new Map<string, GroupRuntime>();

  // --- test seams (production uses the real provider-backed runner) --------
  private stubbedRunAgent: (() => (m: GroupMember, prompt: string) => Promise<AgentTurnResult>) | null = null;
  private spawnStub = false;

  _setRunAgentFactory(f: () => (m: GroupMember, prompt: string) => Promise<AgentTurnResult>): void {
    this.stubbedRunAgent = f;
  }
  _setSpawnStub(v: boolean): void { this.spawnStub = v; }
  isRunning(groupId: string): boolean { return this.runtimes.has(groupId); }

  // --- lifecycle -----------------------------------------------------------

  /** Start (or ignore if already running) the turn loop for a group. Detached.
   *  Persists the user's task as the first bus message, then runs the loop. */
  async start(groupId: string, userMessage: string, providerId = "claude"): Promise<void> {
    if (this.runtimes.has(groupId)) return;
    const { group, members } = this.loadGroup(groupId);

    const taskMsg = appendMessage({
      groupId, fromMember: "user", kind: "task", summary: userMessage, turnIndex: -1,
    });
    this.emit(groupId, { type: "group_message", message: taskMsg });

    await this.runLoop(group, members, userMessage, providerId);
  }

  /** Stop a running group: abort the in-flight turn + mark paused. Cooperative
   *  cancellation halts the loop within one turn (engine checks shouldStop). */
  stop(groupId: string): void {
    const rt = this.runtimes.get(groupId);
    rt?.abort.abort();
    setGroupStatus(groupId, "paused");
  }

  /** Resume: re-spawn fresh member sessions and re-enter the loop, seeding
   *  context from the durable bus (windowed + rolling summary). The bus is the
   *  source of truth — works even after transcripts were archived/deleted.
   *  Resuming a converged group starts a new round appended to the same bus. */
  async resume(groupId: string, providerId = "claude"): Promise<void> {
    if (this.runtimes.has(groupId)) return;
    const { group, members } = this.loadGroup(groupId);
    // The original task is the durable anchor for every resumed round.
    const task = this.originalTask(groupId) ?? group.name;
    await this.runLoop(group, members, task, providerId);
  }

  // --- shared loop core ----------------------------------------------------

  private loadGroup(groupId: string): { group: Group; members: GroupMember[] } {
    const group = getGroup(groupId);
    if (!group) throw new Error("group not found");
    const members = listMembers(groupId);
    if (members.length === 0) throw new Error("group has no members");
    return { group, members };
  }

  /** Original user task from the durable bus (turn_index = -1). */
  private originalTask(groupId: string): string | null {
    const first = readMessages(groupId).find((m) => m.kind === "task" && m.fromMember === "user");
    return first?.summary ?? null;
  }

  /** Spawn fresh sessions (unless stubbed), run the detached turn loop, and
   *  register the runtime. Shared by both start() and resume(). */
  private async runLoop(
    group: Group, members: GroupMember[], task: string, providerId: string,
  ): Promise<void> {
    const backend = this.spawnStub ? null : await this.getBackend();
    if (backend) await this.spawnSessions(group, members, backend);

    setGroupStatus(group.id, "active");
    const abort = new AbortController();

    const runAgent = this.stubbedRunAgent
      ? this.stubbedRunAgent()
      : makeEngineRunAgent(backend!, providerId, abort.signal);

    const deps = {
      runAgent,
      appendMessage,
      readMessages,
      onMessage: (message: GroupMessage) => this.emit(group.id, { type: "group_message", message }),
      shouldStop: () => abort.signal.aborted,
    };

    const loop = runGroupTurnLoop(group, members, deps, task)
      .then((res) => {
        this.emit(group.id, { type: "group_done", reason: res.reason, turns: res.turns, costUsd: res.costUsd });
        // A user-requested stop keeps the group paused for a later resume;
        // any natural termination returns the group to idle.
        setGroupStatus(group.id, res.reason === "stopped" ? "paused" : "idle");
        return res;
      })
      .catch((e) => {
        this.emit(group.id, { type: "error", message: (e as Error).message });
        setGroupStatus(group.id, "idle");
        return { reason: "stopped", turns: 0, costUsd: 0 } as TurnLoopResult;
      })
      .finally(() => {
        if (!this.spawnStub) void this.archiveMembers(group, members);
        this.runtimes.delete(group.id);
      });

    this.runtimes.set(group.id, { abort, clients: new Set(), buffer: [], loop });
    // Surface spawn/immediate errors to the caller; loop errors are emitted.
    await Promise.resolve();
  }

  // --- WS wiring -----------------------------------------------------------

  addClient(groupId: string, ws: WsClient): void {
    const rt = this.runtimes.get(groupId);
    const group = getGroup(groupId);
    if (group) {
      const members = listMembers(groupId).map((m) => ({
        id: m.id, name: m.name, role: m.role, status: m.status, color: m.color,
      }));
      ws.send(JSON.stringify({ type: "group_state", groupId, status: group.status, members } satisfies GroupChatServerMessage));
    }
    if (rt) {
      rt.clients.add(ws);
      for (const ev of rt.buffer) ws.send(JSON.stringify(ev));
    }
  }

  removeClient(groupId: string, ws: WsClient): void {
    this.runtimes.get(groupId)?.clients.delete(ws);
  }

  private emit(groupId: string, ev: GroupChatServerMessage): void {
    const rt = this.runtimes.get(groupId);
    if (!rt) return;
    rt.buffer.push(ev);
    if (rt.buffer.length > MAX_BUFFER) rt.buffer.shift();
    const payload = JSON.stringify(ev);
    for (const c of rt.clients) {
      try { c.send(payload); } catch { /* dropped client */ }
    }
  }

  // --- provider-backed session lifecycle -----------------------------------

  private async spawnSessions(group: Group, members: GroupMember[], backend: ChatBackend): Promise<void> {
    for (const m of members) {
      const session = await backend.createSession({
        projectPath: group.projectPath,
        projectName: group.projectName,
        title: `[group:${group.name}] ${m.name}`,
      });
      setMemberSession(m.id, session.id);
      m.sessionId = session.id;
      if (m.role === "leader") setGroupLeaderSession(group.id, session.id);
    }
  }

  private async archiveMembers(group: Group, members: GroupMember[]): Promise<void> {
    for (const m of members) {
      if (m.sessionId) await archiveAndDelete(m.sessionId, group.name).catch(() => {});
    }
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
        chatService.sendMessage(pid, sid, prompt, { permissionMode: opts?.permissionMode }),
    };
    return this.backendCache;
  }
}

export const groupChatService = new GroupChatService();
