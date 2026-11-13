import type { ChatEvent, ChatMessage } from "../../types/chat.ts";
import { stripSharedContext } from "../../shared/provider-context.ts";
import { decodeReply } from "../../shared/chat-reply.ts";
import { buildTurnUsage, type TurnUsage } from "../../shared/turn-usage.ts";

export interface AntigravityToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface AntigravityTranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  error?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  tool_calls?: AntigravityToolCall[];
  truncated_fields?: string[];
}

const UUID_GLOBAL_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const EXPLICIT_SUBAGENT_ID_RE =
  /(?:conversationId|conversation_id|conversation:\/\/)["'\s:=]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/**
 * Extract the spawned subagent conversation UUID from an `invoke_subagent` tool result,
 * preferring explicit `conversationId` fields and never returning the parent session's own UUID.
 */
export function extractSubagentIdFromOutput(output: string, parentSessionId?: string): string | null {
  if (!output) return null;
  const parentLower = parentSessionId?.toLowerCase();
  for (const m of output.matchAll(EXPLICIT_SUBAGENT_ID_RE)) {
    const candidate = m[1];
    if (candidate && candidate.toLowerCase() !== parentLower) {
      return candidate;
    }
  }
  for (const m of output.matchAll(UUID_GLOBAL_RE)) {
    const candidate = m[1];
    if (candidate && candidate.toLowerCase() !== parentLower) {
      return candidate;
    }
  }
  return null;
}

/** Unwrap double-encoded JSON string values produced in `transcript.jsonl` tool_calls.args. */
export function normalizeToolArgs(rawArgs?: Record<string, unknown>): Record<string, unknown> {
  if (!rawArgs || typeof rawArgs !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(rawArgs)) {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
        trimmed === "true" ||
        trimmed === "false" ||
        /^-?\d+(\.\d+)?$/.test(trimmed)
      ) {
        try {
          out[key] = JSON.parse(trimmed);
          continue;
        } catch { /* keep original string */ }
      }
    }
    out[key] = val;
  }
  return out;
}

/** Map Antigravity tool names and parameters to PPM's standard tool card conventions. */
export function mapAntigravityToolCall(
  call: AntigravityToolCall,
  stepIndex: number,
  callIndex: number,
): { tool: string; input: Record<string, unknown>; toolUseId: string; isSubagent: boolean } {
  const args = normalizeToolArgs(call.args);
  const name = call.name || "unknown_tool";
  const toolUseId = call.id || `agy-step-${stepIndex}-call-${callIndex}`;

  switch (name) {
    case "read_file":
      return {
        tool: "Read",
        input: { file_path: args.Path ?? args.file_path, ...args },
        toolUseId,
        isSubagent: false,
      };
    case "write_file":
      return {
        tool: "Write",
        input: { file_path: args.Path ?? args.file_path, content: args.Content ?? args.content, ...args },
        toolUseId,
        isSubagent: false,
      };
    case "edit_file":
      return {
        tool: "Edit",
        input: {
          file_path: args.Path ?? args.file_path,
          old_string: args.Target ?? args.old_string,
          new_string: args.Replacement ?? args.new_string,
          ...args,
        },
        toolUseId,
        isSubagent: false,
      };
    case "run_command":
      return {
        tool: "Bash",
        input: {
          command: args.CommandLine ?? args.command,
          description: args.toolSummary ?? args.description,
          ...args,
        },
        toolUseId,
        isSubagent: false,
      };
    case "invoke_subagent":
      return {
        tool: "Agent",
        input: {
          description: args.Role ?? args.TypeName ?? "Subagent",
          prompt: args.Prompt,
          subagent_type: args.TypeName,
          ...args,
        },
        toolUseId,
        isSubagent: true,
      };
    default:
      return { tool: name, input: args, toolUseId, isSubagent: false };
  }
}

/** Extract clean user prompt from Antigravity `<USER_REQUEST>` or `agentapi` `<SYSTEM_MESSAGE>` wrapper tags. */
export function cleanAntigravityUserInput(raw: string): string {
  if (!raw) return "";
  const sysMatch = /<SYSTEM_MESSAGE>\s*\[Message\][^\n]*?\ssender=system\s[^\n]*?\scontent=([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/i.exec(raw);
  const unwrapped = sysMatch ? sysMatch[1]! : raw;
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(unwrapped);
  const extracted = reqMatch
    ? reqMatch[1]!
    : unwrapped
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
        .trim();
  return decodeReply(stripSharedContext(extracted.trim())).content;
}

/** Strip `Created At: ...\nCompleted At: ...\n` header from tool output steps when present. */
export function cleanToolResultOutput(raw: string): string {
  if (!raw) return "";
  return raw.replace(/^Created At:[^\n]*\nCompleted At:[^\n]*\n\n?/i, "");
}

export interface PendingToolCall {
  toolUseId: string;
  isSubagent: boolean;
  deferred?: boolean;
  ts: number;
  toolEvent?: Extract<ChatEvent, { type: "tool_use" }>;
}

/**
 * Stateful line-by-line parser for Antigravity `transcript.jsonl`.
 * Used by both live turn tailing and the `/ws/global` subagent transcript window.
 */
export function createAntigravityTailParser(opts?: { parentSessionId?: string }) {
  const pendingQueue: PendingToolCall[] = [];
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let lastContextTokens: number | undefined;
  let hasUsage = false;

  const flushDeferredInto = (target: Array<{ ev: ChatEvent; ts: number }>): void => {
    for (const item of pendingQueue) {
      if (item.deferred && item.toolEvent) {
        item.deferred = false;
        target.push({ ev: item.toolEvent, ts: item.ts });
      }
    }
  };

  return {
    feed(line: string): { events: Array<{ ev: ChatEvent; ts: number }>; links: string[]; turnSettled: boolean } {
      const trimmed = line.trim();
      if (!trimmed) return { events: [], links: [], turnSettled: false };
      let step: AntigravityTranscriptStep;
      try {
        step = JSON.parse(trimmed) as AntigravityTranscriptStep;
      } catch {
        return { events: [], links: [], turnSettled: false };
      }

      const ts = step.created_at ? Date.parse(step.created_at) || Date.now() : Date.now();
      const stepIdx = step.step_index ?? 0;
      const events: Array<{ ev: ChatEvent; ts: number }> = [];
      const links: string[] = [];
      let turnSettled = false;

      if (step.type === "PLANNER_RESPONSE") {
        flushDeferredInto(events);
        pendingQueue.length = 0;

        if (
          typeof step.input_tokens === "number" ||
          typeof step.cache_read_tokens === "number" ||
          typeof step.output_tokens === "number"
        ) {
          const inp = typeof step.input_tokens === "number" ? step.input_tokens : 0;
          const cacheRead = typeof step.cache_read_tokens === "number" ? step.cache_read_tokens : 0;
          const out = typeof step.output_tokens === "number" ? step.output_tokens : 0;
          totalInputTokens += inp;
          totalCacheReadTokens += cacheRead;
          totalOutputTokens += out;
          if (inp + cacheRead > 0) {
            lastContextTokens = inp + cacheRead;
          }
          hasUsage = true;
        }

        if (step.thinking && step.thinking.trim()) {
          events.push({ ev: { type: "thinking", content: step.thinking.trim() }, ts });
        }
        // Emit text BEFORE tool_use so the step renders in the natural order the model wrote it
        if (step.content && step.content.trim()) {
          events.push({ ev: { type: "text", content: step.content }, ts });
        }
        const calls = step.tool_calls ?? [];
        for (let i = 0; i < calls.length; i++) {
          const mapped = mapAntigravityToolCall(calls[i]!, stepIdx, i);
          const ev: Extract<ChatEvent, { type: "tool_use" }> = {
            type: "tool_use",
            tool: mapped.tool,
            input: mapped.input,
            toolUseId: mapped.toolUseId,
          };
          if (mapped.isSubagent) {
            // Hold subagent tool_use until its GENERIC result step provides `subagent-<uuid>`
            // so live streaming emits tool_use and tool_result with the same `subagent-<uuid>` id.
            pendingQueue.push({
              toolUseId: mapped.toolUseId,
              isSubagent: true,
              deferred: true,
              ts,
              toolEvent: ev,
            });
          } else {
            events.push({ ev, ts });
            pendingQueue.push({ toolUseId: mapped.toolUseId, isSubagent: false, ts, toolEvent: ev });
          }
        }
        if (step.status === "DONE" && calls.length === 0) {
          turnSettled = true;
        }
      } else if (step.type === "GENERIC" && (step.source === "MODEL" || step.source === "SYSTEM" || !step.source)) {
        const pending = pendingQueue.shift();
        const output = cleanToolResultOutput(step.content || step.error || "");
        let toolUseId = pending?.toolUseId ?? `agy-step-${stepIdx}-result`;
        if (pending?.isSubagent) {
          const subId = extractSubagentIdFromOutput(output, opts?.parentSessionId);
          if (subId) {
            links.push(subId);
            toolUseId = `subagent-${subId}`;
            if (pending.toolEvent) {
              pending.toolEvent.toolUseId = toolUseId;
              pending.toolEvent.transcriptAvailable = true;
            }
          }
          if (pending.deferred && pending.toolEvent) {
            pending.deferred = false;
            events.push({ ev: pending.toolEvent, ts: pending.ts });
          }
        }
        events.push({
          ev: {
            type: "tool_result",
            output,
            isError: step.status === "ERROR",
            toolUseId,
          },
          ts,
        });
      }

      return { events, links, turnSettled };
    },
    flushPending(): Array<{ ev: ChatEvent; ts: number }> {
      const out: Array<{ ev: ChatEvent; ts: number }> = [];
      flushDeferredInto(out);
      return out;
    },
    getTurnUsage(model = "gemini-4-argon"): TurnUsage | undefined {
      if (!hasUsage) return undefined;
      return buildTurnUsage(
        {
          [model]: {
            inputTokens: totalInputTokens,
            cacheReadInputTokens: totalCacheReadTokens,
            outputTokens: totalOutputTokens,
          },
        },
        { contextTokens: lastContextTokens },
      );
    },
    resetTurnUsage(): void {
      totalInputTokens = 0;
      totalCacheReadTokens = 0;
      totalOutputTokens = 0;
      lastContextTokens = undefined;
      hasUsage = false;
    },
  };
}

/** Parse a complete `transcript.jsonl` (with optional `transcript_full.jsonl` fallback) into `ChatMessage[]`. */
export function parseAntigravityTranscriptSteps(
  lines: string[],
  fullLines?: string[],
  parentSessionId?: string,
): ChatMessage[] {
  const fullByStepIndex = new Map<number, AntigravityTranscriptStep>();
  if (fullLines) {
    for (const l of fullLines) {
      if (!l.trim()) continue;
      try {
        const parsed = JSON.parse(l) as AntigravityTranscriptStep;
        if (typeof parsed.step_index === "number") fullByStepIndex.set(parsed.step_index, parsed);
      } catch { /* ignore */ }
    }
  }

  const messages: ChatMessage[] = [];
  let currentAssistant: ChatMessage | null = null;
  const tailParser = createAntigravityTailParser({ parentSessionId });

  const finalizeCurrentAssistant = (): void => {
    if (!currentAssistant) return;
    for (const { ev } of tailParser.flushPending()) {
      currentAssistant.events!.push(ev);
    }
    const usage = tailParser.getTurnUsage();
    if (usage) currentAssistant.usage = usage;
    tailParser.resetTurnUsage();
    currentAssistant = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let step: AntigravityTranscriptStep;
    try {
      step = JSON.parse(trimmed) as AntigravityTranscriptStep;
    } catch {
      continue;
    }

    if (
      Array.isArray(step.truncated_fields) &&
      step.truncated_fields.length > 0 &&
      typeof step.step_index === "number" &&
      fullByStepIndex.has(step.step_index)
    ) {
      step = fullByStepIndex.get(step.step_index)!;
    }

    const timestamp = step.created_at || new Date().toISOString();
    const stepIdx = step.step_index ?? messages.length;

    // A message agentapi sent for the user is a SYSTEM_MESSAGE from `sender=system` at HIGH priority.
    // agy's own notices are LOW, such as the one it adds each time a chat is reopened in a new process.
    const isSystemPrompt =
      step.type === "SYSTEM_MESSAGE" &&
      typeof step.content === "string" &&
      /\bsender=system\b/.test(step.content) &&
      !/\bpriority=MESSAGE_PRIORITY_LOW\b/.test(step.content);

    if (step.type === "USER_INPUT" || isSystemPrompt) {
      const content = cleanAntigravityUserInput(step.content ?? "");
      if (!content) continue;
      finalizeCurrentAssistant();
      messages.push({
        id: `agy-user-${stepIdx}`,
        role: "user",
        content,
        timestamp,
      });
      continue;
    }

    if (step.type === "PLANNER_RESPONSE" || (step.type === "GENERIC" && (step.source === "MODEL" || step.source === "SYSTEM" || !step.source))) {
      if (!currentAssistant) {
        currentAssistant = {
          id: `agy-assistant-${stepIdx}`,
          role: "assistant",
          content: "",
          events: [],
          timestamp,
        };
        messages.push(currentAssistant);
      }
      const { events } = tailParser.feed(JSON.stringify(step));
      for (const { ev } of events) {
        currentAssistant.events!.push(ev);
        if (ev.type === "text") {
          currentAssistant.content = currentAssistant.content
            ? `${currentAssistant.content}\n\n${ev.content}`
            : ev.content;
        }
      }
    }
  }

  finalizeCurrentAssistant();
  return messages;
}
