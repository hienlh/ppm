// "Waiting on you" in the PPM Assistant, end to end on desktop and phone: two managers file
// reports, the Assistant keeps chatting so the cards drift up the stream, and the cards stay in
// reach — pinned above the stream with their count, a chip's red count landing on its project's
// card (outlined), ‹ › to the next, Reply quoting the card over the field, the manager chat
// showing its own report, and the bar and the counts gone once nothing waits.
//
// Same disposable fixture as the manager loop (tests/e2e/fixtures/assistant-server.ts with
// PPM_ASSISTANT_MANAGER_LOOP=1 and a fake Telegram): no real model, no real PPM data.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_WAITING_SHOTS=<dir> node tests/e2e/assistant-waiting-cards-e2e.mjs
//
// Playwright comes from PPM_PLAYWRIGHT_MODULE (preset in the ppm-e2e-chromium image).
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
import { step1 } from "./assistant-manager-loop/steps-managers.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-waiting-cards-e2e-"));
const shotsDir = resolve(process.env.PPM_WAITING_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const alpha = join(sandbox, "alpha"), beta = join(sandbox, "beta");
await Promise.all([shotsDir, logs, ppm, home, alpha, beta].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (name.endsWith(".png")) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);

for (const [dir, name] of [[alpha, "Alpha"], [beta, "Beta"]]) {
  await writeFile(join(dir, "README.md"), `# ${name}\n`);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");
}

const OWNER = 1001;
const DECISION = "Release 0.25.6 to npm tonight?";
const URGENT = "Staging is down after the deploy";
const checks = [];
const ok = (name) => { checks.push(name); console.log(`PASS ${name}`); };
let fake, backend, browser, web;

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

let failure = null;
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
  console.log(`fixture server pid=${backend.pid} port=${port}; fake telegram pid=${fake.pid}`);
  const fx = fixtureApi(web);
  for (const [name, path] of [["alpha", alpha], ["beta", beta]]) await fx.post("/api/projects", { name, path });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);
  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(OWNER) });
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" } }) });
  const aTitle = "Alpha lead";
  const aChat = (await fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: aTitle })).data.id;

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
  });
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await desk.addInitScript(onboardingDone);
  const page = await desk.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));

  const k = loopKit({ web, fx, tg: phone(fakeInfo.control), page, shotsDir, owner: OWNER, record: (id, name) => ok(`setup ${id}: ${name}`) });
  await k.managerTurn("alpha", aChat, "seed-alpha", [], "Keep the alpha release plan", "default");
  await k.idle(aChat);
  const s = { alpha, beta, main, aChat, aTitle };
  // Alpha's manager from the chat menu, beta's created by the Assistant: two manager chips.
  await step1(k, s);

  // Two reports that wait on the user, then the Assistant keeps talking so they drift up.
  await k.managerTurn("alpha", s.aChat, "w-decision", [{
    session: "report_to_assistant",
    args: { kind: "needs_decision", title: DECISION, body: "All tests pass; the changelog is written.", draft: { to: "npm", text: "npm publish --access public" } },
  }], "Prepare the release");
  await k.answered("w-decision", 1);
  await k.managerTurn("beta", s.bChat, "w-urgent", [{
    session: "report_to_assistant", args: { kind: "urgent", title: URGENT, body: "The health check fails since 14:02." },
  }], "Watch staging");
  await k.answered("w-urgent", 1);
  for (let i = 1; i <= 3; i++) {
    const msg = `Unrelated question number ${i}`;
    await k.askAssistant(`w-chatter-${i}`, [], msg, { reply: `Answer ${i}: nothing to do with the cards. `.repeat(6) });
    await k.idle(main);
  }
  assert.equal((await k.waiting()).total, 2);
  const open = (await fx.api("/api/assistant/cards/open")).data;
  assert.deepEqual(open.cards.map((c) => c.title).sort(), [DECISION, URGENT].sort(), "the open list is the two cards the counts are made of");
  ok("cards/open lists exactly the 2 cards the waiting count says");

  // ---- Desktop ----
  const bar = () => k.body().locator("[data-waiting-cards]");
  await page.goto(`${web}/project/alpha/assistant`);
  await bar().waitFor({ timeout: 30000 });
  assert.equal(await bar().getAttribute("data-waiting-count"), "2");
  await until("alpha chip shows 1", async () => (await k.body().locator('[data-manager-chip="alpha"] [data-manager-chip-count]').count()) === 1, 15000);
  await k.shot("01-desktop-waiting-bar-two-cards");
  ok("desktop: the bar is pinned above the stream with both cards (urgent first)");

  await k.body().locator('[data-manager-chip="alpha"] [data-manager-chip-count]').click();
  await k.body().locator("[data-waiting-card][data-highlighted]").waitFor({ timeout: 5000 });
  assert.equal(await k.body().locator("[data-waiting-card] h4").innerText(), DECISION, "the red count landed on alpha's card");
  await k.page.waitForTimeout(400); // the outline fades in over 300 ms
  await k.shot("02-desktop-red-count-pressed-lands-on-card-highlighted");
  ok("desktop: alpha's red count lands on alpha's card, outlined");

  await page.waitForTimeout(2000);
  await k.body().locator('button[aria-label="Next waiting card"]').click();
  assert.equal(await k.body().locator("[data-waiting-card] h4").innerText(), URGENT);
  await k.body().locator("[data-waiting-card][data-highlighted]").waitFor({ timeout: 5000 });
  await k.page.waitForTimeout(400); // the outline fades in over 300 ms
  await k.shot("03-desktop-next-card");
  ok("desktop: › steps to the next card, outlined");

  await k.body().locator('button[aria-label="Previous waiting card"]').click();
  await k.body().locator("[data-waiting-card]").getByRole("button", { name: "Reply" }).click();
  const quote = k.body().locator("[data-card-reply-quote]");
  await quote.waitFor({ timeout: 5000 });
  assert.match(await quote.innerText(), /Replying to card/);
  assert.match(await quote.innerText(), new RegExp(`alpha · ${DECISION.replace(/[?.]/g, "\\$&")}`));
  await k.body().locator('textarea[aria-label="Your reply to the card"]').fill("Hold it until tomorrow morning, please.");
  await k.shot("04-desktop-replying-to-card");
  await k.body().locator('button[aria-label="Stop replying to this card"]').click();
  await k.composer().waitFor({ timeout: 5000 });
  assert.equal(await quote.count(), 0);
  ok("desktop: Reply quotes the card over the field; ✕ goes back to the Assistant's composer");

  await k.body().locator('[data-manager-chip="alpha"] button').first().click();
  const mgr = page.locator("[data-manager-waiting-cards]:visible").first();
  await mgr.waitFor({ timeout: 30000 });
  assert.match(await mgr.innerText(), new RegExp(DECISION.replace(/[?.]/g, "\\$&")));
  assert.equal(await mgr.getByRole("button", { name: "Open chat" }).count(), 0, "no Open chat inside the manager chat itself");
  await k.shot("05-desktop-manager-chat-with-open-card");
  await mgr.getByRole("button", { name: "Reply" }).click();
  await mgr.locator("[data-card-reply-quote]").waitFor({ timeout: 5000 });
  await k.shot("06-desktop-manager-chat-replying-to-card");
  await mgr.locator('button[aria-label="Stop replying to this card"]').click();
  ok("desktop: the manager chat shows its own open card and answers it in place");

  // ---- Phone ----
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phoneCtx.addInitScript(onboardingDone);
  const mob = await phoneCtx.newPage();
  mob.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  const mk = loopKit({ web, fx, tg: phone(fakeInfo.control), page: mob, shotsDir, owner: OWNER, record: () => {} });
  await mob.goto(`${web}/project/alpha/assistant`);
  await mk.body().locator("[data-waiting-cards]").waitFor({ timeout: 30000 });
  await mk.shot("07-phone-waiting-bar-two-cards");
  // On a phone the bar is one row; the card opens full screen in a sheet outside the body.
  const msheet = mob.locator("[data-waiting-sheet]");
  await mk.body().locator('[data-manager-chip="alpha"] [data-manager-chip-count]').tap();
  await msheet.locator("[data-waiting-card][data-highlighted]").waitFor({ timeout: 5000 });
  assert.equal(await msheet.locator("[data-waiting-card] h4").innerText(), DECISION);
  await mk.page.waitForTimeout(400); // the outline fades in over 300 ms
  await mk.shot("08-phone-red-count-pressed-lands-on-card-highlighted");
  await mob.waitForTimeout(2000);
  await msheet.locator('button[aria-label="Next waiting card"]').tap();
  await msheet.locator("[data-waiting-card][data-highlighted]").waitFor({ timeout: 5000 });
  assert.equal(await msheet.locator("[data-waiting-card] h4").innerText(), URGENT);
  await mk.page.waitForTimeout(400); // the outline fades in over 300 ms
  await mk.shot("09-phone-next-card");
  await msheet.locator('button[aria-label="Previous waiting card"]').tap();
  await msheet.locator("[data-waiting-card]").getByRole("button", { name: "Reply" }).tap();
  // Replying moves the sheet aside; the quote sits over the Assistant's own composer.
  await mk.body().locator("[data-card-reply-quote]").waitFor({ timeout: 5000 });
  assert.equal(await msheet.count(), 0, "the sheet stepped aside for the reply");
  await mk.shot("10-phone-replying-to-card");
  await mk.body().locator('button[aria-label="Stop replying to this card"]').tap();
  ok("phone: bar, red count landing, next, Reply quote");

  await mk.body().locator('[data-manager-chip="alpha"] button').first().tap();
  const mmgr = mob.locator("[data-manager-waiting-cards]:visible").first();
  await mmgr.waitFor({ timeout: 30000 });
  await mk.shot("11-phone-manager-chat-with-open-card");
  await mmgr.locator("[data-waiting-toggle]").tap();
  await msheet.getByRole("button", { name: "Reply" }).tap();
  await msheet.locator("[data-card-reply-quote]").waitFor({ timeout: 5000 });
  await mk.shot("12-phone-manager-chat-replying-to-card");
  await msheet.locator('button[aria-label="Stop replying to this card"]').tap();
  await msheet.locator('button[aria-label="Close the waiting cards"]').tap();
  ok("phone: the manager chat shows its own open card and answers it in place");

  // ---- Nothing waits ----
  for (const c of open.cards) await fx.post(`/api/assistant/cards/${c.id}/dismiss`, {});
  assert.equal((await k.waiting()).total, 0);
  await page.goto(`${web}/project/alpha/assistant`);
  await k.body().locator('[data-manager-chip="alpha"]').waitFor({ timeout: 30000 });
  await until("desktop bar gone", async () => (await k.body().locator("[data-waiting-cards]").count()) === 0, 15000);
  assert.equal(await k.body().locator("[data-manager-chip-count]").count(), 0, "no red count left on a chip");
  await k.shot("13-desktop-nothing-waiting-no-red-count");
  await mob.goto(`${web}/project/alpha/assistant`);
  await mk.body().locator('[data-manager-chip="alpha"]').waitFor({ timeout: 30000 });
  await until("phone bar gone", async () => (await mk.body().locator("[data-waiting-cards]").count()) === 0, 15000);
  assert.equal(await mk.body().locator("[data-manager-chip-count]").count(), 0);
  await mk.shot("14-phone-nothing-waiting-no-red-count");
  ok("no card left: the bar and every red count are gone, desktop and phone");

  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) throw new Error(`page errors:\n${unexpected.join("\n")}`);
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(`FAIL ${failure}`);
  try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(shotsDir, "failure.png") }); } catch { /* none */ }
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
  console.log(`stopped fixture pid=${backend?.pid} (exit ${backend?.exitCode}), fake telegram pid=${fake?.pid}`);
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ checks, failure }, null, 2));
  console.log(`${checks.length} checks passed${failure ? ", then a failure" : ""}; screenshots in ${shotsDir}; logs in ${logs}`);
  if (failure) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
