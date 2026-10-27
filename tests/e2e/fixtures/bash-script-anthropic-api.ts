/**
 * A stand-in for api.anthropic.com that plays a script of Bash tool calls: every `RUN: <command>`
 * line of the latest user message holding any becomes one tool call, in order, one per request;
 * once all have a result the reply is plain text. Enough for the real Claude CLI to run whole
 * turns of commands, one script per turn, with no live credentials.
 */
export interface BashScriptApi {
  url: string;
  stop: () => void;
}

const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

type Block = { type: "text"; text: string } | { type: "tool_use"; command: string };

function reply(block: Block): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(sse("message_start", {
        type: "message_start",
        message: {
          id: `msg_fake_${crypto.randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: "claude-sonnet-4-5",
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
        },
      }));
      if (block.type === "text") {
        c.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        c.enqueue(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } }));
      } else {
        const id = `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
        c.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "Bash", input: {} } }));
        c.enqueue(sse("content_block_delta", {
          type: "content_block_delta", index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: block.command, description: "scripted" }) },
        }));
      }
      c.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      c.enqueue(sse("message_delta", {
        type: "message_delta", delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      }));
      c.enqueue(sse("message_stop", { type: "message_stop" }));
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => b?.text ?? "").join("\n") : "";

export function startBashScriptApi(): BashScriptApi {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
      if (path !== "/v1/messages" || req.method !== "POST") return Response.json({});
      const body: any = await req.json();
      const messages: any[] = body.messages ?? [];
      let scriptAt = -1;
      let commands: string[] = [];
      messages.forEach((m, i) => {
        const found = m.role === "user" ? [...textOf(m.content).matchAll(/^RUN: (.*)$/gm)].map((x) => x[1]!) : [];
        if (found.length) [scriptAt, commands] = [i, found];
      });
      // Side requests (a title, a summary) carry no script: answer them with text.
      if (!commands.length) return reply({ type: "text", text: "Scripted session" });
      const done = messages.slice(scriptAt + 1)
        .flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : [])).length;
      return reply(done < commands.length ? { type: "tool_use", command: commands[done]! } : { type: "text", text: "DONE" });
    },
  });
  return { url: server.url.href.replace(/\/$/, ""), stop: () => server.stop(true) };
}
