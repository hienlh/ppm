// Session schedules, end to end, on the production Vite bundle against a disposable API/ws server
// (tests/e2e/fixtures/session-schedules-server.ts) whose Claude provider is scripted and calls the
// real `ppm-sessions` tools with the token each turn is handed, and which runs the real scheduler
// and deliverer. Covers: the AI scheduling a prompt into its own chat and the run line it leaves
// (a), a due schedule waiting for a running turn with two dues folded into one (b), a fire missed
// while PPM was off delivered once after a restart of the same install (c), the footer chip with
// Pause and Resume (d), Settings → Schedules with its Session column and Chat kind (e), and a
// scheduled message queued behind a person's turn that Stop takes down, held until the chat's next
// turn ends and then run once (f), on a
// desktop and a phone. No live credentials, no real PPM data.
//
// Run it in the capped e2e image (Chromium, Node 20 and playwright-core; see tests/e2e/docker/):
//
//   docker run --rm --cpus=2 --memory=4g -v <repo>:/app:ro -v ppm-e2e-nm:/app/node_modules \
//     -v <out>:/out -v <scratch-web>:/web -w /app -e IS_SANDBOX=1 \
//     -e PPM_SCHED_ARTIFACTS=/out -e PPM_SCHED_WEB_DIR=/web ppm-e2e-chromium:latest \
//     sh -c 'bun install --frozen-lockfile && node tests/e2e/session-schedules-e2e.mjs'
//
// PPM_SCHED_WEB_DIR=<dir> keeps the bundle there (built on the first run, reused after);
// PPM_SCHED_ARTIFACTS=<dir> keeps the screenshots and logs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createKit, pageInit } from "./fixtures/session-turn-refs-helpers.mjs";
import { schedKit, runAiCreatesAndRuns, runBusyChatCoalesces, runChipPauseResume, runRestartCatchUp } from "./fixtures/session-schedules-steps.mjs";
import { runPhone, runSettingsDesktop } from "./fixtures/session-schedules-steps-ui.mjs";
import { runStopDropsQueuedSchedule } from "./fixtures/session-schedules-steps-stop.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-sched-e2e-"));
const artifacts = process.env.PPM_SCHED_ARTIFACTS ? resolve(process.env.PPM_SCHED_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), projects = join(sandbox, "projects");
await Promise.all([artifacts, ppm, home, projects].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

const webDir = process.env.PPM_SCHED_WEB_DIR ? resolve(process.env.PPM_SCHED_WEB_DIR) : join(sandbox, "web");
if (!existsSync(join(webDir, "index.html"))) {
  await writeFile(join(artifacts, "vite.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir, "--emptyOutDir"]));
}
if (!existsSync(join(webDir, "index.html"))) throw new Error(`No web bundle in ${webDir}`);

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const baseEnv = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
  PPM_SCHED_WEB_DIR: webDir, PPM_SCHED_PROJECTS: projects, TZ: process.env.TZ ?? "Asia/Saigon",
};
delete baseEnv.PPM_ALLOW_PROD_DB;

let serverLog = "";
let backend = null;
function startFixture(extra = {}) {
  const child = spawn("bun", ["tests/e2e/fixtures/session-schedules-server.ts"], { env: { ...baseEnv, ...extra }, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (s) => serverLog += s); child.stderr.on("data", (s) => serverLog += s);
  console.log(`fixture server started, pid ${child.pid}`);
  return child;
}
async function stopFixture(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  console.log(`fixture server pid ${child.pid} stopped`);
}

let browser;
const ctx = { web, artifacts, current: null, ids: {}, pageInit };
const kit = ctx.kit = createKit({ web, artifacts, currentPage: () => ctx.current });
const sk = ctx.sk = schedKit(kit, web);
const { until, results, failures } = kit;
const started = Date.now();
const healthy = () => until("fixture healthy", async () => (await fetch(`${web}/api/health`, { headers: { Connection: "close" } })).ok, 90000, 300);

/** Stops the server and starts it again on the same PPM directory: a restart of one install. */
ctx.restart = async ({ backdate } = {}) => {
  await stopFixture(backend);
  serverLog += "\n----- restart -----\n";
  backend = startFixture({ PPM_SCHED_RESUME: "1", ...(backdate ? { PPM_SCHED_BACKDATE: backdate } : {}) });
  await healthy();
};

try {
  backend = startFixture();
  await healthy();
  const { alpha } = await sk.route("/project");
  await kit.post("/api/projects", { name: "alpha", path: alpha });
  ctx.ids.A = await sk.newSession("Release checklist");
  ctx.ids.B = await sk.newSession("Nightly worker");

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  const executablePath = process.env.PPM_PLAYWRIGHT_EXECUTABLE;
  browser = ctx.browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await desktop.addInitScript(pageInit);
  const page = ctx.page = ctx.current = await desktop.newPage();
  ctx.pageErrors = []; page.on("pageerror", (e) => ctx.pageErrors.push(String(e)));

  await runAiCreatesAndRuns(ctx);
  await runChipPauseResume(ctx);
  await runBusyChatCoalesces(ctx);
  await runStopDropsQueuedSchedule(ctx);
  await runRestartCatchUp(ctx);
  await sk.open(page, ctx.ids.A);
  await runSettingsDesktop(ctx);
  await runPhone(ctx);

  const unexpected = ctx.pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) console.log(`NOTE page errors: ${unexpected.join("\n")}`);
  if (failures.length) {
    process.exitCode = 1;
    console.log(`FAILED scenarios: ${failures.map((f) => f.scenario).join(", ")}`);
  }
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
  try { await ctx.current?.screenshot({ path: join(artifacts, "failure.png") }); } catch { /* page gone */ }
} finally {
  await browser?.close();
  await stopFixture(backend);
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${results.filter((r) => r.passed).length} passed, ${failures.length} failed in ${Math.round((Date.now() - started) / 1000)} s; artifacts in ${artifacts}`);
}
