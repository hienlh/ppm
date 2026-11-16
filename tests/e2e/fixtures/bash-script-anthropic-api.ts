/**
 * A stand-in for api.anthropic.com that plays a script of tool calls: every `RUN: <command>` line
 * of the latest user message holding any becomes one Bash tool call, in order, one per request;
 * once all have a result the reply is plain text. Enough for the real Claude CLI to run whole
 * turns of commands, one script per turn, with no live credentials.
 *
 * Two more line kinds, for the PPM Assistant's permission e2e:
 *  - `PS: <script>` is one call to the CLI's `PowerShell` tool (Windows);
 *  - `EDIT: <path> | <old> | <new>` is a `Read` of the file followed by an `Edit` replacing `old`
 *    with `new` (the CLI refuses an edit to a file it has not read).
 * Lines of every kind run in the order written. Every request is recorded (`requests`): the tools
 * the CLI offered and the tool results it sent back, so a test can tell "not offered" from
 * "refused" and see exactly when a call's result arrived.
 */
export interface ScriptedToolResult {
  toolUseId: string;
  isError: boolean;
  text: string;
}
export interface ScriptedRequest {
  at: number;
  /** Names of the tools the CLI offered in this request. */
  tools: string[];
  /** Every tool result the request carries, in message order. */
  results: ScriptedToolResult[];
  /** The call this request was answered with, if any. */
  answeredWith?: { name: string; input: Record<string, unknown> };
}
export interface BashScriptApi {
  url: string;
  stop: () => void;
  requests: ScriptedRequest[];
}

const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

interface ToolCall { name: string; input: Record<string, unknown> }
type Block = { type: "text"; text: string } | { type: "tool_use"; call: ToolCall };

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
        c.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: block.call.name, input: {} } }));
        c.enqueue(sse("content_block_delta", {
          type: "content_block_delta", index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.call.input) },
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

/** The tool calls one scripted line stands for; RUN lines are exactly what they always were. */
function callsOf(kind: string, rest: string): ToolCall[] {
  if (kind === "RUN") return [{ name: "Bash", input: { command: rest, description: "scripted" } }];
  if (kind === "PS") return [{ name: "PowerShell", input: { command: rest, description: "scripted" } }];
  const [path, oldText, newText] = rest.split(" | ");
  if (!path || oldText === undefined || newText === undefined) throw new Error(`EDIT needs "<path> | <old> | <new>": ${rest}`);
  return [
    { name: "Read", input: { file_path: path } },
    { name: "Edit", input: { file_path: path, old_string: oldText, new_string: newText } },
  ];
}

const resultText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? "").join("") : "";

export function startBashScriptApi(): BashScriptApi {
  const requests: ScriptedRequest[] = [];
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
      const record: ScriptedRequest = {
        at: Date.now(),
        tools: Array.isArray(body.tools) ? body.tools.map((t: any) => String(t?.name ?? "")) : [],
        results: messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .filter((b: any) => b?.type === "tool_result")
          .map((b: any) => ({ toolUseId: String(b.tool_use_id ?? ""), isError: b.is_error === true, text: resultText(b.content) })),
      };
      requests.push(record);
      let scriptAt = -1;
      let calls: ToolCall[] = [];
      messages.forEach((m, i) => {
        const found = m.role === "user"
          ? [...textOf(m.content).matchAll(/^(RUN|PS|EDIT): (.*)$/gm)].flatMap((x) => callsOf(x[1]!, x[2]!))
          : [];
        if (found.length) [scriptAt, calls] = [i, found];
      });
      // Side requests (a title, a summary) carry no script: answer them with text.
      if (!calls.length) return reply({ type: "text", text: "Scripted session" });
      const done = messages.slice(scriptAt + 1)
        .flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : [])).length;
      if (done < calls.length) {
        record.answeredWith = calls[done]!;
        return reply({ type: "tool_use", call: calls[done]! });
      }
      return reply({ type: "text", text: "DONE" });
    },
  });
  return { url: server.url.href.replace(/\/$/, ""), stop: () => server.stop(true), requests };
}
