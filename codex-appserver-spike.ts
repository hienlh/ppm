/**
 * Feasibility spike: drive `codex app-server` over stdio JSON-RPC to PROVE:
 *   1. token-by-token text streaming (item/agentMessage/delta)
 *   2. interactive tool approval round-trip (item/commandExecution/requestApproval)
 *   3. ask-user-input round-trip (item/tool/requestUserInput)
 *
 * Newline-delimited JSON framing. Auto-approves and answers prompts.
 * Run AFTER `codex login`:
 *   bun codex-appserver-spike.ts
 */
import { spawn } from "node:child_process";

const t0 = Date.now();
const ms = () => `+${String(Date.now() - t0).padStart(6, " ")}ms`;

// Use bun's resolver to locate + run the scoped codex binary (avoids the prank `codex` pkg).
const proc = spawn(process.execPath, ["x", "@openai/codex", "app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let nextId = 1;
function send(method: string, params?: unknown): number {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  console.log(`${ms()} → req #${id} ${method}`);
  return id;
}
function notify(method: string, params?: unknown) {
  proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  console.log(`${ms()} → notif ${method}`);
}
function respond(id: unknown, result: unknown) {
  proc.stdin.write(JSON.stringify({ id, result }) + "\n");
  console.log(`${ms()} → resp #${id} ${JSON.stringify(result)}`);
}

let threadId: string | null = null;
let deltaCount = 0;
let deltaText = "";
let sawApproval = false;
let sawUserInput = false;

let buf = "";
proc.stdout.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
proc.stderr.on("data", (c: Buffer) => {
  const s = c.toString().trim();
  if (s && !/warning|trace-warnings|circular dependency/i.test(s)) {
    console.error(`${ms()} stderr: ${s.slice(0, 160)}`);
  }
});

function handle(msg: any) {
  // Response to our request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
    console.log(`${ms()} ← resp #${msg.id}`, msg.error ? `ERROR ${JSON.stringify(msg.error)}` : JSON.stringify(msg.result).slice(0, 160));
    if (initId === msg.id) {
      notify("initialized");
      startId = send("thread/start", { cwd: process.cwd(), sandbox: "danger-full-access", approvalPolicy: "on-request" });
    } else if (startId === msg.id) {
      const tid = msg.result?.thread?.id ?? msg.result?.threadId ?? msg.result?.id;
      if (tid) { threadId = tid; startTurn(); }
    }
    return;
  }

  // Server → client REQUEST (has id + method) — approvals / user input
  if (msg.id !== undefined && msg.method) {
    console.log(`${ms()} ←★ SERVER REQUEST ${msg.method}`, JSON.stringify(msg.params).slice(0, 200));
    if (msg.method === "item/commandExecution/requestApproval") {
      sawApproval = true;
      respond(msg.id, { decision: "accept" });
    } else if (msg.method === "execCommandApproval") {
      sawApproval = true;
      respond(msg.id, { decision: "approved" });
    } else if (msg.method === "item/fileChange/requestApproval") {
      sawApproval = true;
      respond(msg.id, { decision: "accept" });
    } else if (msg.method === "item/permissions/requestApproval") {
      sawApproval = true;
      respond(msg.id, { decision: "accept" });
    } else if (msg.method === "item/tool/requestUserInput") {
      sawUserInput = true;
      respond(msg.id, { value: "blue" }); // best-effort answer shape
    } else {
      respond(msg.id, {}); // generic ack
    }
    return;
  }

  // Notification (method, no id)
  if (msg.method) {
    if (msg.method === "item/agentMessage/delta") {
      deltaCount++;
      deltaText += msg.params?.delta ?? "";
      process.stdout.write(deltaCount === 1 ? `${ms()} ←TEXTDELTA: «${msg.params?.delta}` : `»«${msg.params?.delta}`);
      return;
    }
    if (deltaCount > 0 && msg.method !== "item/agentMessage/delta") {
      process.stdout.write("»\n"); // close the delta line
    }
    console.log(`${ms()} ← notif ${msg.method}`, JSON.stringify(msg.params ?? {}).slice(0, 140));
    if (msg.method === "turn/completed") finish();
  }
}

let initId = -1, startId = -1, turnId = -1;

function startTurn() {
  turnId = send("turn/start", {
    threadId,
    input: [{ type: "text", text:
      "Reply with one short greeting sentence. Then run the shell command: echo hi > spike-approval-test.txt",
      text_elements: [] }],
    approvalPolicy: "on-request",
  });
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  console.log("\n==================== SPIKE RESULT ====================");
  console.log(`token deltas received : ${deltaCount}  ${deltaCount > 1 ? "✅ TOKEN-BY-TOKEN" : "❌ NOT streamed"}`);
  console.log(`assembled text        : ${JSON.stringify(deltaText.slice(0, 120))}`);
  console.log(`tool approval prompt  : ${sawApproval ? "✅ received + responded" : "❌ none"}`);
  console.log(`ask-user-input prompt : ${sawUserInput ? "✅ received" : "— (not triggered this run)"}`);
  console.log("=====================================================");
  setTimeout(() => { proc.kill(); process.exit(0); }, 300);
}

// kick off
initId = send("initialize", {
  clientInfo: { name: "ppm-spike", title: "PPM Spike", version: "0.0.0" },
  capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null },
});

setTimeout(() => { console.error(`${ms()} TIMEOUT — killing`); finish(); }, 60_000);
