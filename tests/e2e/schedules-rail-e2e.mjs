// The Schedules window, end to end, on the production Vite bundle against a disposable server
// (tests/e2e/fixtures/schedules-rail-server.ts) seeded with demo projects alpha and beta. Checks the
// rail button's count and red dot, the window's groups, Dismiss, on/off, Open prompt, Run now, the
// project filter and the inline details of a narrow window (1440 and 800), a task's Remind… and its
// reminder card, and the phone's drawer tile, cards, details sheet and long-press actions (390 and
// 320) — with every text button 28px (26px on a phone) and every icon button 24px (22px).
//
// Run it in the capped e2e image (Chromium, Node 20, playwright-core):
//
//   docker run --rm --name ppm-task-schedules-rail --cpus=4 --memory=3g --ulimit core=0 \
//     -e NODE_OPTIONS=--max-old-space-size=1536 -e IS_SANDBOX=1 \
//     -v <repo>:/app:ro -v ppm-e2e-nm:/app/node_modules -v <out>:/out -v <web>:/web -w /app \
//     -e PPM_RAIL_ARTIFACTS=/out -e PPM_RAIL_WEB_DIR=/web -e PPM_RAIL_VIDEO=1 ppm-e2e-chromium:latest \
//     sh -c 'bun install --frozen-lockfile && node tests/e2e/schedules-rail-e2e.mjs'
//
// PPM_RAIL_WEB_DIR keeps the bundle (built on the first run); PPM_RAIL_ARTIFACTS keeps screenshots,
// videos (PPM_RAIL_VIDEO=1) and the server log.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-rail-e2e-"));
const artifacts = process.env.PPM_RAIL_ARTIFACTS ? resolve(process.env.PPM_RAIL_ARTIFACTS) : join(sandbox, "artifacts");
const videoDir = process.env.PPM_RAIL_VIDEO ? join(artifacts, "video") : null;
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), projects = join(sandbox, "projects");
await Promise.all([artifacts, ppm, home, projects, ...(videoDir ? [videoDir] : [])].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

const webDir = process.env.PPM_RAIL_WEB_DIR ? resolve(process.env.PPM_RAIL_WEB_DIR) : join(sandbox, "web");
if (!existsSync(join(webDir, "index.html"))) {
  await writeFile(join(artifacts, "vite.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir, "--emptyOutDir"]));
}

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
let serverLog = "";
const server = spawn("bun", ["tests/e2e/fixtures/schedules-rail-server.ts"], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
    PPM_RAIL_WEB_DIR: webDir, PPM_RAIL_PROJECTS: projects, TZ: process.env.TZ ?? "Asia/Saigon", PPM_ALLOW_PROD_DB: "" },
});
server.stdout.on("data", (s) => serverLog += s); server.stderr.on("data", (s) => serverLog += s);
console.log(`fixture server pid ${server.pid}`);

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (e) { results.push({ name, ok: false, error: String(e?.stack ?? e) }); console.log(`FAIL ${name}\n${e?.stack ?? e}`); }
}
async function until(label, fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { try { if (await fn()) return; } catch { /* retry */ } if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise((r) => setTimeout(r, 200)); }
}
const getJson = async (path) => (await fetch(`${web}${path}`, { headers: { Connection: "close" } })).json();
const pageInit = () => {
  if (window.top !== window) return;
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
};

/** Every visible button under `root` that is a text or an icon button, with its height. */
async function buttonHeights(page, root) {
  return page.locator(root).first().evaluate((el) => [...el.querySelectorAll("button:not([role=switch])")]
    .filter((b) => b.offsetParent !== null && !b.closest("[data-schedule-row]") && b.getBoundingClientRect().height > 0)
    .map((b) => ({ label: (b.getAttribute("aria-label") ?? b.textContent ?? "").trim().slice(0, 30), h: Math.round(b.getBoundingClientRect().height),
      icon: !(b.textContent ?? "").trim() })));
}
function assertHeights(list, { text, icon }, where) {
  assert(list.length > 0, `${where}: some buttons measured`);
  for (const b of list) {
    const want = b.icon ? icon : text;
    assert.equal(b.h, want, `${where}: "${b.label}" is ${b.h}px, want ${want}px`);
  }
}

let browser;
try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`, { headers: { Connection: "close" } })).ok, 90000);
  const seeded = await getJson("/__rail-test/seeded");
  const pwPath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = pwPath ? await import(pathToFileURL(pwPath).href) : await import("playwright-core");
  browser = await pw.chromium.launch({ headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });
  const contextFor = (opts) => browser.newContext({ serviceWorkers: "block", ...opts, ...(videoDir ? { recordVideo: { dir: join(videoDir, "raw"), size: opts.viewport } } : {}) });

  // ---------------- desktop 1440 ----------------
  const desktop = await contextFor({ viewport: { width: 1440, height: 900 } });
  await desktop.addInitScript(pageInit);
  const page = await desktop.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${web}/project/alpha`);
  const railButton = page.locator('[data-rail-util="schedules"]');

  await check("rail button counts the next 24 hours and shows a red dot", async () => {
    await railButton.waitFor({ timeout: 30000 });
    await until("count", async () => (await railButton.locator("[data-rail-count]").count()) === 1);
    const list = await getJson("/api/schedules");
    const count = Number(await railButton.locator("[data-rail-count]").innerText());
    assert(count >= 4 && count <= list.data.length, `count ${count}`);
    assert.equal(await railButton.locator("[data-rail-dot]").count(), 1, "red dot for the failed and the waiting schedule");
    assert.match(await railButton.getAttribute("aria-label"), /Schedules · \d+ in the next 24 h · 2 need attention/);
    assert.equal(Math.round((await railButton.boundingBox()).height), 32, "rail utility size");
  });

  const app = page.locator('[data-schedules-app="window"]');
  await check("the window lists every project's schedules in groups", async () => {
    await railButton.click();
    await app.waitFor({ timeout: 15000 });
    await until("rows", async () => (await app.locator("[data-schedule-row]").count()) === 6);
    const attention = app.locator('[data-group="attention"] [data-schedule-row]');
    assert.deepEqual(await attention.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-schedule-row")).sort()),
      [seeded.ids.nightly, seeded.ids.scan].map(String).sort());
    assert.equal(await app.locator(`[data-group="off"] [data-schedule-row="${seeded.ids.off}"]`).count(), 1);
    const reminder = app.locator(`[data-schedule-row="${seeded.ids.reminder}"]`);
    assert.match(await reminder.innerText(), /London/);
    assert.match(await reminder.innerText(), /beta\/1/);
    assert.equal(await app.locator('[data-permission="bypassPermissions"]').count() >= 3, true, "Bypass pills");
    await page.screenshot({ path: join(artifacts, "01-desktop-1440-window.png") });
  });

  await check("the details show the Bypass warning, and Dismiss clears that problem only", async () => {
    await app.locator(`[data-schedule-row="${seeded.ids.nightly}"]`).click();
    const detail = app.locator(`aside [data-schedule-detail="${seeded.ids.nightly}"]`);
    await detail.waitFor();
    assert.equal(await detail.locator("[data-bypass-warning]").count(), 1);
    assert.match(await detail.locator('[data-attention="failed"]').innerText(), /Timed out after 30m/);
    await page.screenshot({ path: join(artifacts, "02-desktop-1440-detail.png") });
    await detail.getByRole("button", { name: "Dismiss" }).click();
    await until("moved out of attention", async () => (await app.locator(`[data-group="attention"] [data-schedule-row="${seeded.ids.nightly}"]`).count()) === 0);
    assert.match(await railButton.getAttribute("aria-label"), /1 needs attention/);
    assert.equal(await railButton.locator("[data-rail-dot]").count(), 1, "the waiting reminder still needs a look");
  });

  await check("on/off, Open prompt and Run now", async () => {
    const weekly = app.locator(`[data-schedule-row="${seeded.ids.weekly}"]`);
    await weekly.locator('[role="switch"]').click();
    await until("weekly off", async () => (await app.locator(`[data-group="off"] [data-schedule-row="${seeded.ids.weekly}"]`).count()) === 1);
    assert.equal((await getJson(`/api/schedules/${seeded.ids.weekly}`)).data.enabled, 0);
    await app.locator(`[data-schedule-row="${seeded.ids.digest}"]`).getByRole("button", { name: "Open prompt" }).click();
    const sheet = page.locator(`[data-schedule-prompt="${seeded.ids.digest}"]`);
    await sheet.waitFor();
    assert.match(await sheet.innerText(), /Summarise yesterday's commits/);
    await page.screenshot({ path: join(artifacts, "03-desktop-1440-prompt.png") });
    await page.keyboard.press("Escape");
    await app.locator(`[data-schedule-row="${seeded.ids.digest}"]`).getByRole("button", { name: "Run now" }).click();
    await until("run now reached the server", async () => (await getJson("/__rail-test/runs-now")).includes(seeded.ids.digest));
  });

  await check("button heights in the window are 28px (text) and 24px (icon)", async () => {
    assertHeights(await buttonHeights(page, '[data-schedules-app="window"]'), { text: 28, icon: 24 }, "desktop window");
    const rowIcons = await app.locator("[data-schedule-row] button").evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().height)));
    assert(rowIcons.length > 0 && rowIcons.every((h) => h === 24), `row icon buttons ${rowIcons}`);
  });

  await check("the project filter keeps only that project's schedules", async () => {
    await app.locator('select[aria-label="Project"]').selectOption("beta");
    await until("beta only", async () => (await app.locator("[data-schedule-row]").count()) === 3);
    await app.locator('select[aria-label="Project"]').selectOption("");
  });

  await check("a task shows its reminder, and Remind… adds another", async () => {
    await app.locator(`[data-schedule-row="${seeded.ids.reminder}"]`).click();
    await app.locator(`aside [data-schedule-detail="${seeded.ids.reminder}"]`).getByRole("button", { name: "beta/1" }).click();
    const card = page.locator(`[data-task-reminder="${seeded.ids.reminder}"]`);
    await card.waitFor({ timeout: 15000 });
    assert.match(await card.innerText(), /Reminder · .*London/);
    const remind = page.locator("[data-task-remind-button]").first();
    assert.equal(Math.round((await remind.boundingBox()).height), 28, "Remind… is a 28px text button");
    await remind.click();
    await page.locator('[data-remind-choice="morning"]').click();
    await until("second reminder", async () => (await page.locator("[data-task-reminder]").count()) === 2);
    await page.screenshot({ path: join(artifacts, "04-desktop-1440-task-reminder.png") });
  });

  // ---------------- narrow window 800 ----------------
  await check("a narrow window shows the details under the row", async () => {
    await page.setViewportSize({ width: 800, height: 700 });
    await railButton.click();
    await app.waitFor();
    await until("container narrow", async () => (await app.evaluate((el) => el.getBoundingClientRect().width)) < 900);
    await app.locator(`[data-schedule-row="${seeded.ids.scan}"]`).click();
    const inline = app.locator(`[data-schedule-detail="${seeded.ids.scan}"]`).first();
    await inline.waitFor();
    assert.equal(await app.locator("aside").isVisible().catch(() => false), false, "no side pane");
    await page.screenshot({ path: join(artifacts, "05-window-800.png") });
    assertHeights(await buttonHeights(page, '[data-schedules-app="window"]'), { text: 28, icon: 24 }, "narrow window");
  });
  assert.deepEqual(errors.filter((e) => !/serviceWorker/.test(e)), [], "no page errors on the desktop");
  await desktop.close();

  // ---------------- phone 390 and 320 ----------------
  for (const width of [390, 320]) {
    const phone = await contextFor({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.addInitScript(pageInit);
    const p = await phone.newPage();
    const cdp = await phone.newCDPSession(p);
    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await p.goto(`${web}/project/alpha`);

    await check(`${width}: the drawer tile opens Schedules as a tab`, async () => {
      await p.getByRole("button", { name: "Open menu" }).first().click();
      const tile = p.locator('[data-drawer-tile="schedules"]');
      await tile.waitFor({ timeout: 15000 });
      await until("tile count", async () => (await tile.locator("[data-drawer-count]").count()) === 1);
      assert.equal(await tile.locator("[data-drawer-dot]").count(), 1);
      const clipped = await tile.evaluate((b) => { const label = b.querySelector("span.truncate"); return label.scrollWidth > label.clientWidth + 1; });
      assert.equal(clipped, false, "the tile's label fits");
      await p.screenshot({ path: join(artifacts, `06-phone-${width}-drawer.png`) });
      await tile.click();
      await p.locator('[data-schedules-app="phone"]').waitFor({ timeout: 15000 });
      await until("cards", async () => (await p.locator("[data-schedule-card]").count()) === 6);
      assert(await p.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll");
      await p.screenshot({ path: join(artifacts, `07-phone-${width}-list.png`) });
      assertHeights(await buttonHeights(p, '[data-schedules-app="phone"] [data-schedule-card]'), { text: 26, icon: 22 }, `phone ${width} card`);
      const chips = await p.locator("[data-chip]").evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().height)));
      assert(chips.every((h) => h === 26), `chips ${chips}`);
    });

    await check(`${width}: a tap opens the details, a long press the actions`, async () => {
      const card = p.locator(`[data-schedule-card="${seeded.ids.reminder}"]`);
      await card.scrollIntoViewIfNeeded();
      await card.locator("button").first().click();
      const detail = p.locator(`[data-schedule-detail="${seeded.ids.reminder}"]`).last();
      await detail.waitFor();
      await p.screenshot({ path: join(artifacts, `08-phone-${width}-detail.png`) });
      const heights = await detail.locator("button:not([role=switch])").evaluateAll((bs) => bs.filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().height)));
      assert(heights.every((h) => h === 26 || h === 22), `detail buttons ${heights}`);
      await p.keyboard.press("Escape");
      await p.mouse.click(5, 5).catch(() => {});
      await until("sheet closed", async () => (await p.locator(`[data-schedule-detail="${seeded.ids.reminder}"]`).count()) === 0, 5000).catch(() => {});
      const box = await p.locator(`[data-schedule-card="${seeded.ids.digest}"]`).boundingBox();
      await touch("touchStart", box.x + box.width - 40, box.y + 12);
      await p.waitForTimeout(700);
      await touch("touchEnd", box.x + box.width - 40, box.y + 12);
      await p.getByText("Run now", { exact: true }).last().waitFor({ timeout: 5000 });
      await p.screenshot({ path: join(artifacts, `09-phone-${width}-actions.png`) });
    });
    await phone.close();
  }
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (server.exitCode === null) server.kill("SIGKILL");
  console.log(`fixture server pid ${server.pid} stopped`);
  if (videoDir) {
    const raw = join(videoDir, "raw");
    const files = existsSync(raw) ? (await readdir(raw)).filter((f) => f.endsWith(".webm")) : [];
    const names = ["desktop-1440-and-800", "phone-390", "phone-320"];
    for (const [i, f] of files.entries()) await rename(join(raw, f), join(videoDir, `${String(i + 1).padStart(2, "0")}-${names[i] ?? "page"}.webm`)).catch(() => {});
  }
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
