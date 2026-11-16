// Words sent from Telegram to the chat working on a task get that chat's answer back, as a reply to
// the user's own message; a turn that stops on a card says so instead of going quiet. The disposable
// server of tests/e2e/ppm-tasks-e2e.mjs (scripted chats, a fake Telegram Bot API, neutral demo data:
// projects alpha and beta), with each scene drawn as a phone screen from what the fake bot holds.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_TASKS_SHOTS=<dir> node tests/e2e/task-message-reply-e2e.mjs
//
// Runs on Node 20 in the ppm-e2e-chromium image (`--cpus=4 --memory=3g`).
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

const sandbox = await mkdtemp(join(tmpdir(), "ppm-task-reply-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs)].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const [name, dir] of Object.entries(dirs)) await writeFile(join(dir, "README.md"), `# ${name}\n`);

const OWNER = 1001;
/** The follower's grace for a turn the scripted provider does not name (Claude names its turns). */
const GRACE_MS = 3_500;
const results = [];
const failures = [];
const record = (id, name) => { results.push({ step: id, name }); console.log(`PASS ${id} ${name}`); };
let fake, backend, browser, web, kit;

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

/** The `/tasks alpha` card of `title`, paged to. */
async function cardOf(tg, title) {
  // Only a deck sent after this /tasks: an older one's buttons are gone (one deck per chat).
  const before = (await tg.sent(OWNER)).length;
  await tg.send(OWNER, "/tasks alpha");
  let deck = await until("the /tasks deck", async () => (await tg.sent(OWNER)).slice(before).findLast((m) => /What to do first/.test(m.text)), 30000);
  for (let i = 0; i < 10 && !deck.text.includes(title); i++) {
    await tg.pressLabel(OWNER, deck, "›");
    const before = deck.text;
    deck = await until("the next card", async () => {
      const m = await tg.message(OWNER, deck.message_id);
      return m.text !== before ? m : null;
    }, 15000);
  }
  assert(deck.text.includes(title), `the deck reached "${title}"`);
  return deck;
}

/** Presses "Message about this task" and types `typed`: the user's own message, as the bot sees it. */
async function writeAbout(k, title, typed) {
  const { tg } = k;
  const deck = await cardOf(tg, title);
  const shownDeck = { ...deck };
  await tg.pressLabel(OWNER, deck, "💬 Message about this task");
  const prompt = await tg.waitFor(OWNER, "the prompt", (m) => m.text.includes("Your next message goes to"), 20000);
  const pushed = await tg.send(OWNER, typed);
  const userMessageId = pushed.message?.message_id ?? pushed.update?.message?.message_id;
  assert(userMessageId, `the fake bot named the user's message: ${JSON.stringify(pushed)}`);
  return { shownDeck, prompt: { ...prompt }, userMessageId };
}

async function answered(k, s) {
  const typed = "Is the review done? Can it ship today?";
  await k.script("task-answer", [{ text: "Not yet: Mai is halfway through the review and expects to finish by **3 pm**. It can ship today if CI stays green." }], { match: typed, sessionId: s.managers.alpha });
  const { shownDeck, prompt, userMessageId } = await writeAbout(k, s.t.review.title, typed);
  await until("the manager's turn ran", async () => (await k.fx.recordsOf("task-answer")).length > 0 || (await k.messages(s.managers.alpha)).some((m) => m.text.includes(typed)), 30000);
  await k.idle(s.managers.alpha);
  await k.fx.post("/__assistant-test/clock", { advanceMs: GRACE_MS });
  const answer = await k.tg.waitFor(OWNER, "the chat's answer under the user's message", (m) => m.reply_to === userMessageId && m.text.includes("answered"), 30000);
  assert.match(answer.text, /^💬 The alpha manager chat answered, about alpha\/\d+ · Review pull request #412:/);
  assert.match(answer.text, /Mai is halfway through the review/);
  const sent = await k.tg.message(OWNER, prompt.message_id);
  const page = await k.openFrame(telegramFrame([
    { ...shownDeck, caption: "The task's card" },
    { text: "💬 Message about this task", from_user: true },
    { ...prompt, caption: "The bot says where it goes" },
    { text: typed, from_user: true },
    { ...sent, caption: "Handed to the chat" },
    { ...answer, caption: `The chat's answer, as a reply to the user's message (reply_to ${answer.reply_to})` },
  ], "PPM Assistant"));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await k.shot("01-telegram-answer-under-user-message");
  record("answer", "the manager chat's answer comes back as a reply to the user's Telegram message, naming the chat and the task");
}

async function waitingOnCard(k, s) {
  const typed = "Please pick the release date for me";
  await k.script("task-question", [
    { text: "I need one thing from you first." },
    { builtin: "AskUserQuestion", input: { questions: [{ question: "Which release date?", header: "Release", multiSelect: false, options: [{ label: "Friday" }, { label: "Monday" }] }] } },
    { text: "Release set." },
  ], { match: typed, sessionId: s.managers.alpha });
  const { shownDeck, prompt, userMessageId } = await writeAbout(k, s.t.release.title, typed);
  const waiting = await k.tg.waitFor(OWNER, "the waiting line under the user's message", (m) => m.reply_to === userMessageId && m.text.startsWith("⏳"), 30000);
  assert.match(waiting.text, /^⏳ The alpha manager chat is waiting for your answer to a question before it can answer about alpha\/\d+ · Prepare release 2\.15 for staging\./);
  assert(JSON.stringify(waiting).includes("openChat="), "the waiting line links the chat");
  const sent = await k.tg.message(OWNER, prompt.message_id);
  const page = await k.openFrame(telegramFrame([
    { ...shownDeck, caption: "The task's card" },
    { text: "💬 Message about this task", from_user: true },
    { text: typed, from_user: true },
    { ...sent, caption: "Handed to the chat" },
    { ...waiting, caption: "The chat stopped on a question: said under the user's message" },
  ], "PPM Assistant"));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await k.shot("02-telegram-waiting-on-card");
  record("waiting", "a turn that stops on a question says so under the user's message, with the chat's link");
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
  for (const [id, run] of [["answer", answered], ["waiting", waitingOnCard]]) {
    try {
      await run(kit, s);
    } catch (error) {
      failures.push({ step: id, error: String(error.stack ?? error) });
      console.error(`FAIL ${id} ${error.stack ?? error}`);
      await kit.failureShots(id);
      break;
    }
  }
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
