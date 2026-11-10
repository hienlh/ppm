// PPM Assistant over per-project manager chats, the whole loop end to end: the production Vite
// bundle against a disposable server (tests/e2e/fixtures/assistant-server.ts with
// PPM_ASSISTANT_MANAGER_LOOP=1 and PPM_ASSISTANT_FAKE_TELEGRAM=1) whose providers are scripted, a
// fake Telegram Bot API (tests/e2e/fixtures/fake-telegram-server.ts) in place of the phone, and an
// Assistant clock the script moves forward for quiet hours, the digest and the hourly budgets.
// No real model, no real Telegram, no real PPM data: PPM_HOME and HOME are scratch folders.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> node tests/e2e/assistant-manager-loop-e2e.mjs
//
// Runs on Node 20+ (no node:sqlite, no global WebSocket needed). Playwright comes from
// PPM_PLAYWRIGHT_MODULE (the ppm-e2e-chromium image presets it and PPM_PLAYWRIGHT_EXECUTABLE);
// screenshots and results.json go to PPM_MANAGER_LOOP_SHOTS. The steps run in order, each on the
// state the previous ones left, and the first failure stops the run.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild, until } from "./assistant-telegram/harness.mjs";
import { loopKit } from "./assistant-manager-loop/loop-kit.mjs";
import { step1, step2 } from "./assistant-manager-loop/steps-managers.mjs";
import { step3, step4, step5, step6 } from "./assistant-manager-loop/steps-cards.mjs";
import { step7 } from "./assistant-manager-loop/steps-rules.mjs";
import { step8, step9 } from "./assistant-manager-loop/steps-limits.mjs";
import { step10, step11 } from "./assistant-manager-loop/steps-digest-notebook.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-manager-loop-e2e-"));
const shotsDir = resolve(process.env.PPM_MANAGER_LOOP_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const alpha = join(sandbox, "alpha"), beta = join(sandbox, "beta");
await Promise.all([shotsDir, logs, ppm, home, alpha, beta].map((p) => mkdir(p, { recursive: true })));
// A run replaces every screenshot, so none left by an older run passes for this one's.
for (const name of readdirSync(shotsDir)) if (/^(\d\d-.*|failure-.*)\.png$/.test(name)) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);

/** Two projects, each a git repository with one commit, so git can say whether `.ppm/` shows. */
for (const [dir, name] of [[alpha, "Alpha"], [beta, "Beta"]]) {
  await writeFile(join(dir, "README.md"), `# ${name}\n`);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");
}

const OWNER = 1001;
const results = [];
const failures = [];
const record = (id, name, detail = {}) => { results.push({ step: id, name, ...detail }); console.log(`PASS step ${id} ${name}`); };
let fake, backend, browser, web;

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
    PPM_ASSISTANT_MANAGER_LOOP: "1",
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
  for (const [name, path] of [["alpha", alpha], ["beta", beta]]) await fx.post("/api/projects", { name, path });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);

  // The main Assistant session (the first Claude one becomes main), followed by the phone.
  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  assert.equal((await fx.api("/api/assistant/main-session")).data.main?.sessionId, main, "the first Claude Assistant session is the main one");
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(OWNER) });
  // Nothing fires at a time of its own while the clock is moved: the digest is switched on in step 10.
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" } }) });

  // A's chat, which the user makes its manager: one turn already run, in Ask mode.
  const aTitle = "Alpha lead";
  const aChat = (await fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: aTitle })).data.id;

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));

  const k = loopKit({ web, fx, tg: phone(fakeInfo.control), page, shotsDir, owner: OWNER, record });
  await k.managerTurn("alpha", aChat, "seed-alpha", [], "Keep the alpha release plan", "default");
  await k.idle(aChat);
  const s = { alpha, beta, main, aChat, aTitle };

  for (const [id, step] of [[1, step1], [2, step2], [3, step3], [4, step4], [5, step5], [6, step6], [7, step7], [8, step8], [9, step9], [10, step10], [11, step11]]) {
    try {
      await step(k, s);
    } catch (error) {
      failures.push({ step: id, error: String(error.stack ?? error) });
      console.error(`FAIL step ${id} ${error.stack ?? error}`);
      await page.screenshot({ path: join(shotsDir, `failure-step-${id}.png`) }).catch(() => {});
      break;
    }
  }
  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) failures.push({ step: "page-errors", error: unexpected.join("\n") });
} catch (error) {
  failures.push({ step: "setup", error: String(error.stack ?? error) });
  console.error(`FAIL setup ${error.stack ?? error}`);
} finally {
  await browser?.close().catch(() => {});
  if (backend && backend.exitCode === null) {
    const exited = new Promise((r) => backend.once("exit", r));
    await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
    const timer = setTimeout(() => backend.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  if (fake && fake.exitCode === null) fake.kill();
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ results, failures }, null, 2));
  for (const f of failures) console.error(`FAILED step ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} of 11 steps passed, ${failures.length} failed; screenshots in ${shotsDir}; logs in ${logs}`);
  if (failures.length) process.exitCode = 1;
  else if (process.env.PPM_MANAGER_LOOP_KEEP !== "1") {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch (e) { console.error(`could not remove ${sandbox}: ${e.message}`); }
  }
}
