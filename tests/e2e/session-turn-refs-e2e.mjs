// Cross-session turn references, end to end, on the production Vite bundle against a disposable
// API/ws server (tests/e2e/fixtures/session-turn-refs-server.ts) whose Claude and Codex providers
// read real-shaped transcripts seeded into a scratch home and script only their turns. Covers
// copying a turn link and pasting it as a chip, a chip rendered with no fetch, jumping into the
// history window and the 16 px landing held while images load, two-way window loading without a
// shift, Back to latest during a stream, another project's turn, the AI's three tools and their
// grants, the tools switch, a queued message's own turn id, editing a message with chips, a
// migrated Codex chat, a reparent while pinned, an expanded compaction keeping the numbers, and
// the phone's long press and pill. No live credentials, no real PPM data.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/e2e/session-turn-refs-e2e.mjs
//
// PPM_PLAYWRIGHT_EXECUTABLE=<chromium> or PPM_PLAYWRIGHT_CHANNEL=chrome picks the browser.
// PPM_TURN_REFS_WEB_DIR=<dir> keeps the bundle there (built on the first run, reused after);
// PPM_TURN_REFS_ARTIFACTS=<dir> keeps the screenshots and logs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createKit, pageInit } from "./fixtures/session-turn-refs-helpers.mjs";
import { runLinkSteps } from "./fixtures/session-turn-refs-steps-links.mjs";
import { runWindowSteps } from "./fixtures/session-turn-refs-steps-window.mjs";
import { runCrossSteps } from "./fixtures/session-turn-refs-steps-cross.mjs";
import { runGrantSteps } from "./fixtures/session-turn-refs-steps-grants.mjs";
import { runPhoneSteps } from "./fixtures/session-turn-refs-steps-phone.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-turn-refs-e2e-"));
const artifacts = process.env.PPM_TURN_REFS_ARTIFACTS ? resolve(process.env.PPM_TURN_REFS_ARTIFACTS) : join(sandbox, "artifacts");
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
const webDir = process.env.PPM_TURN_REFS_WEB_DIR ? resolve(process.env.PPM_TURN_REFS_WEB_DIR) : join(sandbox, "web");
if (!existsSync(join(webDir, "index.html"))) {
  await writeFile(join(artifacts, "vite.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}
if (!existsSync(join(webDir, "index.html"))) throw new Error(`No web bundle in ${webDir}`);

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
  PPM_TURN_REFS_WEB_DIR: webDir, PPM_TURN_REFS_PROJECTS: projects,
};
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/session-turn-refs-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

let browser;
const ctx = { web, artifacts, current: null };
const kit = ctx.kit = createKit({ web, artifacts, currentPage: () => ctx.current });
const { api, post, until, results, failures } = kit;
const started = Date.now();

try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 90000, 300);
  const ids = await api("/__turn-test/ids");
  await post("/api/projects", { name: "alpha", path: ids.alpha });
  await post("/api/projects", { name: "beta", path: ids.beta });
  const created = await post("/api/project/alpha/chat/sessions", { providerId: "codex", title: "New codex chat" });
  ids.X = { id: created.data.id, title: "New codex chat", project: "alpha" };
  ctx.ids = ids;

  const tab = (s, provider = "claude") => ({ id: `chat:${provider}/${s.id}`, type: "chat", title: s.title, projectId: s.project, closable: true, metadata: { projectName: s.project, sessionId: s.id, providerId: provider } });
  const panel = (id, tabs) => ({ id, tabs, activeTabId: tabs[0].id, tabHistory: tabs.map((t) => t.id) });
  /** Both chats side by side: A (and F) on the left, B (and the new Codex chat) on the right. */
  ctx.resetLayout = async (page) => {
    await api("/api/project/alpha/workspace", { method: "PUT", body: JSON.stringify({ layout: {
      panels: { left: panel("left", [tab(ids.A), tab(ids.F)]), right: panel("right", [tab(ids.B), tab(ids.X, "codex")]) },
      grid: [["left", "right"]], focusedPanelId: "right",
    } }) });
    await api("/api/project/beta/workspace", { method: "PUT", body: JSON.stringify({ layout: {
      panels: { main: panel("main", [tab(ids.D)]) }, grid: [["main"]], focusedPanelId: "main",
    } }) });
    if (!page) return;
    await page.evaluate(() => { localStorage.removeItem("ppm-panels-alpha"); localStorage.removeItem("ppm-panels-beta"); });
    await page.goto(`${web}/project/alpha`);
    await page.locator('textarea[placeholder="Ask anything..."]:visible').first().waitFor({ timeout: 30000 });
  };
  await ctx.resetLayout(null);

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  const executablePath = process.env.PPM_PLAYWRIGHT_EXECUTABLE;
  const channel = process.env.PPM_PLAYWRIGHT_CHANNEL;
  browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : channel ? { channel } : {}) });
  ctx.browser = browser;
  ctx.pageInit = pageInit;

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await desktop.addInitScript(pageInit);
  const page = ctx.current = await desktop.newPage();
  ctx.pageErrors = []; page.on("pageerror", (e) => ctx.pageErrors.push(String(e)));
  await page.goto(`${web}/project/alpha`);
  await page.locator('textarea[placeholder="Ask anything..."]:visible').first().waitFor({ timeout: 30000 });
  ctx.page = page;

  await runLinkSteps(ctx);
  await runWindowSteps(ctx);
  await runCrossSteps(ctx);
  await runGrantSteps(ctx);
  await runPhoneSteps(ctx);

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
