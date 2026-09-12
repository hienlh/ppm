/**
 * Anthropic Messages API wire format for the provider-scoped proxy.
 *
 * The mirror of `proxy-openai-format.ts`: same job, the other dialect, so
 * `/proxy/<provider>/v1/messages` and `/proxy/<provider>/v1/chat/completions`
 * expose the same agent through whichever SDK the caller already uses.
 */

/** One entry of the Anthropic `messages` array. */
export interface AnthropicMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }> | null;
}

export interface AnthropicMessagesBody {
  model?: string;
  messages?: AnthropicMessage[];
  /** Anthropic carries instructions top-level, not as a message role. */
  system?: string | Array<{ type?: string; text?: string }>;
  stream?: boolean;
}

/** Concatenate the text blocks of a content field, ignoring everything else. */
function textOf(content: AnthropicMessage["content"] | AnthropicMessagesBody["system"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  }
  return "";
}

/**
 * Flatten an Anthropic request into a single prompt plus its system text.
 *
 * Non-text blocks (notably `image`) are dropped: the agent turn has no way to
 * carry an inline image today.
 */
export function buildPromptFromAnthropicMessages(
  body: AnthropicMessagesBody,
): { prompt: string; systemPrompt?: string } {
  const parts = (body.messages ?? []).map((m) => {
    const role = m.role === "assistant" ? "Assistant" : "Human";
    return `${role}: ${textOf(m.content)}`;
  });
  const systemPrompt = textOf(body.system) || undefined;
  return { prompt: parts.join("\n\n"), systemPrompt };
}

/** True when any message carries a content block this format cannot forward. */
export function hasUnsupportedAnthropicBlocks(body: AnthropicMessagesBody): boolean {
  return (body.messages ?? []).some((m) =>
    Array.isArray(m.content) && m.content.some((b) => b.type && b.type !== "text"),
  );
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
} as const;

export const ANTHROPIC_SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*",
} as const;

/** Anthropic errors are `{type:"error", error:{type, message}}`, not OpenAI's shape. */
export function anthropicError(status: number, message: string): Response {
  const type = status === 404 ? "not_found_error" : status === 400 ? "invalid_request_error" : "api_error";
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: JSON_HEADERS },
  );
}

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
}

function messageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a non-streaming Messages response. */
export function messageResponse(text: string, model: string, usage?: AnthropicUsage): Response {
  return new Response(JSON.stringify({
    id: messageId(),
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
    },
  }), { status: 200, headers: JSON_HEADERS });
}

/**
 * Emits the Anthropic streaming event sequence for one response.
 *
 * Anthropic SSE is named-event based (`event:` line plus `data:`), and clients
 * reject a stream that skips the message_start / content_block_* / message_stop
 * envelope — so the envelope is written even when no text arrives.
 */
export class MessageStreamWriter {
  private readonly encoder = new TextEncoder();
  private readonly id = messageId();
  private outputTokens = 0;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly model: string,
  ) {}

  private emit(event: string, data: Record<string, unknown>): void {
    this.controller.enqueue(this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  /** message_start + the single text block every response here uses. */
  open(inputTokens = 0): void {
    this.emit("message_start", {
      type: "message_start",
      message: {
        id: this.id, type: "message", role: "assistant", model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
    this.emit("content_block_start", {
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
    });
  }

  text(content: string): void {
    if (!content) return;
    this.emit("content_block_delta", {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content },
    });
  }

  /** Close the block and the message. `usage` reports what the turn actually cost. */
  close(usage?: AnthropicUsage, stopReason = "end_turn"): void {
    this.emit("content_block_stop", { type: "content_block_stop", index: 0 });
    this.emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage?.outputTokens ?? this.outputTokens },
    });
    this.emit("message_stop", { type: "message_stop" });
    this.controller.close();
  }
}
