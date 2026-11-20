// PPM Assistant "Full mode" (Settings → PPM Assistant → Permissions, `permission_mode`), end to end.
// The production Vite bundle against a disposable server (tests/e2e/fixtures/assistant-server.ts with
// PPM_ASSISTANT_FAKE_TELEGRAM=1): scripted providers stand in for Claude and Codex, and a fake
// Telegram Bot API (tests/e2e/fixtures/fake-telegram-server.ts) stands in for the phone.
//
// What it proves:
//   FM1  Full, typed in PPM: the Assistant's send_to_session to a non-manager chat of another
//        project raises no card and the target chat receives the message.
//   FM2  Full, from Telegram: the same send raises no card and the fake Bot API is sent no
//        Allow/Deny message for it.
//   FM3  Full, hard limit: a git push still raises a card (Deny leaves nothing pushed).
//   FM4  Full, PPM-started turn: a watch wake-up that tries the same send is refused, no card.
//   FM5  Ask (regression): the same send raises a card; Deny keeps the message out of the target.
//   FM6  UI: Settings → Permissions → Full asks for confirmation; the window's head chip then reads
//        "Full"; flipping the chip back reads "Ask" and Settings agrees. Desktop 1440×900 and phone
//        390×844.
//   Feature intro: the "PPM has new features" step for assistant-full-mode-2026-11 shows while the
//        question is unanswered (its own server run, PPM_FIXTURE_LEAVE_INTROS).
//
// Screenshots go to PPM_FULL_MODE_ARTIFACTS. PPM_FULL_MODE_PHASE=before runs only the BEFORE
// screenshots (Settings → Permissions and the Assistant head) against a checkout of origin/main,
// where those controls have no Full mode yet.
//
// Needs Node 20+ with the `ws` package for the WebSocket global (the e2e image's Node has none),
// Bun (the fixtures), a Playwright module (PPM_PLAYWRIGHT_MODULE) and Chromium
// (PPM_PLAYWRIGHT_EXECUTABLE). No real Telegram, no real model, no real PPM data: PPM_HOME and HOME
// are scratch folders. See the Docker command in the commit message.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, labelsOf, phone, startChild, transcript, until } from "./assistant-telegram/harness.mjs";

if (typeof globalThis.WebSocket === "undefined") {
  // Node 20 has no WebSocket global; the fixture's own sockets are not used here, but the harness may open one.
  globalThis.WebSocket = (await import("ws")).WebSocket;
}

const REPO = resolve(".");
const PHASE = process.env.PPM_FULL_MODE_PHASE ?? "all";
const ARTIFACTS = resolve(process.env.PPM_FULL_MODE_ARTIFACTS ?? join(REPO, "plans/reports/screenshots-261120-assistant-full-mode"));
mkdirSync(ARTIFACTS, { recursive: true });
const sandbox = await mkdtemp(join(tmpdir(), "ppm-full-mode-e2e-"));
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const alpha = join(sandbox, "alpha"), beta = join(sandbox, "beta");
await Promise.all([ppm, home, alpha, beta].map((p) => mkdir(p, { recursive: true })));
await writeFile(join(alpha, "README.md"), "# Alpha\n");
await writeFile(join(beta, "README.md"), "# Beta\n\nBETA-README-CONTENT\n");
// alpha has a commit and a local bare remote, so a push gets as far as its card (and Deny stops it).
const remote = join(sandbox, "remote.git");
execFileSync("git", ["init", "-q", "--bare", remote]);
execFileSync("git", ["-C", alpha, "init", "-q", "-b", "main"]);
execFileSync("git", ["-C", alpha, "add", "."]);
execFileSync("git", ["-C", alpha, "-c", "user.email=e2e@ppm.test", "-c", "user.name=e2e", "commit", "-q", "-m", "first"]);
execFileSync("git", ["-C", alpha, "remote", "add", "origin", remote]);

const results = [];
const pass = (id, detail = "") => { results.push({ id, passed: true }); console.log(`PASS ${id}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TG_CHAT = 5101;
const SEEDED = [[String(TG_CHAT), String(TG_CHAT), "Phone owner"]];
const COMPOSER = ["Ask anything...", "Follow-up...", "Follow-up or Stop..."].map((p) => `textarea[placeholder="${p}"]:visible`).join(", ");
const CARD = "[data-assistant-body]:visible [data-approval-request]:visible, [data-assistant-body]:visible [data-collab-approval]:visible";

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port;
  await new Promise((r) => l.close(r));
  return port;
}

const fake = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: join(sandbox, "fake-telegram.log"), ready: /FAKE_TELEGRAM (\{.*\})/ });
const fakeInfo = JSON.parse((await fake.ready)[1]);
const port = await freePort();
const web = `http://127.0.0.1:${port}`;
const fx = fixtureApi(web);
const tg = phone(fakeInfo.control);

// The web bundle: a build of this checkout with Monaco staged beside it, as the fixture serves it.
const webDir = resolve(process.env.PPM_FULL_MODE_WEB_DIR ?? join(sandbox, "web"));
if (!process.env.PPM_FULL_MODE_WEB_DIR) {
  await new Promise((done, fail) => {
    const b = spawn("node", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; b.stdout.on("data", (s) => log += s); b.stderr.on("data", (s) => log += s);
    b.on("exit", (code) => (code ? fail(new Error(`vite build exited ${code}: ${log.slice(-2000)}`)) : done()));
  });
  cpSync(join(REPO, "node_modules/monaco-editor/min/vs"), join(webDir, "assets/monaco/vs"), { recursive: true });
}
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);

const fixtureEnv = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
  // Every "new features" question but Full mode's is answered "off" at startup, so only the
  // Full-mode step can show (and only in the run that leaves it unanswered).
  PPM_ASSISTANT_ANSWER_INTROS: "1",
  PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
  PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "180000",
  PPM_ASSISTANT_FAKE_TELEGRAM: "1",
  PPM_TELEGRAM_API_BASE: fakeInfo.api,
  PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: fakeInfo.token,
  PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify(SEEDED),
  PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "300",
  PPM_ASSISTANT_FIXTURE_WATCH_RETRY_MS: "3000",
  PPM_ASSISTANT_FIXTURE_WATCH_TICK_MS: "1000",
  PPM_ASSISTANT_FIXTURE_TG_DELAY_SCALE: "0.05",
};
delete fixtureEnv.PPM_ALLOW_PROD_DB;
delete fixtureEnv.PPM_ASSISTANT_FIXTURE_RESUME;
delete fixtureEnv.PPM_FIXTURE_LEAVE_INTROS;

let backend = null;
async function startBackend({ resume = false, leaveIntros = "" } = {}) {
  const env = { ...fixtureEnv, ...(resume ? { PPM_ASSISTANT_FIXTURE_RESUME: "1" } : {}), ...(leaveIntros ? { PPM_FIXTURE_LEAVE_INTROS: leaveIntros } : {}) };
  const started = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], { env, log: join(sandbox, `fixture-${Date.now()}.log`), ready: /Assistant fixture ready/ });
  backend = started.child;
  await started.ready;
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000);
}
async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((r) => backend.once("exit", r));
  await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
  const timer = setTimeout(() => backend.kill(), 5000);
  await exited;
  clearTimeout(timer);
}

const settingsBody = async () => (await fx.api("/api/assistant/settings")).data.settings;
const setPermission = async (mode) => {
  const s = await settingsBody();
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...s, permission_mode: mode }) });
  await until(`permission_mode ${mode}`, async () => (await settingsBody()).permission_mode === mode, 10000);
};
const newChat = async (project, title) => (await fx.api(`/api/project/${project}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title }) })).data.id;
const newAssistantSession = async () => newChat("__assistant__", "Full mode e2e");
const messagesOf = async (project, id) => JSON.stringify(await fx.api(`/api/project/${project}/chat/sessions/${id}/messages`));
const boundSession = async (chat) => (await until(`chat ${chat} bound`, async () => (await fx.tg("bindings")).find((b) => b.telegramChatId === String(chat)), 15000)).sessionId;
const recordOf = async (label) => until(`${label} done`, async () => (await fx.recordsOf(label)).find((r) => r.done), 120000);

const devices = [];
let browser = null;
async function device(name, kind, { dismissOnboarding = true } = {}) {
  const viewport = kind === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const context = await browser.newContext(kind === "phone"
    ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" }
    : { viewport, serviceWorkers: "block" });
  if (dismissOnboarding) {
    await context.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
    });
  }
  const page = await context.newPage();
  const dev = { name, kind, context, page, errors: [], maxCards: 0 };
  page.on("pageerror", (e) => dev.errors.push(String(e)));
  devices.push(dev);
  return dev;
}
const composer = (dev) => dev.page.locator("[data-assistant-body]:visible").first().locator(COMPOSER).first();
const cardCount = (dev) => dev.page.locator(CARD).count();
async function openAssistant(dev, sid) {
  await dev.page.goto(`${web}/assistant?session=claude/${sid}`);
  await composer(dev).waitFor({ timeout: 30000 });
}
async function send(dev, text) {
  await composer(dev).fill(text);
  await composer(dev).press("Enter");
}
/** Waits for `pred`, counting every card the device shows meanwhile. */
async function waitCounting(dev, label, pred, timeout = 120000) {
  return until(label, async () => {
    dev.maxCards = Math.max(dev.maxCards, await cardCount(dev));
    return pred();
  }, timeout, 150);
}
async function shot(dev, name, locator) {
  const path = join(ARTIFACTS, name);
  await (locator ?? dev.page).screenshot({ path });
  console.log(`SHOT ${path}`);
}
/** The Telegram chat's own Assistant session, set by FM2 and read by FM4. */
let telegramOwnerSession = null;

// ------------------------------------------------------------------ BEFORE (origin/main)
async function beforeShots() {
  await startBackend();
  await fx.post("/api/projects", { name: "alpha", path: alpha });
  const sid = await newAssistantSession();
  browser = await (await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE).href)).chromium.launch({
    headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  for (const [kind, width] of [["desktop", "1440"], ["phone", "390"]]) {
    const dev = await device(`before-${kind}`, kind);
    await openAssistant(dev, sid);
    await dev.page.locator('button[aria-label="PPM Assistant settings"]:visible').first().click();
    await dev.page.locator('[data-testid="assistant-settings-tab-general"]:visible').first().click();
    const block = dev.page.locator('[data-testid="assistant-permissions"]:visible').first();
    await block.waitFor({ timeout: 15000 });
    await block.scrollIntoViewIfNeeded();
    await shot(dev, `before-settings-${width}.png`, block);
    // Settings covers the Assistant (a full-screen tab on a phone): reopen the page for the head.
    await openAssistant(dev, sid);
    await shot(dev, `before-head-${width}.png`, dev.page.locator("[data-assistant-body]:visible").first());
    pass(`before-${kind}`, `Settings → Permissions and the Assistant head on ${kind}`);
    await dev.context.close();
  }
}

// ------------------------------------------------------------------ AFTER
async function featureIntroShots() {
  // A run of its own: the question stays unanswered until the screenshots are taken.
  await startBackend({ leaveIntros: "assistant-full-mode-2026-11" });
  await fx.post("/api/projects", { name: "alpha", path: alpha });
  const sid = await newAssistantSession();
  for (const kind of ["desktop", "phone"]) {
    const dev = await device(`intro-${kind}`, kind, { dismissOnboarding: false });
    await openAssistant(dev, sid);
    const step = dev.page.getByRole("dialog").filter({ hasText: /Full mode|new features/i }).first();
    await step.waitFor({ timeout: 30000 });
    await shot(dev, `after-feature-intro-${kind === "phone" ? "390" : "1440"}.png`);
    pass(`intro-${kind}`, "the Full-mode question shows as a new-feature step while unanswered");
    await dev.context.close();
  }
  await stopBackend();
  // Back on the same database: the next start answers every question "off" as the other suites do.
  await startBackend({ resume: true });
}

async function fullModeScenarios() {
  await fx.post("/api/projects", { name: "beta", path: beta });
  const desk = await device("desktop", "desktop");
  const sid = await newAssistantSession();
  await openAssistant(desk, sid);
  await setPermission("full");

  // FM1: PPM-typed turn, Full: send without a card.
  {
    const target = await newChat("beta", "FM1 target");
    await fx.script("fm1", [{ session: "send_to_session", args: { session_id: target, message: "FM1 hello beta" } }, { text: "FM1 sent." }], { match: "FM1 send" });
    await send(desk, "FM1 send to beta");
    await waitCounting(desk, "FM1 reply", () => desk.page.getByText("FM1 sent.").first().isVisible().catch(() => false), 120000);
    const rec = await recordOf("fm1");
    assert.equal(rec.isError, false, `FM1 refused: ${JSON.stringify(rec)}`);
    assert.equal(desk.maxCards, 0, "FM1: a card showed in Full mode");
    await until("FM1 delivered", async () => (await messagesOf("beta", target)).includes("FM1 hello beta"), 30000);
    pass("FM1", `send to beta without a card (max cards on screen ${desk.maxCards})`);
  }

  // FM2: Telegram-typed turn, Full: send without a card, nothing sent to Telegram as a card.
  {
    const target = await newChat("beta", "FM2 target");
    await fx.script("fm2", [{ session: "send_to_session", args: { session_id: target, message: "FM2 hello beta" } }, { text: "FM2 sent." }], { match: "FM2 send" });
    const mark = (await tg.calls()).total;
    await tg.send(TG_CHAT, "FM2 send to beta");
    await tg.waitText(TG_CHAT, "FM2 sent.", 120000);
    const rec = await recordOf("fm2");
    assert.equal(rec.isError, false, `FM2 refused: ${JSON.stringify(rec)}`);
    const sent = await tg.sent(TG_CHAT);
    assert(sent.every((m) => !labelsOf(m).some((l) => /^(Allow|Deny)/.test(l))), "FM2: a Telegram message carries an Allow/Deny button");
    const calls = await tg.calls(mark);
    assert(!calls.calls.some((c) => /"text":"(Allow|Deny)/.test(c.raw)), "FM2: Telegram API received an Allow/Deny card");
    await until("FM2 delivered", async () => (await messagesOf("beta", target)).includes("FM2 hello beta"), 30000);
    pass("FM2", `Telegram send without an Allow/Deny card (${calls.calls.length} Bot API calls in the turn)`);
    // The Assistant's chat after the Telegram turn, in the browser (the screenshot the report wants).
    const bound = await boundSession(TG_CHAT);
    await openAssistant(desk, bound);
    await desk.page.getByText("FM2 sent.").first().waitFor({ timeout: 30000 });
    await shot(desk, "after-telegram-no-card-1440.png", desk.page.locator("[data-assistant-body]:visible").first());
    const phoneDev = await device("phone-telegram", "phone");
    await openAssistant(phoneDev, bound);
    await phoneDev.page.getByText("FM2 sent.").first().waitFor({ timeout: 30000 });
    await shot(phoneDev, "after-telegram-no-card-390.png");
    await phoneDev.context.close();
    telegramOwnerSession = bound;
  }

  // FM3: hard limit: a git push still asks, in Full mode.
  {
    await fx.script("fm3", [{ mcp: "git_sync", args: { project: "alpha", action: "push" } }, { text: "FM3 done." }], { match: "FM3 push" });
    await openAssistant(desk, sid);
    await send(desk, "FM3 push the branch");
    try {
      await waitCounting(desk, "FM3 card", async () => (await cardCount(desk)) > 0, 120000);
    } catch (error) {
      await shot(desk, "debug-fm3-no-card.png");
      console.error(`FM3 records: ${JSON.stringify(await fx.recordsOf("fm3"))}`);
      console.error(`FM3 page text: ${(await desk.page.locator("[data-assistant-body]:visible").first().innerText().catch(() => "")).slice(-1500)}`);
      throw error;
    }
    await desk.page.locator(CARD).last().getByRole("button", { name: "Deny", exact: true }).click();
    await waitCounting(desk, "FM3 done", () => desk.page.getByText("FM3 done.").first().isVisible().catch(() => false), 120000);
    const pushed = execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"]).toString().trim();
    assert.equal(pushed, "", `FM3: a denied push reached the remote: ${pushed}`);
    pass("FM3", "git push raised a card in Full mode; Deny answered it and the remote stayed empty");
  }

  // FM4: PPM-started turn (a watch wake-up) is refused in Full mode, with no card.
  {
    const target = await newChat("beta", "FM4 watched");
    await fx.script("fm4-target", [{ sleep: 6000 }, { text: "FM4 finished." }], { match: "FM4 long task" });
    const started = await fetch(`${web}/api/project/beta/chat/sessions/${target}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "FM4 long task" }),
    });
    assert(started.ok, `FM4 target did not start: ${started.status}`);
    const owner = telegramOwnerSession;
    await fx.script("fm4-watch", [{ mcp: "chat_watch", args: { project: "beta", sessionId: target, providerId: "claude" } }, { text: "FM4 watching." }], { match: "FM4 watch it" });
    await tg.send(TG_CHAT, "FM4 watch it");
    await tg.waitText(TG_CHAT, "FM4 watching.", 60000);
    await fx.script("fm4-wake", [{ session: "send_to_session", args: { session_id: target, message: "FM4 wake" } }, { text: "FM4 wake done." }], { sessionId: owner });
    const wake = await recordOf("fm4-wake");
    assert.equal(wake.isError, true, `FM4 wake-up was not refused: ${JSON.stringify(wake)}`);
    assert(!(await messagesOf("beta", target)).includes("FM4 wake"), "FM4: the watched chat received a wake-up message");
    await openAssistant(desk, owner);
    await until("FM4 no card on screen", async () => (await cardCount(desk)) === 0, 10000);
    pass("FM4", `watch wake-up refused, no card (${JSON.stringify(wake.text ?? "").slice(0, 120)})`);
  }

  // FM5: Ask mode, the same send raises a card and Deny keeps the message out.
  {
    await setPermission("ask");
    const target = await newChat("beta", "FM5 target");
    await fx.script("fm5", [{ session: "send_to_session", args: { session_id: target, message: "FM5 hello beta" } }, { text: "FM5 finished." }], { match: "FM5 send" });
    await openAssistant(desk, sid);
    await send(desk, "FM5 send to beta");
    await waitCounting(desk, "FM5 card", async () => (await desk.page.locator("[data-assistant-body]:visible [data-collab-approval]:visible").count()) > 0, 120000);
    await desk.page.locator("[data-assistant-body]:visible [data-collab-approval]:visible").last().getByRole("button", { name: "Deny", exact: true }).click();
    await recordOf("fm5");
    assert(!(await messagesOf("beta", target)).includes("FM5 hello beta"), "FM5: a denied message reached the target");
    pass("FM5", "Ask mode: the send raised a card, Deny kept it out of beta");
  }

  // FM6: UI. Settings → Permissions → Full (confirm), head chip → Ask.
  await openAssistant(desk, sid);
  await desk.page.locator('button[aria-label="PPM Assistant settings"]:visible').first().click();
  await desk.page.locator('[data-testid="assistant-settings-tab-general"]:visible').first().click();
  const block = desk.page.locator('[data-testid="assistant-permissions"]:visible').first();
  await block.waitFor({ timeout: 15000 });
  await block.locator('[data-mode-option="full"]').click();
  const confirm = desk.page.getByRole("button", { name: "Use Full", exact: true });
  await confirm.waitFor({ timeout: 10000 });
  await shot(desk, "after-settings-confirm-full-1440.png");
  await confirm.click();
  await until("Full saved", async () => (await settingsBody()).permission_mode === "full", 10000);
  await block.scrollIntoViewIfNeeded();
  await shot(desk, "after-settings-full-1440.png", block);
  await desk.page.keyboard.press("Escape");
  await desk.page.locator('[data-assistant-mode="full"]:visible').first().waitFor({ timeout: 10000 });
  await shot(desk, "after-head-full-1440.png", desk.page.locator("[data-assistant-body]:visible").first());
  await desk.page.locator('[data-assistant-mode="full"]:visible').first().click();
  await until("chip flipped to Ask", async () => (await settingsBody()).permission_mode === "ask", 10000);
  await desk.page.locator('[data-assistant-mode="ask"]:visible').first().waitFor({ timeout: 10000 });
  pass("FM6-desktop", "Full via Settings asked to confirm; the chip read Full; the chip flipped to Ask");

  // Phone: the same switch from the Assistant's own head, and the Settings confirm as a bottom sheet.
  const phoneDev = await device("phone-ui", "phone");
  await openAssistant(phoneDev, sid);
  await phoneDev.page.locator('button[aria-label="PPM Assistant settings"]:visible').first().click();
  await phoneDev.page.locator('[data-testid="assistant-settings-tab-general"]:visible').first().click();
  const pblock = phoneDev.page.locator('[data-testid="assistant-permissions"]:visible').first();
  await pblock.waitFor({ timeout: 15000 });
  await pblock.locator('[data-mode-option="full"]').click();
  await phoneDev.page.getByRole("button", { name: "Use Full", exact: true }).waitFor({ timeout: 10000 });
  await sleep(400);
  await shot(phoneDev, "after-settings-full-390.png");
  await phoneDev.page.getByRole("button", { name: "Use Full", exact: true }).click();
  await until("Full saved on phone", async () => (await settingsBody()).permission_mode === "full", 10000);
  // On a phone Settings is a full-screen tab that Escape does not leave: reopen the Assistant instead.
  await openAssistant(phoneDev, sid);
  await phoneDev.page.locator('[data-assistant-mode="full"]:visible').first().waitFor({ timeout: 10000 });
  await shot(phoneDev, "after-head-full-390.png", phoneDev.page.locator("[data-assistant-body]:visible").first());
  await phoneDev.page.locator('[data-assistant-mode="full"]:visible').first().click();
  await until("phone chip flipped to Ask", async () => (await settingsBody()).permission_mode === "ask", 10000);
  await phoneDev.page.locator('[data-assistant-mode="ask"]:visible').first().waitFor({ timeout: 10000 });
  await phoneDev.context.close();
  pass("FM6-phone", "phone: confirm sheet, then the head chip reads Full");

  // Settings in Ask, for the report.
  await setPermission("ask");
  await openAssistant(desk, sid);
  await desk.page.locator('button[aria-label="PPM Assistant settings"]:visible').first().click();
  await desk.page.locator('[data-testid="assistant-settings-tab-general"]:visible').first().click();
  const askBlock = desk.page.locator('[data-testid="assistant-permissions"]:visible').first();
  await askBlock.waitFor({ timeout: 15000 });
  await askBlock.scrollIntoViewIfNeeded();
  await shot(desk, "after-settings-ask-1440.png", askBlock);
  await desk.page.keyboard.press("Escape");
  await desk.context.close();
}

try {
  if (PHASE === "before") {
    await beforeShots();
  } else {
    browser = await (await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE).href)).chromium.launch({
      headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
    });
    await featureIntroShots();
    await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);
    await fullModeScenarios();
    for (const dev of devices) {
      const unexpected = dev.errors.filter((e) => !/read the 'serviceWorker' property/.test(e));
      assert.deepEqual(unexpected, [], `page errors on ${dev.name}`);
    }
    await transcript(ARTIFACTS, "full-mode", tg, [TG_CHAT], Date.now());
    console.log(`${results.length} checks passed`);
  }
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  for (const dev of devices) await dev.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopBackend().catch(() => backend?.kill());
  if (fake.child.exitCode === null) fake.child.kill();
  await writeFile(join(ARTIFACTS, "results-full-mode.json"), JSON.stringify({ phase: PHASE, results }, null, 2)).catch(() => {});
  if (process.exitCode) console.error(`logs kept in ${sandbox}`);
  else { try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.exit(process.exitCode ?? 0);
}
