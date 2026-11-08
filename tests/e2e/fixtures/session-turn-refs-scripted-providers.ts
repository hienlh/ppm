/**
 * Scripted Claude and Codex providers for the turn-reference e2e. Each subclasses the real
 * provider, so history, sessions and the turn index read the transcripts exactly as in production,
 * and replaces only the part that would start a CLI: a turn appends the records the CLI would
 * write (a prompt with its `promptId`, or `task_started` with codex's turn id), announces the turn
 * (`turn_started` with the browser's `clientMessageId`), makes the MCP calls its plan names with
 * the token the turn was handed — the way the CLI does — and streams its answer.
 *
 * One stream per session lives across turns, as Claude's does: a message sent mid-turn is pushed
 * and waits for the running turn to end. A new Codex chat is renamed to its thread id on its first
 * turn (`session_migrated`), as codex does.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeAgentSdkProvider } from "../../../src/providers/claude-agent-sdk";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider";
import { getSessionProjectPath, setSessionMetadata, setSessionProvider } from "../../../src/services/db.service";
import { ClaudeTranscript } from "./session-turn-refs-transcripts/claude-transcript";
import { CodexRollout } from "./session-turn-refs-transcripts/codex-rollout";
import { claudeSlug } from "./session-turn-refs-transcripts/seed-sessions";
import type { ChatEvent, SendMessageOpts } from "../../../src/types/chat";

export interface ScriptOp { tool: string; args: Record<string, unknown>; token?: "first" | "current" }
export interface TurnPlan { ops?: ScriptOp[]; streamMs?: number; text?: string }
export interface CallRecord { sessionId: string; tool: string; args: Record<string, unknown>; status?: number; isError?: boolean; text?: string }
interface Access { url: string; token: string }
interface Pending { message: string; opts?: SendMessageOpts }
interface Stream { queue: Pending[]; wake: (() => void) | null; ended: boolean; first?: Access }

export const plans = new Map<string, TurnPlan[]>();
/** Sessions whose next send is a one-off run (a Jira job), not the chat socket's stream. */
export const oneShotSessions = new Set<string>();
export const calls: CallRecord[] = [];
let answers = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nextPlan(...ids: string[]): TurnPlan {
  for (const id of ids) {
    const queue = plans.get(id);
    if (queue?.length) return queue.shift()!;
  }
  return {};
}

async function* runOps(sessionId: string, plan: TurnPlan, stream: Stream, current: Access | undefined, onCall: (tool: string, id: string, output: string) => void): AsyncGenerator<ChatEvent> {
  for (const op of plan.ops ?? []) {
    const record: CallRecord = { sessionId, tool: op.tool, args: op.args };
    calls.push(record);
    const toolUseId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    yield { type: "tool_use", tool: `mcp__ppm-tabs__${op.tool}`, input: op.args, toolUseId } as ChatEvent;
    const access = op.token === "current" ? current : stream.first ?? current;
    if (!access) {
      record.text = "no tools handed to this turn";
      record.isError = true;
    } else {
      const res = await fetch(access.url, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: op.tool, arguments: op.args } }),
      });
      record.status = res.status;
      const body = await res.json().catch(() => null) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } } | null;
      record.isError = body?.result?.isError === true;
      record.text = (body?.result?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    onCall(op.tool, toolUseId, record.text ?? "");
    yield { type: "tool_result", output: record.text ?? "", isError: record.isError, toolUseId } as ChatEvent;
  }
}

async function* streamText(text: string, ms: number): AsyncGenerator<ChatEvent> {
  const words = text.split(/(?<= )/);
  for (const word of words) {
    yield { type: "text", content: word } as ChatEvent;
    if (ms) await sleep(ms / words.length);
  }
}

/** The stream loop both providers share: one generator per session, fed by pushes. */
async function* streamLoop(stream: Stream, run: (p: Pending) => AsyncGenerator<ChatEvent>): AsyncGenerator<ChatEvent> {
  while (!stream.ended) {
    const next = stream.queue.shift();
    if (!next) { await new Promise<void>((r) => { stream.wake = r; }); continue; }
    yield* run(next);
  }
}

function push(stream: Stream | undefined, pending: Pending): void {
  if (!stream) return;
  stream.queue.push(pending);
  const wake = stream.wake; stream.wake = null; wake?.();
}

function end(stream: Stream | undefined): void {
  if (!stream) return;
  stream.ended = true;
  const wake = stream.wake; stream.wake = null; wake?.();
}

/** The newest chained record's uuid, which the next record hangs off. */
function lastUuid(file: string): string | null {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]!) as { uuid?: string; type?: string };
      if (rec.uuid && (rec.type === "user" || rec.type === "assistant" || rec.type === "system")) return rec.uuid;
    } catch { /* partial line */ }
  }
  return null;
}

export class ScriptedClaude extends ClaudeAgentSdkProvider {
  private streams = new Map<string, Stream>();
  constructor(private readonly projectsRoot: string) { super(); }

  override async prewarm(): Promise<void> { /* no CLI in the fixture */ }
  override hasStreamingSession(sessionId: string): boolean { return this.streams.has(sessionId); }
  override abortQuery(sessionId: string): void { end(this.streams.get(sessionId)); this.streams.delete(sessionId); }
  override closeStreamingSession(sessionId: string): void { this.abortQuery(sessionId); }
  override pushMessage(sessionId: string, content: string, opts?: SendMessageOpts): void { push(this.streams.get(sessionId), { message: content, opts }); }

  /** Appends a turn's records and streams it, the way the CLI would. */
  private async *turn(sessionId: string, stream: Stream, { message, opts }: Pending): AsyncGenerator<ChatEvent> {
    const cwd = getSessionProjectPath(sessionId) ?? "";
    const file = join(this.projectsRoot, claudeSlug(cwd), `${sessionId}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    const t = new ClaudeTranscript(sessionId, cwd, Date.now());
    (t as unknown as { parent: string | null }).parent = lastUuid(file);
    const promptId = randomUUID();
    const flush = () => { appendFileSync(file, t.toString()); t.lines.length = 0; };
    t.prompt(promptId, message, 0);
    flush();
    yield { type: "turn_started", turnId: promptId, ...(opts?.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}) } as ChatEvent;
    const plan = nextPlan(sessionId);
    yield* runOps(sessionId, plan, stream, opts?.tabToolsMcp, (tool, id, output) => {
      t.toolCall(promptId, { id, name: `mcp__ppm-tabs__${tool}`, input: {}, output }, 0);
      flush();
    });
    const text = plan.text ?? `Answer ${++answers}: noted.`;
    yield* streamText(text, plan.streamMs ?? 0);
    t.assistantText(text, 0);
    flush();
    yield { type: "done", sessionId, resultSubtype: "success" } as ChatEvent;
  }

  override async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    const stream: Stream = { queue: [{ message, opts }], wake: null, ended: false, first: opts?.tabToolsMcp };
    // Only the chat socket keeps a stream open; any other caller (a Jira run) gets one turn.
    const persistent = !oneShotSessions.delete(sessionId);
    if (persistent) this.streams.set(sessionId, stream);
    yield { type: "system" as never, subtype: "init" } as never;
    if (!persistent) { yield* this.turn(sessionId, stream, stream.queue.shift()!); return; }
    yield* streamLoop(stream, (p) => this.turn(sessionId, stream, p));
  }
}

export class ScriptedCodex extends CodexAppServerProvider {
  private streams = new Map<string, Stream>();
  private rollouts = new Map<string, CodexRollout>();
  constructor(private readonly sessionsDir: string, seeded: Record<string, string>) {
    super();
    for (const [id, path] of Object.entries(seeded)) this.rollouts.set(id, new CodexRollout(path, Date.now()));
  }

  // Everything the real provider would start `codex app-server` (or `codex --version`) for.
  override async probe(): Promise<{ ok: true }> { return { ok: true }; }
  override async isAvailable(): Promise<boolean> { return true; }
  override async listModels(): Promise<Array<{ value: string; label: string }>> { return [{ value: "gpt-5.5-codex", label: "GPT-5.5 Codex" }]; }
  override async listSkills(): Promise<never[]> { return []; }
  override async getUsage(): Promise<Record<string, never>> { return {}; }
  override hasStreamingSession(sessionId: string): boolean { return this.streams.has(sessionId); }
  override abortQuery(sessionId: string): void { end(this.streams.get(sessionId)); this.streams.delete(sessionId); }
  override pushMessage(sessionId: string, content: string, opts?: SendMessageOpts): void { push(this.streams.get(sessionId), { message: content, opts }); }

  private async *turn(ids: { thread: string; asked: string }, stream: Stream, { message, opts }: Pending): AsyncGenerator<ChatEvent> {
    const cwd = getSessionProjectPath(ids.thread) ?? getSessionProjectPath(ids.asked) ?? "";
    let rollout = this.rollouts.get(ids.thread);
    if (!rollout) {
      rollout = new CodexRollout(CodexRollout.pathFor(this.sessionsDir, ids.thread, Date.now()), Date.now()).meta(ids.thread, cwd);
      this.rollouts.set(ids.thread, rollout);
    }
    const turnId = randomUUID();
    rollout.taskStarted(turnId, cwd).user(message);
    yield { type: "turn_started", turnId, ...(opts?.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}) } as ChatEvent;
    const plan = nextPlan(ids.thread, ids.asked);
    yield* runOps(ids.thread, plan, stream, opts?.tabToolsMcp, (tool, _id, output) => { rollout!.call(tool, "mcp", output); });
    const text = plan.text ?? `Codex answer ${++answers}.`;
    yield* streamText(text, plan.streamMs ?? 0);
    rollout.agent(text).taskComplete(turnId, text);
    yield { type: "done", sessionId: ids.thread, resultSubtype: "success" } as ChatEvent;
  }

  override async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    const stream: Stream = { queue: [{ message, opts }], wake: null, ended: false, first: opts?.tabToolsMcp };
    let thread = sessionId;
    if (!this.rollouts.has(sessionId)) {
      // A chat codex has never seen: its thread gets codex's own id, as `thread/start` answers.
      thread = randomUUID();
      const cwd = getSessionProjectPath(sessionId) ?? "";
      setSessionMetadata(thread, undefined, cwd);
      setSessionProvider(thread, this.id);
      yield { type: "session_migrated", oldSessionId: sessionId, newSessionId: thread } as ChatEvent;
    }
    this.streams.set(sessionId, stream);
    this.streams.set(thread, stream);
    yield* streamLoop(stream, (p) => this.turn({ thread, asked: sessionId }, stream, p));
  }
}
