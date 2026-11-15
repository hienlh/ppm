// Scenario h of the restart-news e2e: a chat between turns with background work running when PPM
// goes down. Nothing cut it off mid-turn, so the old news never named it; now it has a section of
// its own, each task says what it was and what became of it, and the manager may be asked to start
// that work again: the provenance block the server writes lists the chat's id.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR, until } from "./restart-kit.mjs";

/** A secret in the command line, which the news must never repeat. */
const SECRET = "sk-ant-api03-e2eRestartNewsSecretValue0123456789abcdef";

/** h. A crash while an idle chat had a background shell and a background log follower running. */
export async function scenarioBackground(k, s) {
  const { fx } = k;
  await k.settle([s.main, s.manager, s.child]);

  s.bg = (await fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: "Benchmark runner" })).data.id;
  await k.script("rn-h-start", [
    // No description: the news quotes the command instead, with the token taken out.
    { background: { taskId: "rnhbatch1", tool: "PowerShell", command: `powershell -File run-batch.ps1 -Count 26 -Token ${SECRET}` } },
    { background: { taskId: "rnhlogs1", tool: "Bash", description: "Follow the benchmark container log", command: "docker logs -f bench" } },
    { text: "Both are running in the background." },
  ], { match: "Start the benchmark", sessionId: s.bg });
  await k.say("alpha", s.bg, "Start the benchmark and keep it running");
  await until("h: the benchmark turn ran", () => fx.turnOf("rn-h-start"));
  await k.idle(s.bg);
  await fx.api(`/api/project/alpha/chat/sessions/${s.bg}`, { method: "PATCH", body: JSON.stringify({ title: "Benchmark runner" }) });
  await fx.post("/__assistant-test/rn/link", { child: s.bg, parent: s.manager });
  const rows = await k.trace(s.bg);
  assert.ok(rows.some((r) => r.type === "done"), "h: the chat's turn ended before PPM went down");

  // The log follower keeps writing its output file after the restart, as a detached `docker logs -f`
  // would: the CLI keeps it at <claude temp>/<folder>/<session>/tasks/<task>.output.
  const claudeTmp = join(tmpdir(), "claude", `ppm-e2e-${process.pid}-${Date.now()}`);
  const output = join(claudeTmp, s.bg, "tasks", "rnhlogs1.output");
  mkdirSync(join(claudeTmp, s.bg, "tasks"), { recursive: true });
  writeFileSync(output, "bench | still logging\n");
  const later = new Date(Date.now() + 24 * HOUR);
  utimesSync(output, later, later);

  try {
    await k.advance(HOUR + 60_000);
    await k.stop("crash");
    const label = "rn-h-send";
    await k.start({}, [{
      label, match: "Restart news:", sessionId: s.main,
      ops: [{ session: "send_to_session", args: { session_id: s.manager, message: `PPM restarted (${label}). ${s.bg} had its benchmark running in the background: check it and start it again if it is still needed.` } }],
      reply: "Asked alpha's manager chat to check the benchmark chat.",
    }]);
    const turn = await k.oneNewsTurn(s.main, "scenario h");
    const ctx = turn.sharedContext;
    const has = (text) => assert.ok(ctx.includes(text), `h: the news says ${JSON.stringify(text)}\n--- news ---\n${ctx}`);
    has("Chats cut off mid-turn: none.");
    has("Chats whose background work was stopped (1)");
    has("starts it again only if so");
    const lines = ctx.split("\n");
    const head = lines.findIndex((l) => l.includes(`session ${s.bg}`));
    assert.ok(head > 0, `h: the chat is listed\n${ctx}`);
    assert.match(lines[head], new RegExp(`^\\s{2,}- Chat opened by session ${s.manager} "Benchmark runner"`), `h: listed by title, under the manager that opened it: ${lines[head]}`);
    assert.ok(lines[head].includes("was between turns"), `h: told as a chat between turns: ${lines[head]}`);
    const batch = lines.find((l) => l.includes("PowerShell started at"));
    const logs = lines.find((l) => l.includes("Bash started at"));
    assert.ok(batch?.includes('command "powershell -File run-batch.ps1 -Count 26 -Token [REDACTED]"'), `h: the batch is named by its command, token taken out: ${batch}`);
    assert.ok(logs?.includes('for "Follow the benchmark container log"') && !logs.includes("command"), `h: the log follower is named by what it was for, not its command: ${logs}`);
    assert.ok(batch.includes("After the restart: not known"), `h: nothing says whether the batch still runs: ${batch}`);
    assert.ok(logs?.includes("After the restart: still running"), `h: the log follower wrote after the restart: ${logs}`);
    assert.ok(!ctx.includes(SECRET.slice(12)), "h: the secret in the command line is not repeated");
    assert.match(k.logOf(), /0 chat\(s\) cut off, 1 chat\(s\) with background work stopped \(urgent\)/, "h: the server logs the urgent news");

    const [send] = await k.answered(label, 1);
    assert.equal(send.isError, false, `h: send_to_session to the manager was refused: ${send.text}`);
    const got = await until("h: the manager got the message", async () =>
      (await k.turnsIn(s.manager)).find((t) => t.blocks?.fromSession?.kind === "assistant" && t.blocks.content.includes(label)), 30000);
    assert.equal(got.blocks.provenance?.startedBy, "ppm", "h: the manager is told PPM started the Assistant's turn");
    assert.ok((got.blocks.provenance?.reason ?? "").split(", ").includes("restart"), `h: the provenance carries the restart reason (got ${got.blocks.provenance?.reason})`);
    assert.deepEqual(got.blocks.provenance?.restartChats, [s.bg], `h: the provenance lists the chat whose work stopped (got ${JSON.stringify(got.blocks.provenance?.restartChats)})`);
    await until("h: the delivered news is cleared", async () => (await k.state()).pending === null);
    k.record("h", "an idle chat's background work stopped by a crash: its own section lists both tasks (one not known, one still writing its output), no secret, urgent; the manager is messaged with provenance restart naming that chat");
  } finally {
    rmSync(claudeTmp, { recursive: true, force: true });
  }
}
