/**
 * OpenAI-compatible proxy bridge — converts OpenAI Chat Completions
 * requests into SDK query() calls and returns OpenAI-format responses.
 *
 * Endpoint: POST /proxy/v1/chat/completions
 * Reference: https://github.com/fuergaosi233/claude-code-proxy
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { accountSelector } from "./account-selector.service.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function mapModelToSdkModel(model: string): "sonnet" | "opus" | "haiku" {
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}

function buildSdkEnv(accessToken: string): Record<string, string | undefined> {
  const isOAuth = accessToken.startsWith("sk-ant-oat");
  return {
    ...process.env,
    ANTHROPIC_API_KEY: isOAuth ? "" : accessToken,
    CLAUDE_CODE_OAUTH_TOKEN: isOAuth ? accessToken : "",
    ANTHROPIC_BASE_URL: "",
  };
}

/** Extract system prompt and build text prompt from OpenAI messages format */
function buildPromptFromOpenAiMessages(body: any): { prompt: string; systemPrompt?: string } {
  const messages: any[] = body.messages ?? [];
  let systemPrompt: string | undefined;
  const conversationParts: string[] = [];

  for (const m of messages) {
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
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

function openAiError(status: number, message: string): Response {
  return new Response(JSON.stringify({
    error: { message, type: "server_error", code: String(status) },
  }), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

// ── Public API ───────────────────────────────────────────────────────

interface SdkAccount {
  id: string;
  email?: string | null;
  accessToken: string;
}

/** Forward an OpenAI-format chat completions request via SDK query() */
export async function forwardOpenAiViaSdk(body: any, account: SdkAccount): Promise<Response> {
  const model = mapModelToSdkModel(body.model || "sonnet");
  const stream = body.stream ?? false;
  const { prompt, systemPrompt } = buildPromptFromOpenAiMessages(body);
  const env = buildSdkEnv(account.accessToken);

  console.log(`[proxy-openai] ${stream ? "stream" : "non-stream"} → ${model} via ${account.email ?? account.id}`);

  if (!stream) return handleNonStreaming(prompt, systemPrompt, model, env, body, account);
  return handleStreaming(prompt, systemPrompt, model, env, body, account);
}

// ── Non-streaming ────────────────────────────────────────────────────

async function handleNonStreaming(
  prompt: string, systemPrompt: string | undefined,
  model: "sonnet" | "opus" | "haiku",
  env: Record<string, string | undefined>,
  body: any, account: SdkAccount,
): Promise<Response> {
  try {
    let fullContent = "";
    const response = query({
      prompt,
      options: { maxTurns: 1, model, env, ...(systemPrompt && { systemPrompt }) },
    });

    for await (const message of response) {
      if (message.type === "assistant") {
        for (const block of (message as any).message?.content ?? []) {
          if (block.type === "text") fullContent += block.text;
        }
      }
    }

    accountSelector.onSuccess(account.id);

    return new Response(JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model || "claude-sonnet-4-6",
      choices: [{
        index: 0,
        message: { role: "assistant", content: fullContent },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.error(`[proxy-openai] Non-stream error:`, (error as Error).message);
    accountSelector.onRateLimit(account.id);
    return openAiError(502, (error as Error).message);
  }
}

// ── Streaming ────────────────────────────────────────────────────────

async function handleStreaming(
  prompt: string, systemPrompt: string | undefined,
  model: "sonnet" | "opus" | "haiku",
  env: Record<string, string | undefined>,
  body: any, account: SdkAccount,
): Promise<Response> {
  const encoder = new TextEncoder();
  const chatId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelName = body.model || "claude-sonnet-4-6";

  const chunk = (delta: any, finishReason: string | null) => ({
    id: chatId, object: "chat.completion.chunk", created, model: modelName,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  const readable = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const response = query({
          prompt,
          options: {
            maxTurns: 1, model, env,
            ...(systemPrompt && { systemPrompt }),
            includePartialMessages: true,
          },
        });

        // Initial chunk with role
        send(chunk({ role: "assistant", content: "" }, null));

        const skipBlockIndices = new Set<number>();
        let streamed = false;
        let lastContentLen = 0;

        for await (const message of response) {
          const msgType = (message as any).type;

          // ── stream_event: raw Anthropic SSE events (best quality) ──
          if (msgType === "stream_event") {
            const event = (message as any).event;
            const eventType = event.type as string;
            const eventIndex = event.index as number | undefined;

            if (eventType === "content_block_start" && event.content_block?.type === "tool_use") {
              if (eventIndex !== undefined) skipBlockIndices.add(eventIndex);
              continue;
            }
            if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) continue;

            if (eventType === "content_block_delta" && event.delta?.type === "text_delta") {
              const text = event.delta.text ?? "";
              if (text) send(chunk({ content: text }, null));
            }
            if (eventType === "message_stop") send(chunk({}, "stop"));
            streamed = true;
            continue;
          }

          // ── partial: incremental content (fallback if no stream_event) ──
          if (msgType === "partial" && !streamed) {
            const content = (message as any).message?.content ?? [];
            let fullText = "";
            for (const block of content) {
              if (block.type === "text") fullText += block.text ?? "";
            }
            const delta = fullText.slice(lastContentLen);
            if (delta) {
              send(chunk({ content: delta }, null));
              lastContentLen = fullText.length;
            }
            continue;
          }

          // ── assistant: final message (fallback if nothing streamed) ──
          if (msgType === "assistant" && !streamed && lastContentLen === 0) {
            const content = (message as any).message?.content ?? [];
            let fullText = "";
            for (const block of content) {
              if (block.type === "text") fullText += block.text ?? "";
            }
            if (fullText) send(chunk({ content: fullText }, null));
          }
        }

        // Always send finish + DONE
        if (!streamed) send(chunk({}, "stop"));
        accountSelector.onSuccess(account.id);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        console.error(`[proxy-openai] Stream error:`, (error as Error).message);
        accountSelector.onRateLimit(account.id);
        send(chunk({ content: `\n\nError: ${(error as Error).message}` }, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
