// The waiting cards with long, real content, on desktop, phone and Telegram: a 1,300-character
// plan, a review draft, an Nxsys decision and urgent report with long titles and several
// paragraphs, and a card asking four questions whose options run to two or three lines. Checks
// that a long card in the "Waiting on you" bar keeps its buttons in view, that four questions are
// answered on the card, and that a card which no longer waits folds behind "Show more"; and
// photographs each case. Content: tests/e2e/assistant-waiting-cards/long-cards.mjs.
//
// Same disposable fixture as the manager loop (no real model, no real PPM data):
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco> PPM_WAITING_SHOTS=<dir> node tests/e2e/assistant-waiting-cards-long-e2e.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild, until, labelsOf } from "./assistant-telegram/harness.mjs";
import { loopKit } from "./assistant-manager-loop/loop-kit.mjs";
import { NXSYS_DECISION, NXSYS_URGENT, PLAN, QUESTIONS, REVIEW_DRAFT } from "./assistant-waiting-cards/long-cards.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-waiting-long-e2e-"));
const shotsDir = resolve(process.env.PPM_WAITING_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppmHome = join(sandbox, "ppm-home"), home = join(sandbox, "home");
const ppmDir = join(sandbox, "ppm"), nxDir = join(sandbox, "nxsys");
await Promise.all([shotsDir, logs, ppmHome, home, ppmDir, nxDir].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (/\.(png|txt)$/.test(name)) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const dir of [ppmDir, nxDir]) {
  await writeFile(join(dir, "README.md"), "# project\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");
}

const OWNER = 1001;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`PASS ${name}`); };
let fake, backend, browser, web, failure = null;

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
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A Telegram-like bubble for one message the fake Bot API received: its text and its buttons. */
function telegramPage(messages) {
  const bubbles = messages.map((m) => {
    const rows = (m.reply_markup?.inline_keyboard ?? []).map((row) =>
      `<div class="row">${row.map((b) => `<span class="btn">${escapeHtml(b.text)}</span>`).join("")}</div>`).join("");
    return `<div class="msg"><div class="bubble">${escapeHtml(m.text)}</div>${rows ? `<div class="kb">${rows}</div>` : ""}</div>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#8eb8d6;font:15px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;padding:12px}
    .head{background:#517da2;color:#fff;margin:-12px -12px 12px;padding:12px 16px;font-weight:600}
    .msg{max-width:380px;margin:0 0 12px}
    .bubble{background:#fff;border-radius:12px 12px 12px 4px;padding:8px 11px;white-space:pre-wrap;word-wrap:break-word;color:#000}
    .kb{margin-top:4px}.row{display:flex;gap:4px;margin-top:4px}
    .btn{flex:1;text-align:center;background:rgba(0,0,0,.28);color:#fff;border-radius:8px;padding:8px 6px;font-size:14px;font-weight:500}
    .note{font-size:11px;color:#234;margin:0 0 10px}
  </style><div class="head">PPM Assistant (bot)</div><p class="note">Fake Telegram (tests/helpers/fake-telegram-bot-api.ts): the exact text and buttons PPM sent; drawn here as Telegram would.</p>${bubbles}`;
}

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
  for (const [name, path] of [["ppm", ppmDir], ["Nxsys", nxDir]]) await fx.post("/api/projects", { name, path });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);
  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(OWNER) });
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" } }) });

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
  });
  const desk = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await desk.addInitScript(onboardingDone);
  const page = await desk.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  const tg = phone(fakeInfo.control);
  const k = loopKit({ web, fx, tg, page, shotsDir, owner: OWNER, record: () => {} });

  // Each project's manager chat: one turn run, then made the manager the way the session menu does.
  const managers = {};
  for (const project of ["ppm", "Nxsys"]) {
    const id = (await fx.post(`/api/project/${project}/chat/sessions`, { providerId: "claude", title: "Quản lý" })).data.id;
    await k.managerTurn(project, id, `seed-${project}`, [], `Keep the ${project} plan`, "default");
    await k.idle(id);
    await fx.api(`/api/assistant/managers/${project}`, { method: "PUT", body: JSON.stringify({ sessionId: id }) });
    managers[project] = id;
  }

  // The long reports, then the four questions (which keep the ppm manager waiting on the user).
  const file = async (project, label, card) => {
    const { kind, title, body, draft } = card;
    await k.managerTurn(project, managers[project], label, [{ session: "report_to_assistant", args: { kind, title, body, ...(draft ? { draft } : {}) } }], `Report ${label}`, "default");
    const [r] = await k.answered(label, 1);
    assert.equal(r.isError, false, r.text);
    await k.idle(managers[project]);
  };
  await file("ppm", "r-plan", PLAN);
  await file("ppm", "r-draft", REVIEW_DRAFT);
  await file("Nxsys", "r-nx-decision", NXSYS_DECISION);
  await file("Nxsys", "r-nx-urgent", NXSYS_URGENT);
  await k.managerTurn("ppm", managers.ppm, "r-questions", [{ builtin: "AskUserQuestion", input: { questions: QUESTIONS } }], "Ask the four questions", "default");
  const question = await k.cardOf("question");
  assert.equal(question.payload.questions.length, 4);
  const cards = (await fx.api("/api/assistant/cards/open")).data.cards;
  assert.equal(cards.length, 5, "five open cards");
  const idOf = (title) => cards.find((c) => c.title === title)?.id;
  ok("5 long cards open: plan, review draft, Nxsys decision, Nxsys urgent, four questions");

  /** Steps the bar until it shows the card `id`. */
  async function show(body, id) {
    for (let i = 0; i < 8; i++) {
      if ((await body.locator("[data-waiting-card]").getAttribute("data-waiting-card")) === id) return;
      await body.locator('button[aria-label="Next waiting card"]').click();
    }
    throw new Error(`the bar never showed ${id}`);
  }
  /** The bar's slot scrolled to its end, where the sticky buttons sit over the text. */
  const scrollSlot = (body, to) => body.locator("[data-waiting-slot]").evaluate((el, t) => { el.scrollTop = t === "end" ? el.scrollHeight : 0; }, to);
  /** The whole card, unclipped by the bar's height, for reading it end to end. */
  // A phone's card is taller than its screen: the screen is made tall enough for the whole card
  // (same width, so the same phone layout), or the bottom tab bar covers its end and the part
  // past the screen comes out blank. The check below fails the run if any of it is still cut.
  async function wholeCardShot(pg, body, name) {
    const size = pg.viewportSize();
    const style = await pg.addStyleTag({ content: "[data-waiting-slot]{max-height:none!important}" });
    const card = body.locator("[data-waiting-card]");
    const height = await card.evaluate((el) => el.getBoundingClientRect().height);
    await pg.setViewportSize({ width: size.width, height: Math.max(size.height, Math.ceil(height) + 600) });
    await pg.waitForTimeout(150);
    const box = await card.boundingBox();
    const covered = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      // The card's last line must be the topmost thing there, under no tab bar or composer.
      const hit = document.elementFromPoint(x, r.bottom - 4);
      return !hit || !el.contains(hit);
    });
    assert.ok(box && box.y >= 0 && box.y + box.height <= pg.viewportSize().height && !covered, `${name}: the whole card is on screen and uncovered`);
    await card.screenshot({ path: join(shotsDir, `${name}.png`) });
    await style.evaluate((el) => el.remove());
    await pg.setViewportSize(size);
    await pg.waitForTimeout(150);
  }

  // ---- Desktop ----
  await page.goto(`${web}/project/ppm/assistant`);
  const body = k.body();
  await body.locator("[data-waiting-cards]").waitFor({ timeout: 30000 });
  assert.equal(await body.locator("[data-waiting-cards]").getAttribute("data-waiting-count"), "5");

  await show(body, idOf(PLAN.title));
  await k.shot("01-desktop-bar-long-plan-top");
  const actions = body.locator("[data-waiting-card] [data-card-actions]");
  assert.ok(await actions.isVisible(), "the buttons are in view at the top of a long card");
  const slotBox = await body.locator("[data-waiting-slot]").boundingBox();
  const actBox = await actions.boundingBox();
  assert.ok(actBox.y + actBox.height <= slotBox.y + slotBox.height + 1, "the button row sits inside the bar, not below it");
  await scrollSlot(body, "end");
  await k.shot("02-desktop-bar-long-plan-scrolled-end");
  await scrollSlot(body, "top");
  await wholeCardShot(page, body, "03-desktop-card-plan-whole");
  ok("desktop: a 1,300-character plan scrolls inside the bar with OK / Reply in view");

  await show(body, idOf(REVIEW_DRAFT.title));
  await wholeCardShot(page, body, "04-desktop-card-review-draft-whole");
  await show(body, idOf(NXSYS_DECISION.title));
  await wholeCardShot(page, body, "05-desktop-card-nxsys-long-title-whole");
  await show(body, idOf(NXSYS_URGENT.title));
  await wholeCardShot(page, body, "06-desktop-card-nxsys-urgent-whole");

  await show(body, question.id);
  const q = (n, letter) => body.locator(`[data-waiting-card] [data-card-question="q${n}"] [data-card-option="${letter}"]`);
  await q(1, "A").click();
  await q(2, "A").click();
  await k.shot("07-desktop-bar-four-questions-two-picked");
  await wholeCardShot(page, body, "08-desktop-card-four-questions-whole");
  const send = body.locator("[data-waiting-card]").getByRole("button", { name: /Send answers/ });
  assert.equal(await send.innerText(), "Send answers (2/4)");
  assert.equal(await send.isDisabled(), true);
  ok("desktop: four questions with 2–3-line options are answered on the card, sent together");

  await show(body, idOf(REVIEW_DRAFT.title));
  await body.locator("[data-waiting-card]").getByRole("button", { name: "Reply" }).click();
  await body.locator("[data-card-reply-quote]").waitFor({ timeout: 5000 });
  await body.locator('textarea[aria-label="Your reply to the card"]').fill("Đăng đi, nhưng thêm câu cảm ơn ở đầu.");
  await k.shot("09-desktop-replying-to-long-card");
  await body.locator('button[aria-label="Stop replying to this card"]').click();

  // ---- Phone ----
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phoneCtx.addInitScript(onboardingDone);
  const mob = await phoneCtx.newPage();
  mob.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  const mk = loopKit({ web, fx, tg, page: mob, shotsDir, owner: OWNER, record: () => {} });
  await mob.goto(`${web}/project/ppm/assistant`);
  const mbody = mk.body();
  await mbody.locator("[data-waiting-cards]").waitFor({ timeout: 30000 });
  await show(mbody, idOf(PLAN.title));
  await mk.shot("10-phone-bar-long-plan-top");
  await scrollSlot(mbody, "end");
  await mk.shot("11-phone-bar-long-plan-scrolled-end");
  await scrollSlot(mbody, "top");
  const mActions = await mbody.locator("[data-waiting-card] [data-card-actions] button").evaluateAll((bs) => bs.map((b) => [b.textContent.trim(), Math.round(b.getBoundingClientRect().height)]));
  for (const [label, h] of mActions) assert.ok(h >= 44, `${label} is ${h}px tall on a phone`);
  for (const label of ["Reply", "Open chat", "Dismiss"]) assert.ok(mActions.some(([l]) => l === label), `${label} is on the card on a phone (${mActions.map(([l]) => l).join(", ")})`);
  ok("phone: the long plan scrolls inside the bar; OK, Reply, Open chat and Dismiss all on the card, 44px+");
  await wholeCardShot(mob, mbody, "12-phone-card-plan-whole");
  await show(mbody, idOf(REVIEW_DRAFT.title));
  await wholeCardShot(mob, mbody, "13-phone-card-review-draft-whole");
  await show(mbody, idOf(NXSYS_DECISION.title));
  await wholeCardShot(mob, mbody, "14-phone-card-nxsys-long-title-whole");
  await show(mbody, question.id);
  await mbody.locator('[data-waiting-card] [data-card-question="q1"] [data-card-option="A"]').tap();
  await mk.shot("15-phone-bar-four-questions");
  await wholeCardShot(mob, mbody, "16-phone-card-four-questions-whole");
  await show(mbody, idOf(REVIEW_DRAFT.title));
  await mbody.locator("[data-waiting-card]").getByRole("button", { name: "Reply" }).tap();
  await mbody.locator("[data-card-reply-quote]").waitFor({ timeout: 5000 });
  await mk.shot("17-phone-replying-to-long-card");
  await mbody.locator('button[aria-label="Stop replying to this card"]').tap();

  // The manager chat with its long report.
  await mbody.locator('[data-manager-chip="Nxsys"] button').first().tap();
  const mmgr = mob.locator("[data-manager-waiting-cards]:visible").first();
  await mmgr.waitFor({ timeout: 30000 });
  await mk.shot("18-phone-manager-chat-long-cards");
  await body.locator('[data-manager-chip="Nxsys"] button').first().click();
  await page.locator("[data-manager-waiting-cards]:visible").first().waitFor({ timeout: 30000 });
  await k.shot("19-desktop-manager-chat-long-cards");

  // ---- Telegram (fake Bot API), before anything is answered ----
  const sent = await tg.sent(OWNER);
  const pick = (needle) => sent.findLast((m) => m.text.includes(needle));
  const tgShots = [
    ["22-telegram-plan", PLAN.title], ["23-telegram-review-draft", "Đăng yêu cầu sửa lên PR #89"],
    ["24-telegram-nxsys-decision", "NX-6294 · PR #11179"], ["25-telegram-nxsys-urgent", "job xuất báo cáo đêm"],
    ["26-telegram-four-questions", "3 worktree có 74 commit"],
  ];
  const tgPage = await browser.newPage({ viewport: { width: 420, height: 400 } });
  const text = [];
  for (const [name, needle] of tgShots) {
    const m = pick(needle);
    if (!m) { text.push(`## ${name}\n(no message containing ${JSON.stringify(needle)})\n`); continue; }
    await tgPage.setContent(telegramPage([m]));
    await tgPage.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
    text.push(`## ${name} (message ${m.message_id}${m.history.length ? `, edited ${m.history.length}x` : ""})\n${m.text}\n\nButtons: ${labelsOf(m).join(" | ") || "(none)"}\n`);
  }
  await writeFile(join(shotsDir, "telegram-messages.txt"), text.join("\n"));
  ok("Telegram copies drawn from the fake Bot API");

  // Answer all four questions on the card, from the desktop.
  await page.goto(`${web}/project/ppm/assistant`);
  await body.locator("[data-waiting-cards]").waitFor({ timeout: 30000 });
  await show(body, question.id);
  for (const [n, letter] of [[1, "A"], [2, "A"], [3, "B"], [4, "A"]]) await q(n, letter).click();
  await body.locator("[data-waiting-card]").getByRole("button", { name: "Send answers (4/4)" }).click();
  const [asked] = await k.answered("r-questions", 1);
  assert.equal(asked.approved, true, "the manager got its answers");
  ok("the four answers reached the manager chat");

  // A card that no longer waits folds in the stream: OK the plan, then find it there.
  await show(body, idOf(PLAN.title));
  const okButton = body.locator("[data-waiting-card]").getByRole("button", { name: "OK", exact: true });
  if (await okButton.count()) await okButton.click();
  else await body.locator("[data-waiting-card]").getByRole("button", { name: "Dismiss" }).click();
  await until("plan no longer waits", async () => (await k.cards()).find((c) => c.id === idOf(PLAN.title))?.status !== "open", 15000);
  // Fold the bar so the stream has the window's height.
  await body.locator("[data-waiting-toggle]").click();
  const done = body.locator(`[data-assistant-card="needs_decision"]:not([data-card-status="open"])`, { hasText: PLAN.title }).last();
  // Scroll only the chat's own list: Playwright's scrollIntoView also scrolls the window's
  // overflow-hidden boxes, which slides the bar over the stream.
  await done.evaluate((el) => {
    let box = el.parentElement;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
  });
  assert.equal(await done.locator("[data-card-text][data-folded]").count(), 1, "the answered plan is folded");
  await done.screenshot({ path: join(shotsDir, "20-desktop-stream-answered-plan-folded.png") });
  await done.locator("[data-card-text-toggle]").evaluate((b) => b.click());
  await done.screenshot({ path: join(shotsDir, "21-desktop-stream-answered-plan-show-more.png") });
  assert.equal(await body.locator("[data-card-actions][data-sticky]:not([data-waiting-cards] *)").count(), 0, "no card in the stream sticks its buttons");
  ok("an answered card folds behind Show more in the stream, and unfolds");

  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) throw new Error(`page errors:\n${unexpected.join("\n")}`);
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
  console.log(`stopped fixture pid=${backend?.pid} (exit ${backend?.exitCode}), fake telegram pid=${fake?.pid}`);
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ checks, failure }, null, 2));
  console.log(`${checks.length} checks passed${failure ? ", then a failure" : ""}; screenshots in ${shotsDir}; logs in ${logs}`);
  if (failure) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
