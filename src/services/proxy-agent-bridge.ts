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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startAgentTurn, usageOf, resolveProvider, proxyableProviderIds,
} from "./proxy-agent-turn.ts";
import { decodeImagePayload } from "./proxy-image-bridge.ts";
import {
  buildPromptFromOpenAiMessages, hasUnsupportedBlocks, extractImagePayloads,
  completionResponse, openAiError,
  ChunkWriter, SSE_HEADERS, type OpenAiChatBody,
} from "./proxy-openai-format.ts";

/**
 * Inline images written to a scratch directory, since a provider may take an
 * image only as a path. Returns the paths plus the cleanup that removes them.
 */
function stageImages(body: OpenAiChatBody): { paths: string[]; discard: () => void } {
  const { dataUrls } = extractImagePayloads(body);
  if (dataUrls.length === 0) return { paths: [], discard: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "ppm-chat-img-"));
  const paths = dataUrls.map((url, i) => {
    const { bytes, ext } = decodeImagePayload(url);
    const path = join(dir, `image-${i}${ext}`);
    writeFileSync(path, bytes);
    return path;
  });
  return { paths, discard: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

/** Open the turn described by an OpenAI-format body. */
async function startTurn(providerId: string, body: OpenAiChatBody) {
  const { prompt, systemPrompt } = buildPromptFromOpenAiMessages(body);
  const staged = stageImages(body);
  try {
    const run = await startAgentTurn(providerId, {
      prompt, systemPrompt, model: body.model, imagePaths: staged.paths,
    });
    // The agent reads the files during the turn, so they outlive startTurn and
    // are dropped alongside the session.
    return { ...run, cleanup: async () => { await run.cleanup(); staged.discard(); } };
  } catch (e) {
    staged.discard();
    throw e;
  }
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
      // `done` ends the turn, but a provider's event stream stays open for the
      // session's next turn and never returns. Without this break the request
      // hangs on a completed answer until the idle timeout fires.
      else if (ev.type === "done") { usage = usageOf(ev); break; }
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
          // See runNonStreaming: the stream outlives the turn, so `done` is the
          // only signal that the answer is complete.
          else if (ev.type === "done") break;
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
  // Silently dropping a block would answer the prompt as if it had been seen —
  // worse than refusing, because the caller cannot tell.
  if (hasUnsupportedBlocks(body)) {
    return openAiError(400, "Only text and image_url content blocks are supported");
  }
  if (extractImagePayloads(body).remoteUrls > 0) {
    return openAiError(400, "image_url must be a data: URL; remote URLs are not fetched");
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
