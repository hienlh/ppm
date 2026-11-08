/**
 * Scripted Claude and Codex providers for the session-collaboration e2e. Each subclasses the real
 * provider, so history, the session list and the turn index read what they write exactly as in
 * production; only the part that would start a CLI is replaced. A turn writes the records the CLI
 * would (a Claude prompt with its `promptId`, a Codex `task_started`), announces itself
 * (`turn_started` with the message's `clientMessageId`), then runs its plan: streamed text, calls
 * to the real `/api/sessions-mcp` endpoint with the token PPM handed the turn, a `tools/list`, or a
 * hold that keeps the turn running until the test releases it.
 *
 * A message pushed into a held turn is read inside that turn, as the real providers do: Claude
 * names it a new prompt (`UserPromptSubmit`), Codex steers it into the running turn. One stream per
 * session lives across turns; a new Codex chat takes its thread's own id on its first turn.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeAgentSdkProvider } from "../../../src/providers/claude-agent-sdk";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider";
import { getSessionProjectPath, getSessionTitle, setSessionMetadata, setSessionProvider } from "../../../src/services/db.service";
import { decodeMessageBlocks } from "../../../src/shared/chat-message-blocks";
import { ClaudeTranscript } from "./session-turn-refs-transcripts/claude-transcript";
import { CodexRollout } from "./session-turn-refs-transcripts/codex-rollout";
import { claudeSlug } from "./session-turn-refs-transcripts/seed-sessions";
import type { ChatEvent, SendMessageOpts } from "../../../src/types/chat";

export type Step =
  | { say: string; ms?: number }
  | { call: string; args: Record<string, unknown> }
  | { list: true }
  | { hold: true };
export interface TurnPlan { steps: Step[] }
export interface CallRecord {
  seq: number; sessionId: string; tool: string; args: Record<string, unknown>;
  startedAt: number; endedAt?: number; status?: number; isError?: boolean; text?: string;
}
export interface SendRecord { sessionId: string; kind: "turn" | "read_in_turn"; at: number; content: string }
interface Access { url: string; token: string }
interface Pending { message: string; opts?: SendMessageOpts }
interface Stream { queue: Pending[]; wake: (() => void) | null; ended: boolean; first?: Access }
interface Writer {
  start(message: string): string;
  /** A message read inside the running turn; answers the turn id the provider reports for it. */
  absorb(message: string, turnId: string): string;
  call(turnId: string, name: string, input: unknown, toolUseId: string, output: string): void;
  end(turnId: string, text: string): void;
}

/** Keyed by session id, or `title:<title>` for a session created mid-run. */
export const plans = new Map<string, TurnPlan[]>();
export const calls: CallRecord[] = [];
export const sends: SendRecord[] = [];
const holds = new Set<{ ids: string[]; released: boolean; wake: () => void }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ends every hold of the named session (any of its ids), or every hold. Answers how many. */
export function releaseHolds(sessionId?: string): number {
  let n = 0;
  for (const h of holds) {
    if (sessionId && !h.ids.includes(sessionId)) continue;
    h.released = true;
    h.wake();
    n++;
  }
  return n;
}

function nextPlan(ids: string[], message: string): TurnPlan {
  const keys = [...ids, ...ids.map((id) => getSessionTitle(id)).filter((t): t is string => !!t).map((t) => `title:${t}`)];
  for (const key of keys) {
    const queue = plans.get(key);
    if (queue?.length) return queue.shift()!;
  }
  // Unplanned: a task asking to be held runs until released; anything else is answered at once.
  return decodeMessageBlocks(message).content.includes("HOLD")
    ? { steps: [{ say: "Working on it, step by step." }, { hold: true }, { say: "Finished." }] }
    : { steps: [{ say: "Noted." }] };
}

async function* streamText(text: string, ms = 0): AsyncGenerator<ChatEvent> {
  const words = text.split(/(?<= )/);
  for (const word of words) {
    yield { type: "text", content: word } as ChatEvent;
    if (ms) await sleep(ms / words.length);
  }
}

/** False when the session has no live stream: the message went nowhere, as with the real providers. */
function push(stream: Stream | undefined, pending: Pending): boolean {
  if (!stream || stream.ended) return false;
  stream.queue.push(pending);
  const wake = stream.wake; stream.wake = null; wake?.();
  return true;
}

function end(stream: Stream | undefined): void {
  if (!stream) return;
  stream.ended = true;
  const wake = stream.wake; stream.wake = null; wake?.();
}

async function mcp(access: Access | undefined, method: string, params?: unknown): Promise<{ status: number; result?: Record<string, unknown> }> {
  if (!access) return { status: 0 };
  const res = await fetch(access.url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const body = await res.json().catch(() => null) as { result?: Record<string, unknown> } | null;
  return { status: res.status, result: body?.result };
}

/** One turn, shared by both providers; `toolName` is how each names a `ppm-sessions` tool. */
async function* runTurn(input: {
  ids: string[]; stream: Stream; pending: Pending; writer: Writer;
  toolName: (tool: string) => string; toolInput: (tool: string, args: Record<string, unknown>) => unknown;
}): AsyncGenerator<ChatEvent> {
  const { ids, stream, pending, writer } = input;
  const sessionId = ids[0]!;
  const turnId = writer.start(pending.message);
  sends.push({ sessionId, kind: "turn", at: Date.now(), content: decodeMessageBlocks(pending.message).content });
  const access = pending.opts?.sessionCollabMcp ?? stream.first;
  yield { type: "turn_started", turnId, ...(pending.opts?.clientMessageId ? { clientMessageId: pending.opts.clientMessageId } : {}) } as ChatEvent;
  let said = "";
  for (const step of nextPlan(ids, pending.message).steps) {
    if (stream.ended) return;
    if ("say" in step) {
      const gap = said ? "\n\n" : "";
      said += `${gap}${step.say}`;
      yield* streamText(`${gap}${step.say}`, step.ms);
    } else if ("list" in step) {
      const record: CallRecord = { seq: calls.length, sessionId, tool: "tools/list", args: {}, startedAt: Date.now() };
      calls.push(record);
      const out = await mcp(access, "tools/list");
      record.status = out.status;
      record.text = ((out.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).join(",");
      record.endedAt = Date.now();
    } else if ("call" in step) {
      const record: CallRecord = { seq: calls.length, sessionId, tool: step.call, args: step.args, startedAt: Date.now() };
      calls.push(record);
      const toolUseId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const toolInput = input.toolInput(step.call, step.args);
      yield { type: "tool_use", tool: input.toolName(step.call), input: toolInput, toolUseId } as ChatEvent;
      const out = await mcp(access, "tools/call", { name: step.call, arguments: step.args });
      record.status = out.status;
      record.isError = out.result?.isError === true || !access;
      record.text = access
        ? ((out.result?.content ?? []) as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join("\n")
        : "no session tools handed to this turn";
      record.endedAt = Date.now();
      writer.call(turnId, input.toolName(step.call), toolInput, toolUseId, record.text);
      if (stream.ended) return;
      yield { type: "tool_result", output: record.text, isError: record.isError, toolUseId } as ChatEvent;
    } else {
      const hold = { ids, released: false, wake: () => {} };
      holds.add(hold);
      try {
        while (!stream.ended && !hold.released) {
          const read = stream.queue.shift();
          if (read) {
            // Read inside the running turn, the way each provider reads a message sent mid-turn.
            const readTurn = writer.absorb(read.message, turnId);
            sends.push({ sessionId, kind: "read_in_turn", at: Date.now(), content: decodeMessageBlocks(read.message).content });
            yield { type: "turn_started", turnId: readTurn, ...(read.opts?.clientMessageId ? { clientMessageId: read.opts.clientMessageId } : {}) } as ChatEvent;
            yield* streamText("\n\nRead a message from another session; carrying on.");
            continue;
          }
          await new Promise<void>((r) => { hold.wake = r; stream.wake = r; });
        }
      } finally {
        holds.delete(hold);
      }
    }
  }
  if (stream.ended) return;
  if (!said) { said = "Done."; yield* streamText(said); }
  writer.end(turnId, said);
  yield { type: "done", sessionId, resultSubtype: "success" } as ChatEvent;
}

async function* streamLoop(stream: Stream, run: (p: Pending) => AsyncGenerator<ChatEvent>): AsyncGenerator<ChatEvent> {
  while (!stream.ended) {
    const next = stream.queue.shift();
    if (!next) { await new Promise<void>((r) => { stream.wake = r; }); continue; }
    yield* run(next);
  }
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
  override pushMessage(sessionId: string, content: string, opts?: SendMessageOpts): boolean { return push(this.streams.get(sessionId), { message: content, opts }); }

  private writer(sessionId: string): Writer {
    const file = join(this.projectsRoot, claudeSlug(getSessionProjectPath(sessionId) ?? ""), `${sessionId}.jsonl`);
    const cwd = getSessionProjectPath(sessionId) ?? "";
    const write = (fill: (t: ClaudeTranscript) => void) => {
      mkdirSync(dirname(file), { recursive: true });
      const t = new ClaudeTranscript(sessionId, cwd, Date.now());
      (t as unknown as { parent: string | null }).parent = lastUuid(file);
      fill(t);
      appendFileSync(file, t.toString());
    };
    const prompt = (message: string) => { const id = randomUUID(); write((t) => t.prompt(id, message, 0)); return id; };
    return {
      start: prompt,
      absorb: (message) => prompt(message),
      call: (turnId, name, input, id, output) => write((t) => t.toolCall(turnId, { id, name, input: input as Record<string, unknown>, output }, 0)),
      end: (_turnId, text) => write((t) => { t.assistantText(text, 0); }),
    };
  }

  override async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    const stream: Stream = { queue: [{ message, opts }], wake: null, ended: false, first: opts?.sessionCollabMcp };
    this.streams.set(sessionId, stream);
    yield { type: "system" as never, subtype: "init" } as never;
    const writer = this.writer(sessionId);
    try {
      yield* streamLoop(stream, (pending) => runTurn({
        ids: [sessionId], stream, pending, writer,
        toolName: (tool) => `mcp__ppm-sessions__${tool}`, toolInput: (_tool, args) => args,
      }));
    } finally {
      if (this.streams.get(sessionId) === stream) this.streams.delete(sessionId);
    }
  }
}

export class ScriptedCodex extends CodexAppServerProvider {
  private streams = new Map<string, Stream>();
  private rollouts = new Map<string, CodexRollout>();
  constructor(private readonly sessionsDir: string) { super(); }

  // Everything the real provider would start `codex app-server` (or `codex --version`) for.
  override async probe(): Promise<{ ok: true }> { return { ok: true }; }
  override async isAvailable(): Promise<boolean> { return true; }
  override async listModels(): Promise<Array<{ value: string; label: string }>> { return [{ value: "gpt-5.5-codex", label: "GPT-5.5 Codex" }]; }
  override async listSkills(): Promise<never[]> { return []; }
  override async getUsage(): Promise<Record<string, never>> { return {}; }
  override hasStreamingSession(sessionId: string): boolean { return this.streams.has(sessionId); }
  override abortQuery(sessionId: string): void { end(this.streams.get(sessionId)); this.streams.delete(sessionId); }
  override pushMessage(sessionId: string, content: string, opts?: SendMessageOpts): boolean { return push(this.streams.get(sessionId), { message: content, opts }); }

  private writer(thread: string, cwd: string): Writer {
    let rollout = this.rollouts.get(thread);
    if (!rollout) {
      rollout = new CodexRollout(CodexRollout.pathFor(this.sessionsDir, thread, Date.now()), Date.now()).meta(thread, cwd);
      this.rollouts.set(thread, rollout);
    }
    const r = rollout;
    return {
      start: (message) => { const turnId = randomUUID(); r.taskStarted(turnId, cwd).user(message); return turnId; },
      // A steered message joins the running turn: codex reports that turn's id for it.
      absorb: (message, turnId) => { r.user(message); return turnId; },
      call: (_turnId, name, _input, _id, output) => { r.call(name, "mcp", output); },
      end: (turnId, text) => { r.agent(text).taskComplete(turnId, text); },
    };
  }

  override async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    const stream: Stream = { queue: [{ message, opts }], wake: null, ended: false, first: opts?.sessionCollabMcp };
    const cwd = getSessionProjectPath(sessionId) ?? "";
    let thread = sessionId;
    if (!this.rollouts.has(sessionId)) {
      // A chat codex has never seen: its thread gets codex's own id, as `thread/start` answers.
      thread = randomUUID();
      setSessionMetadata(thread, undefined, cwd);
      setSessionProvider(thread, this.id);
      yield { type: "session_migrated", oldSessionId: sessionId, newSessionId: thread } as ChatEvent;
    }
    this.streams.set(sessionId, stream);
    this.streams.set(thread, stream);
    const writer = this.writer(thread, cwd);
    try {
      yield* streamLoop(stream, (pending) => runTurn({
        ids: [thread, sessionId], stream, pending, writer,
        toolName: (tool) => `ppm_sessions:${tool}`,
        toolInput: (tool, args) => ({ server: "ppm_sessions", tool, arguments: args }),
      }));
    } finally {
      for (const id of [sessionId, thread]) if (this.streams.get(id) === stream) this.streams.delete(id);
    }
  }
}
