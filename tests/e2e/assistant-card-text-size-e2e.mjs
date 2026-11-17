// A PPM Assistant card's text beside the chat around it, at 1440, 800 and 390 px wide: a long
// decision (bold title, five bullets, inline code) in a manager chat's "Waiting on you" bar under
// that chat's own reply written the same way, the same set in the Assistant window under one of the
// Assistant's replies, and the other card kinds (choices, a draft, done, failed). Measures the
// computed font size and line height of every card's text against a chat message's and photographs
// each place. The set of decisions draws a card outside the card frame, and its text used to take
// the page's 16px root size, larger than the card's title and the chat.
//
// Same disposable fixture as the manager loop (no real model, no real PPM data):
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco> PPM_CARD_SIZE_SHOTS=<dir> node tests/e2e/assistant-card-text-size-e2e.mjs
// PPM_CARD_SIZE_BEFORE=1 only photographs and measures (for a build from before the change).
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

const BEFORE = process.env.PPM_CARD_SIZE_BEFORE === "1";
const prefix = BEFORE ? "before" : "after";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-card-size-e2e-"));
const shotsDir = resolve(process.env.PPM_CARD_SIZE_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppmHome = join(sandbox, "ppm-home"), home = join(sandbox, "home"), nxDir = join(sandbox, "nxsys");
await Promise.all([shotsDir, logs, ppmHome, home, nxDir].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (name.startsWith(`${prefix}-`)) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
await writeFile(join(nxDir, "README.md"), "# project\n");
const git = (...args) => execFileSync("git", args, { cwd: nxDir, stdio: "pipe" });
git("init", "-q");
git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");

/** Written for this test, shaped like the card in the report: a bold title, bullets, inline code. */
const LONG = {
  kind: "needs_decision",
  title: "Overtime rate: review the new ticket text",
  body: [
    "- Ticket **Story**, Backlog, no sprint or owner yet. The Slack link is the thread it came from.",
    "- I checked the reference data: **PR100 = Hours (hourly)**, **PR101 = Daily (daily)**, both default rates (`isDefaultRate`). The client's own rates are custom.",
    "- Scope covers all four combinations, as in the earlier ticket. If you only want one, say so and I will narrow it.",
    "- A rate typed by hand is kept. A blank rate with no hourly or daily rate on the profile blocks the row, with a message.",
    "- Next: I post the text on the ticket once you say OK.",
  ].join("\n"),
};
/** The manager chat's own reply, written the same way, so the two sit side by side. */
const CHAT_REPLY = [
  "**Summary so far**",
  "",
  "- I read the ticket and the thread; nothing is assigned yet.",
  "- The two reference rates are `PR100` and `PR101`, both marked as defaults.",
  "- I drafted the ticket text and sent it to you as a decision below.",
].join("\n");
const OTHERS = [
  { kind: "needs_decision", title: "Pick a release window", body: "- **Tonight** keeps the `staging` freeze.\n- **Tomorrow** waits for QA.", options: [{ id: "tonight", label: "Tonight" }, { id: "tomorrow", label: "Tomorrow" }] },
  { kind: "urgent", title: "Reply to the client", body: "- They asked about the **missing export**.\n- Draft below, in `#support`.", draft: { to: "#support", text: "Thanks, we found the cause and a fix ships today." } },
  { kind: "done", title: "Hotfix merged", body: "- **PR 11203** merged.\n- `bun test` 42 pass." },
  { kind: "failed", title: "Staging deploy failed", body: "- **Migration 55** timed out.\n- Log: `deploy-staging.log`." },
];

const OWNER = 1001;
const checks = [];
const measures = [];
const ok = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const check = (name, fn) => { if (BEFORE) return; fn(); ok(name); };
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

/**
 * The computed size of a chat message's text (the reply holding `marker`) and of every card text
 * in `scopeSel`, read from a list item, a paragraph and inline code of each.
 */
function measure({ scopeSel, marker }) {
  const read = (box) => {
    const pick = (sel) => {
      const el = box.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, lineHeight: s.lineHeight };
    };
    return { li: pick("li"), p: pick("p"), code: pick(":not(pre) > code") };
  };
  const visible = (el) => el.getClientRects().length > 0;
  const scope = [...document.querySelectorAll(scopeSel)].find(visible) ?? document;
  const chat = [...document.querySelectorAll(".markdown-content")]
    .find((el) => visible(el) && !el.closest("[data-card-text]") && el.textContent.includes(marker));
  const cards = [...scope.querySelectorAll("[data-card-text]")].filter(visible).map((box) => ({
    kind: box.closest("[data-assistant-card]")?.getAttribute("data-assistant-card") ?? "?",
    inSet: !!box.closest("[data-decision-set]"),
    title: box.closest("[data-assistant-card]")?.querySelector("[data-card-title]")?.textContent?.slice(0, 40) ?? "",
    ...read(box),
  }));
  return { chat: chat ? read(chat) : null, cards };
}

/** Every card's list item, paragraph and code read the same as the chat's. */
function assertSameAsChat(m, where) {
  assert.ok(m.chat?.li, `${where}: the chat reply is on screen`);
  assert.ok(m.cards.length > 0, `${where}: a card text is on screen`);
  for (const c of m.cards) {
    for (const part of ["li", "p", "code"]) {
      if (!c[part] || !m.chat[part]) continue;
      assert.deepEqual(c[part], m.chat[part], `${where}: ${c.kind} "${c.title}" ${part} ${JSON.stringify(c[part])} vs chat ${JSON.stringify(m.chat[part])}`);
    }
  }
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
  const pageErrors = [];
  const tg = phone(fakeInfo.control);
  const seedCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await seedCtx.addInitScript(onboardingDone);
  const seedPage = await seedCtx.newPage();
  const k = loopKit({ web, fx, tg, page: seedPage, shotsDir, owner: OWNER, record: () => {} });

  // The manager chat, its reply, then the long decision it reports; then the other card kinds.
  const manager = (await fx.post("/api/project/Nxsys/chat/sessions", { providerId: "claude", title: "Quản lý" })).data.id;
  await k.managerTurn("Nxsys", manager, "seed", [], "Keep the plan", "default");
  await k.idle(manager);
  await fx.api("/api/assistant/managers/Nxsys", { method: "PUT", body: JSON.stringify({ sessionId: manager }) });
  let n = 0;
  for (const card of OTHERS) {
    const label = `r-other-${n++}`;
    await k.managerTurn("Nxsys", manager, label, [{ session: "report_to_assistant", args: card }], `Report ${card.title}`, "default");
    const [r] = await k.answered(label, 1);
    assert.equal(r.isError, false, `${card.title}: ${r.text}`);
    await k.idle(manager);
  }
  // Last, so the chat's reply sits right above its "Waiting on you" bar.
  await k.script("r-long", [{ session: "report_to_assistant", args: LONG }], { match: "Report the ticket", sessionId: manager, reply: CHAT_REPLY });
  await k.say("Nxsys", manager, "Report the ticket", "default");
  await k.answered("r-long", 1);
  await k.idle(manager);
  // A reply of the Assistant's own in its stream, written the same way.
  await seedPage.goto(`${web}/project/Nxsys/assistant`);
  await k.askAssistant("a-reply", [], "How are the managers doing", { reply: CHAT_REPLY });
  await until("assistant reply", async () => (await fx.turnOf("a-reply")) ? true : null, 30000);
  await seedCtx.close();
  const open = (await fx.api("/api/assistant/cards/open")).data.cards;
  assert.ok(open.some((c) => c.title === LONG.title), "the long decision is open");
  ok(`${open.length} cards open: ${open.map((c) => c.kind).join(", ")}`);

  async function contextAt(width, height) {
    const mobile = width < 768;
    const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(onboardingDone);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
    return { ctx, page, mobile, kit: loopKit({ web, fx, tg, page, shotsDir, owner: OWNER, record: () => {} }) };
  }
  const record = (where, m) => {
    measures.push({ where, ...m });
    const set = m.cards.find((c) => c.inSet) ?? m.cards[0];
    console.log(`${where}: chat li ${JSON.stringify(m.chat?.li)} | card li ${JSON.stringify(set?.li)} (${m.cards.length} card texts)`);
  };

  for (const [width, height] of [[1440, 900], [800, 900], [390, 844]]) {
    const { ctx, page, mobile, kit } = await contextAt(width, height);
    // ---- The Assistant window: its reply, then the set of decisions and the other cards ----
    await page.goto(`${web}/project/Nxsys/assistant`);
    const body = kit.body();
    await body.locator("[data-waiting-dock]").waitFor({ timeout: 30000 });
    const go = body.locator("[data-waiting-go]");
    if (mobile) await go.tap(); else await go.click();
    await body.locator("[data-decision-set][data-highlighted]").waitFor({ timeout: 5000 });
    // Every card of the set (the long one, the one with choices, the urgent one with a draft), one tab at a time.
    const tabs = body.locator("[data-decision-set] [data-question-tab]");
    for (let i = 0; i < await tabs.count(); i++) {
      await tabs.nth(i).click();
      await page.waitForTimeout(300);
      const m = await page.evaluate(measure, { scopeSel: "[data-decision-set]", marker: "Summary so far" });
      record(`${width} assistant window, set tab ${i + 1}`, m);
      check(`${width}: set tab ${i + 1} (${m.cards.map((c) => c.kind).join(", ")}) reads at the chat's size`, () => assertSameAsChat(m, `${width} set tab ${i + 1}`));
    }
    // The long decision's tab, whichever the set opened on.
    await tabs.filter({ hasText: LONG.title.slice(0, 12) }).first().click().catch(() => {});
    // The card's text in the middle of the stream, the Assistant's reply above it.
    await body.locator("[data-decision-set] [data-card-text]").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(shotsDir, `${prefix}-${width}-assistant-window-decision-set.png`) });
    const inAssistant = await page.evaluate(measure, { scopeSel: "[data-assistant-body]", marker: "Summary so far" });
    record(`${width} assistant window`, inAssistant);
    check(`${width}: in the Assistant window every card's text reads at the chat's size`, () => assertSameAsChat(inAssistant, `${width} assistant`));
    // The other kinds, drawn in the stream with the card frame.
    const failedCard = body.locator('[data-assistant-card="failed"]').last();
    if (await failedCard.count()) {
      await failedCard.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shotsDir, `${prefix}-${width}-assistant-window-other-cards.png`) });
    }

    // ---- The manager chat and its "Waiting on you" bar ----
    await body.locator('[data-manager-chip="Nxsys"] button').first().click();
    const bar = page.locator("[data-manager-waiting-cards]:visible").first();
    await bar.waitFor({ timeout: 30000 });
    // On a phone the bar starts closed and opens as a sheet.
    if (mobile) await bar.locator("[data-waiting-toggle]").first().tap();
    const where = mobile ? page.locator("[data-waiting-sheet]:visible").first() : bar;
    await where.locator("[data-card-text]").first().waitFor({ timeout: 15000 });
    await where.locator("[data-question-tab]", { hasText: LONG.title.slice(0, 12) }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(shotsDir, `${prefix}-${width}-manager-chat-waiting-bar.png`) });
    const inManager = await page.evaluate(measure, { scopeSel: mobile ? "[data-waiting-sheet]" : "[data-manager-waiting-cards]", marker: "Summary so far" });
    record(`${width} manager chat`, inManager);
    check(`${width}: in the manager chat's bar the card's text reads at the chat's size`, () => assertSameAsChat(inManager, `${width} manager chat`));
    await ctx.close();
  }

  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) throw new Error(`page errors:\n${unexpected.join("\n")}`);
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(`FAIL ${failure}`);
  try { for (const [i, p] of (browser?.contexts() ?? []).flatMap((c) => c.pages()).entries()) await p.screenshot({ path: join(shotsDir, `${prefix}-failure-${i}.png`) }); } catch { /* none */ }
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
  await writeFile(join(shotsDir, `${prefix}-results.json`), JSON.stringify({ checks, measures, failure }, null, 2));
  console.log(`${checks.length} checks passed${failure ? ", then a failure" : ""}; screenshots in ${shotsDir}; logs in ${logs}`);
  if (failure) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
