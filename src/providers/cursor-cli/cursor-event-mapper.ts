import type { ChatEvent } from "../provider.interface.ts";

interface CursorRawEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      toolName?: string;
      name?: string;
      args?: unknown;
      input?: unknown;
      toolCallId?: string;
      id?: string;
    }>;
  };
  result?: string;
}

/**
 * Map a single Cursor NDJSON line → ChatEvent[].
 * Returns empty array for events we don't care about.
 */
export function mapCursorEvent(raw: unknown, sessionId: string): ChatEvent[] {
  const event = raw as CursorRawEvent;
  if (!event?.type) return [];

  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        return [{ type: "system", subtype: "init" }];
      }
      return [];

    case "user":
      return [];

    case "assistant": {
      const events: ChatEvent[] = [];
      const content = event.message?.content;
      if (!Array.isArray(content)) return [];

      for (const part of content) {
        if (!part) continue;

        if (part.type === "text" && part.text) {
          events.push({ type: "text", content: part.text });
        }

        if (part.type === "reasoning" && part.text) {
          events.push({ type: "thinking", content: part.text });
        }

        if (part.type === "tool-call" || part.type === "tool_use") {
          const toolName = normalizeToolName(part.toolName || part.name || "Unknown");
          const toolId = part.toolCallId || part.id || crypto.randomUUID();
          events.push({
            type: "tool_use",
            tool: toolName,
            input: part.args || part.input || {},
            toolUseId: toolId,
          });
        }
      }
      return events;
    }

    case "result":
      return [];

    default:
      return [];
  }
}

/** Normalize Cursor tool names to PPM standard */
function normalizeToolName(name: string): string {
  switch (name) {
    case "ApplyPatch": return "Edit";
    default: return name;
  }
}
