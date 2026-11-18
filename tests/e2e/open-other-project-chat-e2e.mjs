// Opening another project's chat from a button in a chat, end to end, on the production Vite bundle
// against the turn-reference fixture (tests/e2e/fixtures/session-turn-refs-server.ts) with
// PPM_TURN_REFS_COLLAB_CARDS=1, which adds alpha / G: a chat whose two `send_to_session` tool cards
// point at beta's D (another project) and at alpha's B (the same project).
//
//  1. Desktop, on alpha: "Open session" on the card to beta's chat opens it in a floating window;
//     the screen stays on alpha and beta's layout is not touched.
//  2. The same button again raises that window instead of opening a second one.
//  3. "Open session" on the card to alpha's own chat opens a tab, as before, and no window.
//  4. "Open in project" in the window's titlebar closes it and switches to beta.
//  5. Phone (390 wide, no windows): "Open session" on the card to beta's chat switches project.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/e2e/open-other-project-chat-e2e.mjs
//
// PPM_PLAYWRIGHT_EXECUTABLE=<chromium> or PPM_PLAYWRIGHT_CHANNEL=chrome picks the browser.
// PPM_TURN_REFS_WEB_DIR=<dir> keeps the bundle there (built on the first run, reused after).
// PPM_OPEN_WINDOW_ARTIFACTS=<dir> keeps the screenshots, results and the desktop video
// (open-other-project-chat-desktop.webm, 1440×900).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createKit, pageInit } from "./fixtures/session-turn-refs-helpers.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-open-window-e2e-"));
const artifacts = process.env.PPM_OPEN_WINDOW_ARTIFACTS ? resolve(process.env.PPM_OPEN_WINDOW_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), projects = join(sandbox, "projects"), videoTmp = join(sandbox, "video");
await Promise.all([artifacts, ppm, home, projects, videoTmp].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

const webDir = process.env.PPM_TURN_REFS_WEB_DIR ? resolve(process.env.PPM_TURN_REFS_WEB_DIR) : join(sandbox, "web");
if (!existsSync(join(webDir, "index.html"))) {
  await writeFile(join(artifacts, "vite.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}
if (!existsSync(join(webDir, "index.html"))) throw new Error(`No web bundle in ${webDir}`);

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
  PPM_TURN_REFS_WEB_DIR: webDir, PPM_TURN_REFS_PROJECTS: projects, PPM_TURN_REFS_COLLAB_CARDS: "1", PPM_TURN_REFS_UPLOAD_DELAY: "0",
};
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/session-turn-refs-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

const ctx = { current: null };
const kit = createKit({ web, artifacts, currentPage: () => ctx.current });
const { api, post, until, record, scenario, shot, results, failures, layoutOf } = kit;
const started = Date.now();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;

const WINDOWS = '[data-window-layer] [aria-roledescription="window"]';
/** The tool card messaging `title`, and its Open session button. */
const card = (page, title) => page.locator('[data-session-collab-card="send_to_session"]').filter({ hasText: title }).first();
const openButton = (page, title) => card(page, title).getByRole("button", { name: "Open session" });
/** The active project, as the app holds it (the tab store's current project). */
/**
 * For the recording only: a visible pointer (headless Chromium draws none) and a caption strip, so
 * a person watching the video can follow what is clicked and why.
 */
function demoOverlay() {
  if (window.top !== window) return;
  const add = () => {
    const dot = document.createElement("div");
    dot.id = "__demo-pointer";
    dot.style.cssText = "position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(239,68,68,.35);border:2px solid #ef4444;pointer-events:none;left:-40px;top:-40px;transition:transform .12s";
    const cap = document.createElement("div");
    cap.id = "__demo-caption";
    cap.style.cssText = "position:fixed;z-index:2147483646;left:50%;bottom:44px;transform:translateX(-50%);max-width:1100px;padding:10px 18px;border-radius:10px;background:rgba(17,24,39,.88);color:#fff;font:600 17px/1.4 system-ui,sans-serif;pointer-events:none;display:none;text-align:center";
    document.documentElement.append(dot, cap);
    addEventListener("mousemove", (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    addEventListener("mousedown", () => { dot.style.transform = "scale(.7)"; }, true);
    addEventListener("mouseup", () => { dot.style.transform = ""; }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", add); else add();
}
const caption = (page, text) => page.evaluate((t) => {
  const el = document.getElementById("__demo-caption");
  if (el) { el.textContent = t; el.style.display = t ? "block" : "none"; }
}, text);
/** Moves the pointer to the element where it can be seen, then clicks it. */
async function showClick(page, locator, hold = 700) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) { await locator.click(); return; }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  await pause(hold);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const activeProject = (page) => page.evaluate(() => {
  const m = location.pathname.match(/^\/project\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
});

try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 90000, 300);
  const ids = await api("/__turn-test/ids");
  assert(ids.G, "the fixture seeded the chat with tool cards");
  await post("/api/projects", { name: "alpha", path: ids.alpha });
  await post("/api/projects", { name: "beta", path: ids.beta });
  const { G, B, D } = ids;
  // Every "PPM has new features" question answered, so none covers the screen being recorded.
  const intros = (await api("/api/feature-intros")).data;
  for (const intro of intros?.pending ?? []) {
    if (intro?.id) await post(`/api/feature-intros/${encodeURIComponent(intro.id)}/answer`, { answer: "on" }).catch(() => {});
  }

  const tab = (s) => ({ id: `chat:claude/${s.id}`, type: "chat", title: s.title, projectId: s.project, closable: true, metadata: { projectName: s.project, sessionId: s.id, providerId: "claude" } });
  const panel = (id, tabs) => ({ id, tabs, activeTabId: tabs[0].id, tabHistory: tabs.map((t) => t.id) });
  const betaLayout = { panels: { main: panel("main", [tab(D)]) }, grid: [["main"]], focusedPanelId: "main" };
  async function resetLayout(page) {
    await api("/api/project/alpha/workspace", { method: "PUT", body: JSON.stringify({ layout: {
      panels: { main: panel("main", [tab(G)]) }, grid: [["main"]], focusedPanelId: "main",
    } }) });
    await api("/api/project/beta/workspace", { method: "PUT", body: JSON.stringify({ layout: betaLayout }) });
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("ppm-panels-") || key.startsWith("ppm-window")) localStorage.removeItem(key);
    });
    await page.goto(`${web}/project/alpha/chat/claude/${G.id}`);
    await card(page, "Billing export").waitFor({ timeout: 30000 });
  }

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  const executablePath = process.env.PPM_PLAYWRIGHT_EXECUTABLE;
  const channel = process.env.PPM_PLAYWRIGHT_CHANNEL;
  browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : channel ? { channel } : {}) });

  // ── Desktop, recorded ──
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 }, serviceWorkers: "block",
    recordVideo: { dir: videoTmp, size: { width: 1440, height: 900 } },
  });
  await desktop.addInitScript(pageInit);
  await desktop.addInitScript(demoOverlay);
  const recordingStarted = Date.now();
  const page = ctx.current = await desktop.newPage();
  const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${web}/project/alpha`);
  await resetLayout(page);
  // The video starts here: the page load before it is cut (see the trim below).
  const readyAt = (Date.now() - recordingStarted) / 1000;
  await page.mouse.move(700, 450);
  await caption(page, "Đang ở project alpha. Thẻ trên trỏ tới chat của project beta, thẻ dưới tới chat của alpha.");
  await pause(3000);
  await shot(page, "01-alpha-with-cards");

  await scenario("1", async () => {
    assert.equal(await page.locator(WINDOWS).count(), 0, "no window before the click");
    await caption(page, "Bấm “Open session” trên thẻ gửi tới chat của beta…");
    await showClick(page, openButton(page, "Billing export"));
    const win = page.locator(WINDOWS).first();
    await win.waitFor({ timeout: 15000 });
    await win.getByText("Billing export, question 1").first().waitFor({ timeout: 20000 });
    assert.equal(await page.locator(WINDOWS).count(), 1, "one window");
    assert.equal(await win.getAttribute("aria-label"), "Billing export", "the window shows beta's chat");
    assert(await win.getByRole("button", { name: "Open in project" }).isVisible(), "the window offers Open in project");
    assert.equal(await activeProject(page), "alpha", "the screen stays on alpha");
    assert(await card(page, "Billing export").isVisible(), "alpha's chat is still on screen behind the window");
    const alpha = await layoutOf(page, "alpha");
    assert(!Object.values(alpha?.panels ?? {}).some((p) => p.tabs.some((t) => t.metadata?.sessionId === D.id)), "beta's chat is not put into alpha's grid");
    await caption(page, "→ Chat của beta mở trong cửa sổ nổi. Màn hình vẫn ở project alpha.");
    await pause(3500);
    await shot(page, "02-beta-chat-in-window");
    record("1: on alpha, Open session on the card to beta's chat opens it in a floating window and the screen stays on alpha", { url: page.url() });
  });

  await scenario("2", async () => {
    // Bring alpha's chat to the front first, so raising the window is something to see.
    await caption(page, "Bấm lại lần nữa: cửa sổ cũ được đưa lên, không mở thêm cửa sổ.");
    await showClick(page, openButton(page, "Billing export"));
    await pause(2000);
    assert.equal(await page.locator(WINDOWS).count(), 1, "still one window");
    assert.equal(await page.locator(`${WINDOWS}[data-front]`).count(), 1, "the window is in front");
    record("2: the same button again raises that window instead of opening a second one");
  });

  await scenario("3", async () => {
    await caption(page, "Bấm “Open session” trên thẻ gửi tới chat của chính alpha…");
    await showClick(page, openButton(page, "Planning chat"));
    await until("B open as a tab in alpha", async () => {
      const layout = await layoutOf(page, "alpha");
      return Object.values(layout?.panels ?? {}).some((p) => p.tabs.some((t) => t.metadata?.sessionId === B.id && t.projectId === "alpha"));
    }, 15000);
    await page.getByText("Planning, question 1").first().waitFor({ timeout: 20000 });
    assert.equal(await page.locator(WINDOWS).count(), 1, "no second window for a chat of the same project");
    assert.equal(await activeProject(page), "alpha");
    await caption(page, "→ Cùng project: mở thành tab như cũ (tab “Planning chat”), không có cửa sổ mới.");
    await pause(3500);
    await shot(page, "03-same-project-opens-tab");
    record("3: Open session on the card to alpha's own chat opens a tab, as before, and no window", { url: page.url() });
  });

  await scenario("4", async () => {
    const win = page.locator(WINDOWS).first();
    await caption(page, "Muốn làm việc hẳn trong beta: bấm “Open in project” trên thanh tiêu đề cửa sổ.");
    await showClick(page, win.getByRole("button", { name: "Open in project" }), 1200);
    await until("switched to beta", async () => (await activeProject(page)) === "beta", 20000);
    await page.getByText("Billing export, question 1").first().waitFor({ timeout: 20000 });
    await until("window gone", async () => (await page.locator(WINDOWS).count()) === 0, 10000);
    await caption(page, "→ Cửa sổ đóng, màn hình chuyển sang project beta.");
    await pause(3000);
    await shot(page, "04-open-in-project");
    record("4: Open in project in the window's titlebar closes it and switches to beta", { url: page.url() });
  });

  const video = page.video();
  await desktop.close();
  if (video) {
    const target = join(artifacts, "open-other-project-chat-desktop.webm");
    // Cut the page load at the start: the run begins once alpha's chat is on screen.
    const raw = await video.path();
    const cut = spawn("ffmpeg", ["-v", "error", "-y", "-ss", readyAt.toFixed(2), "-i", raw, "-c:v", "libvpx", "-b:v", "2M", "-an", target]);
    const code = await new Promise((done) => { cut.on("exit", done); cut.on("error", () => done(-1)); });
    if (code !== 0) { await rm(target, { force: true }); await copyFile(raw, target); }
    console.log(`video ${target}`);
  }

  // ── Phone ──
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phone.addInitScript(pageInit);
  const mobile = ctx.current = await phone.newPage();
  await mobile.goto(`${web}/project/alpha`);
  await resetLayout(mobile);
  await scenario("5", async () => {
    await shot(mobile, "05-phone-alpha");
    await openButton(mobile, "Billing export").click();
    await until("switched to beta", async () => (await activeProject(mobile)) === "beta", 20000);
    await mobile.getByText("Billing export, question 1").first().waitFor({ timeout: 20000 });
    assert.equal(await mobile.locator(WINDOWS).count(), 0, "a phone has no windows");
    await pause(800);
    await shot(mobile, "06-phone-switched-to-beta");
    record("5: on a phone, Open session on the card to beta's chat switches to beta, as before", { url: mobile.url() });
  });
  await phone.close();

  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) console.log(`NOTE page errors: ${unexpected.join("\n")}`);
  if (failures.length) {
    process.exitCode = 1;
    console.log(`FAILED scenarios: ${failures.map((f) => f.scenario).join(", ")}`);
  }
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
  try { await ctx.current?.screenshot({ path: join(artifacts, "failure.png") }); } catch { /* page gone */ }
} finally {
  await browser?.close();
  backend.kill();
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${results.filter((r) => r.passed).length} passed, ${failures.length} failed in ${Math.round((Date.now() - started) / 1000)} s; artifacts in ${artifacts}`);
}
