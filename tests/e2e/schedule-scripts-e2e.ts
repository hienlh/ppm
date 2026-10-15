/**
 * Script schedules end to end on a compiled binary: the checklist of
 * plans/261012-1540-schedule-scripts/phase-06-e2e-scratch.md, against a scratch PPM.
 * Nothing leaves the machine: the provider is the mock, ntfy is a fake on loopback, and there
 * is no tunnel. One real `ctx.ai.ask` on haiku runs only with PPM_E2E_REAL_AI=1.
 *
 *   PPM_E2E_BIN=<worktree>/dist/ppm bun tests/e2e/schedule-scripts-e2e.ts
 *
 * PPM_E2E_KEEP=1 leaves the instance running for a look at the UI and prints how to stop it.
 * Not part of `bun test`: it takes about five minutes and starts real processes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNtfy, WRITER_TOKEN } from "../helpers/fake-ntfy-server.ts";
import { isAlive, ScratchPpm } from "./fixtures/schedule-scratch-ppm.ts";

const BIN = process.env.PPM_E2E_BIN;
if (!BIN) { console.error("set PPM_E2E_BIN to a compiled ppm binary"); process.exit(1); }
// A `+` so the URL-encoded form (`%2B`) has to be masked too.
const SECRET = `xoxp-e2e+${crypto.randomUUID()}`;

const results: Array<{ n: number; ok: boolean }> = [];
function check(n: number, name: string, ok: boolean, detail = ""): void {
  results.push({ n, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} #${n} ${name}${detail ? ` — ${detail}` : ""}`);
}

const ntfy = startFakeNtfy();
const ppm = new ScratchPpm(BIN);
const seen: string[] = []; // every answer and every CLI output, for the secret scan

const api = async (method: string, path: string, body?: unknown) => {
  const r = await ppm.api(method, path, body);
  seen.push(r.text);
  return r;
};
const cli = (...args: string[]) => {
  const r = ppm.cli(...args);
  seen.push(r.out);
  return r;
};
async function create(body: Record<string, unknown>): Promise<number> {
  const r = await api("POST", "/schedules", { project_path: ppm.project, kind: "script", ...body });
  if (r.status !== 201) throw new Error(`creating ${body.name}: ${r.status} ${r.text}`);
  return r.json.data.id;
}
const view = async (id: number) => (await api("GET", `/schedules/${id}`)).json.data;
const runs = async (id: number) => (await api("GET", `/schedules/${id}/runs?limit=200`)).json.data as any[];
const setEnabled = (id: number, enabled: boolean) => api("PATCH", `/schedules/${id}`, { enabled });
const state = (id: number) => JSON.parse(ppm.query("SELECT state_json FROM schedules WHERE id = ?", id)[0]?.state_json ?? "null");
const at = (t: string) => Date.parse(t.includes("T") ? t : `${t.replace(" ", "T")}Z`);
const secondsBetween = (times: number[]) => times.slice(1).map((t, i) => Math.round((t - times[i]!) / 100) / 10);

async function waitFor<T>(what: string, ms: number, probe: () => T | null | undefined | Promise<T | null | undefined>): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
const runningPid = (id: number, not?: number) => waitFor(`schedule ${id} running`, 30_000, async () => {
  const s = (await view(id)).status;
  return s.state === "running" && s.pid && s.pid !== not ? (s.pid as number) : null;
});

/** The most script processes alive at once while `during` runs, sampled every 50 ms. */
async function maxChildren(during: () => Promise<void>): Promise<number> {
  let max = 0;
  const timer = setInterval(() => { max = Math.max(max, ppm.scriptChildren().length); }, 50);
  try {
    await during();
  } finally {
    clearInterval(timer);
  }
  return Math.max(max, ppm.scriptChildren().length);
}

async function setup(): Promise<void> {
  await ppm.init();
  // Config load resets a default provider that has no entry of its own, so the mock gets one.
  const ai = JSON.parse(ppm.query<{ value: string }>("SELECT value FROM config WHERE key = 'ai'")[0]!.value);
  ppm.exec("UPDATE config SET value = ? WHERE key = 'ai'", JSON.stringify({
    ...ai, default_provider: "mock", share_provider_context: false,
    providers: { ...ai.providers, mock: { type: "mock", permission_mode: "bypassPermissions" } },
  }));
  const steps = [
    ["projects", "add", ppm.project, "--name", "proj"],
    ["config", "set", "notifications.delay_seconds", "0"],
    ["config", "set", "ntfy.server", ntfy.url],
    ["config", "set", "ntfy.topic", "e2e"],
    ["config", "set", "ntfy.token", WRITER_TOKEN],
  ];
  for (const step of steps) {
    const r = ppm.cli(...step);
    if (r.code !== 0) throw new Error(`${step.join(" ")}: ${r.out}`);
  }
  await ppm.start();
  console.log(`scratch PPM on ${ppm.base}, home ${ppm.home}`);
}

async function ticks(): Promise<number[]> {
  writeFileSync(join(ppm.dir, "tick.js"), "export default async (ctx) => {\n  ctx.state.count = (ctx.state.count ?? 0) + 1;\n  ctx.log(\"tick\", ctx.state.count);\n};\n");
  const added = cli("schedule", "add", "--name", "tick", "--script", join(ppm.dir, "tick.js"), "--mode", "tick", "--cron", "*/5 * * * * *", "--project", "proj");
  const tickId = Number(/#(\d+)/.exec(added.out)?.[1]);
  const tick = await view(tickId);
  check(1, "the CLI creates a script tick schedule, on the mock provider", added.code === 0 && tick?.kind === "script" && tick?.provider_id === "mock",
    `#${tickId} ${tick?.mode} provider=${tick?.provider_id}`);
  if (tick?.provider_id !== "mock") throw new Error("schedules are not on the mock provider; stopping before anything calls an AI");

  const quietId = await create({ name: "quiet", mode: "tick", cron_expr: "*/5 * * * * *", script: "export default async (ctx) => { ctx.state.n = (ctx.state.n ?? 0) + 1; };" });
  const boomId = await create({ name: "boom", mode: "tick", cron_expr: "*/5 * * * * *", script: "export default async () => { throw new Error('boom'); };" });
  await Bun.sleep(31_000);

  const done = (await runs(tickId)).filter((r) => r.status === "done").reverse();
  const gaps = secondsBetween(done.map((r) => at(r.started_at)));
  check(2, "a */5 s tick fires every 5 s", done.length >= 5 && gaps.every((g) => g >= 4 && g <= 6), `${done.length} runs, gaps ${gaps.join(" ")} s`);

  const boom = await runs(boomId);
  check(3, "a quiet tick keeps no run; one that logs or fails keeps one", (await runs(quietId)).length === 0 && state(quietId)?.n >= 5
    && boom.length >= 5 && boom.every((r) => r.status === "error" && /boom/.test(r.error)) && done.every((r) => /^tick \d+/.test(r.output_truncated)),
    `quiet: 0 runs, state n=${state(quietId)?.n}; boom: ${boom.length} error runs`);

  const before = state(tickId).count as number;
  const { old, next } = await ppm.killServer();
  await Bun.sleep(12_000);
  const after = state(tickId).count as number;
  const counts = (await runs(tickId)).map((r) => Number(/tick (\d+)/.exec(r.output_truncated ?? "")?.[1]));
  check(4, "the state carries over from tick to tick and across a server restart", after > before && counts.filter((c) => c === 1).length === 1,
    `count ${before} → ${after} across server ${old} → ${next}`);
  return [tickId, quietId, boomId];
}

async function alwaysOn(): Promise<void> {
  const crasherId = await create({ name: "crasher", mode: "always-on", script: "export default async (ctx) => { ctx.log('start'); await ctx.sleep(2000); throw new Error('crash'); };" });
  await Bun.sleep(47_000);
  const starts = (await api("GET", `/schedules/${crasherId}/logs`)).json.data.lines.filter((l: any) => l.text === "start").map((l: any) => Date.parse(l.at));
  const gaps = secondsBetween(starts);
  check(5, "a crashing always-on script starts again after 5, 10, then 20 s", gaps.length >= 3 && [7, 12, 22].every((w, i) => Math.abs(gaps[i]! - w) <= 1.5),
    `gaps between starts ${gaps.join(" ")} s (2 s of run + backoff)`);
  await setEnabled(crasherId, false);

  const daemonId = await create({ name: "daemon", mode: "always-on", script: "export default async (ctx) => { ctx.log('up'); while (!ctx.signal.aborted) await ctx.sleep(500); };" });
  const p0 = await runningPid(daemonId);
  await setEnabled(daemonId, false);
  await waitFor("the daemon to stop", 15_000, async () => !isAlive(p0) && (await view(daemonId)).status.state === "stopped");
  check(6, "turning an always-on schedule off ends its process", ppm.scriptChildren().length === 0, `pid ${p0} gone`);

  await setEnabled(daemonId, true);
  const p1 = await runningPid(daemonId);
  let p2 = 0;
  const max7 = await maxChildren(async () => {
    await ppm.killServer();
    p2 = await runningPid(daemonId, p1);
    await Bun.sleep(1000);
  });
  check(7, "never two processes when the server is killed and comes back", max7 <= 1 && !isAlive(p1) && isAlive(p2), `max ${max7} at once; ${p1} → ${p2}`);
  await setEnabled(daemonId, false);
  await waitFor("the daemon to stop", 15_000, () => !isAlive(p2));

  const hangId = await create({ name: "hang", mode: "always-on", script: "export default async (ctx) => { ctx.log('spinning'); await ctx.sleep(300); for (;;) {} };" });
  const h1 = await runningPid(hangId);
  await Bun.sleep(2000);
  let h2 = 0;
  const max8 = await maxChildren(async () => {
    await ppm.killServer();
    h2 = await runningPid(hangId, h1);
    await Bun.sleep(1000);
  });
  check(8, "never two processes when the script blocks its event loop and the server is killed", max8 <= 1 && !isAlive(h1) && isAlive(h2), `max ${max8} at once; ${h1} → ${h2}`);
  await setEnabled(hangId, false);
  await waitFor("the spinning script to be killed", 20_000, () => !isAlive(h2));
}

async function templates(): Promise<void> {
  const inputs = [
    { key: "channel", label: "Channel", type: "text", default: "#general" },
    { key: "limit", label: "Limit", type: "number" },
    { key: "token", label: "Token", type: "secret", required: true },
  ];
  const srcId = await create({
    name: "Template source", description: "E2E", mode: "tick", cron_expr: "0 9 * * *", enabled: false, inputs,
    script: "export default async (ctx) => { ctx.log('hello', ctx.inputs.channel, ctx.inputs.limit); };",
    inputValues: { channel: "#ops", limit: 5 }, secrets: { token: SECRET },
  });
  const first = (await api("GET", `/schedules/${srcId}/export`)).json.data.template;
  const imported = await api("POST", "/schedules/import", { template: first, projectName: "proj", secrets: { token: SECRET }, trust: true });
  const again = (await api("GET", `/schedules/${imported.json.data.id}/export`)).json.data.template;
  check(9, "export → import → export gives the same template, with no secret in it", JSON.stringify(first) === JSON.stringify(again) && !JSON.stringify(first).includes(SECRET),
    `${Object.keys(first).join(",")}`);

  const file = join(ppm.dir, "src.ppm-schedule.json");
  const exported = cli("schedule", "export", String(srcId), "-o", file);
  writeFileSync(join(ppm.dir, "token.txt"), `${SECRET}\n`);
  const untrusted = await api("POST", "/schedules/import", { template: first, projectName: "proj" });
  const cliUntrusted = cli("schedule", "import", file, "--project", "proj");
  const cliImport = cli("schedule", "import", file, "--project", "proj", "--set", "limit=7", "--trust");
  const newId = Number(/#(\d+)/.exec(cliImport.out)?.[1]);
  const off = await view(newId);
  const refused = await api("PATCH", `/schedules/${newId}`, { enabled: true });
  const cliRefused = cli("schedule", "enable", String(newId));
  const withSecret = cli("schedule", "import", file, "--project", "proj", "--secret", `token=@${join(ppm.dir, "token.txt")}`, "--trust");
  const secretId = Number(/#(\d+)/.exec(withSecret.out)?.[1]);
  const enabled = cli("schedule", "enable", String(secretId));
  await setEnabled(secretId, false);
  check(11, "an import needs trust and lands turned off; turning on a script with an empty required input is refused",
    exported.code === 0 && untrusted.status === 400 && cliUntrusted.code === 1 && cliImport.code === 0 && off.enabled === 0 && off.inputValues.limit === 7
      && refused.status === 409 && /Fill in token/.test(refused.text) && cliRefused.code === 1 && /Fill in token/.test(cliRefused.out)
      && enabled.code === 0 && (await view(secretId)).secretsSet.includes("token"),
    `REST ${untrusted.status}/${refused.status}, CLI exit ${cliUntrusted.code}/${cliRefused.code}, @file secret → enable exit ${enabled.code}`);
}

async function chats(): Promise<void> {
  const chatId = await create({
    name: "chatter", mode: "tick", cron_expr: "0 9 * * *", enabled: false,
    script: `export default async (ctx) => {
  const a = await ctx.ai.chat("triage", "hello there", { title: "Triage" });
  const b = await ctx.ai.chat("triage", "and again");
  const c = await ctx.ai.chat("bg", "please delete this code", { wait: false });
  const d = await ctx.ai.chat("bg", "second while busy", { wait: false });
  ctx.state.r = { a, b, c, d };
};`,
  });
  await api("POST", `/schedules/${chatId}/run-now`);
  const { a, b, c, d } = await waitFor("the chat script", 60_000, () => state(chatId)?.r);
  const bound = ppm.query("SELECT key, session_id FROM schedule_chats WHERE schedule_id = ?", chatId);
  const title = ppm.query("SELECT title FROM session_titles WHERE session_id = ?", a.sessionId)[0]?.title;
  check(12, "ctx.ai.chat: one PPM chat per key, named, the next turn in the same chat, busy while a turn runs",
    a.ok && b.ok && b.sessionId === a.sessionId && c.started === true && d.busy === true && bound.length === 2 && title === "Triage",
    `triage ${a.sessionId} ×2 titled "${title}", bg started=${c.started} then busy=${d.busy}, ${bound.length} chats bound`);

  const bgId = await create({
    name: "background", mode: "tick", cron_expr: "0 9 * * *", enabled: false,
    script: `export default async (ctx) => {
  if (!ctx.state.started) { ctx.state.started = await ctx.ai.chat("slow", "please delete this code example", { wait: false }); return; }
  ctx.state.finished = await ctx.ai.finished();
};`,
  });
  await api("POST", `/schedules/${bgId}/run-now`);
  await waitFor("a background turn", 20_000, () => ppm.query("SELECT id FROM schedule_ai_turns WHERE schedule_id = ? AND status = 'running'", bgId).length > 0);
  await ppm.killServer();
  await waitFor("the first tick's state", 10_000, () => state(bgId)?.started);
  await api("POST", `/schedules/${bgId}/run-now`);
  const finished = await waitFor("ctx.ai.finished()", 30_000, () => state(bgId)?.finished);
  check(13, "a turn started without waiting and cut by a restart comes back from finished() as interrupted",
    finished.length === 1 && finished[0].ok === false && /interrupted/.test(finished[0].error), JSON.stringify(finished.map((t: any) => ({ key: t.key, ok: t.ok, error: t.error }))));
}

async function notify(): Promise<void> {
  const id = await create({ name: "notifier", mode: "tick", cron_expr: "0 9 * * *", enabled: false, script: "export default async (ctx) => { await ctx.notify({ title: 'E2E title', body: 'E2E body from ' + ctx.schedule.name }); };" });
  await api("POST", `/schedules/${id}/run-now`);
  const sent = await waitFor("the ntfy publish", 15_000, () => ntfy.published.find((m) => JSON.stringify(m).includes("E2E body from notifier")));
  check(14, "ctx.notify reaches ntfy (a fake one on loopback)", JSON.stringify(sent).includes("E2E title"), JSON.stringify(sent));
}

async function realAi(): Promise<void> {
  if (process.env.PPM_E2E_REAL_AI !== "1") {
    console.log("  --   #16 one real ctx.ai.ask — skipped (PPM_E2E_REAL_AI=1 runs it)");
    return;
  }
  const leaked = readFileSync(`/proc/${ppm.status().pid}/environ`, "utf8").split("\0").map((e) => e.split("=")[0]!)
    .filter((k) => /^(CLAUDE|ANTHROPIC|NOTIFY_SOCKET)/.test(k));
  if (leaked.length) { check(16, "one real ctx.ai.ask", false, `not run: the server's environment carries ${leaked.join(", ")}`); return; }
  const id = await create({
    name: "real-ai", mode: "tick", cron_expr: "0 9 * * *", enabled: false,
    script: `export default async (ctx) => {
  const r = await ctx.ai.ask("Reply with ok set to true.", { model: "haiku", jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } });
  ctx.log(JSON.stringify({ ok: r.ok, json: r.json ?? null, error: r.error ?? null }));
};`,
  });
  ppm.exec("UPDATE schedules SET provider_id = 'claude' WHERE id = ?", id);
  await api("POST", `/schedules/${id}/run-now`);
  const [run] = await waitFor("the real AI run", 180_000, async () => { const r = await runs(id); return r.length ? r : null; });
  const out = JSON.parse(run.output_truncated ?? "{}");
  check(16, "one real ctx.ai.ask on haiku, with a JSON schema", run.status === "done" && out.ok === true && out.json?.ok === true,
    `cost $${run.cost_usd ?? 0}, answer ${JSON.stringify(out)}`);
}

async function secretScan(): Promise<void> {
  const id = await create({
    name: "secretive", mode: "tick", cron_expr: "0 9 * * *", enabled: false, secrets: { token: SECRET },
    inputs: [{ key: "token", label: "Token", type: "secret", required: true }],
    script: "export default async (ctx) => { ctx.log('token is', ctx.inputs.token); console.log(JSON.stringify({ t: ctx.inputs.token })); ctx.state.t = ctx.inputs.token; throw new Error('failed with ' + encodeURIComponent(ctx.inputs.token)); };",
  });
  await api("POST", `/schedules/${id}/run-now`);
  await waitFor("the secretive run", 15_000, async () => (await runs(id)).length > 0);
  for (const s of (await api("GET", "/schedules")).json.data) {
    for (const path of ["", "/export", "/logs", "/runs?limit=200"]) await api("GET", `/schedules/${s.id}${path}`);
    if (s.kind === "script") await api("GET", `/schedules/${s.id}/state`);
    cli("schedule", "state", String(s.id));
  }
  cli("schedule", "list");
  const rows = ppm.query("SELECT output_truncated, error FROM schedule_runs").map((r) => `${r.output_truncated}\n${r.error}`);
  const log = readFileSync(join(ppm.home, "ppm.log"), "utf8");
  const where = [
    ...seen.filter((t) => t.includes(SECRET) || t.includes(encodeURIComponent(SECRET))).map(() => "an answer"),
    ...rows.filter((t) => t.includes(SECRET) || t.includes(encodeURIComponent(SECRET))).map(() => "a run row"),
    ...(log.includes(SECRET) || log.includes(encodeURIComponent(SECRET)) ? ["ppm.log"] : []),
  ];
  const masked = (await runs(id))[0];
  check(10, "no answer, CLI output, run row or log line carries a secret", where.length === 0 && /••••/.test(masked.output_truncated) && /••••/.test(masked.error),
    where.length ? `found in ${where.join(", ")}` : `${seen.length} answers, ${rows.length} run rows and ppm.log scanned`);
}

let failed = false;
try {
  await setup();
  const tickIds = await ticks();
  for (const id of tickIds) await setEnabled(id, false);
  await alwaysOn();
  await templates();
  await chats();
  await notify();
  await realAi();
  await secretScan();
  check(15, "all of it ran on the compiled binary", true, BIN);
} catch (e) {
  failed = true;
  console.error(" FAIL  the run stopped:", e);
} finally {
  if (process.env.PPM_E2E_KEEP === "1") {
    console.log(`\nleft running: ${ppm.base} (supervisor ${ppm.status().supervisorPid}, home ${ppm.home})`);
  } else {
    await ppm.stop();
  }
  ntfy.stop();
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} checks passed${failed ? " — the run stopped early" : ""}`);
process.exit(bad || failed ? 1 : 0);
