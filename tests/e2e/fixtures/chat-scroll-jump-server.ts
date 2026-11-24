/**
 * Isolated real-route server for `tests/e2e/chat-scroll-jump-e2e.mjs`. Never use __serve__.
 * Built on chat-footer-server's isolation guards, with one scripted mock provider whose turns
 * look like a real working turn: many thinking deltas, tool calls with multi-line output,
 * Markdown with code blocks and a table, then a closing paragraph. The history it answers
 * (`getMessages`) holds the same turn the way a transcript does, so a refetch at idle swaps the
 * live rows for history rows exactly as it would against Claude. Nothing here reaches Anthropic.
 *
 * A message's words pick the script:
 * - `seed`  a short answer with one code block, to build a transcript longer than the viewport;
 * - `long`  the working turn above (`deltas=<n>` sets how many thinking deltas it streams);
 * - `noisy` the same turn with every delta also echoed as a status ping, to fill the replay buffer.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE, realHomePath = process.env.PPM_HTML_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !profile || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`)) {
  throw new Error("Refusing the production home or PPM directory");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { type: "mock", permission_mode: "bypassPermissions" } },
});
await (await import("./answer-feature-intros")).answerFeatureIntrosAtStartup();

const { MockProvider } = await import("../../../src/providers/mock-provider");
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type ProviderMessage = import("../../../src/providers/provider.interface").ChatMessage;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CODE = [
  "```ts",
  "export function relock(el: HTMLElement, follow: () => void): () => void {",
  "  let last = el.clientHeight;",
  "  const ro = new ResizeObserver(() => {",
  "    const h = el.clientHeight;",
  "    if (h > last) setTimeout(follow, 2);",
  "    last = h;",
  "  });",
  "  ro.observe(el);",
  "  return () => ro.disconnect();",
  "}",
  "```",
].join("\n");
const TABLE = "| Step | What happens | Height |\n| --- | --- | --- |\n| 1 | Thinking streams | grows |\n| 2 | Tool output lands | grows |\n| 3 | The answer is written | grows |\n| 4 | The turn ends | settles |";
const OUTPUT = Array.from({ length: 18 }, (_, i) => `line ${String(i + 1).padStart(2, "0")}: src/web/components/chat/file-${i}.tsx  ok`).join("\n");

interface Script { events: ChatEvent[]; stored: ProviderMessage }

/** The events of one turn, and the assistant message its transcript keeps for history. */
function script(message: string): Script {
  const lower = message.toLowerCase();
  const events: ChatEvent[] = [];
  const stored: ChatEvent[] = [];
  const push = (ev: ChatEvent, keep = true) => { events.push(ev); if (keep) stored.push(ev); };
  // A wake turn PPM starts in the Assistant's chat, answered the way the Assistant answers news
  // that needs nothing from the user: the chat folds the whole turn into one muted line.
  if (message.trimStart().startsWith("[PPM] News")) {
    push({ type: "text", content: "[no reply]" } as ChatEvent);
    return { events, stored: { id: crypto.randomUUID(), role: "assistant", content: "[no reply]", events: stored as never, timestamp: new Date().toISOString() } };
  }
  if (lower.includes("seed")) {
    const text = `Seeded answer for "${message}".\n\n${CODE}\n\nThat is all for this one.`;
    push({ type: "text", content: text } as ChatEvent);
    return { events, stored: { id: crypto.randomUUID(), role: "assistant", content: text, events: stored as never, timestamp: new Date().toISOString() } };
  }
  const deltas = Number(/deltas=(\d+)/.exec(lower)?.[1] ?? 400);
  const think = (n: number) => {
    const words: string[] = [];
    for (let i = 0; i < n; i++) {
      const w = ` thought-${i % 37}`;
      words.push(w);
      events.push({ type: "thinking", content: w } as ChatEvent);
    }
    stored.push({ type: "thinking", content: words.join("") } as ChatEvent);
  };
  think(Math.floor(deltas / 2));
  const lead = "Let me look at the scroll code first.";
  push({ type: "text", content: lead } as ChatEvent);
  if (lower.includes("tasks")) {
    const toolUseId = `toolu_taskc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    push({ type: "tool_use", tool: "TaskCreate", input: { subject: "Find the scroll jump" }, toolUseId } as ChatEvent);
    push({ type: "tool_result", output: "Task #1 created successfully: Find the scroll jump", toolUseId } as ChatEvent);
  }
  const tools = [["Bash", { command: "rg -n scrollTop src/web" }], ["Read", { file_path: "src/web/components/chat/message-list.tsx" }]] as const;
  for (const [i, [tool, input]] of tools.entries()) {
    const toolUseId = `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}_${i}`;
    push({ type: "tool_use", tool, input, toolUseId } as ChatEvent);
    push({ type: "tool_result", output: OUTPUT, toolUseId } as ChatEvent);
  }
  think(deltas - Math.floor(deltas / 2));
  // `tasks`: the turn keeps a Claude task list, and marks its last task done near the end — the
  // list above the transcript then hides itself. `tasks-last` marks it after the closing text.
  const taskCall = (tool: string, input: unknown, output: string) => {
    const toolUseId = `toolu_task_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    push({ type: "tool_use", tool, input, toolUseId } as ChatEvent);
    push({ type: "tool_result", output, toolUseId } as ChatEvent);
  };
  const tasksDone = () => taskCall("TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status");
  if (lower.includes("tasks") && !lower.includes("tasks-last")) tasksDone();
  const body = [
    "## What I found",
    "",
    "The list follows its bottom while a turn streams, and the follow is kept by a resize observer.",
    "",
    "- The thinking block grows first.",
    "- Tool output lands next.",
    "- The answer is written last.",
    "",
    CODE,
    "",
    TABLE,
    "",
    "That is the whole of it: the view should stay at the bottom once the turn ends.",
  ].join("\n");
  // Streamed in word-sized pieces, the way a model writes.
  for (const piece of body.match(/\S+\s*|\s+/g) ?? []) events.push({ type: "text", content: piece } as ChatEvent);
  stored.push({ type: "text", content: body } as ChatEvent);
  if (lower.includes("tasks-last")) tasksDone();
  return {
    events,
    stored: { id: crypto.randomUUID(), role: "assistant", content: `${lead}${body}`, events: stored as never, timestamp: new Date().toISOString() },
  };
}

/**
 * The answer the way a Claude transcript hands it back: every block of a reply is a record of
 * its own, so history holds one assistant message per thinking block, text block and tool call,
 * with each tool's result folded into its call's message (`mergeToolResultMessages`). The live
 * stream draws the same turn as one message, which is what a history reload swaps it for.
 * PPM_SCROLL_SPLIT_HISTORY=0 keeps the single message instead.
 */
function asTranscript(msg: ProviderMessage): ProviderMessage[] {
  if (process.env.PPM_SCROLL_SPLIT_HISTORY === "0" || !msg.events?.length) return [msg];
  const out: ProviderMessage[] = [];
  const byCall = new Map<string, ProviderMessage>();
  for (const ev of msg.events as unknown as Array<{ type: string; content?: string; toolUseId?: string }>) {
    if (ev.type === "tool_result" && ev.toolUseId && byCall.has(ev.toolUseId)) {
      (byCall.get(ev.toolUseId)!.events as unknown[]).push(ev);
      continue;
    }
    const part: ProviderMessage = {
      id: crypto.randomUUID(), role: "assistant", content: ev.type === "text" ? ev.content ?? "" : "",
      events: [ev] as never, timestamp: msg.timestamp,
    };
    if (ev.type === "tool_use" && ev.toolUseId) byCall.set(ev.toolUseId, part);
    out.push(part);
  }
  return out;
}

const turns: { message: string; sessionId: string; at: number; yielded: number; ended?: number; tasksDoneAt?: number; paused?: boolean }[] = [];

// ------------------------------------------------------------------ the Assistant's cards
// Cards go through the real card service, so every open tab hears of them the way it does from a
// manager's report: a card created mid-answer lands in the stream by its time, and a waiting card
// answered mid-answer folds to one line.
const cards = () => import("../../../src/services/assistant-cards/assistant-cards.service");
/** Waiting cards the e2e made, oldest first: `answer-mid` / `answer-end` answer the oldest open one. */
const waitingCards: string[] = [];
async function cardOps(lower: string, at: "mid" | "end"): Promise<void> {
  const { assistantCards } = await cards();
  if (at === "mid" && lower.includes("card-mid")) {
    assistantCards.create({
      kind: "done", projectName: null, projectPath: null, sessionId: null,
      title: "A manager finished something", body: Array.from({ length: 6 }, (_, i) => `- finished item ${i + 1}`).join("\n"),
    });
  }
  if (lower.includes(`answer-${at}`)) {
    const id = waitingCards.shift();
    if (id) assistantCards.transition(id, "answered", { by: "user", channel: "ppm", at: Date.now() });
  }
}

class ScrollScriptMock extends MockProvider {
  readonly history = new Map<string, ProviderMessage[]>();
  /** The same script runs the PPM Assistant's chat (`assistant-scroll-jump-e2e.mjs`). */
  override supportsAssistantSessions = true;
  /** Puts `n` finished exchanges at the start of a session's history, so it pages like a long chat. */
  seed(sessionId: string, n: number): number {
    const older: ProviderMessage[] = [];
    const base = Date.now() - n * 60_000;
    for (let i = 0; i < n; i++) {
      const at = new Date(base + i * 60_000).toISOString();
      older.push({ id: crypto.randomUUID(), role: "user", content: `older question ${i + 1}`, timestamp: at });
      const text = `Older answer ${i + 1}.\n\n${CODE}\n\nDone.`;
      older.push({ id: crypto.randomUUID(), role: "assistant", content: text, events: [{ type: "text", content: text }] as never, timestamp: at });
    }
    const list = [...older, ...(this.history.get(sessionId) ?? [])];
    this.history.set(sessionId, list);
    return list.length;
  }
  constructor() {
    super();
    this.id = "claude";
    this.name = "Claude";
  }
  override async getMessages(sessionId: string): Promise<ProviderMessage[]> {
    return this.history.get(sessionId) ?? [];
  }
  override async *sendMessage(sessionId: string, message: string, _opts?: SendOpts): AsyncIterable<ChatEvent> {
    const turn = { message, sessionId, at: Date.now(), yielded: 0 } as (typeof turns)[number];
    turns.push(turn);
    const history = this.history.get(sessionId) ?? [];
    history.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    yield { type: "system", subtype: "init" } as never;
    const { events, stored } = script(message);
    const lower = message.toLowerCase();
    const noisy = lower.includes("noisy");
    // `bgbar`: a background command runs through the turn and finishes as it ends, so the bar
    // above the transcript goes away at the turn's end (`bgbar-after` a moment after `done`).
    const bgbar = /bgbar/.test(lower);
    const shell = { shellId: `bg-${turns.length}`, command: "bun test tests/unit --watch", outputPath: "/tmp/none.output", toolUseId: `toolu_bg_${turns.length}`, status: "running", startedAt: Date.now() };
    if (bgbar) yield { type: "background_registry", shells: [shell] } as never;
    // `pause=<ms>`: the turn stops for that long before its closing paragraph, so a socket can be
    // dropped and reconnected while it still runs, with most of the answer already drawn.
    const pauseMs = Number(/pause=(\d+)/.exec(lower)?.[1] ?? 0);
    const pauseAt = events.findIndex((ev) => ev.type === "text" && (ev as { content?: string }).content?.startsWith("##"));
    for (const [i, ev] of events.entries()) {
      if (pauseMs > 0 && i === pauseAt) {
        turn.paused = true;
        await sleep(pauseMs);
        turn.paused = false;
      }
      if (i === Math.floor(events.length / 2)) await cardOps(lower, "mid");
      yield ev;
      turn.yielded++;
      if (ev.type === "tool_use" && (ev as { tool?: string }).tool === "TaskUpdate") turn.tasksDoneAt = Date.now();
      if (noisy) yield { type: "system", subtype: "thinking_tokens" } as never;
      // A few milliseconds apart, batched, so a 400-delta turn takes a couple of seconds.
      if (i % 8 === 0) await sleep(12);
    }
    history.push(...asTranscript(stored));
    this.history.set(sessionId, history);
    if (bgbar && !lower.includes("bgbar-after")) yield { type: "background_registry", shells: [] } as never;
    await cardOps(lower, "end");
    turn.ended = Date.now();
    yield { type: "done", sessionId } as ChatEvent;
    if (bgbar && lower.includes("bgbar-after")) {
      await sleep(Number(/after=(\d+)/.exec(lower)?.[1] ?? 0));
      yield { type: "background_registry", shells: [] } as never;
    }
  }
}

const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new ScrollScriptMock();
providerRegistry.register(claude as never);
providerRegistry.get = ((id: string) => (id === claude.id ? claude : undefined)) as typeof providerRegistry.get;
providerRegistry.list = () => [{ id: claude.id, name: claude.name }];
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * What the Assistant e2e drives besides the chat itself:
 * - `POST cards/old?n=&spanMs=`: `n` report cards spread over the last `spanMs`, so the stream has
 *   more than one page of cards and loads older ones as the history reaches back;
 * - `POST cards/waiting`: one card that waits on the user (drawn whole, with its buttons);
 * - `POST wake?session=`: a wake turn PPM starts in that chat (origin `watch`), as the hub does;
 * - `GET scroll-jumps`: the `[scroll-jump]` rows the page shipped to the session trace, read with
 *   the same query the report gives for a real install.
 */
async function assistantTestRoute(url: URL, method: string): Promise<Response> {
  const path = url.pathname.slice("/__scroll-test/".length);
  if (path === "cards/old" && method === "POST") {
    const { insertCardRow } = await import("../../../src/services/assistant-cards/assistant-cards-db");
    const n = Number(url.searchParams.get("n") ?? 90);
    const span = Number(url.searchParams.get("spanMs") ?? 45 * 60_000);
    const now = Date.now();
    for (let i = 0; i < n; i++) {
      insertCardRow({
        kind: "done", projectKey: null, sessionId: null, title: `Older report ${i + 1}`,
        body: "- one finished item\n- another", payload: {}, status: "open", wake: "none",
        at: now - 60_000 - Math.round((span * (n - i)) / n),
      });
    }
    return json({ inserted: n });
  }
  if (path === "cards/waiting" && method === "POST") {
    const { assistantCards } = await cards();
    const card = assistantCards.create({
      kind: "question", projectName: null, projectPath: null, sessionId: null,
      title: "Which build should go out?", body: "The manager needs a pick before it can go on.\n\n- the one with the fix\n- the one without",
    });
    waitingCards.push(card.id);
    return json({ id: card.id });
  }
  if (path === "wake" && method === "POST") {
    const { chatControl } = await import("../../../src/services/chat-control/chat-control");
    const control = chatControl();
    if (!control) return json({ error: "no chat control" }, 500);
    const result = await control.sendUserMessage(url.searchParams.get("session") ?? "", "[PPM] News from manager chats — details are in the context.", {
      origin: "watch", projectName: "__assistant__", providerId: "claude",
    });
    return json({ result });
  }
  if (path === "scroll-jumps" && method === "GET") {
    const { getTraceDb } = await import("../../../src/services/session-trace/session-trace-db");
    const rows = getTraceDb().query(
      "SELECT ts, ref_id, payload_json FROM session_events WHERE source = 'browser' AND type = 'console_warn' AND payload_json LIKE '%[scroll-jump]%' ORDER BY ts",
    ).all();
    return json({ rows });
  }
  return json({ error: "unknown test route" }, 404);
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__html-test/shutdown" && req.method === "POST") {
      setTimeout(shutdown, 50);
      return new Response("Stopping fixture");
    }
    if (url.pathname === "/__scroll-test/state") return json({ turns });
    if (url.pathname.startsWith("/__scroll-test/") && url.pathname !== "/__scroll-test/state" && url.pathname !== "/__scroll-test/seed") {
      return assistantTestRoute(url, req.method).catch((e) => json({ error: String((e as Error)?.stack ?? e) }, 500));
    }
    if (url.pathname === "/__scroll-test/seed" && req.method === "POST") {
      const session = url.searchParams.get("session") ?? "";
      return json({ total: claude.seed(session, Number(url.searchParams.get("n") ?? 30)) });
    }
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = { type: "chat", sessionId: parts[5] ?? "", projectName: decodeURIComponent(parts[3] ?? "") };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/accounts(?:\/|$)/.test(url.pathname) && req.method !== "GET") return new Response("Disabled in fixture", { status: 403 });
    if (/^\/api\/(?:tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
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
function shutdown() { server.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Chat scroll-jump fixture ready at http://127.0.0.1:${server.port}; scripted provider only.`);
