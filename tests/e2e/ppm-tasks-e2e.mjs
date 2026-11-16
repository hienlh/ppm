// PPM Tasks end to end: the production Vite bundle against a disposable server
// (tests/e2e/fixtures/assistant-server.ts with PPM_ASSISTANT_MANAGER_LOOP=1, PPM_ASSISTANT_TASKS=1
// and PPM_ASSISTANT_FAKE_TELEGRAM=1) whose chats are scripted, a fake Telegram Bot API in place of
// the phone, and a clock of the handed-off work checker that the script moves. Neutral demo data
// only (projects alpha, beta and gamma); PPM_HOME and HOME are scratch folders.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> node tests/e2e/ppm-tasks-e2e.mjs
//
// Runs on Node 20 in the ppm-e2e-chromium image (`--cpus=4 --memory=3g`). Screenshots and
// results.json go to PPM_TASKS_SHOTS. With PPM_TASKS_VIDEO set to a directory the run is also the
// walkthrough video: the browser slows down, each scene opens on a caption card, and
// `ppm-tasks/video-cut.mjs` cuts the scenes out of the recordings and joins them into one mp4.
// The steps run in order, each on the state the previous ones left; the first failure stops it.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild } from "./assistant-telegram/harness.mjs";
import { tasksKit } from "./ppm-tasks/tasks-kit.mjs";
import { seedDemo } from "./ppm-tasks/tasks-seed.mjs";
import { DESKTOP_STEPS } from "./ppm-tasks/steps-desktop.mjs";
import { CHECK_STEPS } from "./ppm-tasks/steps-checks.mjs";
import { PHONE_STEPS } from "./ppm-tasks/steps-phone-telegram.mjs";
import { CODE_STEPS } from "./ppm-tasks/steps-task-codes.mjs";
import { WINDOW_STEPS } from "./ppm-tasks/steps-task-window.mjs";
import { cutVideo } from "./ppm-tasks/video-cut.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-tasks-e2e-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const videoDir = process.env.PPM_TASKS_VIDEO ? resolve(process.env.PPM_TASKS_VIDEO) : null;
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs), ...(videoDir ? [videoDir] : [])].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (/^(\d\d.*|failure-.*)\.png$/.test(name)) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const [name, dir] of Object.entries(dirs)) await writeFile(join(dir, "README.md"), `# ${name}\n`);

const OWNER = 1001;
const results = [];
const failures = [];
const record = (id, name, detail = {}) => { results.push({ step: id, name, ...detail }); console.log(`PASS ${id} ${name}`); };
let fake, backend, browser, web, kit;

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

try {
  const f = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: join(logs, "fake-telegram.log"), ready: /FAKE_TELEGRAM (\{.*\})/ });
  fake = f.child;
  const fakeInfo = JSON.parse((await f.ready)[1]);
  const port = await freePort();
  web = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
    PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
    PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
    PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "180000",
    PPM_ASSISTANT_MANAGER_LOOP: "1", PPM_ASSISTANT_TASKS: "1",
    PPM_ASSISTANT_FAKE_TELEGRAM: "1", PPM_TELEGRAM_API_BASE: fakeInfo.api, PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: fakeInfo.token,
    PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify([[String(OWNER), String(OWNER), "Phone"]]),
    PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "200", PPM_ASSISTANT_FIXTURE_TG_DELAY_SCALE: "0.05",
  };
  delete env.PPM_ALLOW_PROD_DB;
  delete env.PPM_ASSISTANT_FIXTURE_RESUME;
  const b = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], { env, log: join(logs, "fixture.log"), ready: /Assistant fixture ready/ });
  backend = b.child;
  await b.ready;
  const fx = fixtureApi(web);

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"], ...(videoDir ? { slowMo: 60 } : {}),
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  kit = tasksKit({ web, fx, tg: phone(fakeInfo.control), browser, shotsDir, videoDir, owner: OWNER, record });
  const s = await seedDemo(kit, dirs);
  await kit.openDesktop();

  // PPM_TASKS_ONLY=codes (or =window) runs the task-code (or task-window) steps alone, on the
  // seeded data (a quick re-check).
  const only = process.env.PPM_TASKS_ONLY;
  const steps = only === "codes" ? CODE_STEPS : only === "window" ? WINDOW_STEPS : [...DESKTOP_STEPS, ...CHECK_STEPS, ...PHONE_STEPS, ...CODE_STEPS, ...WINDOW_STEPS];
  for (const step of steps) {
    try {
      await step.run(kit, s);
    } catch (error) {
      failures.push({ step: step.id, error: String(error.stack ?? error) });
      console.error(`FAIL ${step.id} ${error.stack ?? error}`);
      await kit.failureShots(step.id);
      break;
    }
  }
  const unexpected = kit.pageErrors().filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) failures.push({ step: "page-errors", error: unexpected.join("\n") });
} catch (error) {
  failures.push({ step: "setup", error: String(error.stack ?? error) });
  console.error(`FAIL setup ${error.stack ?? error}`);
} finally {
  const scenes = await kit?.closeAll().catch((e) => { console.error(`closing the browser contexts: ${e.message}`); return []; });
  await browser?.close().catch(() => {});
  if (backend && backend.exitCode === null) {
    const exited = new Promise((r) => backend.once("exit", r));
    await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
    const timer = setTimeout(() => backend.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  if (fake && fake.exitCode === null) fake.kill();
  if (videoDir && scenes?.length) {
    try { await cutVideo(scenes, videoDir); } catch (e) { failures.push({ step: "video", error: String(e.stack ?? e) }); }
  }
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ results, failures }, null, 2));
  for (const f of failures) console.error(`FAILED ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} checks passed, ${failures.length} failed; screenshots in ${shotsDir}; logs in ${logs}`);
  if (failures.length) process.exitCode = 1;
  else if (process.env.PPM_TASKS_KEEP !== "1") {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch (e) { console.error(`could not remove ${sandbox}: ${e.message}`); }
  }
  process.exit(process.exitCode ?? 0);
}
