// Restart news for the PPM Assistant, end to end, across real process restarts of one install: the
// Assistant fixture (tests/e2e/fixtures/assistant-server.ts with PPM_ASSISTANT_MANAGER_LOOP=1 and
// PPM_ASSISTANT_RESTART_NEWS=1) is stopped with SIGKILL (a crash: no clean stop recorded) or SIGTERM
// (a clean stop) and started again on the same PPM_HOME with the PPM_START_REASON the supervisor
// would hand it. Providers are scripted; the Assistant's clock is one the e2e moves and carries
// across restarts. No real model, no real PPM data: PPM_HOME and HOME are scratch folders.
//
// Project alpha has a manager chat and a child chat the manager opened (`spawned_by`); before each
// restart the child is left mid-turn. Scenarios, in order on the state the previous left:
//   0  first start: no previous run, so no news at all (the run is still recorded)
//   a  crash (SIGKILL, no reason given): read from the run log as a crash, "did not shut down cleanly"
//   b  upgrade: clean stop, PPM_START_REASON=upgrade, previous run on an older version
//   c  watchdog: the supervisor's stop note, then SIGKILL (how every ordered stop ends on Windows),
//      PPM_START_REASON=watchdog with a detail: "stopped by PPM's supervisor", never "not cleanly"
//   d  manual: clean stop, PPM_START_REASON=manual with a detail
//      a–d: exactly one restart-news wake turn naming the reason, the version line, the steps before
//      the cut-off child under its manager; the scripted Assistant messages the manager, which
//      receives it with the provenance reason "restart" and exactly the child's id in `restartChats`
//   e  restart news switched off: no wake turn, the run log still written
//   f  quiet hours with a chat cut off: the news is urgent and goes at once, the send passes too
//   g  quiet hours, no chat cut off, two restarts: held, merged into one news, sent once quiet ends
// Then Settings → PPM Assistant → Digest & quiet hours: the switch saves restart_news both ways,
// screenshotted on a desktop (1440x900) and a phone (390x844).
//
//   PPM_ASSISTANT_WEB_DIR=<web build dir> PPM_RESTART_NEWS_SHOTS=<dir> node tests/e2e/assistant-restart-news-e2e.mjs
//
// The bundle is built into PPM_ASSISTANT_WEB_DIR first when it holds none. Runs on Node 20+.
// Playwright comes from PPM_PLAYWRIGHT_MODULE (preset with PPM_PLAYWRIGHT_EXECUTABLE in the
// ppm-e2e-chromium image). The first failure stops the run.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { restartKit } from "./assistant-restart-news/restart-kit.mjs";
import { scenarioA, scenarioB, scenarioC, scenarioD, scenarioFirstStart } from "./assistant-restart-news/steps-reasons.mjs";
import { scenarioOff, scenarioQuietUrgent, scenarioQuietMerge } from "./assistant-restart-news/steps-gates.mjs";
import { settingsScreens } from "./assistant-restart-news/steps-settings.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-restart-news-e2e-"));
const shotsDir = resolve(process.env.PPM_RESTART_NEWS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), alpha = join(sandbox, "alpha");
await Promise.all([shotsDir, logs, ppm, home, alpha].map((p) => mkdir(p, { recursive: true })));
await writeFile(join(alpha, "README.md"), "# Alpha\n");

async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log.slice(-4000)}`);
  return log;
}

const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? join(sandbox, "web"));
if (!existsSync(join(webDir, "index.html"))) {
  console.log(`building the web bundle into ${webDir}`);
  await writeFile(join(shotsDir, "vite.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir, "--emptyOutDir"]));
}
assert(existsSync(join(webDir, "index.html")), `no web bundle in ${webDir}`);

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}
const port = await freePort();
const web = `http://127.0.0.1:${port}`;
const baseEnv = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
  PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
  PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "180000",
  PPM_ASSISTANT_MANAGER_LOOP: "1", PPM_ASSISTANT_RESTART_NEWS: "1",
};
for (const key of ["PPM_ALLOW_PROD_DB", "PPM_ASSISTANT_FIXTURE_RESUME", "PPM_START_REASON", "PPM_START_DETAIL", "PPM_ASSISTANT_E2E_PREVIOUS_VERSION"]) delete baseEnv[key];

const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
const results = [];
const failures = [];
const record = (id, name) => { results.push({ step: id, name }); console.log(`PASS ${id}: ${name}`); };
const k = restartKit({ web, baseEnv, logs, record });
let browser;
const started = Date.now();
const STEPS = [
  ["0", scenarioFirstStart], ["a", scenarioA], ["b", scenarioB], ["c", scenarioC], ["d", scenarioD],
  ["e", scenarioOff], ["f", scenarioQuietUrgent], ["g", scenarioQuietMerge], ["ui", settingsScreens],
];

try {
  const s = { alpha, web, VERSION, shotsDir, cutText: "Keep working on the parser rewrite", childTitle: "Parser rewrite" };
  s.launch = async () => {
    const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
    const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
    browser = await pw.chromium.launch({
      headless: true, args: ["--disable-dev-shm-usage"],
      ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
    });
    return browser;
  };
  for (const [id, step] of STEPS) {
    try {
      await step(k, s);
    } catch (error) {
      failures.push({ step: id, error: String(error.stack ?? error) });
      console.error(`FAIL ${id}: ${error.stack ?? error}`);
      break;
    }
  }
} catch (error) {
  failures.push({ step: "setup", error: String(error.stack ?? error) });
  console.error(`FAIL setup ${error.stack ?? error}`);
} finally {
  await browser?.close().catch(() => {});
  await k.close().catch((e) => console.error(`could not stop the fixture: ${e.message}`));
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ results, failures, fixturePids: k.pids }, null, 2));
  for (const f of failures) console.error(`FAILED ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} passed, ${failures.length} failed in ${Math.round((Date.now() - started) / 1000)} s; ${k.run} fixture runs (pids ${k.pids.join(", ")}); screenshots in ${shotsDir}; logs in ${logs}`);
  if (failures.length) process.exitCode = 1;
  else if (process.env.PPM_RESTART_NEWS_KEEP !== "1") {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch (e) { console.error(`could not remove ${sandbox}: ${e.message}`); }
  }
  process.exit(process.exitCode ?? 0);
}
