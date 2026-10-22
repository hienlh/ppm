/**
 * A stand-in for api.anthropic.com that is just faithful enough for the Claude CLI to run a
 * turn, and that renews OAuth tokens the way the real one does: a refresh grant issues a new
 * access token and revokes every earlier one, so a subprocess still holding the old token
 * gets the same 401 ("OAuth access token has been revoked") a live install sees.
 *
 * Replies stream slowly when the prompt asks for it (`slow`), so a test can renew a token
 * while a turn is provably in flight.
 */
export interface FakeAnthropicApi {
  url: string;
  /** Requests seen, newest last: path, which token they carried, and the status answered. */
  requests: Array<{ at: number; path: string; token: string; status: number }>;
  /** Access tokens issued so far, oldest first; only the last one is accepted. */
  issued: string[];
  stop: () => void;
}

const enc = new TextEncoder();

function sse(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function lastUserText(body: any): string {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    // The CLI puts system reminders in their own blocks before what the user typed.
    const texts = (m.content ?? []).filter((b: any) => b?.type === "text" && !String(b.text).startsWith("<system-reminder>"));
    if (texts.length) return String(texts[texts.length - 1].text);
  }
  return "";
}

function streamReply(text: string, model: string, chunkDelayMs: number): ReadableStream<Uint8Array> {
  const words = text.split(" ");
  return new ReadableStream({
    async start(controller) {
      const id = `msg_fake_${crypto.randomUUID().slice(0, 8)}`;
      const usage = { input_tokens: 12, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
      }));
      controller.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      for (const [i, word] of words.entries()) {
        controller.enqueue(sse("content_block_delta", {
          type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (i ? " " : "") + word },
        }));
        if (chunkDelayMs) await Bun.sleep(chunkDelayMs);
      }
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      controller.enqueue(sse("message_delta", {
        type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: words.length },
      }));
      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });
}

export function startFakeAnthropicApi(opts: { firstToken: string; slowChunkDelayMs?: number }): FakeAnthropicApi {
  const issued = [opts.firstToken];
  const requests: FakeAnthropicApi["requests"] = [];
  const slowDelay = opts.slowChunkDelayMs ?? 1500;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || req.headers.get("x-api-key") || "";
      const note = (status: number) => { requests.push({ at: Date.now(), path: url.pathname, token, status }); };

      if (url.pathname === "/v1/oauth/token" && req.method === "POST") {
        const next = `sk-ant-oat01-fake-${issued.length}`;
        issued.push(next);
        note(200);
        return Response.json({ access_token: next, refresh_token: `refresh-${issued.length}`, expires_in: 28800, token_type: "Bearer" });
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        if (token !== issued[issued.length - 1]) {
          note(401);
          return Response.json(
            { type: "error", error: { type: "authentication_error", message: "OAuth access token has been revoked." } },
            { status: 401 },
          );
        }
        const body = await req.json().catch(() => ({}));
        const prompt = lastUserText(body);
        note(200);
        const slow = /\bslow\b/i.test(prompt);
        const reply = slow
          ? "Working through it slowly, step one, step two, step three, step four, step five, step six, step seven, step eight, done."
          : `Reply to: ${prompt.slice(0, 60)}`;
        if (body?.stream === false || !body?.stream) {
          return Response.json({
            id: "msg_fake", type: "message", role: "assistant", model: body?.model ?? "claude-fake",
            content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 8 },
          });
        }
        return new Response(streamReply(reply, body?.model ?? "claude-fake", slow ? slowDelay : 0), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }

      if (url.pathname === "/v1/messages/count_tokens") {
        note(200);
        return Response.json({ input_tokens: 12 });
      }

      note(404);
      return Response.json({ type: "error", error: { type: "not_found_error", message: "not in the fake" } }, { status: 404 });
    },
  });

  return { url: `http://127.0.0.1:${server.port}`, requests, issued, stop: () => server.stop(true) };
}
