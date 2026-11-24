// The answer buttons of three cards at the app's button standard (docs/design-guidelines.md rule 3):
// a button with text is 28px tall on a desktop and 26px on a phone, with no taller size for touch.
//   - a tool approval in a chat (Allow / Deny),
//   - a session tool's card in a chat (create a session: Allow once / … / Deny),
//   - a PPM Assistant card in the Assistant window (`CardButton`, on a "done" card; a decision goes
//     into the set of decisions, whose own buttons are `SET_BUTTON` and already at the standard).
// Each is raised for real on the disposable Assistant fixture (scripted provider, no real model, no
// real PPM data), measured in Chromium at 1440 and 390 px, and photographed.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco> PPM_BUTTON_SHOTS=<dir> node tests/e2e/button-standard-cards-e2e.mjs
//
// Playwright comes from PPM_PLAYWRIGHT_MODULE (+ _EXECUTABLE / _CHANNEL), as in the other e2e scripts.
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild, until } from "./assistant-telegram/harness.mjs";
import { loopKit } from "./assistant-manager-loop/loop-kit.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-button-standard-e2e-"));
const shotsDir = resolve(process.env.PPM_BUTTON_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppmHome = join(sandbox, "ppm-home"), home = join(sandbox, "home"), nxDir = join(sandbox, "nxsys");
await Promise.all([shotsDir, logs, ppmHome, home, nxDir].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
await writeFile(join(nxDir, "README.md"), "# project\n");

const OWNER = 1001;
const checks = [];
const measures = [];
let fake, backend, browser, web, failure = null;
const pass = (name) => { checks.push(name); console.log(`PASS ${name}`); };

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}
const onboardingDone = () => {
  if (window.top !== window) return;
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
};

/** The drawn height of every visible button inside `locator`, to a tenth of a pixel. */
const heightsIn = (locator) => locator.locator("button").evaluateAll((els) =>
  els.filter((b) => b.getClientRects().length > 0).map((b) => ({ text: b.textContent.trim().slice(0, 24), h: Math.round(b.getBoundingClientRect().height * 10) / 10 })));

try {
  const f = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: join(logs, "fake-telegram.log"), ready: /FAKE_TELEGRAM (\{.*\})/ });
  fake = f.child;
  const fakeInfo = JSON.parse((await f.ready)[1]);
  const port = await freePort();
  web = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PPM_HOME: ppmHome, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
    PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
    PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
    PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "600000",
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
  console.log(`fixture server pid=${backend.pid} port=${port}; fake telegram pid=${fake.pid}`);
  const fx = fixtureApi(web);
  await fx.post("/api/projects", { name: "Nxsys", path: nxDir });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
  });
  const tg = phone(fakeInfo.control);
  const seedCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await seedCtx.addInitScript(onboardingDone);
  const k = loopKit({ web, fx, tg, page: await seedCtx.newPage(), shotsDir, owner: OWNER, record: () => {} });

  // 1. A PPM Assistant card: a manager chat reports a finished job.
  const manager = (await fx.post("/api/project/Nxsys/chat/sessions", { providerId: "claude", title: "Manager" })).data.id;
  await k.managerTurn("Nxsys", manager, "seed", [], "Keep the plan", "default");
  await k.idle(manager);
  await fx.api("/api/assistant/managers/Nxsys", { method: "PUT", body: JSON.stringify({ sessionId: manager }) });
  await k.managerTurn("Nxsys", manager, "report", [{ session: "report_to_assistant", args: { kind: "done", title: "Hotfix merged", body: "PR 11203 merged; bun test 42 pass." } }], "Report the hotfix", "default");
  await k.answered("report", 1);
  await k.idle(manager);

  // 2. A tool approval in an ordinary chat: the turn asks to run a shell command and waits.
  const plain = (await fx.post("/api/project/Nxsys/chat/sessions", { providerId: "claude", title: "Build chat" })).data.id;
  await k.script("approve", [{ builtin: "Bash", input: { command: "bun run build" } }], { match: "Run the build", sessionId: plain });
  await k.say("Nxsys", plain, "Run the build", "default");
  await until("the tool approval is waiting", async () => (await fx.state()).pendingProviderApprovals > 0 ? true : null, 30000);

  // 3. A session tool's card in another chat: the card `create_session` raises.
  // The broker asks only a chat PPM has open, so the chat runs a turn first.
  const asker = (await fx.post("/api/project/Nxsys/chat/sessions", { providerId: "claude", title: "Planner" })).data.id;
  await k.managerTurn("Nxsys", asker, "asker-seed", [], "Plan the follow-up", "default");
  await k.idle(asker);
  await fx.post("/__assistant-test/collab-card", {
    sessionId: asker, waitMs: 600000,
    input: { kind: "create", title: "Follow-up", providerId: "claude", model: null, task: "Follow up on the export", depth: 1 },
  });
  await seedCtx.close();

  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const mobile = width < 768;
    const want = mobile ? 26 : 28;
    const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(onboardingDone);
    const page = await ctx.newPage();
    const tag = mobile ? "phone" : "desktop";
    const expectSized = async (what, locator) => {
      const hs = await heightsIn(locator);
      measures.push({ width, what, heights: hs });
      console.log(`${width} ${what}: ${JSON.stringify(hs)}`);
      assert.ok(hs.length > 0, `${width} ${what}: no button on screen`);
      for (const { text, h } of hs) assert.ok(Math.abs(h - want) < 0.6, `${width} ${what}: "${text}" is ${h}px, want ${want}px`);
      pass(`${width}: ${what} — ${hs.length} button(s), all ${want}px`);
    };

    await page.goto(`${web}/project/Nxsys/chat/claude/${plain}`);
    const approval = page.locator("[data-approval-request]:visible").first();
    await approval.waitFor({ timeout: 30000 });
    await approval.scrollIntoViewIfNeeded();
    await expectSized("tool approval (Allow / Deny)", approval);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, `${tag}-08-tool-approval.png`) });

    await page.goto(`${web}/project/Nxsys/chat/claude/${asker}`);
    const collab = page.locator("[data-collab-approval-actions]:visible").first();
    await collab.waitFor({ timeout: 30000 });
    await collab.scrollIntoViewIfNeeded();
    await expectSized("session tool card", collab);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, `${tag}-09-session-tool-card.png`) });

    await page.goto(`${web}/project/Nxsys/assistant`);
    const card = page.locator('[data-assistant-body]:visible [data-assistant-card="done"]').last();
    await card.waitFor({ timeout: 30000 });
    await card.scrollIntoViewIfNeeded();
    await expectSized("PPM Assistant card (CardButton)", card.locator("[data-card-actions]").first());
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, `${tag}-10-assistant-card.png`) });
    await ctx.close();
  }
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(`FAIL ${failure}`);
  try { for (const [i, p] of (browser?.contexts() ?? []).flatMap((c) => c.pages()).entries()) await p.screenshot({ path: join(shotsDir, `failure-${i}.png`) }); } catch { /* none */ }
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
  await writeFile(join(shotsDir, "button-standard-results.json"), JSON.stringify({ checks, measures, failure }, null, 2));
  console.log(`${checks.length} checks passed${failure ? ", then a failure" : ""}; screenshots in ${shotsDir}; logs in ${logs}`);
  process.exit(failure ? 1 : 0);
}
