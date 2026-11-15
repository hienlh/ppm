// A long PPM Assistant card written in Markdown (sections, bullets, bold, code, a fenced block, a
// link, an outside image and some raw HTML), on desktop, phone and Telegram. Checks that the body
// is drawn by the chat's renderer in its card mode — bold, code and lists render, the HTML is shown
// as text, no image is loaded, links open in a new tab — that the card still folds once it no
// longer waits, and that the Telegram copy is formatted HTML Telegram parses; and photographs each.
//
// Same disposable fixture as the manager loop (no real model, no real PPM data):
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco> PPM_CARD_MD_SHOTS=<dir> node tests/e2e/assistant-card-markdown-e2e.mjs
// PPM_CARD_MD_BEFORE=1 only takes the photographs (for a build from before the change).
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

const BEFORE = process.env.PPM_CARD_MD_BEFORE === "1";
const prefix = BEFORE ? "before" : "after";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-card-md-e2e-"));
const shotsDir = resolve(process.env.PPM_CARD_MD_SHOTS ?? join(sandbox, "shots"));
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

/** Written for this test: a ticket id and code, no client, payroll or tax details. */
const CARD = {
  kind: "needs_decision",
  title: "NX-6318: hotfix ready, pick how to ship it",
  body: [
    "## What happened",
    "- The **nightly export** wrote duplicate rows when a job was **re-run** after a timeout.",
    "- Root cause: the retry in `src/jobs/export-runner.ts` did not reuse the batch id, so `upsertBatch()` saw a new batch.",
    "",
    "## The fix",
    "- PR #11203 reuses the id and adds a guard: `if (batch.id < 0 && !retry) return;`",
    "- Tests: `bun test tests/jobs/export-runner.test.ts` → **42 pass**, 0 fail.",
    "",
    "```bash",
    "git cherry-pick 4f2a9c1 && bun run deploy:staging",
    "```",
    "",
    "## Your call",
    "- **OK** = I deploy to staging now and post in the ticket.",
    "- Details: [PR #11203](https://github.example/nxsys/pull/11203)",
    "",
    "Raw HTML stays text: <b>not bold</b> <img src=\"x\" onerror=\"alert(1)\">",
    "![tracking pixel](https://tracker.example/p.png?k=secret)",
  ].join("\n"),
};

const OWNER = 1001;
const checks = [];
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
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A Telegram-like bubble for one message the fake Bot API received. The HTML PPM sent is drawn
 * with its formatting: it is Telegram's own subset (b, i, code, pre, s, blockquote), which the fake
 * already parsed, so it is safe to put on this throwaway page.
 */
function telegramPage(m) {
  const rows = (m.reply_markup?.inline_keyboard ?? []).map((row) =>
    `<div class="row">${row.map((b) => `<span class="btn">${escapeHtml(b.text)}</span>`).join("")}</div>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#8eb8d6;font:15px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;padding:12px}
    .head{background:#517da2;color:#fff;margin:-12px -12px 12px;padding:12px 16px;font-weight:600}
    .msg{max-width:380px;margin:0 0 12px}
    .bubble{background:#fff;border-radius:12px 12px 12px 4px;padding:8px 11px;white-space:pre-wrap;word-wrap:break-word;color:#000}
    .bubble code{font-family:ui-monospace,Menlo,Consolas,monospace;color:#c0392b;font-size:13px}
    .bubble pre{margin:4px 0;background:#f1f3f5;border-radius:6px;padding:6px 8px;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
    .bubble pre code{color:#222}
    .kb{margin-top:4px}.row{display:flex;gap:4px;margin-top:4px}
    .btn{flex:1;text-align:center;background:rgba(0,0,0,.28);color:#fff;border-radius:8px;padding:8px 6px;font-size:14px;font-weight:500}
    .note{font-size:11px;color:#234;margin:0 0 10px}
  </style><div class="head">PPM Assistant (bot)</div><p class="note">Fake Telegram (tests/helpers/fake-telegram-bot-api.ts): the HTML and buttons PPM sent, drawn as Telegram would.</p><div class="msg"><div class="bubble">${m.html ?? escapeHtml(m.text)}</div>${rows ? `<div class="kb">${rows}</div>` : ""}</div>`;
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
  const desk = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await desk.addInitScript(onboardingDone);
  const page = await desk.newPage();
  const pageErrors = [];
  const outside = [];
  page.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  page.on("request", (r) => { if (!r.url().startsWith(web)) outside.push(r.url()); });
  const tg = phone(fakeInfo.control);
  const k = loopKit({ web, fx, tg, page, shotsDir, owner: OWNER, record: () => {} });

  const manager = (await fx.post("/api/project/Nxsys/chat/sessions", { providerId: "claude", title: "Quản lý" })).data.id;
  await k.managerTurn("Nxsys", manager, "seed", [], "Keep the plan", "default");
  await k.idle(manager);
  await fx.api("/api/assistant/managers/Nxsys", { method: "PUT", body: JSON.stringify({ sessionId: manager }) });
  await fx.api("/api/assistant/managers/Nxsys", { method: "PATCH", body: JSON.stringify({ telegramDetail: "full" }) });
  await k.managerTurn("Nxsys", manager, "r-md", [{ session: "report_to_assistant", args: CARD }], "Report the hotfix", "default");
  const [r] = await k.answered("r-md", 1);
  assert.equal(r.isError, false, r.text);
  await k.idle(manager);
  const card = (await fx.api("/api/assistant/cards/open")).data.cards.find((c) => c.title === CARD.title);
  assert.ok(card, "the card is open");
  ok("a long Markdown card is open");

  /** The card's text box in the bar, read the way the user sees it. */
  const inspect = (scope) => scope.locator("[data-waiting-card] [data-card-text]").first().evaluate((el) => ({
    strong: [...el.querySelectorAll("strong")].map((n) => n.textContent),
    code: [...el.querySelectorAll("code")].map((n) => n.textContent),
    items: el.querySelectorAll("li").length,
    headings: [...el.querySelectorAll("h2")].map((n) => n.textContent),
    imgs: el.querySelectorAll("img").length,
    rawTags: el.querySelectorAll("b, script").length,
    links: [...el.querySelectorAll("a")].map((a) => ({ text: a.textContent, target: a.getAttribute("target") })),
    text: el.textContent,
  }));
  const assertMarkdown = (seen, where) => {
    assert.deepEqual(seen.headings, ["What happened", "The fix", "Your call"], `${where}: headings`);
    assert.ok(seen.items >= 6, `${where}: bullets render as a list (${seen.items})`);
    assert.ok(seen.strong.includes("nightly export"), `${where}: bold renders`);
    assert.ok(seen.code.includes("src/jobs/export-runner.ts"), `${where}: inline code renders`);
    assert.ok(seen.code.some((c) => c.includes("if (batch.id < 0 && !retry) return;")), `${where}: < and & in code shown as written`);
    assert.equal(seen.imgs, 0, `${where}: no image loaded`);
    assert.equal(seen.rawTags, 0, `${where}: raw HTML is not markup`);
    assert.ok(seen.text.includes("<b>not bold</b>"), `${where}: raw HTML shown as text`);
    for (const l of seen.links) assert.equal(l.target, "_blank", `${where}: ${l.text} opens in a new tab`);
    assert.ok(seen.links.some((l) => l.text === "PR #11203"), `${where}: the link is there`);
  };
  /** The whole card copied onto a layer and photographed, as in the long-cards e2e. */
  async function wholeCardShot(pg, scope, name) {
    const size = pg.viewportSize();
    const height = await scope.locator("[data-waiting-card]").evaluate((el) => {
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
    await layer.locator(":scope > *").screenshot({ path: join(shotsDir, `${prefix}-${name}.png`) });
    await layer.evaluate((el) => el.remove());
    if (height > size.height) await pg.setViewportSize(size);
  }

  // ---- Desktop ----
  await page.goto(`${web}/project/Nxsys/assistant`);
  const body = k.body();
  await body.locator("[data-waiting-cards]").waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
  await body.locator("[data-waiting-cards]").screenshot({ path: join(shotsDir, `${prefix}-01-desktop-waiting-bar.png`) });
  await wholeCardShot(page, body, "02-desktop-card-whole");
  const deskSeen = await inspect(body);
  check("desktop: headings, bullets, bold and code render; HTML is text; no image; links open a new tab", () => assertMarkdown(deskSeen, "desktop"));
  check("desktop: nothing was fetched from outside PPM", () => assert.deepEqual(outside, [], outside.join(", ")));

  // ---- Phone ----
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phoneCtx.addInitScript(onboardingDone);
  const mob = await phoneCtx.newPage();
  mob.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  const mk = loopKit({ web, fx, tg, page: mob, shotsDir, owner: OWNER, record: () => {} });
  await mob.goto(`${web}/project/Nxsys/assistant`);
  const mbody = mk.body();
  const msheet = mob.locator("[data-waiting-sheet]");
  await mbody.locator("[data-waiting-cards]").waitFor({ timeout: 30000 });
  await mbody.locator("[data-waiting-toggle]").tap();
  await msheet.waitFor({ timeout: 5000 });
  await mob.waitForTimeout(300);
  await mob.screenshot({ path: join(shotsDir, `${prefix}-03-phone-390x844-sheet.png`) });
  await wholeCardShot(mob, msheet, "04-phone-card-whole");
  const mobSeen = await inspect(msheet);
  check("phone: the same Markdown rendering in the full-screen sheet", () => assertMarkdown(mobSeen, "phone"));

  // ---- Telegram (fake Bot API) ----
  const sent = await tg.sent(OWNER);
  const m = sent.findLast((x) => x.text.includes("NX-6318"));
  assert.ok(m, "the card reached Telegram");
  const tgPage = await browser.newPage({ viewport: { width: 420, height: 400 } });
  await tgPage.setContent(telegramPage(m));
  await tgPage.screenshot({ path: join(shotsDir, `${prefix}-05-telegram-card.png`), fullPage: true });
  await writeFile(join(shotsDir, `${prefix}-telegram-message.txt`),
    `HTML sent (parse_mode ${m.parse_mode}):\n${m.html ?? "(not recorded)"}\n\nAs Telegram shows it:\n${m.text}\n\nButtons: ${labelsOf(m).join(" | ")}\n`);
  check("Telegram: the body is formatted HTML Telegram parses, with < and & escaped", () => {
    assert.equal(m.parse_mode, "HTML");
    assert.ok(m.html.includes("<b>nightly export</b>"), "bold");
    assert.ok(m.html.includes("<code>src/jobs/export-runner.ts</code>"), "code");
    assert.ok(m.html.includes("<code>if (batch.id &lt; 0 &amp;&amp; !retry) return;</code>"), "escaped code");
    assert.ok(m.html.includes('<pre><code class="language-bash">'), "fenced block");
    assert.ok(m.text.includes("• The nightly export"), "bullets");
    assert.ok(m.text.includes("<b>not bold</b>"), "raw HTML stays text");
    assert.ok(!m.text.includes("**"), "no Markdown markers left");
    assert.deepEqual(labelsOf(m).slice(0, 1), ["OK"], "the OK button is kept");
    assert.ok(m.text.includes("Reply to this message to answer in your own words."), "the reply hint is kept");
  });

  // ---- Once answered, the card folds in the stream ----
  await body.locator("[data-waiting-card]").getByRole("button", { name: "OK", exact: true }).click();
  await until("card no longer waits", async () => (await k.cards()).find((c) => c.id === card.id)?.status !== "open", 15000);
  await body.locator("[data-waiting-toggle]").click().catch(() => {});
  const done = body.locator(`[data-assistant-card="needs_decision"]:not([data-card-status="open"])`, { hasText: CARD.title }).last();
  await done.evaluate((el) => {
    let box = el.parentElement;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
  });
  await done.screenshot({ path: join(shotsDir, `${prefix}-06-desktop-answered-folded.png`) });
  assert.equal(await done.locator("[data-card-text][data-folded]").count(), 1, "the answered card is folded");
  await done.locator("[data-card-text-toggle]").evaluate((el) => el.click());
  await done.screenshot({ path: join(shotsDir, `${prefix}-07-desktop-answered-show-more.png`) });
  assert.equal(await done.locator("[data-card-text][data-folded]").count(), 0, "Show more unfolds it");
  ok("an answered card folds behind Show more, and unfolds");

  const ended = (await tg.sent(OWNER)).findLast((x) => x.message_id === m.message_id);
  check("Telegram: the ended copy is still formatted, without its buttons", () => {
    assert.ok(ended.html.includes("<b>nightly export</b>"));
    assert.equal(labelsOf(ended).filter((l) => l === "OK").length, 0);
  });

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
  console.log(`stopped fixture pid=${backend?.pid} (exit ${backend?.exitCode}), fake telegram pid=${fake?.pid}`);
  await writeFile(join(shotsDir, `${prefix}-results.json`), JSON.stringify({ checks, failure }, null, 2));
  console.log(`${checks.length} checks passed${failure ? ", then a failure" : ""}; screenshots in ${shotsDir}; logs in ${logs}`);
  if (failure) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
