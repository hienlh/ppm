import type { ChatEvent } from "../provider.interface.ts";
import type { TurnUsage } from "../../shared/turn-usage.ts";
import { redactTruncate } from "./codex-redact.ts";
import { diffToOldNew, changeToToolUse } from "./codex-patch.ts";
import { parseSubagentActivity, subagentToolResult, subagentToolUse } from "./codex-subagent-thread.ts";

/** ThreadItem variants that are NOT tool calls (text/metadata). Everything else
 * is treated as a tool so nothing is ever silently hidden — known types get a
 * nice mapping, unknown/future ones fall back to a generic visible card. */
const NON_TOOL_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "hookPrompt",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
]);

interface Notif {
  method: string;
  params?: unknown;
}

type Item = Record<string, unknown> & { type?: string; id?: string };

function asObj(v: unknown): Record<string, unknown> {
  return (v && typeof v === "object") ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Keep web-search cards readable: Codex returns structured results, not terminal output. */
function webSearchOutput(item: Item): string {
  const error = text(item.error);
  if (error) return error;
  const results = Array.isArray(item.results) ? item.results : [];
  if (results.length === 0) return "Search completed with no results.";
  const lines = results.slice(0, 8).flatMap((value, index) => {
    const result = asObj(value);
    const url = text(result.url) || text(result.href) || text(result.link);
    const title = text(result.title) || text(result.name) || text(result.domain) || url || `Result ${index + 1}`;
    const snippet = text(result.snippet) || text(result.description) || text(result.text);
    return [
      `${index + 1}. ${title}`,
      ...(url ? [`   ${url}`] : []),
      ...(snippet ? [`   ${snippet}`] : []),
    ];
  });
  return [`Found ${results.length} result${results.length === 1 ? "" : "s"}.`, ...lines].join("\n");
}

/**
 * The command text to SHOW for a commandExecution item.
 *
 * A commandExecution carries the same command twice. `command` is what codex
 * hands its exec layer: the interpreter wrapped around the script, with every
 * backslash in the interpreter path doubled (`C:\\Windows\\System32\\…`), so
 * rendering it puts `\\` in front of the user. `commandActions[].command` is
 * the unwrapped script — single backslashes, no interpreter prefix — which is
 * the part a reader actually cares about.
 *
 * Un-escaping `command` instead would be wrong: a legitimate bash script can
 * contain a real `\\` (regex, escaped path), and rewriting that corrupts the
 * command the user is being shown.
 *
 * Multiple actions are joined by newline; an item with none (or with blank
 * ones) falls back to the wrapped form, because showing the doubled path still
 * beats showing an empty card.
 */
export function commandDisplayText(item: Item): string {
  const raw = String(item.command ?? "");
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const parts: string[] = [];
  for (const a of actions) {
    const cmd = asObj(a).command;
    if (typeof cmd === "string" && cmd.trim()) parts.push(cmd);
  }
  return parts.length > 0 ? parts.join("\n") : raw;
}

/** Build the tool_use input payload from a ThreadItem (per-variant fields). */
export function itemToToolUse(item: Item): ChatEvent {
  const type = item.type ?? "tool";
  let tool = type;
  let input: unknown = {};
  switch (type) {
    case "commandExecution": {
      // Map to PPM's canonical shell tools so the chat UI renders the command
      // (not a raw `commandExecution` JSON blob). Sniff PowerShell vs Bash from
      // the WRAPPED form — the interpreter only appears there, never in the
      // unwrapped script that gets displayed.
      tool = /powershell|pwsh/i.test(String(item.command ?? "")) ? "PowerShell" : "Bash";
      input = { command: commandDisplayText(item), cwd: item.cwd };
      break;
    }
    case "fileChange": {
      // Render like Claude's Edit/Write: first change → file_path + diff.
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const ch = changes[0] as { path?: string; kind?: { type?: string }; diff?: string } | undefined;
      if (ch) {
        const { oldString, newString } = diffToOldNew(ch.diff ?? "");
        const op = (ch.kind?.type as "add" | "update" | "delete") ?? "update";
        return changeToToolUse({ path: ch.path ?? "", op, oldString, newString }, item.id);
      }
      input = { changes: item.changes };
      break;
    }
    case "mcpToolCall":
      tool = `${item.server ?? "mcp"}:${item.tool ?? "tool"}`;
      input = { server: item.server, tool: item.tool, arguments: item.arguments };
      break;
    case "dynamicToolCall":
      tool = String(item.tool ?? "dynamicTool");
      input = { namespace: item.namespace, tool: item.tool, arguments: item.arguments };
      break;
    case "webSearch":
      tool = "WebSearch";
      input = { query: item.query };
      break;
    case "imageGeneration":
      // The item carries the finished PNG twice: `result` is the whole file as
      // base64 (~1.2 MB for a 917 KB image) and `savedPath` points at the copy
      // codex already wrote to disk. Only the path is kept. `result` must never
      // reach a ChatEvent — the event is held in the in-RAM turnEvents buffer,
      // appended to the session JSONL, and broadcast to every connected client,
      // so carrying the payload would cost all three that megabyte per image
      // to display a picture that is already readable from `savedPath`.
      //
      // `file_path` (not `savedPath`) is deliberate: it is the key the chat's
      // image-preview path check already reads, so the thumbnail comes for free.
      tool = "ImageGen";
      input = {
        file_path: item.savedPath ?? null,
        prompt: item.revisedPrompt ?? null,
        transparentBackground: item.transparentBackground ?? false,
      };
      break;
    default:
      input = item;
  }
  return { type: "tool_use", tool, input, toolUseId: item.id };
}

/** Build the tool_result from a completed ThreadItem. */
/**
 * An MCP result's content blocks as readable text, with any image reduced to a label. A
 * block's base64 payload (a `design_check` screenshot is up to half a megabyte) would
 * otherwise be the visible result, and ride through the turn buffer and the JSONL with it.
 */
export function mcpResultText(result: unknown): string | undefined {
  if (result == null) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : JSON.stringify(result);
  return content.map((block) => {
    const b = (block ?? {}) as { type?: unknown; text?: unknown; mimeType?: unknown };
    if (b.type === "text" && typeof b.text === "string") return b.text;
    if (b.type === "image") return `[image ${typeof b.mimeType === "string" ? b.mimeType : ""}]`.replace(" ]", "]");
    return JSON.stringify(block);
  }).join("\n");
}

export function itemToToolResult(item: Item): ChatEvent {
  const type = item.type;
  let output = "";
  let isError = false;
  let exitCode: number | undefined;

  if (type === "commandExecution") {
    output = redactTruncate(item.aggregatedOutput ?? "");
    const exit = item.exitCode;
    exitCode = typeof exit === "number" ? exit : undefined;
    isError = exitCode != null && exitCode !== 0;
  } else if (type === "mcpToolCall") {
    output = redactTruncate(mcpResultText(item.result) ?? item.error ?? "");
    isError = item.error != null;
  } else if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    output = changes.map((c) => `${(c as any)?.kind?.type ?? "update"} ${(c as any)?.path ?? ""}`.trim()).join("\n") || "applied";
    const st = item.status as { type?: string } | string | undefined;
    isError = (typeof st === "object" ? st?.type : st) === "failed";
  } else if (type === "dynamicToolCall") {
    output = redactTruncate(item.contentItems ?? "");
    isError = item.success === false;
  } else if (type === "imageGeneration") {
    // Same reason as the tool_use side: never let the base64 `result` through.
    // Falling to the generic branch below would emit 8 KB of truncated base64
    // as the visible result text.
    const failure = item.failure;
    isError = failure != null;
    output = isError ? redactTruncate(failure) : String(item.savedPath ?? "generated");
  } else if (type === "webSearch") {
    output = redactTruncate(webSearchOutput(item));
    isError = item.error != null;
  } else {
    output = redactTruncate(item);
  }

  return { type: "tool_result", output, isError, ...(exitCode != null ? { exitCode } : {}), toolUseId: item.id };
}

/**
 * Pure translation of one codex app-server notification → PPM ChatEvent[].
 * Stateless: the caller owns any per-itemId outputDelta buffering. Never throws;
 * unknown methods and unexpected shapes map to `[]`.
 */
export function mapCodexEvent(notif: Notif, sessionId: string): ChatEvent[] {
  const p = asObj(notif.params);
  switch (notif.method) {
    case "item/agentMessage/delta":
      return typeof p.delta === "string" ? [{ type: "text", content: p.delta }] : [];

    case "item/reasoning/textDelta":
    // Preserve provider text verbatim; summaryTextDelta is the summary stream
    // requested by turn/start, textDelta is the supported content stream.
    case "item/reasoning/summaryTextDelta":
      return typeof p.delta === "string" ? [{ type: "thinking", content: p.delta }] : [];

    case "item/reasoning/summaryPartAdded":
      // Separate sections, including the first section of a new reasoning item,
      // without inserting whitespace between individual streaming chunks.
      return [{ type: "thinking", content: "\n\n" }];

    case "item/started": {
      const item = asObj(p.item) as Item;
      if (item.type === "contextCompaction") return [{ type: "system", subtype: "compacting" }];
      // A spawned agent is a card, not a tool: its start and its completion are
      // two records naming one thread, and the generic mapping rendered each as
      // a card of its own with the raw item as its body.
      const subagent = parseSubagentActivity(item);
      if (subagent) return [subagentToolUse(subagent)];
      if (item.type && !NON_TOOL_ITEM_TYPES.has(item.type)) return [itemToToolUse(item)];
      return [];
    }

    // codex auto/manual compaction finished — surface PPM's compact status.
    case "thread/compacted":
      return [{ type: "system", subtype: "compact_done" }];

    case "item/completed": {
      const item = asObj(p.item) as Item;
      if (item.type === "contextCompaction") return [{ type: "system", subtype: "compact_done" }];
      const subagent = parseSubagentActivity(item);
      // Answers the card opened at `started` — keyed on the thread, because the
      // two records carry different item ids. The agent's own report is not on
      // this record; the card picks it up when the transcript is read back.
      if (subagent) return [subagent.done ? subagentToolResult(subagent) : subagentToolUse(subagent)];
      if (item.type && !NON_TOOL_ITEM_TYPES.has(item.type)) {
        // Image generation is announced before the picture exists: at `started`
        // there is no saved file and no revised prompt, so the call it produced
        // can show neither. The finished item carries both, so re-emit the call
        // alongside its result — the chat replaces the card by tool-use id.
        // Other tools describe themselves fully at `started`; re-sending those
        // would only cost a second event in the buffer, the log and every
        // client's socket.
        if (item.type === "imageGeneration" || item.type === "webSearch") return [itemToToolUse(item), itemToToolResult(item)];
        return [itemToToolResult(item)];
      }
      return [];
    }

    case "turn/completed":
      return [{ type: "done", sessionId, resultSubtype: "success" }];

    case "error": {
      const err = asObj(p.error);
      const message = typeof err.message === "string" ? err.message
        : typeof p.message === "string" ? p.message
        : "codex error";
      // `willRetry: true` is codex narrating its own retry loop ("Reconnecting...
      // 2/5"), not a failure: the turn is still running and ends with either an
      // answer or a final `willRetry: false` error. Reporting each one as an error
      // put a card per attempt in the chat and made the proxy give up on a turn
      // at the first reconnect.
      if (p.willRetry === true) {
        return [{ type: "status_update", phase: "retrying", message: redactTruncate(message, 256) }];
      }
      return [{ type: "error", message: redactTruncate(message, 1024) }];
    }

    // Neither carries a ChatEvent of its own. Token usage is read by the caller
    // through parseTokenUsage and attached to the turn's `done`; rate limits are
    // served by the usage registry instead.
    case "thread/tokenUsage/updated":
    case "account/rateLimits/updated":
      return [];

    default:
      return []; // ignore unknown / out-of-scope notifications
  }
}

/**
 * Per-turn token counts from `thread/tokenUsage/updated`.
 *
 * Codex reports `inputTokens` as the whole prefix with `cachedInputTokens`
 * already inside it, while TurnUsage.inputTokens means the fresh part only —
 * so the cached and cache-write shares are subtracted rather than added.
 *
 * `last` is this turn; `total` accumulates over the thread and would inflate
 * every turn after the first.
 *
 * `costUsd` stays 0: codex bills against a subscription, so there is no
 * per-token price to report.
 */
export function parseTokenUsage(params: unknown, model?: string): TurnUsage | null {
  const usage = asObj(asObj(params).tokenUsage);
  const last = asObj(usage.last);
  if (typeof last.inputTokens !== "number") return null;

  const cacheReadTokens = num(last.cachedInputTokens);
  const cacheWriteTokens = num(last.cacheWriteInputTokens);
  const prefix = num(last.inputTokens);
  return {
    model: model ?? "",
    inputTokens: Math.max(prefix - cacheReadTokens - cacheWriteTokens, 0),
    outputTokens: num(last.outputTokens),
    cacheReadTokens,
    cacheWriteTokens,
    contextWindow: num(usage.modelContextWindow),
    costUsd: 0,
    cacheHitRate: prefix > 0 ? cacheReadTokens / prefix : 0,
    coldStart: false,
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
