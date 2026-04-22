/**
 * Parses a Claude Code JSONL transcript file into ChatMessage[].
 * Reusable across live SDK session history (claude-agent-sdk.ts) and
 * pre-compact transcript loading (chat route /pre-compact-messages).
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { ChatEvent, ChatMessage } from "../types/chat.ts";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const TEAMMATE_MSG_RE = /<teammate-message[^>]*>[\s\S]*?<\/teammate-message>/g;

/** Strip SDK teammate-message XML tags from assistant text */
export function stripTeammateXml(text: string): string {
  if (!text.includes("<teammate-message")) return text;
  return text.replace(TEAMMATE_MSG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Extract plain text from message payload */
export function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as Record<string, unknown>;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

/** Parse SDK SessionMessage into ChatMessage with events for tool_use blocks */
export function parseSessionMessage(
  msg: { uuid: string; type: string; message: unknown; parent_tool_use_id?: string | null },
): ChatMessage {
  const message = msg.message as Record<string, unknown> | undefined;
  const role = msg.type as "user" | "assistant";
  const parentId = (msg as any).parent_tool_use_id as string | undefined;

  // Filter synthetic SDK-generated error messages (auth failures, rate limits, etc.)
  const isSdkErrorMessage =
    (msg as any).isApiErrorMessage === true ||
    typeof (msg as any).error === "string" ||
    (message && (message as any).model === "<synthetic>" &&
      Array.isArray(message.content) &&
      (message.content as Array<Record<string, unknown>>).some(
        (b) => b.type === "text" && typeof b.text === "string" &&
          /Failed to authenticate|API Error: 40[13]|hit your limit|rate.?limit/i.test(b.text as string),
      ));
  if (isSdkErrorMessage) {
    return {
      id: msg.uuid,
      role,
      content: "",
      timestamp: new Date().toISOString(),
      sdkUuid: msg.uuid,
    };
  }

  const events: ChatEvent[] = [];
  let textContent = "";

  if (message && Array.isArray(message.content)) {
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        const cleaned = role === "assistant" ? stripTeammateXml(block.text) : block.text;
        textContent += cleaned;
        if (role === "assistant" && cleaned) {
          events.push({ type: "text", content: cleaned, ...(parentId && { parentToolUseId: parentId }) });
        }
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool_use",
          tool: (block.name as string) ?? "unknown",
          input: block.input ?? {},
          toolUseId: block.id as string | undefined,
          ...(parentId && { parentToolUseId: parentId }),
        });
      } else if (block.type === "tool_result") {
        const output = block.content ?? block.output ?? "";
        events.push({
          type: "tool_result",
          output: typeof output === "string" ? output : JSON.stringify(output),
          isError: !!(block as Record<string, unknown>).is_error,
          toolUseId: block.tool_use_id as string | undefined,
          ...(parentId && { parentToolUseId: parentId }),
        });
      }
    }
  } else {
    textContent = extractText(message);
  }

  // SDK-generated user messages carry system text (tool_result blocks, teammate XML) —
  // clear so they don't render as user bubbles.
  if (role === "user" && (events.some((e) => e.type === "tool_result") || textContent.includes("<teammate-message"))) {
    textContent = "";
  }

  return {
    id: msg.uuid,
    role,
    content: textContent,
    events: events.length > 0 ? events : undefined,
    timestamp: new Date().toISOString(),
    sdkUuid: msg.uuid,
  };
}

/**
 * Move events with parentToolUseId into their parent Agent/Task tool_use's children array.
 * Mutates the array in-place.
 */
export function nestChildEvents(events: ChatEvent[]): void {
  const parentMap = new Map<string, ChatEvent & { type: "tool_use" }>();
  for (const ev of events) {
    if (ev.type === "tool_use" && (ev.tool === "Agent" || ev.tool === "Task") && ev.toolUseId) {
      parentMap.set(ev.toolUseId, ev);
    }
  }
  if (parentMap.size === 0) return;

  const childIndices: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const pid = (ev as any).parentToolUseId as string | undefined;
    if (!pid) continue;
    const parent = parentMap.get(pid);
    if (parent) {
      if (!parent.children) parent.children = [];
      parent.children.push(ev);
      childIndices.push(i);
    }
  }
  for (let i = childIndices.length - 1; i >= 0; i--) {
    events.splice(childIndices[i]!, 1);
  }
}

/**
 * Validate JSONL path — must be under ~/.claude/ (prevents arbitrary file reads).
 * Throws Error with descriptive message. Returns resolved realpath on success.
 */
export function validateJsonlPath(inputPath: string): string {
  if (!inputPath) throw new Error("jsonlPath is required");
  // Reject obvious traversal attempts before resolution
  if (inputPath.includes("\0")) throw new Error("Invalid path: denied");
  if (!inputPath.endsWith(".jsonl")) throw new Error("Invalid path: must be a .jsonl file");

  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) throw new Error("File not found");

  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    throw new Error("File not found");
  }

  const claudeDir = resolve(homedir(), ".claude") + "/";
  if (!(real + "/").startsWith(claudeDir)) {
    throw new Error("Access denied: path traversal detected");
  }

  const stat = statSync(real);
  if (!stat.isFile()) throw new Error("Not a regular file");
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${Math.round(stat.size / 1024 / 1024)}MB exceeds 50MB limit`);
  }
  return real;
}

/**
 * Read a JSONL transcript file, parse entries, apply merge/nest pipeline, return ChatMessage[].
 * Applies the same logic as ClaudeAgentSdkProvider.getMessages() but reads from file directly.
 *
 * @param beforeUuid  If provided, stop parsing at the line with this uuid (exclusive).
 *                    Used for the expand-compact feature: Claude's compact summary references
 *                    the CURRENT session file (pre+summary+post), so we truncate at the
 *                    compact summary's uuid to return only pre-compact messages.
 */
export async function parseJsonlTranscript(
  filePath: string,
  beforeUuid?: string,
): Promise<ChatMessage[]> {
  const text = await Bun.file(filePath).text();
  const parsed: ChatMessage[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines defensively
    }
    if (beforeUuid && entry.uuid === beforeUuid) break; // stop at compact boundary (exclusive)
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.uuid || !entry.message) continue;
    parsed.push(parseSessionMessage(entry));
  }

  // Merge tool_result-only user messages into preceding assistant
  const merged: ChatMessage[] = [];
  for (const msg of parsed) {
    if (msg.events?.length && msg.events.every((e) => e.type === "tool_result")) {
      const lastAssistant = [...merged].reverse().find((m) => m.role === "assistant");
      if (lastAssistant?.events) {
        lastAssistant.events.push(...msg.events);
        continue;
      }
    }
    merged.push(msg);
  }

  for (const msg of merged) {
    if (msg.events) nestChildEvents(msg.events);
  }

  return merged.filter(
    (msg) => msg.content.trim().length > 0 || (msg.events && msg.events.length > 0),
  );
}
