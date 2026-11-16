// "Open chat" from a task carries the task into the next message, on desktop, on a phone and on
// Telegram. The production Vite bundle against the disposable server of tests/e2e/ppm-tasks-e2e.mjs
// (scripted chats, a fake Telegram Bot API), with its neutral demo data (projects alpha and beta).
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_TASKS_SHOTS=<dir> node tests/e2e/task-open-chat-ref-e2e.mjs
//
// Runs on Node 20 in the ppm-e2e-chromium image (`--cpus=4 --memory=3g`). Each step checks what it
// shows and writes a screenshot: the chip in the composer, the sent message with its chip, the
// block the AI received (drawn from what the scripted chat got), the same on a 390 px phone, and
// Telegram's "Message about this task" drawn from the fake Bot API.
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { buttonsOf, fixtureApi, phone, startChild } from "./assistant-telegram/harness.mjs";
import { tasksKit, until } from "./ppm-tasks/tasks-kit.mjs";
import { seedDemo } from "./ppm-tasks/tasks-seed.mjs";
import { telegramFrame } from "./ppm-tasks/steps-phone-telegram.mjs";
import { assertCodesOnBaseline, assertHeights, ICON_HEIGHT, TEXT_HEIGHT } from "./ppm-tasks/steps-task-codes.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-task-chat-ref-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs)].map((p) => mkdir(p, { recursive: true })));
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

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const COMPOSER = "textarea[aria-label='Message']:visible";

/** What the chat's AI got: the message as it entered the chat, drawn as a page with the task block marked. */
function aiViewFrame(text, title) {
  const at = text.indexOf("<ppm-taskref-v1>");
  const body = at < 0 ? esc(text) : `${esc(text.slice(0, at))}<mark>${esc(text.slice(at))}</mark>`;
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#11151b;color:#e6e9ee;font:14px/1.5 "Liberation Mono",monospace}
    h1{font:600 18px "Liberation Sans",Arial,sans-serif;margin:0;padding:16px 20px;background:#1a2029;border-bottom:1px solid #2a3240}
    h1 small{display:block;font-weight:400;color:#8b96a8;font-size:13px;margin-top:4px}
    pre{margin:0;padding:20px;white-space:pre-wrap;word-break:break-word}
    mark{background:#1d3a2a;color:#d6f5e1;border-left:3px solid #3fb871;display:block;padding:6px 10px;margin-top:6px}
  </style><h1>${esc(title)}<small>The message exactly as the chat's AI received it (from the scripted provider); the task block PPM's server wrote is highlighted.</small></h1><pre>${body}</pre>`;
}

/** The message that last entered `sessionId` and contains `typed`. */
const entered = (k, sessionId, typed) => until(`"${typed}" entered the chat`, async () => (await k.messages(sessionId)).findLast((m) => m.text.includes(typed)), 30000);

async function desktop(k, s) {
  const page = k.page;
  await k.selectTask(s.t.login.title);
  const block = k.detail().locator("[data-working-session]");
  await block.waitFor({ timeout: 20000 });
  await block.getByRole("button", { name: "Open chat" }).click();
  const chip = page.locator("[data-composer-task-refs] [data-task-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  assert.match(await chip.innerText(), new RegExp(`#${s.t.login.number}\\s*${s.t.login.title}`));
  assert.equal(await assertCodesOnBaseline(page, "[data-composer-task-refs]", "composer chip"), 1, "the chip's code sits on its title's baseline");
  await assertHeights(page, "[data-composer-task-refs] [data-task-chip]", TEXT_HEIGHT(false), "composer chip");
  await assertHeights(page, "[data-composer-task-refs] [data-task-chip-remove]", ICON_HEIGHT(false), "composer chip's remove button");
  await k.shot("01-desktop-chip-in-composer");

  const typed = "Is this one still blocked on QA?";
  await page.locator(COMPOSER).first().fill(typed);
  await page.locator(COMPOSER).first().press("Enter");
  const bubbleChip = page.locator("[data-user-message] [data-task-ref]:visible").first();
  await bubbleChip.waitFor({ timeout: 30000 });
  assert.match(await bubbleChip.innerText(), new RegExp(`#${s.t.login.number}\\b`));
  assert.equal(await assertCodesOnBaseline(page, "[data-user-message]", "sent chip"), 1, "the sent chip's code sits on its title's baseline");
  await assertHeights(page, "[data-user-message] [data-task-ref]", TEXT_HEIGHT(false), "sent chip");
  assert.equal(await page.locator("[data-composer-task-refs]:visible").count(), 0, "the chip left the composer");
  const msg = await entered(k, s.managers.alpha, typed);
  assert.match(msg.text, /<ppm-taskref-v1>/);
  assert(msg.text.includes(`task_id ${s.t.login.id}`), "the block names the task id");
  assert(msg.text.includes(`"${s.t.login.title}"`), "the block names the title");
  assert.match(msg.text, /status "[^"]+" · urgency Now · due none/);
  await k.shot("02-desktop-sent-with-task-chip");

  // A reload does not bring the chip back.
  await page.reload();
  await page.locator("[data-user-message] [data-task-ref]").first().waitFor({ timeout: 30000 });
  assert.equal(await page.locator("[data-composer-task-refs]").count(), 0, "no chip after a reload");

  const frame = await k.openFrame(aiViewFrame(msg.text, `What the alpha manager's AI received`));
  await k.shot("03-ai-view-of-the-block");
  await frame.close();
  k.use(k.desktop);
  record("desktop", "Open chat → chip → sent with the task's block → chip gone and not back after reload");
}

async function phoneFlow(k, s) {
  const page = await k.openPhone();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ppm:open-navigation", { detail: { tab: "tasks" } })));
  await page.locator("[data-task-list-mobile]:visible").waitFor({ timeout: 30000 });
  await page.locator("[data-task-row]").getByText(s.t.release.title).first().tap();
  const detail = page.locator("[data-task-detail-mobile]:visible");
  await detail.waitFor({ timeout: 15000 });
  const open = detail.locator("[data-working-session]").getByRole("button", { name: "Open chat" });
  await open.scrollIntoViewIfNeeded();
  await open.tap();
  const chip = page.locator("[data-composer-task-refs] [data-task-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  assert.match(await chip.innerText(), new RegExp(`#${s.t.release.number}\\b`));
  // The chip row's phone size (docs/design-guidelines.md rule 3), not a 44 px target.
  await assertHeights(page, "[data-composer-task-refs] [data-task-chip]", TEXT_HEIGHT(true), "phone composer chip");
  await assertHeights(page, "[data-composer-task-refs] [data-task-chip-remove]", ICON_HEIGHT(true), "phone composer chip's remove button");
  assert.equal(await assertCodesOnBaseline(page, "[data-composer-task-refs]", "phone composer chip"), 1);
  await k.shot("04-phone-390-chip-in-composer");

  const typed = "Can staging take this tonight?";
  await page.locator(COMPOSER).first().fill(typed);
  await page.getByRole("button", { name: /^Send/ }).first().tap();
  await page.locator("[data-user-message] [data-task-ref]:visible").first().waitFor({ timeout: 30000 });
  const msg = await entered(k, s.managers.alpha, typed);
  assert(msg.text.includes(`task_id ${s.t.release.id}`));
  await assertHeights(page, "[data-user-message] [data-task-ref]", TEXT_HEIGHT(true), "phone sent chip");
  await k.shot("05-phone-390-sent-with-task-chip");
  record("phone", "390 px: Open chat → 26 px chip (22 px remove) → sent with the task's block in a 26 px chip");
}

async function telegram(k, s) {
  const { tg, owner } = k;
  const start = (await tg.sent(owner)).length;
  await tg.send(owner, "/tasks alpha");
  let deck = await tg.waitFor(owner, "the /tasks deck", (m) => /What to do first/.test(m.text), 30000);
  for (let i = 0; i < 10 && !deck.text.includes(s.t.review.title); i++) {
    await tg.pressLabel(owner, deck, "›");
    deck = await until("the next card", async () => {
      const m = await tg.message(owner, deck.message_id);
      return m.text !== deck.text ? m : null;
    }, 15000);
  }
  assert(deck.text.includes(s.t.review.title), "the deck reached the review task");
  const shownDeck = { ...deck };
  await tg.pressLabel(owner, deck, "💬 Message about this task");
  const prompt = await tg.waitFor(owner, "the prompt", (m) => m.text.includes("Your next message goes to"), 20000);
  assert(prompt.text.includes("the alpha manager chat"));
  assert.deepEqual(buttonsOf(prompt).map((b) => b.text), ["Cancel"]);
  const shownPrompt = { ...prompt };
  const typed = "Ask Mai to review it before lunch";
  await tg.send(owner, typed);
  const done = await tg.waitFor(owner, "sent", (m) => m.message_id === prompt.message_id && m.text.startsWith("✅"), 30000);
  const msg = await entered(k, s.managers.alpha, typed);
  assert.match(msg.text, /<ppm-user-words-v1>/);
  assert(msg.text.includes(`task_id ${s.t.review.id}`));

  const page = await k.openFrame(telegramFrame([
    { text: "/tasks alpha", from_user: true },
    { ...shownDeck, caption: "The task's card" },
    { text: "💬 Message about this task", from_user: true },
    { ...shownPrompt, caption: "What the bot says next" },
    { text: typed, from_user: true },
    { ...done, caption: "Once it went" },
  ], "PPM Assistant"));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await k.shot("06-telegram-message-about-task");
  await page.setContent(aiViewFrame(msg.text, "What the alpha manager's AI received from Telegram"));
  await k.shot("07-telegram-ai-view");
  record("telegram", "Message about this task → prompt with Cancel → next words to the manager chat with user-words and task blocks", { sentBefore: start });
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
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  kit = tasksKit({ web, fx, tg: phone(fakeInfo.control), browser, shotsDir, videoDir: null, owner: OWNER, record });
  const s = await seedDemo(kit, dirs);
  await kit.openDesktop();
  for (const [id, run] of [["desktop", desktop], ["phone", phoneFlow], ["telegram", telegram]]) {
    try {
      await run(kit, s);
    } catch (error) {
      failures.push({ step: id, error: String(error.stack ?? error) });
      console.error(`FAIL ${id} ${error.stack ?? error}`);
      await kit.failureShots(id);
      break;
    }
  }
  const unexpected = kit.pageErrors().filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) failures.push({ step: "page-errors", error: unexpected.join("\n") });
} catch (error) {
  failures.push({ step: "setup", error: String(error.stack ?? error) });
  console.error(`FAIL setup ${error.stack ?? error}`);
} finally {
  await kit?.closeAll().catch(() => []);
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
  for (const f of failures) console.error(`FAILED ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} checks passed, ${failures.length} failed; screenshots in ${shotsDir}; logs in ${logs}`);
  process.exit(failures.length ? 1 : 0);
}
