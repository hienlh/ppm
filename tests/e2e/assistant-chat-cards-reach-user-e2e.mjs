// A card in a chat the user opened themselves — not a manager, not watched — reaches them: the
// chat asks to open a Design chat (`create_session` with `design`), the card shows in the PPM
// Assistant's "Waiting on you" and on Telegram with its deadline, Allow on Telegram opens the
// Design chat; then a second card nobody answers expires, and Telegram is told so in one line.
//
// Same disposable fixture as the manager loop (tests/e2e/fixtures/assistant-server.ts with
// PPM_ASSISTANT_MANAGER_LOOP=1, a fake Telegram and a scripted provider): no real model, no real
// PPM data. Run it in the capped image (tests/e2e/docker/Dockerfile):
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_CHAT_CARDS_SHOTS=<dir> node tests/e2e/assistant-chat-cards-reach-user-e2e.mjs
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

const sandbox = await mkdtemp(join(tmpdir(), "ppm-chat-cards-e2e-"));
const shotsDir = resolve(process.env.PPM_CHAT_CARDS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), repo = join(sandbox, "ppm-repo");
await Promise.all([shotsDir, logs, ppm, home, repo].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (/\.(png|json)$/.test(name)) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);

const SLUG = "ppm-tasks-kho-task";
await mkdir(join(repo, "designs", SLUG), { recursive: true });
await writeFile(join(repo, "designs", SLUG, "index.html"), "<!doctype html><title>Kho task</title><h1>Kho task</h1>\n");
await writeFile(join(repo, "README.md"), "# ppm\n");
{
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");
}

const OWNER = 1001;
const KHO = "Kho task";
const HEADLINE = `Chat “${KHO}” in ppm needs your decision`;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`PASS ${name}`); };
let fake, backend, browser, web, tg;

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

const buttonsOf = (m) => (m?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text);

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
    PPM_ASSISTANT_FIXTURE_DESIGN: "1",
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
  tg = phone(fakeInfo.control);
  await fx.post("/api/projects", { name: "ppm", path: repo });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);
  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(OWNER) });
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  // No quiet hours, whatever time the run happens at: this is about the card reaching the phone.
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" }, quiet_hours: { ...settings.quiet_hours, enabled: false } }) });
  // The project has a manager (as ppm does), so its cards go to the phone in full.
  const manager = (await fx.post("/api/project/ppm/chat/sessions", { providerId: "claude", title: "QL PPM" })).data.id;
  await fx.api("/api/assistant/managers/ppm", { method: "PUT", body: JSON.stringify({ sessionId: manager }) });
  // The user's own chat: not the manager, not opened by it, not watched.
  const kho = (await fx.post("/api/project/ppm/chat/sessions", { providerId: "claude", title: KHO })).data.id;

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
  const k = loopKit({ web, fx, tg, page, shotsDir, owner: OWNER, record: () => {} });

  // ---- 1. The chat asks to open a Design chat ----
  const ask = "Make the design for the kho task";
  await k.managerTurn("ppm", kho, "kho-design", [{
    session: "create_session", args: { project: "ppm", title: "Kho task design", task: "Design the kho task screen", design: SLUG },
  }], ask, "default");
  const card = await k.cardOf("approval");
  assert.equal(card.sessionId, kho, "the card belongs to the chat that asked");
  assert.deepEqual(card.payload.chat, { title: KHO, providerId: "claude" });
  assert.ok(card.payload.expiresAt > Date.now() + 8 * 60_000, "it carries the ten-minute deadline");
  assert.equal(card.status, "open");
  assert.equal((await k.waiting()).total, 1);
  ok("the chat's create_session card is an open Assistant card, named after the chat, with its deadline");

  const tgCard = await tg.waitFor(OWNER, "the chat's card", (m) => m.text.includes(HEADLINE) && buttonsOf(m).includes("Allow"));
  assert.match(tgCard.text, /Expires in (9|10) minutes \(at \d\d:\d\d\)/, tgCard.text);
  assert.ok(tgCard.text.includes(`designs/${SLUG}`), "the card says which design");
  assert.deepEqual(buttonsOf(tgCard).filter((t) => t === "Allow" || t === "Deny"), ["Allow", "Deny"]);
  ok("Telegram: the card names the chat and project, says what it asks and when it expires, and offers Allow and Deny");

  await page.goto(`${web}/project/ppm/assistant`);
  const bar = k.body().locator("[data-waiting-cards]");
  await bar.waitFor({ timeout: 30000 });
  const waitingText = await k.body().locator("[data-waiting-card]").innerText();
  assert.match(waitingText, new RegExp(`Chat\\s+“${KHO}”\\s+in ppm wants to use`));
  assert.match(waitingText, /Expires at /);
  await k.shot("01-waiting-on-you-chat-card");
  ok("PPM: the card is in \"Waiting on you\", naming the chat, with Allow, Deny and its deadline");

  // ---- 2. Allowed on Telegram: the Design chat is opened ----
  await tg.pressLabel(OWNER, tgCard, "Allow");
  const [created] = await k.answered("kho-design", 1);
  assert.equal(created.isError, false, created.text);
  const result = k.parse(created);
  assert.equal(result.design, SLUG, "a Design chat for that design");
  assert.ok(result.sessionId, "the new chat's id");
  const after = (await k.cards()).find((c) => c.id === card.id);
  assert.equal(after.status, "resolved");
  assert.equal(after.answer?.note, "Answered on Telegram");
  const edited = await tg.waitFor(OWNER, "the card answered", (m) => m.message_id === tgCard.message_id && /Allowed here/.test(m.text));
  assert.deepEqual(buttonsOf(edited).filter((t) => t === "Allow" || t === "Deny"), []);
  await until("the bar is gone", async () => (await k.body().locator("[data-waiting-cards]").count()) === 0, 15000);
  await k.shot("02-after-allow-on-telegram-nothing-waits");
  ok(`Allow on Telegram opened the Design chat ${result.sessionId}; the Assistant card and the Telegram card both say it was answered`);
  await k.idle(kho);

  // ---- 3. A card nobody answers expires ----
  const sent = (await tg.sent(OWNER)).length;
  const raised = await fx.post("/__assistant-test/collab-card", {
    sessionId: kho, waitMs: 8000,
    input: { kind: "create", title: "Kho follow-up", providerId: "claude", model: null, task: "Follow up on the kho task", depth: 1 },
  });
  // Named as the chat is now: its provider titled it after the first message since.
  const lateCard = await tg.waitFor(OWNER, "the second card", (m) => /^🔐 Chat “.+” in ppm needs your decision/.test(m.text) && m.text.includes("Follow up on the kho task"));
  assert.match(lateCard.text, /Expires in 1 minute \(at \d\d:\d\d\)/, lateCard.text);
  await page.reload();
  await k.body().locator("[data-waiting-cards]").waitFor({ timeout: 30000 });
  await k.shot("03-second-card-waiting");
  const outcome = await until("the second card expired", async () => (await fx.api(`/__assistant-test/collab-card/${raised.requestId}`)).outcome, 30000);
  assert.equal(outcome.reason, "timeout");
  const expiredLine = await tg.waitFor(OWNER, "the expired line", (m) => m.text.startsWith("⌛ This card expired"));
  assert.equal(expiredLine.reply_to, lateCard.message_id, "said under the card it is about");
  assert.match(expiredLine.text, /Chat “.+” in ppm/, "it names the chat");
  const lateEdited = await tg.waitFor(OWNER, "the second card ended", (m) => m.message_id === lateCard.message_id && /it expired/.test(m.text));
  assert.deepEqual(buttonsOf(lateEdited).filter((t) => t === "Allow" || t === "Deny"), []);
  const lateRow = (await k.cards()).find((c) => c.payload.requestId === raised.requestId);
  assert.equal(lateRow.status, "resolved");
  assert.match(lateRow.answer.note, /^Expired/);
  await until("the bar is gone again", async () => (await k.body().locator("[data-waiting-cards]").count()) === 0, 15000);
  await k.shot("04-after-expiry-nothing-waits");
  const newMessages = (await tg.sent(OWNER)).slice(sent).filter((m) => m.text.startsWith("⌛"));
  assert.equal(newMessages.length, 1, "one line, once");
  ok("a card nobody answered: its Telegram copy loses its buttons and says it expired, one line under it says so, and \"Waiting on you\" drops it");

  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) throw new Error(`page errors:\n${unexpected.join("\n")}`);
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(`FAIL ${failure}`);
  try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(shotsDir, "failure.png") }); } catch { /* none */ }
} finally {
  try { if (tg) await writeFile(join(shotsDir, "telegram-messages.json"), JSON.stringify(await tg.sent(OWNER), null, 2)); } catch { /* fake gone */ }
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
