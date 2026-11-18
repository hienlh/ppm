// Ask manager on a task: the quick view (desktop popover and the phone's sheet page), the task's
// window, and Telegram's task card open the project's manager chat about the task, with the task as
// the composer chip "Task #N · title" (Telegram: the next message goes there with the task's block,
// and the answer comes back). A task the manager itself works on (not handed off) shows Ask manager
// alone, never beside an Open chat that would open the same chat; a project with no manager chat
// shows no Ask manager. The disposable server of tests/e2e/ppm-tasks-e2e.mjs (scripted chats, a fake
// Telegram Bot API, neutral demo data: alpha and beta with manager chats).
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_TASKS_SHOTS=<dir> node tests/e2e/task-ask-manager-e2e.mjs
//   PPM_ASK_MANAGER_BEFORE=1 …   the same screens on a build without the button: screenshots only
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

const BEFORE = process.env.PPM_ASK_MANAGER_BEFORE === "1";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-ask-manager-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs)].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const [name, dir] of Object.entries(dirs)) await writeFile(join(dir, "README.md"), `# ${name}\n`);

const OWNER = 1001;
/** The follower's grace for a turn the scripted provider does not name. */
const GRACE_MS = 3_500;
const ASK = "🤖 Ask manager";
const ABOUT = "💬 Message about this task";
const results = [];
const failures = [];
const record = (id, name, detail = {}) => { results.push({ step: id, name, ...detail }); console.log(`PASS ${id} ${name}`); };
let fake, backend, browser, web, kit;

/** Heights for the page's width, ±1 px: a button with text 28 / 26 (docs/design-guidelines.md rule 3). */
const TEXT = (phoneSize) => (phoneSize ? [25, 27] : [27, 29]);
const pre = (name) => (BEFORE ? `before-${name}` : `after-${name}`);

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

const box = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
async function heightOf(loc, [min, max], what) {
  await loc.waitFor({ timeout: 15000 });
  const h = Math.round((await box(loc)).height * 10) / 10;
  assert(h >= min && h <= max, `${what}: ${h}px, want ${min}–${max}`);
  return h;
}

const chatUrl = (k, s) => `${k.web}/project/alpha/chat/claude/${s.managers.alpha}`;
const rowOpen = (page, id) => page.locator(`[data-chip-task="${id}"] [data-chip-task-open]:visible`);
const peekOf = (page, id) => page.locator(`[data-task-peek-popover="${id}"]`);
const composerChip = (page, id) => page.locator(`[data-composer-task-refs] [data-task-chip="${id}"]:visible`);

async function openList(page) {
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  await chip.click();
  await page.locator("[data-chip-task]:visible").first().waitFor({ timeout: 15000 });
}

/** Every button of the quick view's footer lies inside it, and the footer does not scroll sideways. */
async function footerFits(scope, what) {
  const footer = scope.locator("[data-task-peek-footer]");
  await footer.waitFor({ timeout: 15000 });
  const fit = await footer.evaluate((el) => {
    const f = el.getBoundingClientRect();
    const out = [...el.querySelectorAll("button")].filter((b) => { const r = b.getBoundingClientRect(); return r.left < f.left - 0.5 || r.right > f.right + 0.5; });
    // A label cut to "Ask man…" fits too, and says nothing: every word must show whole.
    const cut = [...el.querySelectorAll("button span")].filter((s) => s.scrollWidth > s.clientWidth + 0.5);
    return { overflow: el.scrollWidth > el.clientWidth + 1, out: out.map((b) => b.textContent), cut: cut.map((s) => s.textContent) };
  });
  assert(!fit.overflow && fit.out.length === 0 && fit.cut.length === 0, `${what}: the footer's buttons fit, their words whole (${JSON.stringify(fit)})`);
}

/** A chat of `project`, named at creation, that the task is handed off to. */
async function handOff(k, project, task, title) {
  const chat = (await k.fx.post(`/api/project/${project}/chat/sessions`, { providerId: "claude", title })).data.id;
  const t = await k.task(task.id);
  const r = await k.patch(t.id, { revision: t.revision, workingSessionId: chat });
  assert.equal(r.ok, true, JSON.stringify(r.body));
  return chat;
}

/** The chat in front is the manager chat, with the task as its composer's chip. */
async function managerChatWithChip(page, k, s, task, what) {
  const chip = composerChip(page, task.id);
  await chip.waitFor({ timeout: 30000 });
  const label = (await chip.innerText()).replace(/\s+/g, " ");
  assert(label.includes(`#${task.number}`) && label.includes(task.title), `${what}: the chip reads "Task #${task.number} · ${task.title}" (got "${label}")`);
  await until(`${what}: the manager chat is the one open`, async () => page.url().includes(s.managers.alpha), 15000);
}

async function desktop(k, s) {
  const page = k.use(k.desktop);
  await page.goto(chatUrl(k, s));
  await openList(page);

  // Not handed off: the manager works on it, so Ask manager is its one way to a chat.
  await rowOpen(page, s.t.login.id).click();
  const loginPeek = peekOf(page, s.t.login.id);
  await loginPeek.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await k.shot(pre("01-popover-not-handed-1440"));
  if (!BEFORE) {
    assert.equal(await loginPeek.locator("[data-task-peek-chat]").count(), 0, "no Open chat for a task the manager works on");
    await heightOf(loginPeek.locator("[data-task-peek-ask-manager]"), TEXT(false), "Ask manager (not handed off)");
    await footerFits(loginPeek, "1440 not handed off");
  }

  // Handed off: Open chat for its own chat, Ask manager for the manager's.
  await rowOpen(page, s.t.copy.id).click();
  const copyPeek = peekOf(page, s.t.copy.id);
  await copyPeek.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await k.shot(pre("02-popover-handed-1440"));
  if (BEFORE) return;
  const heights = {
    openChat: await heightOf(copyPeek.locator("[data-task-peek-chat]"), TEXT(false), "Open chat (handed off)"),
    askManager: await heightOf(copyPeek.locator("[data-task-peek-ask-manager]"), TEXT(false), "Ask manager (handed off)"),
  };
  await footerFits(copyPeek, "1440 handed off");
  await copyPeek.locator("[data-task-peek-ask-manager]").click();
  await until("the quick view and the list closed for the chat", async () => (await page.locator("[data-task-peek-popover]").count()) === 0, 5000);
  await managerChatWithChip(page, k, s, s.t.copy, "1440 popover");
  await page.waitForTimeout(400);
  await k.shot(pre("03-manager-chat-with-chip-1440"));
  record("1440-popover", "not handed off: Ask manager alone; handed off: Open chat + Ask manager, both 28 px, footer fits; Ask manager opens the manager chat with the task's chip", { heights });
}

async function desktop800(k, s) {
  const page = await k.openDesktopAt(800, 900);
  await page.goto(chatUrl(k, s));
  await openList(page);
  await rowOpen(page, s.t.copy.id).click();
  const peek = peekOf(page, s.t.copy.id);
  await peek.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await k.shot(pre("04-popover-handed-800"));
  if (BEFORE) return;
  await footerFits(peek, "800 handed off");
  const width = (await box(peek)).width;
  record("800-popover", `the popover's three buttons fit its ${Math.round(width)} px footer`);
}

async function taskWindow(k, s) {
  const page = k.use(k.desktop);
  await page.goto(`${k.web}/project/alpha`);
  // Handed off: the header's Ask manager, the working-session block's Open chat.
  await k.selectTask(s.t.copy.title);
  const copyWin = page.locator('[aria-roledescription="window"]', { has: page.locator(`[data-task-detail="${s.t.copy.id}"]`) });
  await copyWin.waitFor({ timeout: 20000 });
  await page.waitForTimeout(400);
  await k.shot(pre("05-task-window-handed-1440"));
  if (!BEFORE) {
    assert.equal(await copyWin.getByRole("button", { name: "Ask manager" }).count(), 1, "one Ask manager on a handed-off task's page");
    assert.equal(await copyWin.locator("[data-working-session]").getByRole("button", { name: "Open chat" }).count(), 1, "Open chat for its own chat");
  }
  // Not handed off: Ask manager only, the block keeps no Open chat that would open the same chat.
  await k.selectTask(s.t.login.title);
  const loginWin = page.locator('[aria-roledescription="window"]', { has: page.locator(`[data-task-detail="${s.t.login.id}"]`) });
  await loginWin.waitFor({ timeout: 20000 });
  await page.waitForTimeout(400);
  await k.shot(pre("06-task-window-not-handed-1440"));
  if (BEFORE) return;
  assert.equal(await loginWin.locator("[data-working-session]").getByRole("button", { name: "Open chat" }).count(), 0, "no Open chat beside Ask manager");
  const ask = loginWin.getByRole("button", { name: "Ask manager" });
  assert.equal(await ask.count(), 1, "one Ask manager");
  await ask.click();
  await managerChatWithChip(page, k, s, s.t.login, "task window");
  await until("the task window went to the dock", async () => !(await loginWin.isVisible()), 10000);
  await k.shot(pre("07-window-ask-manager-chat-1440"));
  record("1440-window", "handed off: header Ask manager + block Open chat; not handed off: Ask manager only; it opens the manager chat with the chip and docks the window");
}

async function phoneFlow(k, s) {
  const page = await k.openPhone(390, 844);
  await page.goto(chatUrl(k, s));
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  await chip.tap();
  await page.locator("[data-chip-task]:visible").first().waitFor({ timeout: 15000 });
  await rowOpen(page, s.t.copy.id).tap();
  const sheet = page.locator(`[data-task-peek="${s.t.copy.id}"][data-task-peek-layout="sheet"]:visible`);
  await sheet.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await k.shot(pre("08-phone-sheet-handed-390"));
  if (BEFORE) return;
  const ask = sheet.locator("[data-task-peek-ask-manager]");
  const heights = {
    openChat: await heightOf(sheet.locator("[data-task-peek-chat]"), TEXT(true), "phone Open chat"),
    askManager: await heightOf(ask, TEXT(true), "phone Ask manager"),
  };
  await footerFits(sheet, "390 handed off");
  // The 26 px button answers a 44 px press: 9 px above and below it reach it.
  const reach = await ask.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const hits = [r.top - 8, r.bottom + 8].map((y) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit)); });
    return { above: hits[0], below: hits[1] };
  });
  assert(reach.above && reach.below, `Ask manager takes a press 8 px above and below it (${JSON.stringify(reach)})`);
  await ask.tap();
  await managerChatWithChip(page, k, s, s.t.copy, "phone sheet");
  await page.waitForTimeout(400);
  await k.shot(pre("09-phone-manager-chat-with-chip-390"));
  record("390-sheet", "the sheet page shows Open chat + Ask manager (26 px, a 44 px press), fits 390 px; Ask manager opens the manager chat with the chip", { heights, reach });
}

/** The `/tasks alpha` card of `title`, paged to. */
async function cardOf(tg, project, title) {
  const before = (await tg.sent(OWNER)).length;
  await tg.send(OWNER, `/tasks ${project}`);
  let deck = await until("the /tasks deck", async () => (await tg.sent(OWNER)).slice(before).findLast((m) => /What to do first/.test(m.text)), 30000);
  for (let i = 0; i < 10 && !deck.text.includes(title); i++) {
    await tg.pressLabel(OWNER, deck, "›");
    const was = deck.text;
    deck = await until("the next card", async () => {
      const m = await tg.message(OWNER, deck.message_id);
      return m.text !== was ? m : null;
    }, 15000);
  }
  assert(deck.text.includes(title), `the deck reached "${title}"`);
  return deck;
}
const rowWith = (m, label) => buttonsOf(m).map((b) => b.text).includes(label);
const wordsRow = (m) => (m.reply_markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text)).find((row) => row.some((t) => t === ASK || t === ABOUT)) ?? [];

async function telegram(k, s) {
  const { tg } = k;
  const deck = await cardOf(tg, "alpha", s.t.copy.title);
  const shownDeck = { ...deck };
  if (BEFORE) {
    const page = await k.openFrame(telegramFrame([{ text: "/tasks alpha", from_user: true }, { ...shownDeck, caption: "A handed-off task's card" }], "PPM Assistant"));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await k.shot(pre("10-telegram-card-handed"));
    return;
  }
  assert.deepEqual(wordsRow(deck), [ABOUT, ASK], "a handed-off task's card: Message about this task and Ask manager side by side");
  const typed = "Is the onboarding copy worker on track?";
  await k.script("ask-manager-answer", [{ text: "Yes: the worker has the first draft and needs **one more pass** on the welcome line." }], { match: typed, sessionId: s.managers.alpha });
  await tg.pressLabel(OWNER, deck, ASK);
  const prompt = await tg.waitFor(OWNER, "the prompt", (m) => m.text.includes("Your next message goes to"), 20000);
  assert(prompt.text.includes("the alpha manager chat"), `the prompt names the manager chat: ${prompt.text}`);
  const shownPrompt = { ...prompt };
  const pushed = await tg.send(OWNER, typed);
  const userMessageId = pushed.message?.message_id ?? pushed.update?.message?.message_id;
  const msg = await until("the words entered the manager chat", async () => (await k.messages(s.managers.alpha)).findLast((m) => m.text.includes(typed)), 30000);
  assert.match(msg.text, /<ppm-user-words-v1>/);
  assert(msg.text.includes(`task_id ${s.t.copy.id}`), "the manager gets the task's block");
  const sent = await tg.waitFor(OWNER, "sent", (m) => m.message_id === prompt.message_id && m.text.startsWith("✅"), 30000);
  await k.idle(s.managers.alpha);
  await k.fx.post("/__assistant-test/clock", { advanceMs: GRACE_MS });
  const answer = await tg.waitFor(OWNER, "the manager's answer under the user's message", (m) => m.reply_to === userMessageId && m.text.includes("answered"), 30000);
  assert.match(answer.text, /The alpha manager chat answered, about alpha\/\d+/);
  assert.match(answer.text, /one more pass/);

  // A task the manager works on shows Ask manager alone.
  const loginDeck = await cardOf(tg, "alpha", s.t.login.title);
  assert.deepEqual(wordsRow(loginDeck), [ASK], "a task not handed off: Ask manager alone");
  assert(!rowWith(loginDeck, ABOUT));

  const page = await k.openFrame(telegramFrame([
    { ...shownDeck, caption: "A handed-off task's card" },
    { text: ASK, from_user: true },
    { ...shownPrompt, caption: "The bot says the next message goes to the manager chat" },
    { text: typed, from_user: true },
    { ...sent, caption: "Sent to the manager chat" },
    { ...answer, caption: "The manager's answer, under the user's message" },
  ], "PPM Assistant"));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await k.shot(pre("10-telegram-ask-manager"));
  await page.setContent(telegramFrame([{ ...loginDeck, caption: "A task the manager works on: Ask manager alone" }], "PPM Assistant"));
  await k.shot(pre("11-telegram-card-not-handed"));
  record("telegram", "handed-off card: Message about this task + Ask manager; Ask manager → prompt names the manager chat → words reach it with the task's block → its answer comes back under the user's message; a task not handed off shows Ask manager alone");
}

async function noManager(k, s) {
  // beta loses its manager chat: nothing creates one, and no Ask manager is offered.
  const r = await k.fx.call("/api/assistant/managers/beta", { method: "DELETE" });
  assert.equal(r.ok, true, `beta's manager chat was unassigned: ${JSON.stringify(r.body)}`);
  const deck = await cardOf(k.tg, "beta", s.t.sprite.title);
  assert.deepEqual(wordsRow(deck), [ABOUT], "no manager chat: Message about this task alone");

  const page = k.use(k.desktop);
  await page.goto(`${k.web}/project/beta/task/${s.t.sprite.id}`);
  const detail = page.locator(`[data-task-detail="${s.t.sprite.id}"]:visible`).first();
  await detail.waitFor({ timeout: 30000 });
  await detail.getByText("No chat works on this task").first().waitFor({ timeout: 20000 });
  assert.equal(await detail.getByRole("button", { name: "Ask manager" }).count(), 0, "no Ask manager without a manager chat");
  await page.waitForTimeout(400);
  await k.shot(pre("12-no-manager-task-1440"));
  const managers = (await k.fx.api("/api/assistant/managers")).data ?? (await k.fx.api("/api/assistant/managers"));
  const list = Array.isArray(managers) ? managers : managers.managers ?? [];
  assert(!list.some((m) => m.projectName === "beta"), "no manager chat was created for beta");
  record("no-manager", "a project with no manager chat: no Ask manager on the task page, Telegram keeps Message about this task, nothing creates a manager chat");
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
  await handOff(kit, "alpha", s.t.copy, "Onboarding copy worker");
  await kit.openDesktop();
  const steps = [["1440-popover", desktop], ["800-popover", desktop800], ["1440-window", taskWindow], ["390-sheet", phoneFlow], ["telegram", telegram], ...(BEFORE ? [] : [["no-manager", noManager]])];
  for (const [id, run] of steps) {
    try {
      await run(kit, s);
      if (BEFORE) record(id, "screenshots only");
    } catch (error) {
      failures.push({ step: id, error: String(error.stack ?? error) });
      console.error(`FAIL ${id} ${error.stack ?? error}`);
      await kit.failureShots(id);
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
  await writeFile(join(shotsDir, BEFORE ? "results-before.json" : "results.json"), JSON.stringify({ results, failures }, null, 2));
  for (const f of failures) console.error(`FAILED ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} checks passed, ${failures.length} failed; screenshots in ${shotsDir}; logs in ${logs}`);
  process.exit(failures.length ? 1 : 0);
}
