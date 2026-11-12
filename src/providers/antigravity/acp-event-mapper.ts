import type { ChatEvent, SendMessageOpts } from "../../types/chat.ts";
import { withSharedContext } from "../../shared/provider-context.ts";
import { buildTurnUsage, type TurnUsage } from "../../shared/turn-usage.ts";
import { mapAntigravityToolCall } from "./antigravity-transcript-parser.ts";

/** One `session/update` payload from `agy acp`, narrowed to the fields PPM reads. */
export interface AcpUpdate {
  sessionUpdate?: string;
  content?: unknown;
  toolCallId?: string;
  name?: string;
  title?: string;
  status?: string;
  args?: Record<string, unknown>;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  availableCommands?: unknown;
}

export interface AcpPermissionOption {
  optionId: string;
  kind?: string;
}

/** Tool calls already shown in the turn: agy repeats a call's name and args on every update. */
export interface AcpToolState {
  started: Set<string>;
  finished: Set<string>;
}

export function newToolState(): AcpToolState {
  return { started: new Set(), finished: new Set() };
}

/** The card PPM shows for an agy tool call, named the way the transcript history names it. */
export function acpToolCard(call: { toolCallId?: string; name?: string; title?: string; args?: Record<string, unknown>; rawInput?: Record<string, unknown> }) {
  const mapped = mapAntigravityToolCall({ id: call.toolCallId, name: call.name ?? call.title, args: call.args ?? call.rawInput }, 0, 0);
  return { tool: mapped.tool, input: mapped.input };
}

export function mapAcpUpdate(update: AcpUpdate, tools: AcpToolState): ChatEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update.content);
      return text ? [{ type: "text", content: text }] : [];
    }
    case "agent_thought_chunk": {
      const text = textOf(update.content);
      return text ? [{ type: "thinking", content: text }] : [];
    }
    case "tool_call":
    case "tool_call_update":
      return toolEvents(update, tools);
    default:
      return [];
  }
}

function textOf(content: unknown): string {
  const c = content as { type?: string; text?: unknown } | undefined;
  return c?.type === "text" && typeof c.text === "string" ? c.text : "";
}

function toolEvents(update: AcpUpdate, tools: AcpToolState): ChatEvent[] {
  const id = update.toolCallId;
  if (!id) return [];
  const out: ChatEvent[] = [];
  if (!tools.started.has(id)) {
    tools.started.add(id);
    out.push({ type: "tool_use", ...acpToolCard(update), toolUseId: id });
  }
  if ((update.status === "completed" || update.status === "failed") && !tools.finished.has(id)) {
    tools.finished.add(id);
    const { output, exitCode } = toolOutput(update);
    out.push({
      type: "tool_result",
      toolUseId: id,
      output,
      ...(update.status === "failed" ? { isError: true } : {}),
      ...(exitCode != null ? { exitCode } : {}),
    });
  }
  return out;
}

function toolOutput(update: AcpUpdate): { output: string; exitCode?: number } {
  const raw = update.rawOutput as { output?: unknown; exit_code?: unknown } | undefined;
  const exitCode = typeof raw?.exit_code === "number" ? raw.exit_code : undefined;
  if (typeof raw?.output === "string") return { output: raw.output, exitCode };
  const parts = Array.isArray(update.content)
    ? update.content.map((c) => textOf((c as { content?: unknown })?.content)).filter(Boolean)
    : [];
  if (parts.length) return { output: parts.join("\n"), exitCode };
  if (raw != null) return { output: typeof raw === "string" ? raw : JSON.stringify(raw), exitCode };
  return { output: "", exitCode };
}

/** A user message as `session/prompt` content. Images lead: the text usually refers to them. */
export function acpPromptBlocks(message: string, opts?: SendMessageOpts): unknown[] {
  return [
    ...(opts?.images ?? []).map((img) => ({ type: "image", mimeType: img.mediaType, data: img.data })),
    { type: "text", text: withSharedContext(message, opts?.sharedContext) },
  ];
}

/**
 * A new chat's `_meta.antigravity.systemPrompt.append`: the provider's Additional Instructions,
 * then PPM's shared context. agy reads it only in `session/new` and keeps it with the chat for
 * good; `session/load` and `session/prompt` ignore it (measured on agy 1.5.2).
 */
export function acpSystemPromptAppend(additional?: string, sharedContext?: string): string | undefined {
  const parts = [additional, sharedContext ? withSharedContext("", sharedContext) : undefined]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part);
  return parts.length ? parts.join("\n\n") : undefined;
}

/** agy compacts on `/compact` without sending a single update, so PPM reports it itself. */
export function isCompactCommand(message: string): boolean {
  return /^\s*\/compact(\s|$)/.test(message);
}

/** `outputTokens` already counts thinking, and `inputTokens` excludes the cached prefix (measured on agy 1.5.2). */
export function acpTurnUsage(usage: unknown, model: string): TurnUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number };
  return buildTurnUsage({
    [model]: {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadInputTokens: u.cachedReadTokens ?? 0,
      cacheCreationInputTokens: u.cachedWriteTokens ?? 0,
    },
  });
}

/** How the turn ends, from the stop reason of its last `session/prompt` answer. */
export function stopReasonEvents(stopReason: unknown, sessionId: string, usage?: TurnUsage): ChatEvent[] {
  const withUsage = usage ? { usage } : {};
  const failed = (message: string, resultSubtype: "error_during_execution" | "error_max_turns" = "error_during_execution"): ChatEvent[] => [
    { type: "error", message },
    { type: "done", sessionId, resultSubtype, ...withUsage },
  ];
  switch (stopReason) {
    case "cancelled":
      return [{ type: "done", sessionId, resultSubtype: "error_during_execution", ...withUsage }];
    case "max_tokens":
      return failed("Antigravity stopped: the reply reached its length limit.");
    case "max_turn_requests":
      return failed("Antigravity stopped: the turn reached its step limit.", "error_max_turns");
    case "refusal":
      return failed("Antigravity declined to continue this request.");
    default:
      return [{ type: "done", sessionId, resultSubtype: "success", ...withUsage }];
  }
}

/** The answer to a permission request: the option of the matching kind, else a cancel. */
export function permissionOutcome(options: AcpPermissionOption[], approved: boolean): unknown {
  const kinds = approved ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** agy's session mode for a PPM permission mode. Bypass keeps agy's default and PPM answers every ask. */
export function acpModeFor(permissionMode?: string): string {
  if (permissionMode === "acceptEdits") return "accept-edits";
  if (permissionMode === "plan") return "plan";
  return "default";
}
