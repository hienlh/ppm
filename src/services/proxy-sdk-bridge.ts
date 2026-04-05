/**
 * SDK-based proxy bridge — translates Anthropic Messages API requests
 * into Agent SDK query() calls for OAuth (Claude Max/Pro) accounts.
 *
 * Direct API forwarding doesn't work for OAuth tokens because they're
 * meant for the Claude Code infrastructure, not raw api.anthropic.com.
 * This bridge uses the same SDK approach as opencode-claude-max-proxy.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { accountSelector } from "./account-selector.service.ts";

/** Map Anthropic model IDs to SDK model names */
function mapModelToSdkModel(model: string): "sonnet" | "opus" | "haiku" {
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}

/** Extract text prompt from Messages API body (system + messages) */
function buildPromptFromBody(body: any): { prompt: string; systemPrompt?: string } {
  // Extract system prompt
  let systemPrompt: string | undefined;
  if (body.system) {
    if (typeof body.system === "string") {
      systemPrompt = body.system;
    } else if (Array.isArray(body.system)) {
      systemPrompt = body.system
        .filter((b: any) => b.type === "text" && b.text)
        .map((b: any) => b.text)
        .join("\n");
    }
  }

  // Convert messages to text, preserving role context
  const parts = body.messages
    ?.map((m: { role: string; content: string | Array<{ type: string; text?: string }> }) => {
      const role = m.role === "assistant" ? "Assistant" : "Human";
      let content: string;
      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        content = m.content
          .filter((block: any) => block.type === "text" && block.text)
          .map((block: any) => block.text)
          .join("");
      } else {
        content = String(m.content);
      }
      return `${role}: ${content}`;
    })
    .join("\n\n") || "";

  return { prompt: parts, systemPrompt };
}

/** Build env for SDK subprocess — sets OAuth token, blocks stale env vars */
function buildSdkEnv(accessToken: string): Record<string, string | undefined> {
  return {
    ...process.env,
    // OAuth token → CLAUDE_CODE_OAUTH_TOKEN; clear API key to prevent conflicts
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: accessToken,
    // Clear base URL to ensure SDK hits Anthropic directly
    ANTHROPIC_BASE_URL: "",
  };
}

interface SdkAccount {
  id: string;
  email?: string | null;
  accessToken: string;
}

/**
 * Forward a Messages API request via SDK query() for OAuth accounts.
 * Returns a Response in Anthropic Messages API format (JSON or SSE).
 */
export async function forwardViaSdk(
  body: any,
  account: SdkAccount,
): Promise<Response> {
  const model = mapModelToSdkModel(body.model || "sonnet");
  const stream = body.stream ?? true;
  const { prompt, systemPrompt } = buildPromptFromBody(body);
  const env = buildSdkEnv(account.accessToken);

  console.log(`[proxy-sdk] ${stream ? "stream" : "non-stream"} → ${model} via account ${account.email ?? account.id}`);

  if (!stream) {
    return handleNonStreaming(prompt, systemPrompt, model, env, body, account);
  }
  return handleStreaming(prompt, systemPrompt, model, env, body, account);
}

/** Non-streaming: collect full response and return as JSON */
async function handleNonStreaming(
  prompt: string,
  systemPrompt: string | undefined,
  model: "sonnet" | "opus" | "haiku",
  env: Record<string, string | undefined>,
  body: any,
  account: SdkAccount,
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

    if (!fullContent) fullContent = "";
    accountSelector.onSuccess(account.id);

    return new Response(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: fullContent }],
      model: body.model,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.error(`[proxy-sdk] Non-stream error:`, (error as Error).message);
    accountSelector.onRateLimit(account.id);
    return new Response(JSON.stringify({
      type: "error",
      error: { type: "api_error", message: (error as Error).message },
    }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}

/** Streaming: convert SDK events to Anthropic SSE format */
async function handleStreaming(
  prompt: string,
  systemPrompt: string | undefined,
  model: "sonnet" | "opus" | "haiku",
  env: Record<string, string | undefined>,
  body: any,
  account: SdkAccount,
): Promise<Response> {
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const response = query({
          prompt,
          options: {
            maxTurns: 1,
            model,
            env,
            ...(systemPrompt && { systemPrompt }),
            includePartialMessages: true,
          },
        });

        const heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(`: ping\n\n`)); } catch { clearInterval(heartbeat); }
        }, 15_000);

        // Track tool_use block indices to filter them out
        const skipBlockIndices = new Set<number>();
        let streamed = false; // track if we sent any SSE events
        let lastContentLen = 0; // for partial message diff

        try {
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

              if (eventType === "message_delta") {
                const patched = {
                  ...event,
                  delta: { ...(event.delta || {}), stop_reason: "end_turn" },
                  usage: event.usage || { output_tokens: 0 },
                };
                controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(patched)}\n\n`));
              } else {
                controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`));
              }
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
                // Emit Anthropic SSE envelope on first partial
                if (lastContentLen === 0) {
                  const msgStart = { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } };
                  controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`));
                  controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`));
                }
                controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } })}\n\n`));
                lastContentLen = fullText.length;
              }
              continue;
            }

            // ── assistant: final complete message (fallback if nothing streamed) ──
            if (msgType === "assistant" && !streamed && lastContentLen === 0) {
              const content = (message as any).message?.content ?? [];
              let fullText = "";
              for (const block of content) {
                if (block.type === "text") fullText += block.text ?? "";
              }
              if (fullText) {
                const msgStart = { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } };
                controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`));
                controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`));
                controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: fullText } })}\n\n`));
                lastContentLen = fullText.length;
              }
            }
          }

          // Close SSE envelope if we used partial/assistant fallback
          if (!streamed && lastContentLen > 0) {
            controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`));
            controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } })}\n\n`));
            controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`));
          }

          accountSelector.onSuccess(account.id);
        } finally {
          clearInterval(heartbeat);
        }

        controller.close();
      } catch (error) {
        console.error(`[proxy-sdk] Stream error:`, (error as Error).message);
        accountSelector.onRateLimit(account.id);
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { type: "api_error", message: (error as Error).message },
        })}\n\n`));
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
