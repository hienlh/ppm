// A manager's card offering three choices (`options` on report_to_assistant), on desktop, phone
// and Telegram: in the decision set, one tile per choice in place of OK, stacked and at least 44 px
// tall, answered with Send this one; on Telegram one inline button per choice, each its own row. A
// press on Telegram and one in PPM each reach the manager chat as the user's words naming the
// choice, the card says which choice was made, and the Telegram copy loses its buttons. A card that
// writes its choices as text gets no button and the manager is told to use `options`. Photographs
// each step.
//
// Same disposable fixture as the manager loop (no real model, no real PPM data):
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco> PPM_CARD_OPTIONS_SHOTS=<dir> node tests/e2e/assistant-card-options-e2e.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild, until, labelsOf } from "./assistant-telegram/harness.mjs";
import { loopKit } from "./assistant-manager-loop/loop-kit.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-card-options-e2e-"));
const shotsDir = resolve(process.env.PPM_CARD_OPTIONS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppmHome = join(sandbox, "ppm-home"), home = join(sandbox, "home"), nxDir = join(sandbox, "nxsys");
await Promise.all([shotsDir, logs, ppmHome, home, nxDir].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (/^\d\d-|^results|^telegram-/.test(name)) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
await writeFile(join(nxDir, "README.md"), "# project\n");
const git = (...args) => execFileSync("git", args, { cwd: nxDir, stdio: "pipe" });
git("init", "-q");
git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");

/** Written for this test: a ticket id and a PR, no client, payroll or tax details. */
const SHIP = {
  kind: "needs_decision",
  title: "NX-6402: export fix is ready — how do we ship it?",
  body: [
    "The **nightly export** fix is in PR #4120: CI green, one approval.",
    "- Staging still runs last week's build.",
    "- The second reviewer is out until Monday.",
  ].join("\n"),
  options: [
    { id: "merge-now", label: "Merge and deploy to staging now", description: "Merge PR #4120 into develop today and post in the ticket." },
    { id: "staging-first", label: "Test on staging first", description: "Deploy the branch to staging, run the export once, then merge." },
    { id: "hold", label: "Hold until Monday", description: "Wait for the second review; nothing changes before then." },
  ],
};
const FREEZE = {
  kind: "needs_decision",
  title: "NX-6410: release freeze starts Friday — which tickets go in?",
  body: "Two tickets are ready; the freeze leaves room for one more deploy.",
  options: [
    { id: "both", label: "Ship both tickets", description: "One deploy Thursday with NX-6398 and NX-6405." },
    { id: "one", label: "Ship NX-6398 only", description: "Keep NX-6405 for after the freeze." },
    { id: "none", label: "Ship nothing", description: "Both wait until the freeze ends." },
  ],
};
const IN_TEXT = {
  kind: "needs_decision",
  title: "NX-6415: pick a fix",
  body: "Two ways to fix it: (1) patch the query, (2) rebuild the index tonight.",
};

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

/** A Telegram-like bubble for one message the fake Bot API received, with its keyboard. */
function telegramPage(messages) {
  const bubble = (m) => {
    const rows = (m.reply_markup?.inline_keyboard ?? []).map((row) =>
      `<div class="row">${row.map((b) => `<span class="btn">${escapeHtml(b.text)}${b.url ? " ↗" : ""}</span>`).join("")}</div>`).join("");
    return `<div class="msg"><div class="bubble">${m.html ?? escapeHtml(m.text)}</div>${rows ? `<div class="kb">${rows}</div>` : ""}</div>`;
  };
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#8eb8d6;font:15px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;padding:12px}
    .head{background:#517da2;color:#fff;margin:-12px -12px 12px;padding:12px 16px;font-weight:600}
    .msg{max-width:380px;margin:0 0 12px}
    .bubble{background:#fff;border-radius:12px 12px 12px 4px;padding:8px 11px;white-space:pre-wrap;word-wrap:break-word;color:#000}
    .bubble code{font-family:ui-monospace,Menlo,Consolas,monospace;color:#c0392b;font-size:13px}
    .kb{margin-top:4px}.row{display:flex;gap:4px;margin-top:4px}
    .btn{flex:1;text-align:center;background:rgba(0,0,0,.28);color:#fff;border-radius:8px;padding:8px 6px;font-size:14px;font-weight:500}
    .note{font-size:11px;color:#234;margin:0 0 10px}
  </style><div class="head">PPM Assistant (bot)</div><p class="note">Fake Telegram (tests/helpers/fake-telegram-bot-api.ts): the HTML and buttons PPM sent, drawn as Telegram would.</p>${messages.map(bubble).join("")}`;
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
  const fixtureLog = join(logs, "fixture.log");
  const b = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], { env, log: fixtureLog, ready: /Assistant fixture ready/ });
  backend = b.child;
  await b.ready;
  console.log(`fixture server pid=${backend.pid} port=${port}; fake telegram pid=${fake.pid}`);
  const fx = fixtureApi(web);
  await fx.post("/api/projects", { name: "Nxsys", path: nxDir });
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

  const manager = (await fx.post("/api/project/Nxsys/chat/sessions", { providerId: "claude", title: "Quản lý" })).data.id;
  await k.managerTurn("Nxsys", manager, "seed", [], "Keep the plan", "default");
  await k.idle(manager);
  await fx.api("/api/assistant/managers/Nxsys", { method: "PUT", body: JSON.stringify({ sessionId: manager }) });
  await fx.api("/api/assistant/managers/Nxsys", { method: "PATCH", body: JSON.stringify({ telegramDetail: "full" }) });

  /** Files one report from the manager chat and answers the card it made. */
  async function report(label, args) {
    await k.managerTurn("Nxsys", manager, label, [{ session: "report_to_assistant", args }], `Report ${label}`, "default");
    const [r] = await k.answered(label, 1);
    assert.equal(r.isError, false, r.text);
    await k.idle(manager);
    return r;
  }

  // ---- A card whose choices are written as text: no button, and the manager is told ----
  const inText = await report("r-text", IN_TEXT);
  assert.match(inText.text, /lists choices in its text/, "the manager is told to use options");
  await until("the warning is in the log", async () => readFileSync(fixtureLog, "utf8").includes("lists choices in its text without `options`"), 10000);
  const textCard = (await k.cards()).find((c) => c.title === IN_TEXT.title);
  assert.equal(textCard.payload.options, undefined, "no choice was built from the text");
  const textCopy = await tg.waitText(OWNER, "NX-6415");
  assert.deepEqual(labelsOf(textCopy).filter((l) => /^\d\. /.test(l)), [], "no choice button on Telegram");
  await fx.api(`/api/assistant/cards/${textCard.id}/dismiss`, { method: "POST" });
  ok("choices written as text: no button anywhere, the manager is told to use options, and PPM logs a warning");

  // ---- The card with three choices ----
  await report("r-ship", SHIP);
  const ship = (await fx.api("/api/assistant/cards/open")).data.cards.find((c) => c.title === SHIP.title);
  assert.ok(ship, "the card is open");
  assert.equal(ship.okOffered, true, "its choices can be pressed");
  assert.deepEqual(ship.payload.options.map((o) => o.id), ["merge-now", "staging-first", "hold"]);
  ok("a card with three choices is open, offered whole");

  /** The whole card copied onto a layer and photographed, as in the long-cards e2e. */
  async function wholeCardShot(pg, scope, name) {
    const size = pg.viewportSize();
    const height = await scope.locator("[data-decision-set]").first().evaluate((el) => {
      const layer = document.createElement("div");
      layer.id = "e2e-whole-card";
      Object.assign(layer.style, {
        position: "fixed", left: "0", top: "72px", zIndex: "2147483647", padding: "12px",
        width: `${el.getBoundingClientRect().width + 24}px`, boxSizing: "border-box",
        background: getComputedStyle(document.body).backgroundColor,
      });
      layer.appendChild(el.cloneNode(true));
      document.body.appendChild(layer);
      return layer.getBoundingClientRect().bottom;
    });
    if (height > size.height) await pg.setViewportSize({ width: size.width, height: Math.ceil(height) + 24 });
    await pg.waitForTimeout(150);
    const layer = pg.locator("#e2e-whole-card");
    await layer.locator(":scope > *").screenshot({ path: join(shotsDir, `${name}.png`) });
    await layer.evaluate((el) => el.remove());
    if (height > size.height) await pg.setViewportSize(size);
  }
  /** The shown card's answer tiles as laid out: label, box, and whether they can be pressed. */
  const choiceBoxes = (scope) => scope.locator("[data-decision-set] [data-question-option]").evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      label: el.querySelector("span.font-medium")?.textContent ?? "",
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      disabled: el.getAttribute("aria-disabled") === "true",
    };
  }));
  /** A card's own answer area inside the set (only the shown tab's card is drawn). */
  const shown = (scope, card) => scope.locator(`[data-decision-set] [data-decision-card="${card.id}"]`);
  const SHIP_LABELS = SHIP.options.map((o) => o.label);
  const assertStacked = (boxes, where) => {
    assert.deepEqual(boxes.map((b) => b.label), SHIP_LABELS, `${where}: one tile per choice, in order`);
    for (const b of boxes) {
      assert.ok(b.h >= 44, `${where}: "${b.label}" is ${b.h}px tall`);
      assert.equal(b.disabled, false, `${where}: "${b.label}" can be pressed`);
    }
    for (let i = 1; i < boxes.length; i++) {
      assert.equal(boxes[i].x, boxes[0].x, `${where}: stacked in one column`);
      assert.ok(boxes[i].y >= boxes[i - 1].y + boxes[i - 1].h, `${where}: "${boxes[i].label}" sits below "${boxes[i - 1].label}"`);
    }
  };

  // ---- Desktop ----
  await page.goto(`${web}/project/Nxsys/assistant`);
  const body = k.body();
  await body.locator("[data-waiting-dock]").waitFor({ timeout: 30000 });
  await shown(body, ship).locator("[data-question-option]").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotsDir, "01-desktop-assistant.png") });
  await wholeCardShot(page, body, "02-desktop-card-three-choices");
  const deskBoxes = await choiceBoxes(body);
  assertStacked(deskBoxes, "desktop");
  assert.ok(!deskBoxes.some((b) => /^OK\b/.test(b.label)), "desktop: no OK tile");
  assert.equal(await body.locator("[data-decision-set] [data-decision-reply]").count(), 1, "desktop: the Other answer is kept");
  ok("desktop: three stacked choice tiles, each at least 44 px, no OK, the Other answer kept");

  // ---- Phone ----
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phoneCtx.addInitScript(onboardingDone);
  const mob = await phoneCtx.newPage();
  mob.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  const mk = loopKit({ web, fx, tg, page: mob, shotsDir, owner: OWNER, record: () => {} });
  await mob.goto(`${web}/project/Nxsys/assistant`);
  const mbody = mk.body();
  await mbody.locator("[data-waiting-dock]").waitFor({ timeout: 30000 });
  await mbody.locator("[data-waiting-go]").tap();
  await mbody.locator("[data-decision-set][data-highlighted]").waitFor({ timeout: 10000 });
  await shown(mbody, ship).locator("[data-question-option]").first().waitFor({ timeout: 10000 });
  await mob.waitForTimeout(700);
  await mob.screenshot({ path: join(shotsDir, "03-phone-390x844-card-in-stream.png") });
  await wholeCardShot(mob, mbody, "04-phone-card-three-choices");
  const mobBoxes = await choiceBoxes(mbody);
  assertStacked(mobBoxes, "phone");
  for (const b of mobBoxes) assert.ok(b.w >= 300, `phone: ${b.id} spans the card (${b.w}px)`);
  ok("phone: three full-width choice tiles stacked, each at least 44 px");
  await phoneCtx.close();

  // ---- Telegram (fake Bot API) ----
  const shipCopy = await tg.waitText(OWNER, "NX-6402");
  const rows = shipCopy.reply_markup.inline_keyboard;
  assert.deepEqual(rows.slice(0, 3).map((r) => r.map((x) => x.text)), [
    ["1. Merge and deploy to staging now"], ["2. Test on staging first"], ["3. Hold until Monday"],
  ], "one row per choice");
  assert.ok(!labelsOf(shipCopy).includes("OK"), "no OK button");
  for (const r of rows.slice(0, 3)) assert.match(r[0].callback_data, /^a:[A-Za-z0-9_-]{16}$/, "a short random code");
  assert.ok(shipCopy.text.includes("Choices\n1. Merge and deploy to staging now — Merge PR #4120"), "the choices are listed in the text");
  const tgPage = await browser.newPage({ viewport: { width: 420, height: 400 } });
  await tgPage.setContent(telegramPage([shipCopy]));
  await tgPage.screenshot({ path: join(shotsDir, "05-telegram-card-three-choices.png"), fullPage: true });
  await writeFile(join(shotsDir, "telegram-message.txt"),
    `HTML sent (parse_mode ${shipCopy.parse_mode}):\n${shipCopy.html}\n\nAs Telegram shows it:\n${shipCopy.text}\n\nButtons: ${labelsOf(shipCopy).join(" | ")}\n`);
  ok("Telegram: the choices listed in the text, one inline button per row, short codes, no OK");

  // ---- Pressed on Telegram ----
  const answersBefore = (await tg.answers()).length;
  const pressed = await tg.pressLabel(OWNER, shipCopy, "2. Test on staging first");
  const toast = await tg.answerAfter(answersBefore);
  assert.match(JSON.stringify(toast), /Sent to the Nxsys manager/);
  const got = await until("the manager got the choice", async () =>
    (await k.turnsIn(manager)).find((t) => t.blocks.userWords?.choice?.id === "staging-first"), 30000);
  assert.equal(got.blocks.content, "I choose: Test on staging first");
  assert.deepEqual(got.blocks.userWords.choice, { id: "staging-first", label: "Test on staging first" });
  assert.equal(got.blocks.userWords.channel, "telegram");
  assert.equal(got.blocks.userWords.cardId, ship.id);
  assert.equal(got.blocks.userWords.ok, undefined, "a choice is not an OK");
  assert.equal(got.blocks.fromSession, null);
  await until("card answered", async () => (await k.cards()).find((c) => c.id === ship.id)?.status === "answered");
  const answered = (await k.cards()).find((c) => c.id === ship.id);
  assert.equal(answered.answer.note, 'Chose "Test on staging first" on Telegram');
  const ended = await tg.waitFor(OWNER, "the card lost its buttons", (m) => m.message_id === shipCopy.message_id && !labelsOf(m).some((l) => /^\d\. /.test(l)));
  assert.ok(ended.text.includes('Chose "Test on staging first" on Telegram'), "the copy says which choice");
  // The same button again (a second press, or a copy on another phone): no longer valid.
  const again = (await tg.answers()).length;
  await tg.press(OWNER, shipCopy.message_id, pressed, { stale: true });
  assert.match(JSON.stringify(await tg.answerAfter(again)), /no longer valid/);
  assert.equal((await k.turnsIn(manager)).filter((t) => t.blocks.userWords?.choice).length, 1, "forwarded once");
  await tgPage.setContent(telegramPage([ended]));
  await tgPage.screenshot({ path: join(shotsDir, "06-telegram-after-choice.png"), fullPage: true });
  await k.idle(manager);
  await page.waitForTimeout(500);
  // Answered, it folds to one line; open it to read how it ended.
  await body.locator("[data-answered-card]", { hasText: SHIP.title }).locator("[data-answered-toggle]").click();
  const doneCard = body.locator(`[data-assistant-card="needs_decision"][data-card-status="answered"]`, { hasText: SHIP.title }).last();
  await doneCard.waitFor({ timeout: 15000 });
  await doneCard.scrollIntoViewIfNeeded();
  assert.equal(await doneCard.locator('[data-card-choice="staging-first"][data-chosen]').count(), 1, "the chosen one is marked");
  assert.equal(await doneCard.locator("[data-card-choice]:enabled").count(), 0, "no choice can be pressed any more");
  assert.match(await doneCard.locator("[data-card-status-line]").textContent(), /Chose "Test on staging first" on Telegram/);
  await doneCard.screenshot({ path: join(shotsDir, "07-desktop-answered-from-telegram.png") });
  ok("Telegram press: the manager gets the user's words naming the choice, once; the card shows it in PPM and on Telegram; the button is spent");

  // ---- Pressed in PPM ----
  await report("r-freeze", FREEZE);
  const freeze = await k.cardOf("needs_decision", "NX-6410");
  const freezeCopy = await tg.waitText(OWNER, "NX-6410");
  // The set shows the card itself when it is the only decision waiting, and a tab strip (one tab per
  // card, the shown one by hand) once it holds two or more. Wait for whichever the page draws, open
  // its tab only when a strip exists, then pick its tile and send it on its own.
  const freezeTab = body.locator(`[data-decision-set] [data-question-tab="${freeze.id}"]`);
  await body.locator(`[data-decision-set] [data-decision-card="${freeze.id}"], [data-decision-set] [data-question-tab="${freeze.id}"]`).first().waitFor({ timeout: 15000 });
  if (await freezeTab.count() && !(await shown(body, freeze).count())) await freezeTab.click();
  await shown(body, freeze).waitFor({ timeout: 15000 });
  await shown(body, freeze).locator("[data-question-option]", { hasText: "Ship NX-6398 only" }).click();
  await body.locator("[data-decision-send-one]").click();
  const gotPpm = await until("the manager got the PPM choice", async () =>
    (await k.turnsIn(manager)).find((t) => t.blocks.userWords?.choice?.id === "one"), 30000);
  assert.equal(gotPpm.blocks.content, "I choose: Ship NX-6398 only");
  assert.equal(gotPpm.blocks.userWords.channel, "ppm");
  await until("freeze answered", async () => (await k.cards()).find((c) => c.id === freeze.id)?.status === "answered");
  await tg.waitFor(OWNER, "the freeze copy lost its buttons", (m) => m.message_id === freezeCopy.message_id && !labelsOf(m).some((l) => /^\d\. /.test(l)));
  await k.idle(manager);
  await page.waitForTimeout(500);
  await body.locator("[data-answered-card]", { hasText: FREEZE.title }).locator("[data-answered-toggle]").click();
  const freezeDone = body.locator(`[data-assistant-card="needs_decision"][data-card-status="answered"]`, { hasText: FREEZE.title }).last();
  await freezeDone.waitFor({ timeout: 15000 });
  await freezeDone.scrollIntoViewIfNeeded();
  assert.match(await freezeDone.locator("[data-card-status-line]").textContent(), /Chose "Ship NX-6398 only" in PPM/);
  await freezeDone.screenshot({ path: join(shotsDir, "08-desktop-answered-in-ppm.png") });
  ok("PPM press: the manager gets the choice from PPM, the Telegram copy loses its buttons");

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
