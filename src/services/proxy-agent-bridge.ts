/**
 * Agent → OpenAI Chat Completions, for `POST /proxy/<provider>/v1/chat/completions`.
 *
 * An OpenAI client points its `baseURL` at `…/proxy/codex/v1`; the provider comes
 * from the URL and the model from the request body. Session lifetime, sandboxing
 * and timeouts live in `proxy-agent-turn.ts`, shared with the Anthropic-format
 * endpoint so the two cannot drift apart.
 *
 * Unlike the Claude-only bridge (`proxy-openai-bridge.ts`, a single SDK query),
 * this drives a real agent session: a turn may run the provider's own tools
 * before answering. Tool traffic has no place in the OpenAI wire format, so only
 * assistant text reaches the caller.
 */
import {
  startAgentTurn, usageOf, resolveProvider, proxyableProviderIds,
} from "./proxy-agent-turn.ts";
import {
  buildPromptFromOpenAiMessages, hasUnsupportedBlocks, completionResponse, openAiError,
  ChunkWriter, SSE_HEADERS, type OpenAiChatBody,
} from "./proxy-openai-format.ts";

/** Open the turn described by an OpenAI-format body. */
function startTurn(providerId: string, body: OpenAiChatBody) {
  const { prompt, systemPrompt } = buildPromptFromOpenAiMessages(body);
  return startAgentTurn(providerId, { prompt, systemPrompt, model: body.model });
}

/** Non-streaming: drain the turn, return one `chat.completion`. */
async function runNonStreaming(providerId: string, body: OpenAiChatBody): Promise<Response> {
  const { events, cleanup } = await startTurn(providerId, body);
  try {
    let content = "";
    let usage: ReturnType<typeof usageOf>;
    for await (const ev of events) {
      if (ev.type === "text") content += ev.content;
      else if (ev.type === "error") throw new Error(ev.message);
      else if (ev.type === "done") usage = usageOf(ev);
    }
    return completionResponse(content, body.model || providerId, usage && {
      promptTokens: usage.inputTokens, completionTokens: usage.outputTokens,
    });
  } finally {
    await cleanup();
  }
}

/** Streaming: map assistant text onto `chat.completion.chunk` frames. */
async function runStreaming(providerId: string, body: OpenAiChatBody): Promise<Response> {
  // Started before the stream so a setup failure is still a JSON error the
  // client can read, rather than an SSE stream that opens and immediately dies.
  const { events, cleanup } = await startTurn(providerId, body);
  const model = body.model || providerId;

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunks = new ChunkWriter(controller, model);
      chunks.open();
      try {
        for await (const ev of events) {
          if (ev.type === "text") chunks.text(ev.content);
          else if (ev.type === "error") throw new Error(ev.message);
        }
        chunks.close();
      } catch (e) {
        // The stream already carries a 200, so the error has to ride inside it.
        chunks.text(`\n\nError: ${(e as Error).message}`);
        chunks.close();
      } finally {
        await cleanup();
      }
    },
    async cancel() {
      await cleanup();
    },
  });

  return new Response(readable, { headers: SSE_HEADERS });
}

/**
 * Entry point for `POST /proxy/<provider>/v1/chat/completions`.
 * Never throws: every failure becomes an OpenAI-shaped error response.
 */
export async function forwardAgentChatCompletions(
  providerId: string,
  body: OpenAiChatBody,
): Promise<Response> {
  if (!resolveProvider(providerId)) {
    return openAiError(404, `Unknown provider "${providerId}". Available: ${proxyableProviderIds().join(", ") || "none"}`);
  }
  // Silently dropping an image would answer the prompt as if the picture had
  // been seen — worse than refusing, because the caller cannot tell.
  if (hasUnsupportedBlocks(body)) {
    return openAiError(400, "This endpoint accepts text content blocks only; image_url is not supported yet");
  }
  try {
    return body.stream
      ? await runStreaming(providerId, body)
      : await runNonStreaming(providerId, body);
  } catch (e) {
    return openAiError(502, (e as Error).message);
  }
}

export { listProviderModels } from "./proxy-agent-turn.ts";
