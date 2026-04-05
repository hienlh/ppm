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

        try {
          for await (const message of response) {
            if (message.type !== "stream_event") continue;

            const event = (message as any).event;
            const eventType = event.type as string;
            const eventIndex = event.index as number | undefined;

            // Filter tool_use content blocks — external tools expect text only
            if (eventType === "content_block_start") {
              const block = event.content_block;
              if (block?.type === "tool_use") {
                if (eventIndex !== undefined) skipBlockIndices.add(eventIndex);
                continue;
              }
            }

            // Skip deltas and stops for tool_use blocks
            if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) continue;

            // Override message_delta to always show end_turn
            if (eventType === "message_delta") {
              const patched = {
                ...event,
                delta: { ...(event.delta || {}), stop_reason: "end_turn" },
                usage: event.usage || { output_tokens: 0 },
              };
              controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(patched)}\n\n`));
              continue;
            }

            // Forward all other events (message_start, text deltas, content_block_start/stop, message_stop)
            controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`));
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
