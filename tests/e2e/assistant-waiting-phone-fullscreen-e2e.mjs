// "Waiting on you" on a phone opens full screen, and the stream names a waiting card once. Two long
// real cards (a 1,300-character ppm plan, a rewritten Nxsys decision), then on two iPhone sizes
// (390×844, 430×932): the bar folded to one row, opened full screen over the chat, scrolled to the
// card's end, the next card, the stream with no second set of buttons, and "Show" opening the bar on
// that card; then the same stream check on a desktop. Content: tests/e2e/assistant-waiting-cards/long-cards.mjs.
//
// Same disposable fixture as the manager loop (no real model, no real PPM data):
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco> PPM_WAITING_SHOTS=<dir> node tests/e2e/assistant-waiting-phone-fullscreen-e2e.mjs
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
import { NXSYS_DECISION, PLAN } from "./assistant-waiting-cards/long-cards.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-waiting-phone-e2e-"));
const shotsDir = resolve(process.env.PPM_WAITING_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppmHome = join(sandbox, "ppm-home"), home = join(sandbox, "home");
const ppmDir = join(sandbox, "ppm"), nxDir = join(sandbox, "nxsys");
await Promise.all([shotsDir, logs, ppmHome, home, ppmDir, nxDir].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (/\.png$/.test(name)) rmSync(join(shotsDir, name), { force: true });
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
/** Scrolls only the chat's own list to `el`: Playwright's scrollIntoView also scrolls clipped boxes. */
const scrollStreamTo = (loc) => loc.evaluate((el) => {
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 80;
});

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
  const pageErrors = [];
  const tg = phone(fakeInfo.control);
  const seedCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const seedPage = await seedCtx.newPage();
  const k = loopKit({ web, fx, tg, page: seedPage, shotsDir, owner: OWNER, record: () => {} });

  const managers = {};
  for (const project of ["ppm", "Nxsys"]) {
    const id = (await fx.post(`/api/project/${project}/chat/sessions`, { providerId: "claude", title: "Quản lý" })).data.id;
    await k.managerTurn(project, id, `seed-${project}`, [], `Keep the ${project} plan`, "default");
    await k.idle(id);
    await fx.api(`/api/assistant/managers/${project}`, { method: "PUT", body: JSON.stringify({ sessionId: id }) });
    managers[project] = id;
  }
  for (const [project, label, card] of [["ppm", "r-plan", PLAN], ["Nxsys", "r-nx", NXSYS_DECISION]]) {
    await k.managerTurn(project, managers[project], label, [{ session: "report_to_assistant", args: { kind: card.kind, title: card.title, body: card.body } }], `Report ${label}`, "default");
    const [r] = await k.answered(label, 1);
    assert.equal(r.isError, false, r.text);
    await k.idle(managers[project]);
  }
  // A few turns after the cards, so the stream has moved on past them.
  await seedPage.goto(`${web}/project/ppm/assistant`);
  for (let i = 1; i <= 2; i++) {
    await k.askAssistant(`chatter-${i}`, [], `Something else, question ${i}`, { reply: `Answer ${i}, about something else entirely.` });
    await k.idle(main);
  }
  const cards = (await fx.api("/api/assistant/cards/open")).data.cards;
  assert.equal(cards.length, 2);
  const idOf = (title) => cards.find((c) => c.title === title).id;
  await seedCtx.close();
  ok("two long cards wait: the ppm plan and the Nxsys decision");

  for (const [w, h] of [[390, 844], [430, 932]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await ctx.addInitScript(onboardingDone);
    const mob = await ctx.newPage();
    mob.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
    const mk = loopKit({ web, fx, tg, page: mob, shotsDir, owner: OWNER, record: () => {} });
    const tag = `iphone-${w}x${h}`;
    const body = mk.body();
    const sheet = mob.locator("[data-waiting-sheet]");
    await mob.goto(`${web}/project/ppm/assistant`);
    await body.locator("[data-waiting-cards]").waitFor({ timeout: 30000 });
    await body.locator("[data-card-pointer]").first().waitFor({ timeout: 30000 });

    // Folded: one row, no card over the chat.
    assert.equal(await body.locator("[data-waiting-card]").count(), 0, "no card under the row");
    assert.equal(await sheet.count(), 0);
    await mk.shot(`${tag}-01-before-open-one-row`);

    // Open: full screen, the chat behind it out of reach.
    await body.locator("[data-waiting-toggle]").tap();
    await sheet.waitFor({ timeout: 5000 });
    await mob.waitForTimeout(350); // the sheet slides up over 200 ms
    const box = await sheet.boundingBox();
    assert.ok(box.height >= h * 0.9, `${tag}: the sheet is ${Math.round(box.height)}px of ${h}`);
    const covered = await mob.evaluate(() => {
      const s = document.querySelector("[data-waiting-sheet]");
      return [0.25, 0.5, 0.75].every((y) => s.contains(document.elementFromPoint(window.innerWidth / 2, window.innerHeight * y)));
    });
    assert.ok(covered, `${tag}: the sheet covers the chat at every height`);
    assert.equal(await sheet.locator("[data-waiting-position]").innerText(), "1/2");
    const closeBox = await sheet.locator('button[aria-label="Close the waiting cards"]').boundingBox();
    assert.ok(closeBox.width >= 44 && closeBox.height >= 44, `${tag}: close is ${closeBox.width}×${closeBox.height}`);
    await mk.shot(`${tag}-02-open-full-screen-card-1`);

    // The end of the card, its buttons stuck to the bottom of the sheet.
    const slot = sheet.locator("[data-waiting-slot]");
    await slot.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await mob.waitForTimeout(150);
    const first = await sheet.locator("[data-waiting-card]").getAttribute("data-waiting-card");
    const firstCard = cards.find((c) => c.id === first);
    const tail = firstCard.body.split("\n").filter(Boolean).at(-1).slice(0, 30);
    assert.ok((await sheet.locator("[data-card-text]").innerText()).includes(tail), "the card's last line is there");
    const actions = await sheet.locator("[data-card-actions]").boundingBox();
    assert.ok(actions.y + actions.height <= h + 1, `${tag}: the buttons are on screen`);
    await mk.shot(`${tag}-03-card-1-scrolled-to-end`);

    await sheet.locator('button[aria-label="Next waiting card"]').tap();
    assert.equal(await sheet.locator("[data-waiting-position]").innerText(), "2/2");
    await mob.waitForTimeout(400);
    await mk.shot(`${tag}-04-card-2`);
    await slot.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await mob.waitForTimeout(150);
    await mk.shot(`${tag}-05-card-2-scrolled-to-end`);
    ok(`${tag}: opens full screen with ‹ 2/2 › and a 44px close; each long card scrolls to its end with its buttons in view`);

    // Closed again: the stream names each waiting card once, with no buttons of its own.
    await sheet.locator('button[aria-label="Close the waiting cards"]').tap();
    await until("sheet closed", async () => (await sheet.count()) === 0, 5000);
    assert.equal(await body.locator("[data-card-pointer]").count(), 2, "both cards are named in the stream");
    assert.equal(await body.locator("[data-card-actions]").count(), 0, "no second set of buttons anywhere on the page");
    const pointer = body.locator(`[data-card-pointer]`, { hasText: NXSYS_DECISION.title.slice(0, 20) });
    await scrollStreamTo(pointer);
    await mob.waitForTimeout(150);
    await mk.shot(`${tag}-06-stream-names-the-card-once`);

    await pointer.getByRole("button", { name: /Show/ }).tap();
    await sheet.waitFor({ timeout: 5000 });
    assert.equal(await sheet.locator("[data-waiting-card]").getAttribute("data-waiting-card"), idOf(NXSYS_DECISION.title), "Show opens that card");
    await mob.waitForTimeout(400);
    await mk.shot(`${tag}-07-show-opens-that-card`);
    ok(`${tag}: the stream names each card once with no buttons; Show opens the sheet on that card`);
    await ctx.close();
  }

  // ---- Desktop ----
  const desk = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await desk.addInitScript(onboardingDone);
  const page = await desk.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  const dk = loopKit({ web, fx, tg, page, shotsDir, owner: OWNER, record: () => {} });
  const body = dk.body();
  await page.goto(`${web}/project/ppm/assistant`);
  await body.locator("[data-waiting-cards] [data-waiting-card]").waitFor({ timeout: 30000 });
  await body.locator("[data-card-pointer]").first().waitFor({ timeout: 30000 });
  assert.equal(await body.locator("[data-card-actions]:not([data-waiting-cards] *)").count(), 0, "no buttons outside the bar");
  assert.equal(await body.locator("[data-waiting-cards] [data-card-actions]").count(), 1, "one set, in the bar");
  await dk.shot("desktop-01-bar-open-stream-below");
  await body.locator("[data-waiting-toggle]").click();
  const pointer = body.locator("[data-card-pointer]", { hasText: PLAN.title.slice(0, 20) });
  await scrollStreamTo(pointer);
  await page.waitForTimeout(150);
  await dk.shot("desktop-02-bar-folded-stream-names-the-card-once");
  await pointer.getByRole("button", { name: /Show/ }).click();
  await body.locator("[data-waiting-card][data-highlighted]").waitFor({ timeout: 5000 });
  assert.equal(await body.locator("[data-waiting-card]").getAttribute("data-waiting-card"), idOf(PLAN.title));
  await page.waitForTimeout(400);
  await dk.shot("desktop-03-show-opens-that-card");
  ok("desktop: one set of buttons, in the bar; the stream names the card; Show opens the bar on it");

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
