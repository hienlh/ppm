// A chat's AskUserQuestion, shown outside the chat as the PPM Assistant's "Needs your answer" card,
// is answered with the very form the chat shows (`chat/question-card.tsx`: options, "Other",
// several choices, Submit and Skip), and in the user's own words on Telegram:
//   1. desktop 1440: a single-choice question; an option picked, then words typed in Other replace it;
//      the same question in the chat itself is photographed beside the card;
//   2. Telegram: a two-question card asked step by step: ✏️ Other then a message on question 1, a
//      tick then a reply to the card on the several-choice question 2, then Send;
//   3. phone 390: a several-choice question and a question with no choices, both typed, with the
//      chat's own form photographed beside the card;
// and each time the scripted provider is handed the answer in Claude's own shape (question text →
// the words), as an answer from the chat would be. The manager's set of decisions is photographed
// for the record. The "before" pictures in the same folder come from an earlier run on 006a79ce.
//
// Same disposable fixture as the manager loop (tests/e2e/fixtures/assistant-server.ts with
// PPM_ASSISTANT_MANAGER_LOOP=1, a fake Telegram and a scripted provider): no real model, no real
// PPM data. Run it in the capped image:
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco> PPM_Q_OTHER_SHOTS=<dir> node tests/e2e/assistant-question-other-e2e.mjs
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

const P = "after";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-q-other-e2e-"));
const shotsDir = resolve(process.env.PPM_Q_OTHER_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), repo = join(sandbox, "ppm-repo");
await Promise.all([shotsDir, logs, ppm, home, repo].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (name.startsWith(`${P}-`)) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
await writeFile(join(repo, "README.md"), "# ppm\n");
{
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");
}

const OWNER = 1001;
const CHAT = "Fix login";
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

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function telegramPage(messages) {
  const bubbles = messages.map((m) => {
    const rows = (m.reply_markup?.inline_keyboard ?? []).map((row) =>
      `<div class="row">${row.map((b) => `<span class="btn">${escapeHtml(b.text)}</span>`).join("")}</div>`).join("");
    const mine = m.fromUser ? " me" : "";
    return `<div class="msg${mine}"><div class="bubble">${escapeHtml(m.text)}</div>${rows ? `<div class="kb">${rows}</div>` : ""}</div>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#8eb8d6;font:15px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;padding:12px}
    .head{background:#517da2;color:#fff;margin:-12px -12px 12px;padding:12px 16px;font-weight:600}
    .msg{max-width:380px;margin:0 0 12px}.msg.me{margin-left:auto}.msg.me .bubble{background:#e1ffc7;border-radius:12px 12px 4px 12px}
    .bubble{background:#fff;border-radius:12px 12px 12px 4px;padding:8px 11px;white-space:pre-wrap;word-wrap:break-word;color:#000}
    .kb{margin-top:4px}.row{display:flex;gap:4px;margin-top:4px}
    .btn{flex:1;text-align:center;background:rgba(0,0,0,.28);color:#fff;border-radius:8px;padding:8px 6px;font-size:14px;font-weight:500}
    .note{font-size:11px;color:#234;margin:0 0 10px}
  </style><div class="head">PPM Assistant (bot)</div><p class="note">Fake Telegram (tests/helpers/fake-telegram-bot-api.ts): the exact text and buttons PPM sent; drawn here as Telegram would.</p>${bubbles}`;
}

const SINGLE = [{
  question: "Which approach for the login fix?", header: "Approach", multiSelect: false,
  options: [
    { label: "Patch the session check", description: "Smallest change, ships today." },
    { label: "Rewrite the auth middleware", description: "Cleaner, two days of work." },
    { label: "Add a feature flag (Recommended)", description: "Ship off by default, turn on per user." },
  ],
}];
const TWO = [
  { question: "Which environment first?", header: "Env", multiSelect: false, options: [{ label: "staging" }, { label: "production" }] },
  { question: "Who should hear about it?", header: "Notify", multiSelect: true, options: [{ label: "email" }, { label: "Slack #releases" }, { label: "nobody" }] },
];
const PHONE = [
  { question: "Which checks should run before merge?", header: "Checks", multiSelect: true, options: [{ label: "unit" }, { label: "e2e" }, { label: "lint" }] },
  { question: "What should the release note say?", header: "Note", multiSelect: false, options: [] },
];
const DECISION = {
  kind: "needs_decision",
  title: "Login fix is ready: ship it behind a flag today?",
  body: "The fix passed review. OK = merge behind a flag that starts off, and turn it on for one team first. Reply if you want it on for everyone.",
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
  console.log(`mode=${P}; fixture server pid=${backend.pid} port=${port}; fake telegram pid=${fake.pid}`);
  const fx = fixtureApi(web);
  tg = phone(fakeInfo.control);
  await fx.post("/api/projects", { name: "ppm", path: repo });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);
  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(OWNER) });
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" }, quiet_hours: { ...settings.quiet_hours, enabled: false } }) });
  const manager = (await fx.post("/api/project/ppm/chat/sessions", { providerId: "claude", title: "QL PPM" })).data.id;
  await fx.api("/api/assistant/managers/ppm", { method: "PUT", body: JSON.stringify({ sessionId: manager }) });
  // The user's own chat: its questions reach the Assistant and Telegram as "Needs your answer".
  const chat = (await fx.post("/api/project/ppm/chat/sessions", { providerId: "claude", title: CHAT })).data.id;

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
  const tgPage = await browser.newPage({ viewport: { width: 420, height: 400 } });
  const tgShot = async (name, messages) => {
    await tgPage.setContent(telegramPage(messages));
    await tgPage.screenshot({ path: join(shotsDir, `${P}-${name}.png`), fullPage: true });
  };
  /** A card drawn whole in the stream, photographed by itself (scrolled into the chat's own list). */
  const cardShot = async (pg, card, name) => {
    await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await pg.waitForTimeout(400);
    await card.screenshot({ path: join(shotsDir, `${P}-${name}.png`) });
  };
  const ask = async (label, questions, words) => {
    const before = (await k.cards()).filter((c) => c.kind === "question").length;
    await k.managerTurn("ppm", chat, label, [{ builtin: "AskUserQuestion", input: { questions } }], words, "default");
    return until(`question card ${label}`, async () => {
      const qs = (await k.cards()).filter((c) => c.kind === "question");
      return qs.length > before ? qs.find((c) => c.status === "open" && c.payload.questions?.[0]?.question === questions[0].question) : null;
    }, 30000);
  };
  const tgCopyOf = (question) => tg.waitFor(OWNER, `Telegram copy of "${question}"`, (m) => m.text.includes(question) && labelsOf(m).length > 0);
  /** The same question as the chat itself shows it, photographed in a page of its own. */
  const chatShot = async (ctx, name) => {
    const pg = await ctx.newPage();
    await pg.goto(`${web}/project/ppm?openChat=claude%2F${chat}`);
    // The chat's own panel only: the Assistant's floating window (it holds the same card) stays out of the picture.
    await pg.locator("[data-window-layer]").first().waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
    await pg.addStyleTag({ content: "[data-window-layer]{display:none!important}" });
    const form = pg.locator("[data-question-card]:visible").first();
    await form.waitFor({ timeout: 30000 });
    await pg.waitForTimeout(500);
    await form.screenshot({ path: join(shotsDir, `${P}-${name}.png`) });
    await pg.close();
  };

  // ---- 1. Desktop: a single-choice question, answered in words ----
  const single = await ask("q-single", SINGLE, "Ask which approach");
  assert.equal(single.payload.chat?.title, CHAT);
  await page.goto(`${web}/project/ppm/assistant`);
  const singleCard = k.body().locator(`[data-waiting-card="${single.id}"]`);
  await singleCard.waitFor({ timeout: 30000 });
  const singleForm = singleCard.locator("[data-question-card]");
  assert.equal(await singleForm.count(), 1, "desktop: the card holds the chat's own question form");
  await chatShot(desk, "17-desktop-chat-same-question");
  await singleForm.locator('[data-question-option="2"]').click();
  await page.screenshot({ path: join(shotsDir, `${P}-01-desktop-1440-waiting-on-you.png`) });
  await cardShot(page, singleCard, "02-desktop-single-question-card");
  const singleTg = await tgCopyOf(SINGLE[0].question);
  await tgShot("03-telegram-single-question", [singleTg]);
  assert.ok(labelsOf(singleTg).includes("✏️ Other (type it)"), `Telegram: an Other button (has ${labelsOf(singleTg).join(", ")})`);
  await singleForm.locator("[data-question-other] input").fill("Neither: patch it now, rewrite next sprint");
  assert.equal(await singleForm.locator('[data-question-option="2"]').getAttribute("aria-pressed"), "false", "typing clears the option");
  await cardShot(page, singleCard, "04-desktop-single-other-typed");
  await singleForm.locator("button", { hasText: "Submit ✓" }).click();
  {
    const [rec] = await k.answered("q-single", 1);
    assert.equal(rec.approved, true);
    assert.deepEqual(rec.answer, { [SINGLE[0].question]: "Neither: patch it now, rewrite next sprint" }, "the provider got the words, as from the chat's form");
    const edited = await tg.waitFor(OWNER, "single card answered", (m) => m.message_id === singleTg.message_id && /Answered in PPM/.test(m.text));
    assert.deepEqual(labelsOf(edited).filter((l) => l.startsWith("✏️")), []);
  }
  ok("desktop: the card holds the chat's question form; the typed words replaced the option and reached the provider as Claude's answer; the Telegram copy ended");
  await k.idle(chat);

  // ---- 2. Telegram: two questions, step by step ----
  const two = await ask("q-two", TWO, "Ask about the release");
  const twoCard = k.body().locator(`[data-waiting-card="${two.id}"]`);
  await twoCard.waitFor({ timeout: 30000 });
  assert.equal(await twoCard.locator("[data-question-card] [data-question-tab]").count(), 2, "desktop: one tab per question, as in the chat");
  await cardShot(page, twoCard, "05-desktop-two-questions-card");
  let step = await tgCopyOf(TWO[0].question);
  await tgShot("06-telegram-step-1", [step]);
  await tg.pressLabel(OWNER, step, "✏️ Other (type it)");
  const prompt = await tg.waitFor(OWNER, "the type-your-answer line", (m) => m.text.startsWith("✏️ Type your answer to: Which environment first?"));
  assert.deepEqual(labelsOf(prompt), ["Cancel"]);
  await tg.send(OWNER, "staging-2, the new cluster");
  step = await tg.waitFor(OWNER, "step 2", (m) => m.message_id === step.message_id && m.text.includes("Question 2/2"));
  {
    const sent = await tg.sent(OWNER);
    await tgShot("07-telegram-other-pressed-and-typed", [...sent.filter((m) => m.message_id === prompt.message_id), { text: "staging-2, the new cluster", fromUser: true }, ...sent.filter((m) => m.text.startsWith("Got it"))]);
  }
  assert.ok(labelsOf(step).includes("✏️ Other (type it)"), "Other on the several-choice question too");
  await tg.pressLabel(OWNER, step, "email");
  await tgShot("08-telegram-step-2-ticked", [await tg.message(OWNER, step.message_id)]);
  // A reply to the card: the words replace the tick.
  await tg.send(OWNER, "Only the on-call person", { extra: { reply_to_message: { message_id: step.message_id, chat: { id: OWNER, type: "private" }, date: Math.floor(Date.now() / 1000) } } });
  step = await tg.waitFor(OWNER, "summary", (m) => m.message_id === step.message_id && m.text.includes("Your answers"));
  assert.ok(step.text.includes("→ staging-2, the new cluster") && step.text.includes("→ Only the on-call person"), step.text);
  await tgShot("09-telegram-summary", [step]);
  await tg.pressLabel(OWNER, step, "Send");
  {
    const [rec] = await k.answered("q-two", 1);
    assert.deepEqual(rec.answer, { [TWO[0].question]: "staging-2, the new cluster", [TWO[1].question]: "Only the on-call person" });
    const done = await tg.waitFor(OWNER, "two-question card answered", (m) => m.message_id === step.message_id && /Answered here/.test(m.text));
    await tgShot("10-telegram-answered", [done]);
    await until("the PPM card is answered", async () => (await k.cards()).find((c) => c.id === two.id)?.status !== "open", 15000);
  }
  ok("Telegram: ✏️ Other then a message, a tick then a reply to the card (several-choice), Send: the provider got both typed answers; the PPM card closed");
  await k.idle(chat);

  // ---- 3. Phone 390: a several-choice question and one with no choices ----
  const phoneQ = await ask("q-phone", PHONE, "Ask about merge checks");
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phoneCtx.addInitScript(onboardingDone);
  const mob = await phoneCtx.newPage();
  mob.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  const mk = loopKit({ web, fx, tg, page: mob, shotsDir, owner: OWNER, record: () => {} });
  await chatShot(phoneCtx, "18-phone-390-chat-same-question");
  await mob.goto(`${web}/project/ppm/assistant`);
  const phoneCard = mk.body().locator(`[data-waiting-card="${phoneQ.id}"]`);
  await phoneCard.waitFor({ timeout: 30000 });
  const phoneForm = phoneCard.locator("[data-question-card]");
  assert.equal(await phoneForm.count(), 1, "phone: the card holds the chat's own question form");
  await cardShot(mob, phoneCard, "11-phone-390-question-card");
  await mob.screenshot({ path: join(shotsDir, `${P}-12-phone-390-waiting-on-you.png`) });
  const phoneTg = await tgCopyOf(PHONE[0].question);
  await tgShot("13-telegram-phone-card", [phoneTg]);
  await phoneForm.locator('[data-question-option="1"]').tap();
  await phoneForm.locator("[data-question-other] input").fill("unit and the payroll smoke test");
  await phoneForm.locator('[data-question-tab="1"]').tap();
  await phoneForm.locator("[data-question-other] input").fill("Fixes the login loop after a password reset.");
  await cardShot(mob, phoneCard, "14-phone-390-other-typed");
  await phoneForm.locator("button", { hasText: "Submit ✓" }).tap();
  {
    const [rec] = await k.answered("q-phone", 1);
    assert.deepEqual(rec.answer, { [PHONE[0].question]: "unit and the payroll smoke test", [PHONE[1].question]: "Fixes the login loop after a password reset." });
  }
  ok("phone 390: the chat's form on the card, Other on a several-choice question and alone on a no-choice question; the provider got both");
  await k.idle(chat);

  // ---- 4. The manager's set of decisions (already had Other), for the record ----
  await k.managerTurn("ppm", manager, "decision", [{ session: "report_to_assistant", args: DECISION }], "Report the decision", "default");
  await k.answered("decision", 1);
  await page.reload();
  const set = k.body().locator("[data-decision-set]");
  await set.waitFor({ timeout: 30000 });
  await cardShot(page, set, "15-desktop-decision-set");
  await mob.reload();
  const mset = mk.body().locator("[data-decision-set]");
  await mset.waitFor({ timeout: 30000 });
  await cardShot(mob, mset, "16-phone-390-decision-set");
  assert.equal(await set.locator("[data-decision-reply]").count(), 1, "the set keeps its Other");
  ok("decision set: its Other field is still there, desktop and phone");
  await phoneCtx.close();

  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) throw new Error(`page errors:\n${unexpected.join("\n")}`);
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(`FAIL ${failure}`);
  try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(shotsDir, `${P}-failure.png`) }); } catch { /* none */ }
} finally {
  try { if (tg) await writeFile(join(shotsDir, `${P}-telegram-messages.json`), JSON.stringify(await tg.sent(OWNER), null, 2)); } catch { /* fake gone */ }
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
  await writeFile(join(shotsDir, `${P}-results.json`), JSON.stringify({ mode: P, checks, failure }, null, 2));
  console.log(`${checks.length} checks passed${failure ? ", then a failure" : ""}; screenshots in ${shotsDir}; logs in ${logs}`);
  if (failure) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
