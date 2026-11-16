// A task's link chips open their web page: the Jira key on the project's Jira site, each PR on
// GitHub, a URL as it is — each a real link to a new tab with the open-externally icon beside its
// live state — and the chat inside PPM. On desktop, on a 390 px phone (the web chips the Links block's own chip size) and on the
// Telegram `/tasks` card. The production Vite bundle against the disposable server of
// tests/e2e/ppm-tasks-e2e.mjs (scripted chats, a fake Telegram Bot API), with its neutral demo
// data (projects alpha and beta). No Jira or GitHub is asked: the Jira site and the links' states
// are written the way a Jira config and the link checker leave them, and the pages a click opens
// are answered by the browser context, which records the address it was asked for.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_TASKS_SHOTS=<dir> node tests/e2e/task-link-open-web-e2e.mjs
//
// Runs on Node 20 in the ppm-e2e-chromium image (`--cpus=4 --memory=3g`).
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild } from "./assistant-telegram/harness.mjs";
import { tasksKit, until } from "./ppm-tasks/tasks-kit.mjs";
import { seedDemo } from "./ppm-tasks/tasks-seed.mjs";
import { telegramFrame } from "./ppm-tasks/steps-phone-telegram.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-task-link-web-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs)].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const [name, dir] of Object.entries(dirs)) await writeFile(join(dir, "README.md"), `# ${name}\n`);

const OWNER = 1001;
const JIRA_SITE = "https://alpha-demo.atlassian.net";
const TITLE = "Ship the export fix to staging";
const EXPECTED = [
  ["jira", `${JIRA_SITE}/browse/AL-6284`],
  ["pr", "https://github.com/alpha/beta-backend/pull/11195"],
  ["pr", "https://github.com/alpha/beta-frontend/pull/2424"],
  ["url", "https://example.com/export-spec"],
];
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

/** Answers every outside page in this context with a page naming the address the browser asked for. */
async function answerOutsidePages(context, opened) {
  await context.route(/^https:\/\/(alpha-demo\.atlassian\.net|github\.com|example\.com)\//, (route) => {
    const url = route.request().url();
    opened.push(url);
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><title>Opened</title><style>
      body{margin:0;font:16px/1.5 "Liberation Sans",Arial,sans-serif;background:#f6f7f9;color:#111;display:grid;place-items:center;height:100vh}
      div{background:#fff;border:1px solid #d5d9e0;border-radius:12px;padding:28px 36px;max-width:900px}
      h1{font-size:20px;margin:0 0 10px} code{font:600 18px "Liberation Mono",monospace;color:#0b57d0;word-break:break-all}
      p{margin:10px 0 0;color:#555;font-size:14px}</style>
      <div><h1>A new browser tab opened at</h1><code>${esc(url)}</code><p>Answered by the e2e's browser context instead of the real site: no Jira, GitHub or example.com is asked.</p></div>` });
  });
}

/** The chips of the Links card, as [kind, href, target, rel, has the open-externally icon]. */
const chipFacts = (card) => card.locator("a[data-link-kind]").evaluateAll((as) => as.map((a) => [
  a.getAttribute("data-link-kind"), a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel"), !!a.querySelector("[data-link-external]"),
]));

function assertChips(facts) {
  assert.deepEqual(facts.map(([kind, href]) => [kind, href]), EXPECTED, "every web link opens its page");
  for (const [kind, , target, rel, icon] of facts) {
    assert.equal(target, "_blank", `${kind} opens in a new tab`);
    assert.equal(rel, "noopener noreferrer", `${kind} keeps the opener out`);
    assert(icon, `${kind} carries the open-externally icon`);
  }
}

async function desktop(k, s) {
  const page = k.page;
  const opened = [];
  await answerOutsidePages(page.context(), opened);
  await k.selectTask(TITLE);
  const card = k.detail().locator('[data-task-card="links"]');
  await card.scrollIntoViewIfNeeded();
  await card.getByText("Dev Failed").waitFor({ timeout: 20000 });
  assertChips(await chipFacts(card));
  assert.equal(await card.locator('button[data-link-kind="session"]').count(), 1, "the chat is a button that opens it in PPM");
  for (const state of ["Dev Failed", "open · CI running", "open"]) assert(await card.getByText(state).first().isVisible(), `${state} still shows`);
  await k.shot("01-desktop-1440-task-detail-links");
  await card.screenshot({ path: `${shotsDir}/02-desktop-links-card-closeup.png` });

  // A click on the Jira chip opens the issue in a tab of its own.
  const [tab] = await Promise.all([page.context().waitForEvent("page"), card.locator('a[data-link-kind="jira"]').click()]);
  // A noopener tab starts on about:blank and then navigates.
  await tab.waitForURL(EXPECTED[0][1], { timeout: 15000 });
  await tab.setViewportSize({ width: 1100, height: 420 });
  await tab.screenshot({ path: `${shotsDir}/03-desktop-click-jira-opens-issue.png` });
  await tab.close();
  // And each PR on GitHub, the URL as it is.
  for (const [i, [kind, href]] of EXPECTED.entries()) {
    if (i === 0) continue;
    const [t] = await Promise.all([page.context().waitForEvent("page"), card.locator(`a[data-link-kind="${kind}"]`).nth(kind === "pr" ? i - 1 : 0).click()]);
    await t.waitForURL(href, { timeout: 15000 });
    await t.close();
  }
  assert.deepEqual(opened, EXPECTED.map(([, href]) => href), "the browser asked for exactly these pages");

  // The chat opens inside PPM, not in a browser tab.
  const pagesBefore = page.context().pages().length;
  await card.locator('button[data-link-kind="session"]').click();
  await until("the manager chat opened in PPM", async () => (await page.locator("textarea[aria-label='Message']:visible").count()) > 0, 20000);
  assert.equal(page.context().pages().length, pagesBefore, "no new browser tab for a chat");
  record("desktop", "Jira, both PRs and the URL are new-tab links with the icon and their state; clicks open the right pages; the chat opens in PPM", { opened });
}

async function phoneFlow(k) {
  const page = await k.openPhone();
  const opened = [];
  await answerOutsidePages(page.context(), opened);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ppm:open-navigation", { detail: { tab: "tasks" } })));
  await page.locator("[data-task-list-mobile]:visible").waitFor({ timeout: 30000 });
  await page.locator("[data-task-row]").getByText(TITLE).first().tap();
  const detail = page.locator("[data-task-detail-mobile]:visible");
  await detail.waitFor({ timeout: 15000 });
  const card = detail.locator('[data-task-card="links"]');
  await card.scrollIntoViewIfNeeded();
  await card.getByText("Dev Failed").waitFor({ timeout: 20000 });
  assertChips(await chipFacts(card));
  // The web chips keep the Links block's own chip size, all alike: no tap area is added for them.
  // (The chat chip is a button, which the phone card's existing button rule sizes on its own.)
  const targets = await card.locator("a[data-link-kind], button[data-link-kind]").evaluateAll((els) => els.map((el) => ({
    kind: el.getAttribute("data-link-kind"), height: Math.round(el.getBoundingClientRect().height),
  })));
  const web = targets.filter((t) => t.kind !== "session");
  assert.equal(new Set(web.map((t) => t.height)).size, 1, `every web chip is one size: ${JSON.stringify(targets)}`);
  assert(web[0].height < 44, `no 44 px target is added: ${JSON.stringify(targets)}`);
  await k.shot("04-phone-390-task-detail-links");
  await card.screenshot({ path: `${shotsDir}/05-phone-390-links-card-closeup.png` });
  const [tab] = await Promise.all([page.context().waitForEvent("page"), card.locator('a[data-link-kind="jira"]').tap()]);
  // A noopener tab starts on about:blank and then navigates.
  await tab.waitForURL(EXPECTED[0][1], { timeout: 15000 });
  await tab.close();
  record("phone", "390 px: the same chips, all one size, and a tap on Jira opens the issue", { targets });
}

async function telegram(k) {
  const { tg, owner, fx } = k;
  await fx.api("/api/assistant/managers/alpha", { method: "PATCH", body: JSON.stringify({ telegramDetail: "full" }) });
  await tg.send(owner, "/tasks alpha");
  let deck = await tg.waitFor(owner, "the /tasks deck", (m) => /What to do first/.test(m.text), 30000);
  for (let i = 0; i < 10 && !deck.text.includes(TITLE); i++) {
    await tg.pressLabel(owner, deck, "›");
    deck = await until("the next card", async () => {
      const m = await tg.message(owner, deck.message_id);
      return m.text !== deck.text ? m : null;
    }, 15000);
  }
  assert(deck.text.includes(TITLE), "the deck reached the task");
  const html = deck.html ?? "";
  for (const [kind, href] of EXPECTED.filter(([kind]) => kind !== "url")) {
    assert(html.includes(`<a href="${href}">`), `the ${kind} line opens ${href}: ${html}`);
  }
  assert.match(deck.text, /AL-6284 Dev Failed/);
  const frame = await k.openFrame(telegramFrame([{ text: "/tasks alpha", from_user: true }, { ...deck, caption: "The task's card: its Jira and PR lines are links" }], "PPM Assistant")
    .replace("</style>", "a{color:#6ab2f2;text-decoration:underline}</style>"));
  await frame.setViewportSize({ width: 600, height: 700 });
  await k.shot("06-telegram-tasks-card-links");
  record("telegram", "The /tasks card's Jira and PR lines are tapable links to the issue and the PRs");
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
  await kit.createTask({
    project: "alpha", title: TITLE, urgency: "now", importance: "must",
    links: [
      { kind: "jira", ref: "AL-6284" },
      { kind: "pr", ref: "alpha/beta-backend#11195" },
      { kind: "pr", ref: "alpha/beta-frontend#2424" },
      { kind: "url", ref: "https://example.com/export-spec" },
      { kind: "session", ref: s.managers.alpha },
    ],
  });
  await fx.post("/__assistant-test/tasks/link-world", {
    projectPath: dirs.alpha, jiraBaseUrl: `${JIRA_SITE}/`,
    states: [
      { kind: "jira", ref: "AL-6284", state: { status: "Dev Failed", category: "indeterminate", assignee: null, updated: null, summary: "Export drops the last row" } },
      { kind: "pr", ref: "alpha/beta-backend#11195", state: { state: "open", checks: { total: 4, failing: 0, pending: 1 } } },
      { kind: "pr", ref: "alpha/beta-frontend#2424", state: { state: "open", checks: { total: 3, failing: 0, pending: 0 } } },
    ],
  });
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
