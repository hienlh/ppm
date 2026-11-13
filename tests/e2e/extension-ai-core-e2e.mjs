// PPM's extension AI APIs end to end, with no browser and no real AI: a disposable API server
// (tests/e2e/fixtures/extension-ai-server.ts) whose one provider is scripted, and a probe
// extension (tests/e2e/fixtures/ext-ai-probe) installed through the real dev-link route. The
// probe keeps its data in its data folder with bun:sqlite, creates a bindable chat, binds a tool
// policy and its own toolset, and drives headless turns; the scripted model calls the probe's
// tool through the real /api/ext-mcp endpoint and has a read outside the policy's roots refused.
// Then ppm.ai.complete with a JSON Schema, and a cancelled call. Isolated PPM_HOME and HOME.
//
//   bun tests/e2e/extension-ai-core-e2e.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-ext-ai-e2e-"));
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project"), outside = join(sandbox, "outside");
await Promise.all([ppm, home, join(project, "notes"), outside].map((p) => mkdir(p, { recursive: true })));
await writeFile(join(project, "notes/plan.md"), "the plan inside the root\n");
await writeFile(join(project, "package.json"), "{}\n");
await writeFile(join(outside, "secret.txt"), "must never be read\n");

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_EXT_TEST_REAL_HOME: homedir(), PPM_EXT_TEST_PORT: String(port) };
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/extension-ai-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

async function until(label, fn, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
async function api(path, init = {}) {
  const response = await fetch(base + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json();
  assert(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
  return { status: response.status, body };
}
async function run(command, ...args) {
  const { body } = await api("/__ext-test/command", { method: "POST", body: JSON.stringify({ command, args }) });
  assert.equal(body.ok, true, `${command}: ${body.error}`);
  return body.result;
}
const records = async () => (await api("/__ext-test/records")).body;

const NAME = "probe-project", EXT = "ppm-ext-ai-probe";
let passed = 0;
const pass = (name) => { passed++; console.log(`PASS ${name}`); };

try {
  await until("fixture healthy", async () => (await fetch(`${base}/api/health`)).ok, 60000);
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: NAME, path: project }) });

  const linked = await api("/api/extensions/dev-link", { method: "POST", body: JSON.stringify({ path: resolve("tests/e2e/fixtures/ext-ai-probe") }) });
  assert.equal(linked.status, 201);
  const info = (await api(`/api/extensions/${EXT}`)).body.data;
  assert.equal(info.activated, true, "the probe is activated by dev-link");
  assert.deepEqual(await run("probe.registered"), ["probe_echo"]);
  pass("dev-link installs and activates the probe; its toolset is accepted as probe_echo");

  const storage = await run("probe.storage");
  assert.equal(storage.path, join(ppm, "extension-data", EXT));
  assert.equal(storage.value, "xin chào");
  assert.equal(storage.journal, "wal");
  assert(existsSync(join(ppm, "extension-data", EXT, "probe.db")), "the database file is in the data folder");
  pass("globalStoragePath is <ppm dir>/extension-data/<id>, and bun:sqlite works there inside the worker");

  const policy = { readRoots: [project], writeRoots: [project] };
  const bound = await run("probe.session", NAME, { instructions: "You are the probe.", toolsets: ["probe"], toolPolicy: policy });
  const sessionId = bound.session.sessionId;
  assert.deepEqual(bound.bound.toolsets, ["probe"]);
  assert.deepEqual(bound.bound.toolPolicy.readRoots, [project]);
  assert.equal(bound.bound.pendingRestart, false);
  pass("a bindable Claude session is created and bound to instructions, a tool policy and the probe toolset");

  const inside = join(project, "notes/plan.md"), secret = join(outside, "secret.txt"), manifest = join(project, "package.json");
  const turn = await run("probe.turn", sessionId, `use-echo read-files read=${inside} read=${secret} write=${manifest}`);
  assert.equal(turn.sent.queued, false);
  assert.equal(turn.state.running, false);
  assert.match(turn.last, /^Turn \d+: echo=echo:hello:extension, files=3\.$/);
  const after = await records();
  const firstTurn = after.turns.find((t) => t.sessionId === sessionId);
  assert.equal(firstTurn.extensionMcp, true, "the turn is handed the ppm-ext server");
  assert.equal(firstTurn.extensionPolicy, true, "the turn carries the tool policy");
  assert.equal(firstTurn.instructions, "You are the probe.");
  assert.equal(firstTurn.permissionMode, "acceptEdits", "a policy session is clamped out of bypass");
  assert.equal(firstTurn.tabTools, false);
  const echo = after.tools.find((t) => t.sessionId === sessionId && t.tool === "mcp__ppm-ext__probe_echo");
  assert.deepEqual(echo.listed, ["probe_echo"]);
  assert.equal(echo.status, 200);
  assert.equal(echo.text, "echo:hello:extension");
  const calls = await run("probe.calls");
  assert.deepEqual(calls, [{ name: "echo", text: "hello", sessionId, turnOrigin: "extension" }]);
  pass("a headless turn's model calls probe_echo over /api/ext-mcp; the handler sees the session and turnOrigin \"extension\"");

  const verdict = (path) => after.tools.find((t) => t.sessionId === sessionId && t.tool.endsWith(` ${path}`));
  assert.equal(verdict(inside).allowed, true);
  assert.equal(verdict(inside).text, "the plan inside the root\n");
  assert.equal(verdict(secret).allowed, false);
  assert.match(verdict(secret).reason, /outside the folders this chat may read/);
  assert.equal(verdict(manifest).allowed, false);
  assert.match(verdict(manifest).reason, /protected/);
  pass("the policy allows a read inside its root, refuses one outside it and refuses writing package.json");

  const plain = await run("probe.session", NAME, { toolPolicy: policy });
  const plainTurn = await run("probe.turn", plain.session.sessionId, "use-echo");
  assert.match(plainTurn.last, /This chat was given no ppm-ext server/);
  assert.equal((await records()).turns.find((t) => t.sessionId === plain.session.sessionId).extensionMcp, false);
  pass("a session bound to no toolset is not handed the probe's tools");

  const approval = await run("probe.turn", sessionId, "ask-approval");
  assert.match(approval.last, /approval=denied/);
  const asked = (await records()).approvals.at(-1);
  assert.equal(asked.approved, false);
  assert(asked.ms < 5000, `denied at once with no browser attached (${asked.ms} ms)`);
  pass(`an approval in an extension turn with no browser attached is denied at once (${asked.ms} ms)`);

  const before = (await records()).turns.length;
  const rest = await api(`/api/project/${NAME}/chat/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content: "rest turn" }) });
  assert.equal(rest.status, 202);
  await until("REST turn ran", async () => (await records()).turns.length > before);
  pass("POST /chat/sessions/:id/messages starts a headless turn (202)");

  const schema = { type: "object", properties: { score: { type: "number", minimum: 0, maximum: 1 }, label: { type: "string" } }, required: ["score", "label"], additionalProperties: false };
  const shotsBefore = (await records()).oneShots.length;
  const ai = await run("probe.ai", { provider: "claude", model: "claude-haiku-4-5", system: "Rate it.", prompt: "score this", jsonSchema: schema });
  assert(!ai.error, JSON.stringify(ai.error));
  assert.deepEqual(ai.result.json, { score: 0.5, label: "likely" });
  assert.equal(ai.result.inputTokens, 20);
  assert.equal(ai.result.outputTokens, 10);
  const shots = (await records()).oneShots.slice(shotsBefore);
  assert.equal(shots.length, 2, "one retry after the answer broke the schema");
  assert(shots.every((s) => s.jsonSchema && s.schemaInSystem));
  pass("ppm.ai.complete validates the answer against the schema, retries once and returns parsed JSON with summed tokens");

  const cancelled = await run("probe.aiCancel", { provider: "claude", model: "claude-haiku-4-5", system: "", prompt: "hang until stopped" }, 300);
  assert.equal(cancelled.error?.name, "AbortError");
  assert.equal(cancelled.error?.code, "ABORTED");
  assert(cancelled.elapsedMs < 2000, `the caller is released at once (${cancelled.elapsedMs} ms)`);
  await until("the provider call is stopped", async () => (await records()).oneShots.find((s) => s.prompt.startsWith("hang"))?.aborted === true, 10000);
  pass(`aborting ppm.ai.complete rejects with AbortError (${cancelled.elapsedMs} ms) and stops the provider call`);

  const signals = await run("probe.signals");
  assert(Array.isArray(signals.usage.accounts) && typeof signals.usage.now === "string");
  assert.equal(typeof signals.presence.active, "boolean");
  assert.equal(signals.presence.activeWindowMs, 600000);
  pass("ppm.usage and ppm.presence answer in the worker");
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  console.error(`--- server log (tail) ---\n${serverLog.slice(-6000)}`);
  process.exitCode = 1;
} finally {
  backend.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  console.log(`${passed} passed${process.exitCode ? ", 1 failed" : ""}; sandbox ${sandbox}`);
}
