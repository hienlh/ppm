/**
 * Agent → Anthropic Messages, for `POST /proxy/<provider>/v1/messages`.
 *
 * The mirror of `proxy-agent-bridge.ts`: same agent turn (`proxy-agent-turn.ts`),
 * same ephemeral-session and sandbox rules, rendered in Anthropic's dialect so a
 * client already pointed at `ANTHROPIC_BASE_URL` can reach any PPM provider by
 * setting that base to `…/proxy/<provider>`.
 */
import {
  startAgentTurn, usageOf, resolveProvider, proxyableProviderIds,
} from "./proxy-agent-turn.ts";
import {
  buildPromptFromAnthropicMessages, hasUnsupportedAnthropicBlocks, messageResponse, anthropicError,
  MessageStreamWriter, ANTHROPIC_SSE_HEADERS, type AnthropicMessagesBody,
} from "./proxy-anthropic-format.ts";

/** Open the turn described by an Anthropic-format body. */
function startTurn(providerId: string, body: AnthropicMessagesBody) {
  const { prompt, systemPrompt } = buildPromptFromAnthropicMessages(body);
  return startAgentTurn(providerId, { prompt, systemPrompt, model: body.model });
}

/** Non-streaming: drain the turn, return one `message`. */
async function runNonStreaming(providerId: string, body: AnthropicMessagesBody): Promise<Response> {
  const { events, cleanup } = await startTurn(providerId, body);
  try {
    let text = "";
    let usage: ReturnType<typeof usageOf>;
    for await (const ev of events) {
      if (ev.type === "text") text += ev.content;
      else if (ev.type === "error") throw new Error(ev.message);
      else if (ev.type === "done") usage = usageOf(ev);
    }
    return messageResponse(text, body.model || providerId, usage);
  } finally {
    await cleanup();
  }
}

/** Streaming: map assistant text onto the Anthropic SSE event sequence. */
async function runStreaming(providerId: string, body: AnthropicMessagesBody): Promise<Response> {
  // Started before the stream so a setup failure is still a JSON error the
  // client can read, rather than an SSE stream that opens and immediately dies.
  const { events, cleanup } = await startTurn(providerId, body);
  const model = body.model || providerId;

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stream = new MessageStreamWriter(controller, model);
      stream.open();
      let usage: ReturnType<typeof usageOf>;
      try {
        for await (const ev of events) {
          if (ev.type === "text") stream.text(ev.content);
          else if (ev.type === "error") throw new Error(ev.message);
          else if (ev.type === "done") usage = usageOf(ev);
        }
        stream.close(usage);
      } catch (e) {
        // The stream already carries a 200, so the error has to ride inside it.
        stream.text(`\n\nError: ${(e as Error).message}`);
        stream.close(usage);
      } finally {
        await cleanup();
      }
    },
    async cancel() {
      await cleanup();
    },
  });

  return new Response(readable, { headers: ANTHROPIC_SSE_HEADERS });
}

/**
 * Entry point for `POST /proxy/<provider>/v1/messages`.
 * Never throws: every failure becomes an Anthropic-shaped error response.
 */
export async function forwardAgentMessages(
  providerId: string,
  body: AnthropicMessagesBody,
): Promise<Response> {
  if (!resolveProvider(providerId)) {
    return anthropicError(404, `Unknown provider "${providerId}". Available: ${proxyableProviderIds().join(", ") || "none"}`);
  }
  // Silently dropping an image would answer the prompt as if the picture had
  // been seen — worse than refusing, because the caller cannot tell.
  if (hasUnsupportedAnthropicBlocks(body)) {
    return anthropicError(400, "This endpoint accepts text content blocks only; image blocks are not supported yet");
  }
  try {
    return body.stream
      ? await runStreaming(providerId, body)
      : await runNonStreaming(providerId, body);
  } catch (e) {
    return anthropicError(502, (e as Error).message);
  }
}
