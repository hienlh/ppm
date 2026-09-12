/**
 * OpenAI Chat Completions wire format — the shared translation layer between
 * PPM's proxy bridges and the shape an OpenAI client expects.
 *
 * Both proxy bridges speak this: the Claude SDK bridge (`proxy-openai-bridge.ts`)
 * and the provider-agnostic agent bridge (`proxy-agent-bridge.ts`). Keeping the
 * wire format in one place is what stops the two from drifting into subtly
 * different `chat.completion` payloads.
 */

/** One entry of the OpenAI `messages` array (content is string or block array). */
export interface OpenAiMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }> | null;
}

export interface OpenAiChatBody {
  model?: string;
  messages?: OpenAiMessage[];
  stream?: boolean;
}

/**
 * Flatten OpenAI `messages` into a single prompt plus a system prompt.
 *
 * Non-text blocks (notably `image_url`) are dropped: neither bridge can carry
 * an inline image today. Callers that must not silently lose an attachment
 * should check `hasUnsupportedBlocks` first.
 */
export function buildPromptFromOpenAiMessages(
  body: OpenAiChatBody,
): { prompt: string; systemPrompt?: string } {
  const messages = body.messages ?? [];
  let systemPrompt: string | undefined;
  const conversationParts: string[] = [];

  for (const m of messages) {
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
        : String(m.content ?? "");

    if (m.role === "system") {
      systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
    } else {
      const role = m.role === "assistant" ? "Assistant" : "Human";
      conversationParts.push(`${role}: ${text}`);
    }
  }

  return { prompt: conversationParts.join("\n\n"), systemPrompt };
}

/** True when any message carries a content block this format cannot forward. */
export function hasUnsupportedBlocks(body: OpenAiChatBody): boolean {
  return (body.messages ?? []).some((m) =>
    Array.isArray(m.content) && m.content.some((b) => b.type && b.type !== "text"),
  );
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
} as const;

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*",
} as const;

export function openAiError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "server_error", code: String(status) } }),
    { status, headers: JSON_HEADERS },
  );
}

/** Token counts for the `usage` object; omitted fields report as 0. */
export interface OpenAiUsage {
  promptTokens?: number;
  completionTokens?: number;
}

/** Build a non-streaming `chat.completion` response. */
export function completionResponse(
  content: string,
  model: string,
  usage?: OpenAiUsage,
): Response {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  return new Response(JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }), { status: 200, headers: JSON_HEADERS });
}

/** Emits `chat.completion.chunk` frames for one streamed response. */
export class ChunkWriter {
  private readonly encoder = new TextEncoder();
  private readonly id = `chatcmpl-${Date.now()}`;
  private readonly created = Math.floor(Date.now() / 1000);

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly model: string,
  ) {}

  /** One SSE frame carrying a delta (and optionally the finish reason). */
  send(delta: Record<string, unknown>, finishReason: string | null = null): void {
    const payload = {
      id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    this.controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  }

  /** OpenAI clients treat the role-only first chunk as the start of the message. */
  open(): void {
    this.send({ role: "assistant", content: "" });
  }

  text(content: string): void {
    if (content) this.send({ content });
  }

  /** Terminal frame plus the `[DONE]` sentinel every OpenAI client waits for. */
  close(finishReason = "stop"): void {
    this.send({}, finishReason);
    this.controller.enqueue(this.encoder.encode("data: [DONE]\n\n"));
    this.controller.close();
  }
}
