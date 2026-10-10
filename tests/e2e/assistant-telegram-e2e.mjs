// PPM Assistant + Telegram, end to end: the production Vite bundle against a disposable server
// (tests/e2e/fixtures/assistant-server.ts with PPM_ASSISTANT_FAKE_TELEGRAM=1) that starts the hub
// through `startAssistantHub()` — the server's own startup — with scripted providers in place of
// Claude and Codex and a fake Telegram Bot API (tests/e2e/fixtures/fake-telegram-server.ts, a
// process of its own so it outlives a PPM restart) in place of the phone. A browser plays PPM on a
// desktop (1366×900) and a phone (390×844); the fake plays the person on Telegram.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/e2e/assistant-telegram-e2e.mjs
//
// Needs Node 22.5+, Bun, and a scratch web build (dist/web with Monaco staged — `bun run
// build:web && bun scripts/copy-monaco.ts`, or PPM_ASSISTANT_WEB_DIR). PPM_PLAYWRIGHT_CHANNEL=chrome
// runs the installed Chrome. Screenshots and one transcript of the fake Telegram chats per scenario
// go to PPM_ASSISTANT_TG_SHOTS (default: the plan's visuals/e2e); PPM_ASSISTANT_TG_ONLY=s1,s5 runs a
// subset. No real Telegram, no real model, no real PPM data: PPM_HOME and HOME are scratch folders.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { browserKit, fixtureApi, phone, startChild, transcript, until } from "./assistant-telegram/harness.mjs";
import * as sync from "./assistant-telegram/scenarios-sync.mjs";
import * as watch from "./assistant-telegram/scenarios-watch.mjs";
import * as bot from "./assistant-telegram/scenarios-bot.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-assistant-tg-e2e-"));
const shotsDir = resolve(process.env.PPM_ASSISTANT_TG_SHOTS ?? "plans/261010-2243-ppm-assistant-telegram-hub/visuals/e2e");
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const alpha = join(sandbox, "alpha"), beta = join(sandbox, "beta");
await Promise.all([shotsDir, logs, ppm, home, alpha, beta].map((p) => mkdir(p, { recursive: true })));
await writeFile(join(alpha, "README.md"), "# Alpha\n\nThe alpha project.\n");
await writeFile(join(beta, "README.md"), "# Beta\n\nBETA-README-CONTENT\n");
const ONLY = new Set((process.env.PPM_ASSISTANT_TG_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const wanted = (id) => ONLY.size === 0 || ONLY.has(id);
// A full run replaces every screenshot and transcript, so none left over from an older run is mistaken for this one's.
if (ONLY.size === 0) {
  for (const name of readdirSync(shotsDir)) {
    if (/\.png$|^telegram-.*\.txt$|^results\.json$/.test(name)) rmSync(join(shotsDir, name), { force: true });
  }
}

const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port;
  await new Promise((r) => l.close(r));
  return port;
}

// Private chats connected before the run: [chat id, user id, name]. A private chat's id is its
// user's id; 1003 is a row an older PPM wrote, with no user id.
const CHATS = {
  owner: 1001, second: 1002, noUser: 1003, phoneRun: 1005, restartDraft: 1006, restartCard: 1007,
  commands: 1008, cards: 1009, failedWake: 1010, quietWake: 1011, longTurn: 1012, codexRename: 1013,
};
const SEEDED = [
  ...Object.entries(CHATS).filter(([k]) => k !== "noUser").map(([k, id]) => [String(id), String(id), `Phone ${k}`]),
  [String(CHATS.noUser), "", "Old row"],
];

const results = [];
const failures = [];
const record = (id, viewport, name, detail = {}) => {
  results.push({ id, viewport, name, passed: true, ...detail });
  console.log(`PASS [${viewport}] ${id} ${name}`);
};

let fake, backend, browser, port, web;
const fakeLog = join(logs, "fake-telegram.log");
const serverLog = join(logs, "fixture.log");
let fixtureEnv;

async function startBackend(resume) {
  const started = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], {
    env: resume ? { ...fixtureEnv, PPM_ASSISTANT_FIXTURE_RESUME: "1" } : fixtureEnv,
    log: serverLog, ready: /Assistant fixture ready/,
  });
  backend = started.child;
  await started.ready;
}
async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((r) => backend.once("exit", r));
  await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
  const timer = setTimeout(() => backend.kill(), 5000);
  await exited;
  clearTimeout(timer);
}

try {
  const f = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: fakeLog, ready: /FAKE_TELEGRAM (\{.*\})/ });
  fake = f.child;
  const fakeInfo = JSON.parse((await f.ready)[1]);
  port = await freePort();
  web = `http://127.0.0.1:${port}`;
  fixtureEnv = {
    ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
    PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
    PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
    PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "180000",
    PPM_ASSISTANT_FAKE_TELEGRAM: "1",
    PPM_TELEGRAM_API_BASE: fakeInfo.api,
    PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: fakeInfo.token,
    PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify(SEEDED),
    PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "300",
    PPM_ASSISTANT_FIXTURE_WATCH_RETRY_MS: "3000",
    PPM_ASSISTANT_FIXTURE_WATCH_TICK_MS: "1000",
    PPM_ASSISTANT_FIXTURE_TG_DELAY_SCALE: "0.05",
  };
  delete fixtureEnv.PPM_ALLOW_PROD_DB;
  delete fixtureEnv.PPM_ASSISTANT_FIXTURE_RESUME;
  await startBackend(false);
  const fx = fixtureApi(web);
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000);
  for (const [name, path] of [["alpha", alpha], ["beta", beta]]) await fx.post("/api/projects", { name, path });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true, channel: process.env.PPM_PLAYWRIGHT_CHANNEL || undefined });
  const kit = browserKit({ web, shotsDir, browser });
  const desk = await kit.open("desktop", "desktop");
  const mobile = await kit.open("phone", "phone");

  const tg = phone(fakeInfo.control);
  const ctx = {
    web, wsBase: web.replace("http", "ws"), fx, tg, kit, shotsDir, record, CHATS, token: fakeInfo.token, fakeApi: fakeInfo.api,
    paths: { alpha, beta, serverLog },
    restart: async () => { await stopBackend(); await startBackend(true); await until("fixture back", async () => (await fetch(`${web}/api/health`)).ok, 60000); },
    stopBackend, startBackend,
    serverLogText: () => readFileSync(serverLog, "utf8"),
  };
  const state = {};
  const run = async (id, viewport, chats, fn) => {
    if (!wanted(id)) return;
    const startedAt = Date.now();
    try {
      await fn();
    } catch (error) {
      failures.push({ id, viewport, error: String(error.stack ?? error) });
      console.error(`FAIL [${viewport}] ${id} ${error.stack ?? error}`);
      for (const d of Object.values(kit.devices)) {
        try { await d.page.screenshot({ path: join(logs, `failure-${id}-${d.name}.png`) }); } catch { /* gone */ }
        try {
          const layout = await d.page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
            .filter((k) => /^ppm-(panels|window)/.test(k)).map((k) => [k, localStorage.getItem(k)])));
          await writeFile(join(logs, `failure-${id}-${d.name}-layout.json`), JSON.stringify({ url: d.page.url(), layout }, null, 1));
        } catch { /* gone */ }
      }
    } finally {
      await transcript(shotsDir, `${id}-${viewport}`, tg, chats, startedAt).catch((e) => console.error(`transcript ${id}: ${e.message}`));
    }
  };

  await run("s1", "desktop", [CHATS.owner], async () => { state.owner = await sync.s1(ctx, desk, CHATS.owner); });
  await run("s2", "desktop", [CHATS.owner], () => sync.s2(ctx, desk, CHATS.owner, state.owner));
  await run("s1", "phone", [CHATS.phoneRun], async () => { state.phoneRun = await sync.s1(ctx, mobile, CHATS.phoneRun); });
  await run("s2", "phone", [CHATS.phoneRun], () => sync.s2(ctx, mobile, CHATS.phoneRun, state.phoneRun));
  await run("s3", "telegram", [CHATS.owner], async () => { state.s3 = await sync.s3(ctx, CHATS.owner); });
  await run("s4", "desktop", [CHATS.owner], () => sync.s4(ctx, desk, CHATS.owner, state.owner));
  await run("s4", "phone", [CHATS.phoneRun], () => sync.s4(ctx, mobile, CHATS.phoneRun, state.phoneRun));
  await run("s21", "desktop+phone", [CHATS.owner], () => sync.s21(ctx, CHATS.owner, state.owner, state.phoneRun));
  for (const [id, viewport, chats, fn] of watch.plan(ctx, state, { desk, mobile })) await run(id, viewport, chats, fn);
  for (const [id, viewport, chats, fn] of bot.plan(ctx, state, { desk, mobile })) await run(id, viewport, chats, fn);

  for (const dev of Object.values(kit.devices)) {
    const unexpected = dev.errors.filter((e) => !/read the 'serviceWorker' property/.test(e));
    if (unexpected.length) failures.push({ id: "page-errors", viewport: dev.name, error: unexpected.join("\n") });
  }
} catch (error) {
  failures.push({ id: "setup", viewport: "-", error: String(error.stack ?? error) });
  console.error(`FAIL setup ${error.stack ?? error}`);
} finally {
  await browser?.close().catch(() => {});
  await stopBackend().catch(() => backend?.kill());
  if (fake && fake.exitCode === null) fake.kill();
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ results, failures }, null, 2));
  for (const f of failures) console.error(`FAILED [${f.viewport}] ${f.id}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} passed, ${failures.length} failed; screenshots and transcripts in ${shotsDir}; logs in ${logs}`);
  if (failures.length) {
    process.exitCode = 1;
  } else if (process.env.PPM_ASSISTANT_TG_KEEP !== "1") {
    // Green: the scratch PPM, its database and the logs go.
    try { rmSync(sandbox, { recursive: true, force: true }); } catch (e) { console.error(`could not remove ${sandbox}: ${e.message}`); }
  }
}
