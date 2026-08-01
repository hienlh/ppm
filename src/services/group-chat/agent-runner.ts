import type { AgentTurnResult, GroupMember } from "../../types/group-chat.ts";

const SUMMARY_CAP = 600;

/** Narrow provider abstraction so the runner is unit-testable without a real
 *  provider. Production wiring passes an adapter over ChatService. */
export interface ChatBackend {
  createSession(config: { projectPath?: string; projectName?: string; title?: string }): Promise<{ id: string }>;
  sendMessage(
    providerId: string,
    sessionId: string,
    prompt: string,
    opts?: { permissionMode?: string; signal?: AbortSignal; model?: string; oneMContext?: boolean },
  ): AsyncIterable<{ type: string; content?: string; message?: string; costUsd?: number; usage?: { costUsd?: number } }>;
}

export interface AgentRunResult {
  text: string;
  full: string;
  summary: string;
  usage?: { costUsd?: number };
}

/** Run one turn for a member's session. Summary is derived from the FULL
 *  concatenated text (capped) — never the last streamed chunk (spike-v1 fix). */
export async function runAgentTurn(
  backend: ChatBackend,
  providerId: string,
  member: GroupMember,
  prompt: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AgentRunResult> {
  if (!member.sessionId) throw new Error(`member ${member.name} has no session`);
  if (opts.signal?.aborted) return { text: "", full: "", summary: "" };

  let full = "";
  let costUsd: number | undefined;

  const events = backend.sendMessage(providerId, member.sessionId, prompt, {
    permissionMode: "bypassPermissions",
    // Honor the member's configured model (e.g. haiku); falls back to the provider
    // default when unset. Without this the turn always used the provider default.
    model: member.model ?? undefined,
    // Group turns are short/windowed — never request the 1M-context beta. If the user's
    // config has context_1m on, the [1m] model suffix triggers "long context beta not
    // available for this subscription" (HTTP 400). Opt out here (like the router).
    oneMContext: false,
    signal: opts.signal,
  });

  for await (const ev of events) {
    if (opts.signal?.aborted) break;
    if (ev.type === "text") full += ev.content ?? "";
    else if (ev.type === "error") {
      // Provider errors (auth, rate limit, crash) are terminal for this turn.
      // Throw so the turn loop aborts and surfaces the error to the UI instead
      // of appending an empty message and looping to the turn cap.
      throw new Error(ev.message || `agent turn failed for ${member.name}`);
    }
    else if (ev.type === "done") {
      costUsd = ev.costUsd ?? ev.usage?.costUsd;
      break;
    }
  }

  full = full.trim();
  const summary = full.length > SUMMARY_CAP ? full.slice(0, SUMMARY_CAP) : full;
  return { text: full, full, summary, usage: { costUsd } };
}

/** Adapt the runner into the Phase-2 engine's `runAgent` dep. The engine only
 *  needs `{ text, usage }`; the full transcript is captured separately at
 *  spawn/archive time via each member's session. */
export function makeEngineRunAgent(
  backend: ChatBackend,
  providerId: string,
  signal?: AbortSignal,
): (member: GroupMember, prompt: string) => Promise<AgentTurnResult> {
  return async (member, prompt) => {
    const res = await runAgentTurn(backend, providerId, member, prompt, { signal });
    return { text: res.text, usage: res.usage };
  };
}

/** Run async task factories with a bounded concurrency pool. Results preserve
 *  input order (index-mapped), independent of completion order. */
export async function dispatchParallel<T>(
  tasks: Array<() => Promise<T>>,
  cap: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  const limit = Math.max(1, cap);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      const task = tasks[i];
      if (!task) return;
      results[i] = await task();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
