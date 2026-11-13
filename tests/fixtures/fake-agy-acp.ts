// A stand-in for `agy acp` (Agent Client Protocol, JSON-RPC 2.0 over stdio, one message per line)
// for the Antigravity provider's tests, shaped after the messages agy 1.5.2 sent on 2026-11-07.
//
// The prompt's text picks what happens:
//   hello       a thought, two text chunks and a title; end_turn with usage
//   tool        a run_command call that runs and completes
//   perm        asks permission for run_command and says which answer it got
//   long        streams until session/cancel, then answers `cancelled`
//   slow        six text chunks 40 ms apart (two prompts in a row show the queueing)
//   image       says which content blocks it was sent
//   env         says what it found in its environment
//   fs          sends fs/read_text_file to the client and says what came back
//   crash       exits with code 3 halfway through the turn
//   refusal / max_tokens   answers with that stop reason
//   /compact    sends nothing at all and answers end_turn, as agy does while it compacts
//
// Like agy, it names its slash commands (`available_commands_update`) twice after session/new,
// and once while session/load replays the chat.
//
// A prompt sent while another runs is queued, as agy does: the running prompt is answered at once
// with `end_turn` (no usage) while its reply keeps streaming, then the queued one runs.
//
// Flags before `acp`: `--log <file>` appends argv, cwd and every message received as JSON lines;
// `--session-id <id>` is the id `session/new` answers with.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const logFile = flag("--log");
const newSessionId = flag("--session-id") ?? crypto.randomUUID();
const record = (entry: unknown) => { if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`); };
record({ argv, cwd: process.cwd() });

const send = (msg: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const update = (sessionId: string, u: Record<string, unknown>) => send({ method: "session/update", params: { sessionId, update: u } });
const text = (t: string) => ({ type: "text", text: t });

const opened = {
  models: {
    availableModels: [
      { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    ],
    currentModelId: "gemini-4-argon-medium",
  },
  modes: {
    currentModeId: "default",
    availableModes: [{ id: "default", name: "Default" }, { id: "accept-edits", name: "Accept edits" }, { id: "plan", name: "Plan" }],
  },
};

// Requests this fake sent to the client, waiting for their answer.
const asked = new Map<string, (msg: Record<string, unknown>) => void>();
let askSeq = 0;
function ask(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = `ask-${++askSeq}`;
  return new Promise((resolve) => {
    asked.set(id, resolve);
    send({ id, method, params });
  });
}

interface Turn {
  rpcId: number | string;
  sessionId: string;
  prompt: Array<{ type: string; text?: string; mimeType?: string }>;
  answered: boolean;
  cancelled: boolean;
}
let running: Turn | null = null;
const queue: Turn[] = [];

const commands = [
  { name: "goal", description: "Run until the specified goal is completely finished.", input: { hint: "the goal" } },
  { name: "compact", description: "Compact the conversation now." },
];
const announceCommands = (sessionId: string) => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: commands });

const usage = { inputTokens: 1200, outputTokens: 80, cachedReadTokens: 300, cachedWriteTokens: 0, thoughtTokens: 20, totalTokens: 1580 };
function answer(turn: Turn, result: Record<string, unknown>) {
  if (turn.answered) return;
  turn.answered = true;
  send({ id: turn.rpcId, result });
}

async function play(turn: Turn): Promise<void> {
  const { sessionId } = turn;
  const said = turn.prompt.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  const say = (t: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(t) });
  if (said.trim() === "/compact") {
    await sleep(30);
  } else if (said.includes("hello")) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: text("Greeting the user") });
    say("Hel");
    say("lo");
    update(sessionId, { sessionUpdate: "session_info_update", title: "Greeting Exchange" });
  } else if (said.includes("tool")) {
    const call = { toolCallId: "call_1", name: "run_command", args: { CommandLine: "ls -la", toolSummary: "List files" }, kind: "execute", title: "ls -la" };
    update(sessionId, { sessionUpdate: "tool_call", ...call, status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "in_progress" });
    update(sessionId, {
      sessionUpdate: "tool_call_update", ...call, status: "completed",
      rawOutput: { output: "Command exited with code 0.\n\nCommand output:\nREADME.md\n", exit_code: 0 },
      content: [{ type: "content", content: text("Command exited with code 0.\n\nCommand output:\nREADME.md\n") }],
    });
    say("One file.");
  } else if (said.includes("perm")) {
    const call = { toolCallId: "call_2", name: "run_command", args: { CommandLine: "rm -rf build" }, kind: "execute", title: "rm -rf build" };
    update(sessionId, { sessionUpdate: "tool_call", ...call, status: "pending" });
    const reply = await ask("session/request_permission", {
      sessionId,
      toolCall: { sessionUpdate: "tool_call", ...call, status: "pending" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    });
    const outcome = (reply.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
    const picked = outcome?.outcome === "selected" ? outcome.optionId : outcome?.outcome ?? "none";
    update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: picked === "allow" ? "completed" : "failed", rawOutput: { output: picked === "allow" ? "removed" : "denied by user" } });
    say(`permission: ${picked}`);
  } else if (said.includes("long")) {
    for (let i = 0; i < 400 && !turn.cancelled; i++) {
      say(`chunk ${i} `);
      await sleep(10);
    }
  } else if (said.includes("slow")) {
    for (let i = 0; i < 6 && !turn.cancelled; i++) {
      say(`${said.includes("second") ? "B" : "A"}${i} `);
      await sleep(40);
    }
  } else if (said.includes("image")) {
    say(turn.prompt.map((b) => b.type === "image" ? `image:${b.mimeType}` : b.type).join(","));
  } else if (said.includes("env")) {
    say(JSON.stringify({
      home: process.env.HOME,
      wsl: process.env.WSL_DISTRO_NAME ?? null,
      aiChat: process.env.PPM_AI_CHAT ?? null,
      secret: process.env.FAKE_AGY_SECRET ?? null,
    }));
  } else if (said.includes("fs")) {
    const reply = await ask("fs/read_text_file", { sessionId, path: "/etc/hostname" });
    say(`fs: ${JSON.stringify(reply.error ?? reply.result)}`);
  } else if (said.includes("crash")) {
    say("about to crash");
    await sleep(20);
    process.exit(3);
  } else if (said.includes("refusal") || said.includes("max_tokens")) {
    say("stopping");
    answer(turn, { stopReason: said.includes("refusal") ? "refusal" : "max_tokens" });
    return;
  } else {
    say("ok");
  }
  answer(turn, turn.cancelled ? { stopReason: "cancelled", usage } : { stopReason: "end_turn", usage });
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    running = queue.shift()!;
    await play(running);
    running = null;
  }
}

function onRequest(msg: Record<string, unknown>): void {
  const id = msg.id as number | string;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  switch (msg.method) {
    case "initialize":
      send({ id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true } },
        agentInfo: { name: "Fake Antigravity ACP Server", version: "0.0.0" },
        authMethods: [],
      } });
      return;
    case "session/new":
      send({ id, result: { sessionId: newSessionId, ...opened } });
      announceCommands(newSessionId);
      announceCommands(newSessionId);
      return;
    case "session/load": {
      const sessionId = String(params.sessionId);
      announceCommands(sessionId);
      update(sessionId, { sessionUpdate: "user_message_chunk", content: text("an old question") });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("an old reply") });
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "old_call", name: "read_file", args: { Path: "/x" }, status: "completed" });
      send({ id, result: opened });
      return;
    }
    case "session/set_model":
    case "session/set_mode":
      send({ id, result: {} });
      return;
    case "session/prompt": {
      const turn: Turn = { rpcId: id, sessionId: String(params.sessionId), prompt: (params.prompt ?? []) as Turn["prompt"], answered: false, cancelled: false };
      if (running) answer(running, { stopReason: "end_turn" });
      queue.push(turn);
      if (!running) void drain();
      return;
    }
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line) as Record<string, unknown>;
  record(msg);
  const isAnswer = msg.method === undefined && (msg.result !== undefined || msg.error !== undefined);
  if (isAnswer) {
    asked.get(String(msg.id))?.(msg);
    asked.delete(String(msg.id));
  } else if (msg.method === "session/cancel") {
    if (running) running.cancelled = true;
    for (const turn of queue.splice(0)) answer(turn, { stopReason: "cancelled" });
  } else if (msg.id !== undefined) {
    onRequest(msg);
  }
}).on("close", () => process.exit(0));
