import type { ChatEvent } from "../provider.interface.ts";
import { redactTruncate } from "./codex-redact.ts";
import { diffToOldNew, changeToToolUse } from "./codex-patch.ts";

/** ThreadItem variants that map to a PPM tool_use/tool_result pair. */
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
]);

interface Notif {
  method: string;
  params?: unknown;
}

type Item = Record<string, unknown> & { type?: string; id?: string };

function asObj(v: unknown): Record<string, unknown> {
  return (v && typeof v === "object") ? (v as Record<string, unknown>) : {};
}

/** Build the tool_use input payload from a ThreadItem (per-variant fields). */
export function itemToToolUse(item: Item): ChatEvent {
  const type = item.type ?? "tool";
  let tool = type;
  let input: unknown = {};
  switch (type) {
    case "commandExecution": {
      // Map to PPM's canonical shell tools so the chat UI renders the command
      // (not a raw `commandExecution` JSON blob). Sniff PowerShell vs Bash.
      const command = String(item.command ?? "");
      tool = /powershell|pwsh/i.test(command) ? "PowerShell" : "Bash";
      input = { command, cwd: item.cwd };
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
    default:
      input = item;
  }
  return { type: "tool_use", tool, input, toolUseId: item.id };
}

/** Build the tool_result from a completed ThreadItem. */
export function itemToToolResult(item: Item): ChatEvent {
  const type = item.type;
  let output = "";
  let isError = false;

  if (type === "commandExecution") {
    output = redactTruncate(item.aggregatedOutput ?? "");
    const exit = item.exitCode;
    isError = typeof exit === "number" && exit !== 0;
  } else if (type === "mcpToolCall") {
    output = redactTruncate(item.result ?? item.error ?? "");
    isError = item.error != null;
  } else if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    output = changes.map((c) => `${(c as any)?.kind?.type ?? "update"} ${(c as any)?.path ?? ""}`.trim()).join("\n") || "applied";
    const st = item.status as { type?: string } | string | undefined;
    isError = (typeof st === "object" ? st?.type : st) === "failed";
  } else if (type === "dynamicToolCall") {
    output = redactTruncate(item.contentItems ?? "");
    isError = item.success === false;
  } else {
    output = redactTruncate(item);
  }

  return { type: "tool_result", output, isError, toolUseId: item.id };
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
      return typeof p.delta === "string" ? [{ type: "thinking", content: p.delta }] : [];

    case "item/started": {
      const item = asObj(p.item) as Item;
      if (item.type === "contextCompaction") return [{ type: "system", subtype: "compacting" }];
      if (item.type && TOOL_ITEM_TYPES.has(item.type)) return [itemToToolUse(item)];
      return [];
    }

    // codex auto/manual compaction finished — surface PPM's compact status.
    case "thread/compacted":
      return [{ type: "system", subtype: "compact_done" }];

    case "item/completed": {
      const item = asObj(p.item) as Item;
      if (item.type === "contextCompaction") return [{ type: "system", subtype: "compact_done" }];
      if (item.type && TOOL_ITEM_TYPES.has(item.type)) return [itemToToolResult(item)];
      return [];
    }

    case "turn/completed":
      return [{ type: "done", sessionId, resultSubtype: "success" }];

    case "error": {
      const err = asObj(p.error);
      const message = typeof err.message === "string" ? err.message
        : typeof p.message === "string" ? p.message
        : "codex error";
      return [{ type: "error", message: redactTruncate(message, 1024) }];
    }

    // Usage cut from MVP — ChatEvent has no usage variant + no cross-provider sink.
    case "thread/tokenUsage/updated":
    case "account/rateLimits/updated":
      return [];

    default:
      return []; // ignore unknown / out-of-scope notifications
  }
}
