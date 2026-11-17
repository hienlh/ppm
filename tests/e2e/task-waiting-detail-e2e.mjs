// A waiting task says on whom it waits and until when — in the Tasks sidebar, the manager chat's
// Tasks chip list (where it used to say only "Waiting") and Telegram `/tasks` — and "Waiting on
// you" narrows both lists to the user's own waits. The production Vite bundle against the
// disposable server of tests/e2e/ppm-tasks-e2e.mjs, with its neutral demo data.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_TASKS_SHOTS=<dir> node tests/e2e/task-waiting-detail-e2e.mjs
//
// Runs on Node 20 in the ppm-e2e-chromium image (`--cpus=4 --memory=3g`). At 1440, 800, 390 and
// 320 it checks, in the sidebar list and in the chip's list: every waiting row names whom it waits
// on (the user's own marked "me", a long name cut with "…"), shows its due date or its age, stays
// on one line beside a task code that stays on one line, nothing overflows sideways, and the
// "Waiting on you" chip is 28px (26px on a phone) and leaves only the user's waits.
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

const sandbox = await mkdtemp(join(tmpdir(), "ppm-task-waiting-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs)].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const [name, dir] of Object.entries(dirs)) await writeFile(join(dir, "README.md"), `# ${name}\n`);

const OWNER = 1001;
const LONG_NAME = "Nguyễn Hoàng Minh Khôi (Payroll QA)";
const results = [];
const failures = [];
const record = (id, name, detail = {}) => { results.push({ step: id, name, ...detail }); console.log(`PASS ${id} ${name}`); };
let fake, backend, browser, web, kit;

/** A chip or button with text, ±1 px: 28 on desktop, 26 on a phone. */
const TEXT = (phone) => (phone ? [25, 27] : [27, 29]);

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

/** The world this test needs on top of the demo: a member with a long name, and five ways of waiting. */
async function seedWaits(k, s) {
  await k.saveSettings("alpha", { members: { add: [{ name: "Việt" }, { name: LONG_NAME }] } });
  const settings = await k.settings("alpha");
  const waitingStatus = settings.statuses.find((x) => x.baseGroup === "waiting");
  const viet = settings.members.find((m) => m.name === "Việt");
  const long = settings.members.find((m) => m.name === LONG_NAME);
  const patch = async (task, body) => {
    const now = await k.task(task.id);
    const r = await k.patch(task.id, { revision: now.revision, ...body });
    assert(r.ok, `patch ${task.title}: ${JSON.stringify(r)}`);
  };
  // The user's own: one in Waiting with a due date, one only named (its status not Waiting).
  await patch(s.t.release, { statusId: waitingStatus.id, waitingOnMemberId: "me" });
  await patch(s.t.copy, { waitingOnMemberId: "me" });
  // Someone else's, no date: its age since the move into Waiting.
  await patch(s.t.review, { statusId: waitingStatus.id, waitingOnMemberId: viet.id });
  // Nobody named: "Waiting" and its age, where the row used to show nothing.
  await patch(s.t.logs, { statusId: waitingStatus.id });
  // A long name, which must give way with "…" on a narrow screen.
  await patch(s.t.reply, { statusId: waitingStatus.id, waitingOnMemberId: long.id });
  return {
    mine: [s.t.release.id, s.t.copy.id],
    expect: {
      [s.t.release.id]: { who: "me", words: "Waiting on you", until: "due" },
      [s.t.copy.id]: { who: "me", words: "Waiting on you", until: "due" },
      [s.t.review.id]: { who: "member", words: "Waiting on Việt", until: "for" },
      [s.t.logs.id]: { who: "unknown", words: "Waiting", until: "for" },
      [s.t.reply.id]: { who: "member", words: `Waiting on ${LONG_NAME}`, until: "for" },
    },
  };
}

/**
 * Every waiting row inside `root`: its label is what `want` says, sits on one line, its words are
 * cut rather than wrapped, and the row's task code stays on one line too.
 */
async function checkLabels(page, rowSel, want, where) {
  const found = await page.evaluate(({ rowSel, ids }) => ids.map((id) => {
    const row = [...document.querySelectorAll(rowSel.replace("ID", id))].find((r) => r.getBoundingClientRect().width > 0);
    if (!row) return { id, missing: true };
    const label = row.querySelector("[data-task-waiting]");
    if (!label) return { id, noLabel: true, text: row.textContent };
    const words = label.querySelector("[data-task-waiting-words]");
    const code = row.querySelector("[data-task-code]");
    const lh = (el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5;
    const r = label.getBoundingClientRect();
    return {
      id, who: label.getAttribute("data-task-waiting"), until: label.getAttribute("data-task-waiting-until"),
      words: words?.textContent ?? "", cut: words ? words.scrollWidth > words.clientWidth + 1 : false,
      oneLine: r.height <= lh(label) + 4, height: Math.round(r.height),
      codeOneLine: code ? code.getClientRects().length === 1 && code.getBoundingClientRect().height <= lh(code) + 4 : true,
      inside: r.right <= row.getBoundingClientRect().right + 1,
    };
  }), { rowSel, ids: Object.keys(want) });
  for (const f of found) {
    const w = want[f.id];
    assert(!f.missing, `${where}: row ${f.id} is shown`);
    assert(!f.noLabel, `${where}: row ${f.id} has a waiting label (row says: ${f.text})`);
    assert.equal(f.who, w.who, `${where}: on whom (${f.words})`);
    assert.equal(f.words, w.words, `${where}: the words`);
    assert.equal(f.until, w.until, `${where}: until when, for ${f.words}`);
    assert(f.oneLine, `${where}: "${f.words}" on one line (${f.height}px)`);
    assert(f.codeOneLine, `${where}: the code of "${f.words}" on one line`);
    assert(f.inside, `${where}: "${f.words}" stays inside its row`);
  }
  return found;
}

const noSideOverflow = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((el) => el.getBoundingClientRect().width > 0)
  .every((el) => el.scrollWidth <= el.clientWidth + 1), sel);

async function heightOf(loc, [min, max], what) {
  await loc.waitFor({ timeout: 15000 });
  const h = Math.round((await loc.boundingBox()).height * 10) / 10;
  assert(h >= min && h <= max, `${what}: ${h}px, want ${min}–${max}`);
  return h;
}

/** Turns "Waiting on you" on, checks only the user's waits are left, and turns it off again. */
async function checkFilter(page, scope, rowSel, mine, isPhone, where, shot) {
  const toggle = page.locator(`${scope} [data-task-waiting-on-me-filter]:visible`).first();
  const height = await heightOf(toggle, TEXT(isPhone), `${where}: Waiting on you`);
  assert.equal(await toggle.locator("[data-task-waiting-on-me-count]").innerText(), String(mine.length), `${where}: the count`);
  await toggle.click();
  await until(`${where}: only the user's waits`, async () => {
    const ids = await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((r) => r.getBoundingClientRect().width > 0)
      .map((r) => r.getAttribute("data-task-row") ?? r.getAttribute("data-chip-task")), rowSel);
    return ids.length === mine.length && mine.every((id) => ids.includes(id));
  }, 10000);
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  if (shot) await kit.shot(shot);
  await toggle.click();
  await until(`${where}: every task back`, async () => (await toggle.getAttribute("aria-pressed")) === "false", 5000);
  return height;
}

const SIDEBAR = "[data-tasks-panel]";
const CHIP_LIST = "[role=dialog][aria-label='Tasks']";
const SIDEBAR_ROW = "[data-tasks-panel] [data-task-row='ID']";
const CHIP_ROW = "[data-chip-task='ID']";
const chatUrl = (s) => `${web}/project/alpha/chat/claude/${s.managers.alpha}`;

async function openChipList(page) {
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  await chip.click();
  await page.locator("[data-chip-task]:visible").first().waitFor({ timeout: 15000 });
}

async function desktopAt(k, s, w, width) {
  const page = width === 1440 ? k.use(k.desktop) : await k.openDesktopAt(width, 900);
  await page.goto(`${web}/project/alpha`);
  await k.openTasks();
  await page.locator("[data-tasks-panel] [data-task-waiting]").first().waitFor({ timeout: 20000 });
  const labels = await checkLabels(page, SIDEBAR_ROW, w.expect, `sidebar ${width}`);
  assert(await noSideOverflow(page, "[data-tasks-panel]"), `sidebar ${width}: nothing overflows sideways`);
  await k.shot(`${width}-sidebar`);
  const sidebarChip = await checkFilter(page, SIDEBAR, "[data-tasks-panel] [data-task-row][data-depth='0']", w.mine, false, `sidebar ${width}`, width === 1440 ? `${width}-sidebar-waiting-on-you` : null);

  await page.goto(chatUrl(s));
  await openChipList(page);
  await checkLabels(page, CHIP_ROW, w.expect, `chip list ${width}`);
  assert(await noSideOverflow(page, "[data-manager-tasks-list]"), `chip list ${width}: nothing overflows sideways`);
  await k.shot(`${width}-chip-list`);
  const listChip = await checkFilter(page, CHIP_LIST, "[data-chip-task]", w.mine, false, `chip list ${width}`, `${width}-chip-list-waiting-on-you`);
  await page.keyboard.press("Escape");
  record(`desktop-${width}`, "sidebar and chip list say on whom and until when; Waiting on you leaves only the user's waits", {
    heights: { sidebarChip, listChip }, labels: labels.map((l) => `${l.words} (${l.until}${l.cut ? ", cut" : ""})`),
  });
}

async function phoneAt(k, s, w, width) {
  const page = width === 390 ? await k.openPhone(390, 844) : k.page;
  if (width !== 390) await page.setViewportSize({ width, height: 640 });
  // The drawer's Tasks list.
  await page.goto(`${web}/project/alpha`);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ppm:open-navigation", { detail: { tab: "tasks" } })));
  await page.locator("[data-task-list-mobile]:visible").waitFor({ timeout: 30000 });
  const labels = await checkLabels(page, SIDEBAR_ROW, w.expect, `phone list ${width}`);
  assert(await noSideOverflow(page, "[data-tasks-panel]"), `phone list ${width}: nothing overflows sideways`);
  if (width === 320) assert(labels.find((l) => l.words.includes(LONG_NAME))?.cut, "320: the long name is cut with …");
  await k.shot(`${width}-phone-list`);
  const listChip = await checkFilter(page, SIDEBAR, "[data-tasks-panel] [data-task-row][data-depth='0']", w.mine, true, `phone list ${width}`, null);

  // The manager chat's Tasks chip sheet.
  await page.goto(chatUrl(s));
  await openChipList(page);
  const chipLabels = await checkLabels(page, CHIP_ROW, w.expect, `chip sheet ${width}`);
  assert(await noSideOverflow(page, "[data-manager-tasks-list]"), `chip sheet ${width}: nothing overflows sideways`);
  await k.shot(`${width}-chip-sheet`);
  const sheetChip = await checkFilter(page, CHIP_LIST, "[data-chip-task]", w.mine, true, `chip sheet ${width}`, `${width}-chip-sheet-waiting-on-you`);
  record(`phone-${width}`, "phone list and chip sheet say on whom and until when on one line; long names cut; 26px chip", {
    heights: { listChip, sheetChip }, labels: chipLabels.map((l) => `${l.words} (${l.until}${l.cut ? ", cut" : ""})`),
  });
}

/** Telegram `/tasks alpha`: page through the deck and draw the waiting cards as the phone showed them. */
async function telegram(k) {
  const { tg, owner } = k;
  await tg.send(owner, "/tasks alpha");
  let card = await tg.waitFor(owner, "the /tasks deck", (m) => /\d+ of \d+ · What to do first/.test(m.text), 30000);
  const total = Number(/of (\d+)/.exec(card.text)[1]);
  const waits = [];
  for (let i = 0; i < total; i++) {
    if (/Waiting/.test(card.text.split("\n").slice(3).join("\n"))) waits.push(card);
    if (i === total - 1) break;
    const before = card.text;
    await tg.pressLabel(owner, card, "›");
    card = await until("the next card", async () => {
      const m = await tg.message(owner, card.message_id);
      return m && m.text !== before ? m : null;
    }, 15000);
  }
  const texts = waits.map((m) => m.text);
  assert(texts.some((t) => t.includes("✋ Waiting on you · Due")), `a card says ✋ Waiting on you · Due…: ${texts.join("\n---\n")}`);
  assert(texts.some((t) => t.includes("⏳ Waiting on Việt · for")), "a card names Việt with how long");
  assert(texts.some((t) => /⏳ Waiting · for/.test(t)), "a card with nobody named says Waiting with how long");
  const page = await k.openFrame(telegramFrame([{ text: "/tasks alpha", from_user: true }, ...waits.map((m) => ({ ...m, reply_markup: undefined }))], "PPM Assistant"));
  await page.setViewportSize({ width: 460, height: 900 });
  await k.shot("telegram-tasks");
  record("telegram", "/tasks cards say on whom and until when, the user's own marked", { cards: texts.length });
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
  const w = await seedWaits(kit, s);
  await kit.openDesktop();
  const steps = [
    ["1440", () => desktopAt(kit, s, w, 1440)], ["800", () => desktopAt(kit, s, w, 800)],
    ["390", () => phoneAt(kit, s, w, 390)], ["320", () => phoneAt(kit, s, w, 320)], ["telegram", () => telegram(kit)],
  ];
  for (const [id, run] of steps) {
    try {
      await run();
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
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ results, failures }, null, 2));
  for (const f of failures) console.error(`FAILED ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} checks passed, ${failures.length} failed; screenshots in ${shotsDir}; logs in ${logs}`);
  process.exit(failures.length ? 1 : 0);
}
