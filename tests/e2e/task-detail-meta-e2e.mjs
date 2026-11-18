// A task page's card headers: who-and-when never runs under a card's button. The Result block's
// "Manager Nxsys · Nov 17, 2026, 01:27 …" used to run under its Edit, which was laid over the block
// from outside. A decision task with a result recorded under a long name, Why / Next step / notes
// and two links, opened in a narrow floating window (380 px), a wide one (900 px), as a tab at 1440
// and on a phone (390). The production Vite bundle against the disposable server of
// tests/e2e/ppm-tasks-e2e.mjs.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_TASKS_SHOTS=<dir> PPM_META_SHOT_TAG=after node tests/e2e/task-detail-meta-e2e.mjs
//
// PPM_META_SHOT_TAG names the screenshots (`before-…`, `after-…`). With `before` it only measures
// and shoots, so the same scene can be taken on a build from before the fix; with `after` (the
// default) it also asserts: in every card header no two parts overlap, the result's who-and-when is
// cut with "…" and its tooltip holds the full text, Edit keeps its width, nothing in the page is
// wider than it, and on the phone a card's text button is a 44 px target that opens its editor.
//
// Runs on Node 20 in the ppm-e2e-chromium image (`--cpus=4 --memory=3g`).
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild } from "./assistant-telegram/harness.mjs";
import { tasksKit, until } from "./ppm-tasks/tasks-kit.mjs";
import { seedDemo } from "./ppm-tasks/tasks-seed.mjs";

const TAG = process.env.PPM_META_SHOT_TAG ?? "after";
const CHECK = TAG !== "before";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-task-detail-meta-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs)].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const [name, dir] of Object.entries(dirs)) await writeFile(join(dir, "README.md"), `# ${name}\n`);

const OWNER = 1001;
const TITLE = "Reversal sign on the employer's YTD totals";
const RESULT_BY = "Manager Nxsys Payroll — Quarterly Close Reconciliation";
const RESULT = "#11221 APPROVED (hienlh, f4d5bf1): reversal always 0 — what was filed for every employer, YTD kept ≥ 0, spec in integration.paths. FE #2440 APPROVED. PR BLOCKED (bot review red). Develop still uses keepReversalSign (5 places) → needs a matching develop PR.";
const QUESTION = "Which branch takes the reversal fix first, given that develop still carries keepReversalSign in five places?";
const results = [];
const failures = [];
const measured = [];
const record = (id, name, detail = {}) => { results.push({ step: id, name, ...detail }); console.log(`PASS ${id} ${name}`); };
let fake, backend, browser, web, kit;

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

const WINDOW = '[aria-roledescription="window"]';
const box = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
const shot = (page, name) => page.screenshot({ path: join(shotsDir, `${TAG}-${name}.png`) });
async function shotOf(page, loc, name, pad = 12) {
  const b = await box(loc);
  const vw = page.viewportSize();
  const x = Math.max(0, b.left - pad), y = Math.max(0, b.top - pad);
  await page.screenshot({ path: join(shotsDir, `${TAG}-${name}.png`), clip: { x, y, width: Math.min(vw.width - x, b.width + 2 * pad), height: Math.min(vw.height - y, b.height + 2 * pad) } });
}

/**
 * Every card header in `scope`: its drawn parts (the direct children with a box, and the text
 * actions inside them), and every pair of them that overlaps by more than half a pixel.
 */
function headerLayout(scope) {
  return scope.evaluate((root) => {
    const out = [];
    const headers = root.querySelectorAll("[data-task-card] > header, [data-task-result] > header");
    for (const h of headers) {
      if (!h.getClientRects().length) continue;
      const card = h.closest("[data-task-card]")?.getAttribute("data-task-card") ?? "result";
      const parts = [];
      for (const el of h.children) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // A wrapper of buttons (Links' aside) counts as its buttons and texts, not as one box.
        const inner = el.matches("[data-card-text-button]") ? [] : [...el.querySelectorAll("[data-card-text-button]")];
        if (inner.length && el.children.length > 1) {
          for (const c of el.children) { const cr = c.getBoundingClientRect(); if (cr.width >= 1) parts.push({ el: c, r: cr }); }
        } else parts.push({ el, r });
      }
      const name = (el) => (el.matches("[data-card-text-button]") || el.querySelector("[data-card-text-button]") || el.tagName === "BUTTON" ? "button:" : "text:") + (el.textContent ?? "").trim().slice(0, 24);
      const overlaps = [];
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i].r, b = parts[j].r;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), hgt = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 0.5 && hgt > 0.5) overlaps.push({ a: name(parts[i].el), b: name(parts[j].el), px: Math.round(w) });
      }
      const outside = parts.filter((p) => p.r.right > h.getBoundingClientRect().right + 0.5 || p.r.left < h.getBoundingClientRect().left - 0.5).map((p) => name(p.el));
      out.push({ card, width: Math.round(h.getBoundingClientRect().width), parts: parts.map((p) => name(p.el)), overlaps, outside });
    }
    const meta = root.querySelector("[data-task-result] > header > span[title], [data-task-result] > header > span.truncate");
    const edit = root.querySelector("[data-task-card=result] [data-card-text-button], [data-task-card=result] button");
    const m = meta?.getBoundingClientRect(), e = edit?.getBoundingClientRect();
    return {
      headers: out,
      meta: meta ? { text: meta.textContent, title: meta.getAttribute("title"), cut: meta.scrollWidth > meta.clientWidth + 1, width: Math.round(m.width) } : null,
      metaUnderEdit: m && e ? Math.max(0, Math.round(Math.min(m.right, e.right) - Math.max(m.left, e.left))) * (Math.min(m.bottom, e.bottom) > Math.max(m.top, e.top) ? 1 : 0) : null,
      editWidth: e ? Math.round(e.width) : null,
      sideways: root.scrollWidth - root.clientWidth,
    };
  });
}

function judge(where, layout, { phone: onPhone = false } = {}) {
  measured.push({ where, ...layout });
  const bad = layout.headers.filter((h) => h.overlaps.length || h.outside.length);
  console.log(`${where}: result meta under Edit ${layout.metaUnderEdit ?? "-"} px; meta cut ${layout.meta?.cut}; headers with overlap ${bad.map((h) => `${h.card}(${h.overlaps.map((o) => `${o.a}×${o.b} ${o.px}px`).join(", ")}${h.outside.length ? ` outside: ${h.outside}` : ""})`).join("; ") || "none"}`);
  if (!CHECK) return;
  const cards = new Set(layout.headers.map((h) => h.card));
  for (const c of ["result", "notes", "links"]) assert(cards.has(c), `${where}: the ${c} card's header is on screen (${[...cards]})`);
  if (!onPhone) assert(cards.has("decision"), `${where}: the decision card's header is on screen`);
  assert.deepEqual(bad, [], `${where}: no card header has parts on top of each other or outside it`);
  assert(layout.meta, `${where}: the result's who-and-when`);
  if (!onPhone) assert.equal(layout.metaUnderEdit, 0, `${where}: who-and-when does not run under Edit`);
  assert(layout.meta.title?.includes(RESULT_BY), `${where}: the tooltip holds the full who-and-when (${layout.meta.title})`);
  assert(layout.meta.text.includes(RESULT_BY.slice(0, 12)), `${where}: who-and-when shows the name`);
  if (!onPhone) assert(layout.editWidth >= 40, `${where}: Edit keeps its width (${layout.editWidth})`);
  assert(layout.sideways <= 1, `${where}: nothing is wider than the page (${layout.sideways})`);
}

/** The task page in a floating window `w` px wide, opened from the Tasks list at 1440. */
async function windowAt(k, s, w, label) {
  const page = k.use(k.desktop);
  await page.evaluate(({ w, layerW }) => {
    // No task window left from the last step: the next one opens at the remembered rect.
    const panels = JSON.parse(localStorage.getItem("ppm-window-panels") ?? "{}");
    const ids = new Set();
    for (const [id, p] of Object.entries(panels)) if (p?.tabs?.some((t) => t.type === "task")) { ids.add(id.replace(/^__win__:/, "")); delete panels[id]; }
    localStorage.setItem("ppm-window-panels", JSON.stringify(panels));
    localStorage.setItem("ppm-windows", JSON.stringify(JSON.parse(localStorage.getItem("ppm-windows") ?? "[]").filter((x) => !ids.has(x.id))));
    // Layer coordinates: the layer starts at the sidebar's edge, so this is from its left.
    localStorage.setItem("ppm-task-window-rect", JSON.stringify({ x: layerW - w - 24, y: 24, w, h: 820 }));
  }, { w, layerW: 1440 - 280 });
  await page.goto(`${k.web}/project/alpha`);
  await k.openTasks();
  await k.row(TITLE).getByText(TITLE, { exact: true }).first().click();
  const win = page.locator(WINDOW, { has: page.locator(`[data-task-detail="${s.task.id}"]`) });
  await win.waitFor({ timeout: 20000 });
  await win.locator("[data-task-result]").waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  const wb = await box(win);
  const width = Math.round(wb.width);
  if (CHECK) {
    assert(Math.abs(width - w) <= 2, `the window is ${w} px wide (${width})`);
    assert(wb.left >= 0 && wb.right <= 1440, `the window is on screen (${Math.round(wb.left)}–${Math.round(wb.right)})`);
  }
  const detail = win.locator("[data-task-detail]");
  const layout = await headerLayout(detail);
  await shot(page, `window-${label}-${w}`);
  await shotOf(page, win.locator("[data-task-card=result]"), `window-${label}-${w}-result`);
  await shotOf(page, win.locator("[data-task-card=decision]"), `window-${label}-${w}-decision`);
  judge(`window ${w}`, layout);
  record(`window-${w}`, `window ${w} px: card headers apart, who-and-when cut with a tooltip, Edit ${layout.editWidth} px`, { width, metaWidth: layout.meta?.width, editWidth: layout.editWidth });
  return win;
}

/** The task as a tab at 1440: "Open as tab" from its window. */
async function tabAt1440(k, s, win) {
  const page = k.use(k.desktop);
  await win.locator("[data-task-open-as-tab]").click();
  const detail = page.locator(`[data-task-detail="${s.task.id}"]:visible`).first();
  await until("the task is a tab", async () => (await page.locator(`${WINDOW} [data-task-detail="${s.task.id}"]`).count()) === 0, 10000);
  await detail.locator("[data-task-result]").waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  const layout = await headerLayout(detail);
  await shot(page, "page-1440");
  await shotOf(page, detail.locator("[data-task-card=result]"), "page-1440-result");
  judge("page 1440", layout);
  record("page-1440", `as a tab at 1440: card headers apart, Edit ${layout.editWidth} px`, { metaWidth: layout.meta?.width });
}

/** 390: the sheet, then Full screen; the cards there and a 44 px press area on their buttons. */
async function phoneAt(k, s) {
  const page = await k.openPhone(390, 844);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ppm:open-navigation", { detail: { tab: "tasks" } })));
  const list = page.locator("[data-task-list-mobile]:visible");
  await list.waitFor({ timeout: 30000 });
  await list.locator("[data-task-row]", { hasText: TITLE }).first().getByText(TITLE, { exact: true }).tap();
  await page.locator(`[data-task-open-sheet="${s.task.id}"]`).waitFor({ timeout: 20000 });
  await page.locator("[data-task-sheet-full-screen]").tap();
  const detail = page.locator(`[data-task-detail="${s.task.id}"][data-task-detail-mobile]:visible`);
  await detail.waitFor({ timeout: 20000 });
  const result = detail.locator("[data-task-card=result]");
  await result.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const layout = await headerLayout(detail);
  await shot(page, "phone-390");
  await shotOf(page, result, "phone-390-result");
  const notes = detail.locator("[data-task-card=notes]");
  await notes.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shotOf(page, detail.locator("[data-task-card=links]").or(notes).first(), "phone-390-notes-links");
  judge("phone 390", layout, { phone: true });
  // The phone's task page draws every card button 44 × 44 (THUMB_CARDS).
  // `header button`: a build from before the fix has no data-card-text-button.
  const btn = notes.locator("header button").first();
  const b = await box(btn);
  console.log(`phone 390: Notes' Edit is ${Math.round(b.width)} × ${Math.round(b.height)} px`);
  if (CHECK) {
    assert(b.height >= 43.5 && b.width >= 43.5, `Notes' Edit is a 44 px target (${Math.round(b.width)} × ${Math.round(b.height)})`);
    await btn.tap();
    await notes.locator('textarea[aria-label="Why"]').waitFor({ timeout: 5000 });
  }
  record("phone-390", `phone 390: card headers apart, Edit ${Math.round(b.width)} × ${Math.round(b.height)} px`, { editHeight: Math.round(b.height) });
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
  console.log(`fixture server pid ${backend.pid} on ${web}`);
  const fx = fixtureApi(web);
  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  kit = tasksKit({ web, fx, tg: phone(fakeInfo.control), browser, shotsDir, videoDir: null, owner: OWNER, record });
  const s = await seedDemo(kit, dirs);
  const created = await kit.createTask({
    project: "alpha", title: TITLE, type: "decision", urgency: "today", importance: "must",
    why: "Every employer's filed YTD must stay ≥ 0 after a reversal.", nextStep: "Open the develop PR that drops keepReversalSign.",
    decision: { question: QUESTION, options: ["Master first", "Develop first"] },
    links: [{ kind: "jira", ref: "NX-6284" }, { kind: "session", ref: s.managers.alpha, label: "alpha manager" }],
  });
  const withResult = await kit.patch(created.id, { revision: created.revision, result: { text: RESULT }, notes: "Checked against the integration spec." });
  assert.equal(withResult.ok, true, `the result is recorded (${JSON.stringify(withResult).slice(0, 200)})`);
  // The result is recorded as "You" through the REST API; a manager chat records it under its own
  // title, which is what runs long. Written into the scratch database, as a manager's write lands.
  const sql = spawnSync("bun", ["-e", `const { Database } = require("bun:sqlite"); const db = new Database(process.argv[1]); db.run("UPDATE tasks SET result_by = ? WHERE id = ?", [process.argv[2], process.argv[3]]); db.close();`, join(ppm, "ppm.db"), RESULT_BY, created.id], { encoding: "utf8" });
  assert.equal(sql.status, 0, `the result's author is set (${sql.stderr})`);
  s.task = await kit.task(created.id);
  assert.equal(s.task.result?.by, RESULT_BY, "the result is recorded under the manager's long title");
  await kit.openDesktop();
  const steps = [
    ["window-380", async (k, x) => { await windowAt(k, x, 380, "narrow"); }],
    ["window-900", async (k, x) => { x.wide = await windowAt(k, x, 900, "wide"); }],
    ["page-1440", (k, x) => tabAt1440(k, x, x.wide)],
    ["phone-390", (k, x) => phoneAt(k, x)],
  ];
  for (const [id, run] of steps) {
    try {
      await run(kit, s);
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
  await writeFile(join(shotsDir, `${TAG}-results.json`), JSON.stringify({ results, failures, measured }, null, 2));
  for (const f of failures) console.error(`FAILED ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} checks passed, ${failures.length} failed; screenshots in ${shotsDir}; logs in ${logs}`);
  process.exit(failures.length ? 1 : 0);
}
