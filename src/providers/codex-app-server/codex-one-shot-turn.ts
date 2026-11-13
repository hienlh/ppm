/**
 * The pieces of a Codex one-shot that need no subprocess: the params of its thread and turn,
 * and a collector that turns the app-server's notifications into one answer.
 *
 * Checked against the protocol schema `codex app-server generate-json-schema` writes for
 * codex-cli 0.164.0: `ThreadStartParams` has `ephemeral` (no rollout file, so the call never
 * shows up as a session) and a free-form `config`, whose `web_search` takes
 * `disabled | cached | indexed | live`; `TurnStartParams` has `outputSchema` ("Optional JSON
 * Schema used to constrain the final assistant message for this turn").
 */
import type { JsonRpcNotification } from "./codex-protocol.ts";
import type { OneShotUsage } from "../one-shot-error.ts";
import { threadIdFromNotification } from "./codex-notification-thread.ts";
import { codexAccountProblemOf, type CodexAccountProblem } from "./codex-one-shot-account-health.ts";

export interface CodexOneShotParamsInput {
  cwd: string;
  model: string;
  systemPrompt?: string;
  webSearch?: boolean;
  /** The user's own MCP servers (`planAssistantCodexMcp`), each switched off for the call. */
  disableMcpServers?: readonly string[];
}

/**
 * Tool surfaces a one-shot never needs, switched off with the same dotted keys as
 * `codex -c features.<name>=false`. A read-only sandbox still offers a shell that can read any
 * file, and under live web search a page could ask for one to be read and sent on; subagents
 * would open threads the call does not watch; apps and plugins reach accounts beyond the call.
 * Each key was checked with `codex -c features.<name>=false features list` (codex-cli 0.163.0).
 * `unified_exec` is left out: that override did not take effect on that version.
 */
export const CODEX_ONE_SHOT_FEATURES_OFF: Readonly<Record<string, false>> = {
  "features.shell_tool": false,
  "features.multi_agent": false,
  "features.image_generation": false,
  "features.apps": false,
  "features.plugins": false,
};

export function codexOneShotThreadParams(input: CodexOneShotParamsInput): Record<string, unknown> {
  return {
    cwd: input.cwd,
    model: input.model,
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
    ...(input.systemPrompt?.trim() ? { developerInstructions: input.systemPrompt } : {}),
    config: {
      web_search: input.webSearch ? "live" : "disabled",
      ...CODEX_ONE_SHOT_FEATURES_OFF,
      ...Object.fromEntries((input.disableMcpServers ?? []).map((name) => [`mcp_servers.${name}.enabled`, false])),
    },
  };
}

export function codexOneShotTurnParams(
  threadId: string,
  input: { prompt: string; model: string },
  outputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: input.prompt, text_elements: [] }],
    model: input.model,
    ...(outputSchema ? { outputSchema } : {}),
  };
}

/** A turn's end as `turn/completed` reports it. */
export interface CodexTurnEnd {
  status: string;
  error?: string;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Notifications of the call's own thread folded into its answer, its token count and its last
 * error. One app-server also streams any thread the model spawns, so a notification naming
 * another thread is dropped: a child's `turn/completed` must not end the call with the child's
 * text. A notification naming no thread is taken as the call's own, as the chat path does.
 */
export class CodexOneShotCollector {
  private deltas = "";
  private lastMessage: string | null = null;
  /** Token totals per thread the call started; a schema retry runs on a thread of its own. */
  private usageByThread = new Map<string, OneShotUsage>();
  private searches = 0;
  private current: string | null = null;
  /** The last error codex reported for good (retry notices are not errors). */
  lastError = "";
  turnId: string | null = null;
  private onEnd: ((end: CodexTurnEnd) => void) | null = null;
  /** Told about a signed-out or spent account the moment codex names it. */
  onAccountProblem: ((problem: CodexAccountProblem) => void) | null = null;

  /** From now on, only this thread's notifications count. */
  follow(threadId: string): void {
    this.current = threadId;
  }

  /** Called once when the running turn ends. */
  awaitEnd(fn: (end: CodexTurnEnd) => void): void {
    this.onEnd = fn;
  }

  /** A new turn starts from an empty answer. */
  resetAnswer(): void {
    this.deltas = "";
    this.lastMessage = null;
    this.lastError = "";
    this.turnId = null;
  }

  handle(notif: JsonRpcNotification): void {
    const p = asObj(notif.params);
    const threadId = threadIdFromNotification(notif.params);
    if (threadId && threadId !== this.current) return;
    switch (notif.method) {
      case "turn/started": {
        const id = asObj(p.turn).id;
        if (typeof id === "string") this.turnId = id;
        return;
      }
      case "item/agentMessage/delta":
        if (typeof p.delta === "string") this.deltas += p.delta;
        return;
      case "item/completed": {
        const item = asObj(p.item);
        if (item.type === "agentMessage" && typeof item.text === "string") this.lastMessage = item.text;
        if (item.type === "webSearch") this.searches++;
        return;
      }
      case "thread/tokenUsage/updated": {
        // `total` is the thread's running sum.
        const total = asObj(asObj(p.tokenUsage).total);
        if (typeof total.inputTokens === "number") {
          this.usageByThread.set(threadId ?? this.current ?? "", { inputTokens: num(total.inputTokens), outputTokens: num(total.outputTokens) });
        }
        return;
      }
      case "error": {
        const problem = codexAccountProblemOf(notif.params);
        if (problem) this.onAccountProblem?.(problem);
        if (p.willRetry === true) return;
        const err = asObj(p.error);
        this.lastError = typeof err.message === "string" ? err.message : typeof p.message === "string" ? p.message : "codex error";
        return;
      }
      case "turn/completed": {
        const turn = asObj(p.turn);
        const status = typeof turn.status === "string" ? turn.status : "completed";
        const turnError = asObj(turn.error).message;
        const end: CodexTurnEnd = { status };
        const error = typeof turnError === "string" && turnError ? turnError : this.lastError;
        if (error) end.error = error;
        const fn = this.onEnd;
        this.onEnd = null;
        fn?.(end);
        return;
      }
      default:
        return;
    }
  }

  answer(): string {
    return this.lastMessage ?? this.deltas;
  }

  tokens(): OneShotUsage {
    let inputTokens = 0, outputTokens = 0;
    for (const u of this.usageByThread.values()) { inputTokens += u.inputTokens; outputTokens += u.outputTokens; }
    return { inputTokens, outputTokens, ...(this.searches > 0 && { webSearches: this.searches }) };
  }
}

/** Whether a failed turn was refused for the schema it carried (so a retry without it can work). */
export function isSchemaRefusal(message: string): boolean {
  return /json[\s_-]?schema|output[\s_-]?schema|response_format|text\.format|invalid schema/i.test(message);
}
