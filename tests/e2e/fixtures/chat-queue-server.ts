/** Served-production fixture for the chat message queue (Claude Code's queue).
 *
 * Runs the REAL Claude provider and CLI against a fake Anthropic API that plays `RUN: <command>`
 * lines of the turn's first prompt as Bash tool calls, then answers `Got: <what the user wrote
 * since the last answer>` — so a test can see whether a queued message reached the model inside
 * the running turn, after it, or never. API-key auth from settings; no accounts.
 *
 * Requires an isolated home/config and serves the scratch Vite bundle in PPM_QUEUE_WEB_DIR.
 * Test endpoint: GET /__queue-test/requests (user texts the fake API saw, oldest first).
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME, realHomePath = process.env.PPM_HTML_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || privatePpm === realHome || privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`)) {
  throw new Error("Refusing the production home or PPM directory");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.DISABLE_TELEMETRY = "1";
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

// ---- Fake Anthropic API ------------------------------------------------------------------
const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const seen: Array<{ at: number; texts: string[]; toolResult: boolean }> = [];

function reply(block: { type: "text"; text: string } | { type: "tool"; command: string }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      c.enqueue(sse("message_start", { type: "message_start", message: { id: `msg_q_${crypto.randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage } }));
      if (block.type === "tool") {
        const id = `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
        c.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "Bash", input: {} } }));
        c.enqueue(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: block.command, description: "scripted" }) } }));
      } else {
        c.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        c.enqueue(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } }));
      }
      c.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      c.enqueue(sse("message_delta", { type: "message_delta", delta: { stop_reason: block.type === "tool" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }));
      c.enqueue(sse("message_stop", { type: "message_stop" }));
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

/** What the person wrote since the model last answered, reminders left out. */
function textsSinceAnswer(messages: any[]): { texts: string[]; toolResult: boolean } {
  const texts: string[] = [];
  let toolResult = false;
  // The CLI can end the list with a `system` message of its own, which carries a message queued mid-turn.
  for (let i = messages.length - 1; i >= 0 && messages[i]?.role !== "assistant"; i--) {
    if (messages[i]?.role !== "user" && messages[i]?.role !== "system") continue;
    const content = messages[i].content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
    for (const b of [...blocks].reverse()) {
      if (b.type === "tool_result") toolResult = true;
      if (b.type !== "text") continue;
      const text = String(b.text);
      // A message queued mid-turn reaches the model inside a system reminder, beside the tool result.
      if (!text.startsWith("<system-reminder>")) texts.unshift(text);
      else texts.unshift(...[...text.matchAll(/QUEUED[A-Z ]*[A-Z]/g)].map((m) => m[0]));
    }
  }
  return { texts, toolResult };
}

const fakeApi = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (path !== "/v1/messages" || req.method !== "POST") return Response.json({});
    const body: any = await req.json();
    const messages: any[] = body.messages ?? [];
    // Side requests (titles) carry a system prompt of their own and no tools.
    if (!Array.isArray(body.tools) || body.tools.length === 0) return reply({ type: "text", text: "Queue test" });
    const now = textsSinceAnswer(messages);
    seen.push({ at: Date.now(), ...now });
    // The turn's script: the last user message holding RUN lines, played one command per request.
    let scriptAt = -1, commands: string[] = [];
    messages.forEach((m, i) => {
      if (m.role !== "user") return;
      const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b?.text ?? "").join("\n");
      const found = [...text.matchAll(/^RUN: (.*)$/gm)].map((x) => x[1]!);
      if (found.length) [scriptAt, commands] = [i, found];
    });
    const done = scriptAt < 0 ? 0 : messages.slice(scriptAt + 1)
      .flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : [])).length;
    if (done < commands.length && now.texts.every((t) => !t.startsWith("QUEUED"))) return reply({ type: "tool", command: commands[done]! });
    const said = now.texts.filter((t) => !/^RUN: /m.test(t) && !t.startsWith("[Request interrupted")).join(" | ");
    return reply({ type: "text", text: `Got: ${said || "(tool result only)"}` });
  },
});

// ---- PPM ---------------------------------------------------------------------------------
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
const ai = configService.get("ai");
configService.set("ai", {
  ...ai, default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { ...ai.providers.claude, type: "agent-sdk", permission_mode: "bypassPermissions", model: "claude-sonnet-5", api_key: "sk-ant-api03-fake-queue-e2e", base_url: fakeApi.url.href.replace(/\/$/, "") } },
});
await (await import("./answer-feature-intros")).answerFeatureIntrosAtStartup();

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  async fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__queue-test/requests") return Response.json(seen);
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = { type: "chat", sessionId: parts[5] ?? "", projectName: decodeURIComponent(parts[3] ?? "") };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_QUEUE_WEB_DIR;
      if (!webDir) throw new Error("PPM_QUEUE_WEB_DIR required");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (relative.includes("..")) return new Response("Invalid path", { status: 400 });
      const file = Bun.file(resolve(webDir, relative || "index.html"));
      return file.exists().then((found) => new Response(found ? file : Bun.file(resolve(webDir, "index.html"))));
    }
    return app.fetch(req, instance);
  },
  websocket: {
    idleTimeout: 960, sendPong: true,
    open(ws) {
      if (ws.data.type === "chat") chatWebSocket.open(ws as never);
      else if (ws.data.type === "global") globalWebSocket.open(ws);
    },
    message(ws, message) {
      if (ws.data.type === "chat") chatWebSocket.message(ws as never, message as string);
      else if (ws.data.type === "global") globalWebSocket.message(ws, message as string);
      else ws.send("pong");
    },
    close(ws) {
      if (ws.data.type === "chat") chatWebSocket.close(ws as never);
      else if (ws.data.type === "global") globalWebSocket.close(ws);
    },
  },
});
function shutdown() { server.stop(true); fakeApi.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Chat-queue fixture ready at http://127.0.0.1:${server.port}; fake Anthropic API at ${fakeApi.url.href}.`);
