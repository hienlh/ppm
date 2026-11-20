// The file browser reached by path, end to end, on the production Vite bundle against a disposable
// API/ws server whose only provider is scripted (tests/e2e/fixtures/file-browser-paths-server.ts):
//   1. a phone (390) opens it from a /files?path= link, edits the path, walks the breadcrumb, is
//      told plainly about a path that does not exist, and nothing is wider than the screen;
//   2. a desktop (1440) opens a file's folder from a link with the file selected;
//   3. the PPM Assistant's ui_open_file_browser opens a folder with a file selected through the real
//      endpoint, and is refused for ~/.ssh before any device is asked;
//   4. an ordinary chat's open_file opens a folder in the file browser, and the paths in its answer
//      become links only when they exist and are not private — on the desktop and the phone.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/e2e/file-browser-paths-e2e.mjs
//
// PPM_FB_WEB_DIR=<dir> serves that build; PPM_FB_MODE=before only takes the screenshots (a build
// without these features); PPM_FB_ARTIFACTS=<dir> keeps them.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const MODE = process.env.PPM_FB_MODE === "before" ? "before" : "after";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-fb-e2e-"));
const artifacts = process.env.PPM_FB_ARTIFACTS ? resolve(process.env.PPM_FB_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "demo");
const story = join(sandbox, "media", "tiktok", "story-2026-11-19-london");
const clip = join(story, "cut-01.mp4");
await Promise.all([artifacts, ppm, join(home, ".ssh"), join(project, "src"), join(project, "docs"), join(story, "photos")].map((p) => mkdir(p, { recursive: true })));
await writeFile(join(project, "src", "app.ts"), "export const app = 1;\n");
await writeFile(clip, "not really a video");
await writeFile(join(story, "notes.txt"), "shot list\n");
await writeFile(join(home, ".ssh", "id_rsa"), "-----not a key-----\n");

async function command(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

let webDir = process.env.PPM_FB_WEB_DIR;
if (!webDir) {
  webDir = join(sandbox, "web");
  await writeFile(join(artifacts, "build.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port), PPM_FB_WEB_DIR: webDir };
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/file-browser-paths-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

async function until(label, fn, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(body)}`); return body;
}

const NAME = "demo";
const results = [];
const record = (name) => { results.push({ name, passed: true }); console.log(`PASS ${name}`); };
const shot = async (page, name) => { await page.screenshot({ path: join(artifacts, `${MODE}-${name}.png`) }); };
const files = (path) => `${web}/files?path=${encodeURIComponent(path)}`;
let browser;

/** The answer a chat streams: a folder in code, a project file, a private key file and a missing folder. */
const ANSWER = [
  `Your clips are in \`${story}\` — the first is ${clip}.`,
  "",
  "I changed src/app.ts and left docs/ alone.",
  "",
  `Not linked: \`~/.ssh/id_rsa\` and ${join(sandbox, "nowhere", "at-all")}, nor and/or, 1/2 or 20/11/2026.`,
].join("\n");

async function sendTurn(page, ops, text) {
  const before = (await api("/__fb-test/state")).turns;
  await api("/__fb-test/script", { method: "POST", body: JSON.stringify({ ops }) });
  const composer = page.locator('textarea[aria-label="Message"]:visible').first();
  await composer.fill(text);
  await composer.press("Enter");
  await until(`turn ${before + 1} finished`, async () => (await api("/__fb-test/state")).turns > before, 30000);
  await page.locator(`text=Turn ${before + 1}: done.`).first().waitFor({ state: "attached", timeout: 15000 });
}

/** The front explorer window on a desktop: its path's last crumb and the row it selected. */
const frontWindow = (page) => page.locator('[role="group"][data-front]').last();

try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000);
  await command("git", ["init", "-q", project]);
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: NAME, path: project }) });

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true, executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE || undefined });
  const onboarding = () => {
    if (window.top !== window) return;
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
  };
  const phoneContext = () => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  const deskContext = () => browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  /** A fresh page in its own context, the onboarding tour already dismissed. */
  const freshPage = async (context) => { const ctx = await context(); await ctx.addInitScript(onboarding); return ctx.newPage(); };

  // ── 1. The phone's file browser ───────────────────────────────────────────────────────────────
  const phone = await phoneContext(); await phone.addInitScript(onboarding);
  const mobile = await phone.newPage();
  const pageErrors = []; mobile.on("pageerror", (e) => pageErrors.push(String(e)));
  if (MODE === "before") {
    await mobile.goto(`${web}/project/${NAME}`);
    await mobile.getByRole("button", { name: "Open menu" }).click();
    await mobile.getByRole("button", { name: "Files" }).click();
    await mobile.waitForTimeout(1200);
    await shot(mobile, "phone-390-file-browser");
  } else {
    await mobile.goto(files(story));
    const title = mobile.locator('button[aria-label^="Edit path:"]');
    await title.waitFor({ timeout: 30000 });
    const crumbs = mobile.locator('[data-testid="explorer-mobile-breadcrumb"] button');
    await until("the link opened the story folder", async () => (await crumbs.last().innerText()) === "story-2026-11-19-london");
    await mobile.locator(`[data-path="${clip}"]`).first().waitFor({ timeout: 10000 });
    await mobile.waitForTimeout(400);
    await shot(mobile, "phone-390-opened-by-link");
    record("phone: a /files?path= link opens the file browser at that folder");

    // The path field: a folder of the project typed in, then a path that does not exist.
    await title.click();
    const field = mobile.locator('input[aria-label="Path"]');
    await field.fill(join(project, "src"));
    await mobile.waitForTimeout(200);
    await shot(mobile, "phone-390-editing-path");
    await field.press("Enter");
    await until("the typed folder opened", async () => (await crumbs.last().innerText()) === "src");
    await mobile.locator(`[data-path="${join(project, "src", "app.ts")}"]`).first().waitFor({ timeout: 10000 });
    record("phone: typing a path and pressing Enter goes straight to that folder");

    await title.click();
    await field.fill(join(sandbox, "no-such-folder"));
    await mobile.getByRole("button", { name: "Go to path" }).click();
    const alert = mobile.locator('[role="alert"]', { hasText: "No folder or file at" });
    await alert.waitFor({ timeout: 10000 });
    await shot(mobile, "phone-390-bad-path");
    await mobile.getByRole("button", { name: "Cancel editing the path" }).click();
    record("phone: a path that does not exist is refused in plain words, the folder stays");

    // The breadcrumb: tap the project's own folder.
    await crumbs.filter({ hasText: /^demo$/ }).click();
    await until("the crumb opened its folder", async () => (await crumbs.last().innerText()) === "demo");
    record("phone: tapping a breadcrumb chip goes to that folder");

    // Chip heights follow the app's chip row; nothing is wider than the screen.
    const sizes = await mobile.evaluate(() => {
      const heights = [...document.querySelectorAll('[data-testid="explorer-mobile-breadcrumb"] button, [data-testid="explorer-places-strip"] button')]
        .map((b) => Math.round(b.getBoundingClientRect().height));
      return { heights, scroll: document.documentElement.scrollWidth, width: window.innerWidth };
    });
    assert.ok(sizes.heights.length > 0 && sizes.heights.every((h) => h === 26), `chips are 26px: ${sizes.heights}`);
    assert.ok(sizes.scroll <= sizes.width, `no page scroll sideways: ${sizes.scroll} > ${sizes.width}`);
    await shot(mobile, "phone-390-breadcrumb");
    record("phone: chips are 26px tall and nothing is wider than 390px");
  }

  // ── 2. The desktop: a file's link opens its folder with the file selected ─────────────────────
  const desk = await deskContext(); await desk.addInitScript(onboarding);
  const page = await desk.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  if (MODE === "after") {
    await page.goto(files(clip));
    const row = page.locator(`[data-path="${clip}"][aria-selected="true"]`);
    await row.first().waitFor({ timeout: 30000 });
    await shot(page, "desktop-1440-file-selected-by-link");
    record("desktop: a link to a file opens its folder with the file selected");

    // The desktop path field resolves the same way.
    const win = frontWindow(page);
    await win.getByRole("button", { name: "Edit path" }).click();
    await win.locator('input[aria-label="Path"]').fill(join(sandbox, "nope"));
    await win.locator('input[aria-label="Path"]').press("Enter");
    await win.locator('[role="alert"]', { hasText: "No folder or file at" }).waitFor({ timeout: 10000 });
    record("desktop: the path field says when a path does not exist");
    await page.keyboard.press("Escape");
  }

  // ── 3. The PPM Assistant's ui_open_file_browser ────────────────────────────────────────────────
  if (MODE === "after") {
    const { id } = (await api("/api/project/__assistant__/chat/sessions", { method: "POST", body: JSON.stringify({ providerId: "claude" }) })).data;
    const asst = await freshPage(deskContext);
    asst.on("pageerror", (e) => pageErrors.push(String(e)));
    await asst.goto(`${web}/assistant?session=claude/${id}`);
    await asst.locator('textarea[aria-label="Message"]:visible').first().waitFor({ timeout: 30000 });
    await sendTurn(asst, [
      { tool: "mcp__ppm-assistant__ui_open_file_browser", input: { path: join(story, "notes.txt") } },
      { tool: "mcp__ppm-assistant__ui_open_file_browser", input: { path: "~/.ssh" } },
      { text: "Opened it." },
    ], "open the london story folder");
    const answers = (await api("/__fb-test/state")).answers.filter((a) => a.tool.endsWith("ui_open_file_browser"));
    assert.equal(answers[0]?.isError, false, `opened: ${answers[0]?.output}`);
    assert.match(answers[0].output, /"select":\s*".*notes\.txt"/);
    assert.equal(answers[1]?.isError, true, "~/.ssh refused");
    assert.match(answers[1].output, /logins or keys/);
    await asst.locator(`[data-path="${join(story, "notes.txt")}"][aria-selected="true"]`).first().waitFor({ timeout: 10000 });
    assert.equal(await asst.locator(`[data-path="${join(home, ".ssh", "id_rsa")}"]`).count(), 0, "nothing from ~/.ssh on screen");
    await asst.waitForTimeout(400);
    await shot(asst, "desktop-1440-assistant-tool");
    record("Assistant: ui_open_file_browser opens the folder with the file selected; ~/.ssh is refused before any device is asked");
  }

  // ── 4. An ordinary chat: open_file on a folder, and the paths in its answer ────────────────────
  const sessionId = (await api(`/api/project/${NAME}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Video edits" }) })).data.id;
  const chatTab = { id: `chat-${sessionId}`, type: "chat", title: "Video edits", projectId: NAME, closable: true, metadata: { projectName: NAME, sessionId, providerId: "claude" } };
  await api(`/api/project/${NAME}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { main: { id: "main", tabs: [chatTab], activeTabId: chatTab.id, tabHistory: [chatTab.id] } }, grid: [["main"]], focusedPanelId: "main" } }) });
  const chat = await freshPage(deskContext);
  chat.on("pageerror", (e) => pageErrors.push(String(e)));
  await chat.goto(`${web}/project/${NAME}`);
  await chat.locator('textarea[aria-label="Message"]:visible').first().waitFor({ timeout: 30000 });
  await sendTurn(chat, [
    ...(MODE === "after" ? [{ tool: "mcp__ppm-tabs__open_file", input: { path: story } }] : []),
    { text: ANSWER },
  ], "where are my clips?");
  if (MODE === "after") {
    const openFile = (await api("/__fb-test/state")).answers.find((a) => a.tool.endsWith("open_file"));
    assert.equal(openFile?.isError, false, `open_file: ${openFile?.output}`);
    assert.match(openFile.output, /Opened the file browser at/);
    await chat.locator(`[data-path="${clip}"]`).first().waitFor({ timeout: 10000 });
    record("chat: open_file on a folder opens the file browser there");
    await frontWindow(chat).getByRole("button", { name: /close/i }).first().click().catch(() => {});

    const links = chat.locator("[data-local-path]");
    await until("the answer's paths were checked", async () => (await links.count()) >= 4, 10000);
    const linked = await links.allInnerTexts();
    assert.deepEqual(linked.sort(), [clip, "docs/", "src/app.ts", story].sort(), `linked: ${linked}`);
    record("chat: existing folders and files in an answer are links; ~/.ssh, a missing path and and/or, 1/2, dates are not");
  }
  await chat.waitForTimeout(400);
  await shot(chat, "desktop-1440-chat-answer");

  if (MODE === "after") {
    await chat.locator(`code[data-local-path="folder"]`).first().click();
    await chat.locator(`[data-path="${clip}"]`).first().waitFor({ timeout: 10000 });
    await shot(chat, "desktop-1440-chat-folder-link-opened");
    record("chat: clicking a folder in an answer opens the file browser there");
    await chat.locator('[data-local-path="file"]', { hasText: "src/app.ts" }).first().click();
    await until("the project file opened in the editor", async () => chat.evaluate(() => [...document.querySelectorAll('[role="tab"], [data-tab-id]')].some((el) => el.textContent?.includes("app.ts"))), 10000);
    record("chat: clicking a project code file opens it in the editor");
  }

  // The same answer on the phone.
  const phoneChat = await freshPage(phoneContext);
  await phoneChat.goto(`${web}/project/${NAME}`);
  await phoneChat.locator(`text=Turn`).first().waitFor({ timeout: 30000 });
  await phoneChat.waitForTimeout(800);
  await shot(phoneChat, "phone-390-chat-answer");
  if (MODE === "after") {
    await until("phone: the answer's paths are links", async () => (await phoneChat.locator("[data-local-path]").count()) >= 4, 10000);
    await phoneChat.locator(`code[data-local-path="folder"]`).first().click();
    await phoneChat.locator('button[aria-label^="Edit path:"]').waitFor({ timeout: 10000 });
    await until("phone: the sheet shows the story folder", async () => (await phoneChat.locator('[data-testid="explorer-mobile-breadcrumb"] button').last().innerText()) === "story-2026-11-19-london");
    await phoneChat.waitForTimeout(400);
    await shot(phoneChat, "phone-390-chat-folder-link-opened");
    record("phone: tapping a folder in an answer opens the file browser sheet there");
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
  }

  await writeFile(join(artifacts, `${MODE}-results.json`), JSON.stringify(results, null, 2));
  console.log(`DONE ${MODE}: ${results.length} checks passed; screenshots in ${artifacts}`);
} catch (e) {
  await writeFile(join(artifacts, `${MODE}-server.log`), serverLog).catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  backend.kill("SIGKILL");
}
