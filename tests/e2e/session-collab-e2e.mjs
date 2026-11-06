// Session collaboration, end to end, on the production Vite bundle against a disposable API/ws
// server (tests/e2e/fixtures/session-collab-server.ts) whose Claude and Codex providers are scripted
// and call the real `ppm-sessions` tools (`/api/sessions-mcp`) with the token each turn is handed.
// Covers creating a session behind the card, the child's from-session bubble and turn link, a
// waited reply, a message inserted into a running turn, the pair limit, depth and running limits,
// Stop and Stop all child sessions, Codex and Claude creating each other, the Settings switches
// (each checked in a chat started after the change), the phone, and which notifications are sent.
// No live credentials, no real PPM data.
//
// Run it in the capped e2e image (Chromium, Node 20 and playwright-core; see tests/e2e/docker/):
//
//   docker build -t ppm-e2e-chromium:latest tests/e2e/docker
//   docker run --rm --cpus=4 --memory=6g -v <repo>:/app:ro -v ppm-e2e-nm:/app/node_modules \
//     -v <out>:/out -v <scratch-web>:/web -w /app -e IS_SANDBOX=1 \
//     -e PPM_COLLAB_ARTIFACTS=/out -e PPM_COLLAB_WEB_DIR=/web ppm-e2e-chromium:latest \
//     sh -c 'bun install --frozen-lockfile && node tests/e2e/session-collab-e2e.mjs'
//
// From PowerShell keep the `sh -c` body free of double quotes (PowerShell 5.1 strips them), or
// mount a script and run that. Outside Docker:
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/e2e/session-collab-e2e.mjs
// PPM_PLAYWRIGHT_EXECUTABLE=<chromium> or PPM_PLAYWRIGHT_CHANNEL=chrome picks the browser.
// PPM_COLLAB_WEB_DIR=<dir> keeps the bundle there (built on the first run, reused after);
// PPM_COLLAB_ARTIFACTS=<dir> keeps the screenshots and logs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createKit, pageInit } from "./fixtures/session-turn-refs-helpers.mjs";
import { collabKit } from "./fixtures/session-collab-helpers.mjs";
import { runCreateSteps } from "./fixtures/session-collab-steps-create.mjs";
import { runLimitSteps } from "./fixtures/session-collab-steps-limits.mjs";
import { runSettingsSteps } from "./fixtures/session-collab-steps-settings.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-collab-e2e-"));
const artifacts = process.env.PPM_COLLAB_ARTIFACTS ? resolve(process.env.PPM_COLLAB_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), projects = join(sandbox, "projects");
await Promise.all([artifacts, ppm, home, projects].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

// A named bundle directory is built into on the first run and reused after that.
const webDir = process.env.PPM_COLLAB_WEB_DIR ? resolve(process.env.PPM_COLLAB_WEB_DIR) : join(sandbox, "web");
if (!existsSync(join(webDir, "index.html"))) {
  await writeFile(join(artifacts, "vite.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}
if (!existsSync(join(webDir, "index.html"))) throw new Error(`No web bundle in ${webDir}`);

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
  PPM_COLLAB_WEB_DIR: webDir, PPM_COLLAB_PROJECTS: projects,
};
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/session-collab-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

let browser;
const ctx = { web, artifacts, current: null, ids: {} };
const kit = ctx.kit = createKit({ web, artifacts, currentPage: () => ctx.current });
const ck = ctx.ck = collabKit(kit, web);
const { until, results, failures } = kit;
const started = Date.now();

try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 90000, 300);
  const { alpha } = await ck.route("/project");
  await kit.post("/api/projects", { name: "alpha", path: alpha });
  ctx.ids.A = await ck.newSession("claude", "Planner");
  ctx.ids.C = await ck.newSession("claude", "Release notes");
  ctx.ids.D = await ck.newSession("claude", "Reviewer");
  ctx.ids.X = await ck.newSession("codex", "Codex lead");

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  const executablePath = process.env.PPM_PLAYWRIGHT_EXECUTABLE;
  const channel = process.env.PPM_PLAYWRIGHT_CHANNEL;
  browser = ctx.browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : channel ? { channel } : {}) });
  ctx.pageInit = pageInit;

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await desktop.addInitScript(pageInit);
  const page = ctx.page = ctx.current = await desktop.newPage();
  ctx.pageErrors = []; page.on("pageerror", (e) => ctx.pageErrors.push(String(e)));
  await page.goto(`${web}/project/alpha`);

  await runCreateSteps(ctx);
  await runLimitSteps(ctx);
  await runSettingsSteps(ctx);

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
  backend.kill();
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${results.filter((r) => r.passed).length} passed, ${failures.length} failed in ${Math.round((Date.now() - started) / 1000)} s; artifacts in ${artifacts}`);
}
