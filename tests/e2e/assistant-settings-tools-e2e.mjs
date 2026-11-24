// The PPM Assistant's settings tools (`settings_*`), end to end. The production Vite bundle against a
// disposable server (tests/e2e/fixtures/assistant-server.ts with PPM_ASSISTANT_FAKE_TELEGRAM=1):
// scripted providers call the real /api/assistant-mcp endpoint, and a fake Telegram Bot API
// (tests/e2e/fixtures/fake-telegram-server.ts) stands in for the phone.
//
// What it proves:
//   ST0  The "PPM has new features" step for assistant-settings-tools-2026-11 shows while unanswered.
//   ST1  Settings → PPM Assistant → Changes, opened through `/?openSettings=assistant:changes`:
//        its switch turns the tools on (off until chosen).
//   ST2  Full, typed in PPM: two ordinary settings change with no card; the chat card shows
//        before → after; its Undo puts one back.
//   ST3  Full, a permission setting still shows a card; Deny changes nothing.
//   ST4  Ask: an ordinary setting shows a card; Allow changes it; the chat card says "Allowed on card".
//   ST5  A secret is refused before any card, and its value never reaches the chat.
//   ST6  Full, from Telegram: the change comes back as a Telegram card with Undo; pressing it puts
//        the value back and the card says so.
//   ST7  From Telegram, a permission setting is a Telegram approval card (Allow/Deny), Deny holds.
//   ST8  An install is always a card that says what it downloads (denied here: no network).
//   ST9  The Changes tab lists them all, Undo from it works, on 1440 and 390.
//
//   PPM_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs [PPM_PLAYWRIGHT_CHANNEL=chrome] node tests/e2e/assistant-settings-tools-e2e.mjs
// PPM_SETTINGS_TOOLS_WEB_DIR reuses a scratch build; PPM_SETTINGS_TOOLS_ARTIFACTS is where screenshots go.
// No real Telegram, no real model, no network, no real PPM data: PPM_HOME and HOME are scratch folders.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, labelsOf, phone, startChild, until } from "./assistant-telegram/harness.mjs";

if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = (await import("ws")).WebSocket;

const REPO = resolve(".");
const ARTIFACTS = resolve(process.env.PPM_SETTINGS_TOOLS_ARTIFACTS ?? join(REPO, "plans/reports/screenshots-261121-assistant-settings-tools/after"));
mkdirSync(ARTIFACTS, { recursive: true });
const sandbox = await mkdtemp(join(tmpdir(), "ppm-settings-tools-e2e-"));
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), alpha = join(sandbox, "alpha");
await Promise.all([ppm, home, alpha].map((p) => mkdir(p, { recursive: true })));
await writeFile(join(alpha, "README.md"), "# Alpha\n");

const results = [];
const pass = (id, detail = "") => { results.push(id); console.log(`PASS ${id}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TG_CHAT = 5201;
const COMPOSER = ["Ask anything...", "Follow-up...", "Follow-up or Stop..."].map((p) => `textarea[placeholder="${p}"]:visible`).join(", ");
const BODY = "[data-assistant-body]:visible";
const CARD = `${BODY} [data-approval-request]:visible`;

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
// The Assistant's own bot token is a secret PPM holds: it must never reach a tool answer or the page.
const CANARY = fakeInfo.token;

const webDir = resolve(process.env.PPM_SETTINGS_TOOLS_WEB_DIR ?? join(sandbox, "web"));
if (!process.env.PPM_SETTINGS_TOOLS_WEB_DIR) {
  await new Promise((done, fail) => {
    const b = spawn("node", ["--max-old-space-size=4096", "node_modules/vite/bin/vite.js", "build", "--outDir", webDir], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; b.stdout.on("data", (s) => log += s); b.stderr.on("data", (s) => log += s);
    b.on("exit", (code) => (code ? fail(new Error(`vite build exited ${code}: ${log.slice(-2000)}`)) : done()));
  });
  cpSync(join(REPO, "node_modules/monaco-editor/min/vs"), join(webDir, "assets/monaco/vs"), { recursive: true });
}
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);

const fixtureEnv = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
  PPM_ASSISTANT_ANSWER_INTROS: "1",
  PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
  PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "180000",
  PPM_ASSISTANT_FAKE_TELEGRAM: "1",
  PPM_TELEGRAM_API_BASE: fakeInfo.api,
  PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: fakeInfo.token,
  PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify([[String(TG_CHAT), String(TG_CHAT), "Phone owner"]]),
  PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "300",
  PPM_ASSISTANT_FIXTURE_TG_DELAY_SCALE: "0.05",
};
for (const k of ["PPM_ALLOW_PROD_DB", "PPM_ASSISTANT_FIXTURE_RESUME", "PPM_FIXTURE_LEAVE_INTROS"]) delete fixtureEnv[k];

let backend = null;
const pids = [];
async function startBackend({ resume = false, leaveIntros = "" } = {}) {
  const env = { ...fixtureEnv, ...(resume ? { PPM_ASSISTANT_FIXTURE_RESUME: "1" } : {}), ...(leaveIntros ? { PPM_FIXTURE_LEAVE_INTROS: leaveIntros } : {}) };
  const started = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], { env, log: join(sandbox, `fixture-${Date.now()}.log`), ready: /Assistant fixture ready/ });
  backend = started.child;
  pids.push(backend.pid);
  console.log(`fixture pid ${backend.pid} on port ${port}`);
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

const assistantSettings = async () => (await fx.api("/api/assistant/settings")).data.settings;
const setPermission = async (mode) => {
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...(await assistantSettings()), permission_mode: mode }) });
  await until(`permission_mode ${mode}`, async () => (await assistantSettings()).permission_mode === mode, 10000);
};
const voice = async () => (await fx.api("/api/speech/voice-settings")).data;
const notifications = async () => (await fx.api("/api/notifications/settings")).data;
const theme = async () => (await fx.api("/api/settings/theme")).data.theme;
const recordOf = async (label) => until(`${label} done`, async () => (await fx.recordsOf(label)).find((r) => r.done), 120000);
const newAssistantSession = async () => (await fx.api("/api/project/__assistant__/chat/sessions", { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Settings tools e2e" }) })).data.id;

let browser = null;
async function device(kind, { dismissOnboarding = true } = {}) {
  const viewport = kind === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const context = await browser.newContext(kind === "phone" ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" } : { viewport, serviceWorkers: "block" });
  if (dismissOnboarding) {
    await context.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
    });
  }
  const page = await context.newPage();
  const dev = { kind, context, page, errors: [], width: viewport.width };
  page.on("pageerror", (e) => dev.errors.push(String(e)));
  return dev;
}
const composer = (dev) => dev.page.locator(BODY).first().locator(COMPOSER).first();
async function openAssistant(dev, sid) {
  await dev.page.goto(`${web}/assistant?session=claude/${sid}`);
  await composer(dev).waitFor({ timeout: 30000 });
}
async function send(dev, text) { await composer(dev).fill(text); await composer(dev).press("Enter"); }
async function shot(dev, name, locator) {
  const path = join(ARTIFACTS, `${name}-${dev.width}.png`);
  await (locator ?? dev.page).screenshot({ path });
  console.log(`SHOT ${path}`);
}
const settingsCard = (dev, tool = "settings_set") => dev.page.locator(`${BODY} [data-settings-tool-card="${tool}"]`).last();

function telegramPage(messages) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const bubble = (m) => {
    const rows = (m.reply_markup?.inline_keyboard ?? []).map((row) => `<div class="row">${row.map((b) => `<span class="btn">${esc(b.text)}${b.url ? " ↗" : ""}</span>`).join("")}</div>`).join("");
    return `<div class="msg"><div class="bubble">${m.html ?? esc(m.text)}</div>${rows ? `<div class="kb">${rows}</div>` : ""}</div>`;
  };
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#8eb8d6;font:15px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;padding:12px;width:366px}
    .head{background:#517da2;color:#fff;margin:-12px -12px 12px;padding:12px 16px;font-weight:600}
    .msg{margin:0 0 12px}.bubble{background:#fff;border-radius:12px 12px 12px 4px;padding:8px 11px;white-space:pre-wrap;word-wrap:break-word;color:#000}
    .kb{margin-top:4px}.row{display:flex;gap:4px;margin-top:4px}
    .btn{flex:1;text-align:center;background:rgba(0,0,0,.28);color:#fff;border-radius:8px;padding:8px 6px;font-size:14px;font-weight:500}
    .note{font-size:11px;color:#234;margin:0 0 10px}
  </style><div class="head">PPM Assistant (bot)</div><p class="note">Fake Telegram: the HTML and buttons PPM sent, drawn as Telegram would.</p>${messages.map(bubble).join("")}`;
}
async function telegramShot(name, messages) {
  const page = await browser.newPage({ viewport: { width: 390, height: 300 }, deviceScaleFactor: 2 });
  await page.setContent(telegramPage(messages));
  const path = join(ARTIFACTS, `${name}-390.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`SHOT ${path}`);
  await page.close();
}

try {
  browser = await (await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE).href)).chromium.launch({
    headless: true, ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });

  // ST0: the new-features question, in a run that leaves it unanswered.
  await startBackend({ leaveIntros: "assistant-settings-tools-2026-11" });
  await fx.post("/api/projects", { name: "alpha", path: alpha });
  {
    const sid = await newAssistantSession();
    for (const kind of ["desktop", "phone"]) {
      const dev = await device(kind, { dismissOnboarding: false });
      await openAssistant(dev, sid);
      const step = dev.page.getByRole("dialog").filter({ hasText: /changes settings for you/i }).first();
      await step.waitFor({ timeout: 30000 });
      await shot(dev, "feature-intro");
      await dev.context.close();
    }
    assert.equal((await assistantSettings()).settings_tools, undefined, "the question settled itself");
    pass("ST0", "the new-features step shows while unanswered (1440 and 390)");
  }
  await stopBackend();
  await startBackend({ resume: true });
  assert.equal((await assistantSettings()).settings_tools, false, "answering every intro 'off' left the tools on");

  const desk = await device("desktop");
  const sid = await newAssistantSession();

  // ST1: the Changes tab through its deep link; the switch turns the tools on.
  {
    await desk.page.goto(`${web}/?openSettings=assistant:changes`);
    const pane = desk.page.locator('[data-testid="assistant-settings-changes"]:visible').first();
    await pane.waitFor({ timeout: 30000 });
    const sw = pane.getByRole("switch", { name: "Let the Assistant change settings" });
    assert.equal(await sw.getAttribute("aria-checked"), "false");
    await sw.click();
    await until("settings_tools on", async () => (await assistantSettings()).settings_tools === true, 10000);
    pass("ST1", "deep link opens Changes; the switch turns the tools on");
  }

  await openAssistant(desk, sid);
  await setPermission("full");

  // ST2: Full, two ordinary settings, no card; Undo from the chat card.
  {
    // A fresh install sends voice as heard (no Haiku): start from Haiku on, so turning it off is a change.
    await fx.api("/api/speech/voice-settings", { method: "PUT", body: JSON.stringify({ cleanupEnabled: true }) });
    await fx.script("st2", [{ mcp: "settings_set", args: { changes: [{ key: "voice.cleanup_enabled", value: false }, { key: "notifications.delay_seconds", value: 120 }] } }, { text: "ST2 done." }], { match: "ST2" });
    await send(desk, "ST2 tắt Haiku dọn chữ và cho thông báo chờ 2 phút");
    await desk.page.getByText("ST2 done.").first().waitFor({ timeout: 120000 });
    assert.equal(await desk.page.locator(CARD).count(), 0, "ST2: a card showed in Full mode");
    assert.equal((await voice()).cleanupEnabled, false);
    assert.equal((await notifications()).delay_seconds, 120);
    const card = settingsCard(desk);
    await card.waitFor();
    assert.match(await card.innerText(), /2 settings changed[\s\S]*Full mode, no card[\s\S]*On[\s\S]*Off/);
    await shot(desk, "chat-card-full", desk.page.locator(BODY).first());
    await card.locator("[data-undo-change]").first().click();
    await until("ST2 undo", async () => (await voice()).cleanupEnabled === true, 15000);
    await card.getByText("Undone").first().waitFor({ timeout: 10000 });
    pass("ST2", "Full changes two settings with no card; the card's Undo puts one back");
  }

  // ST3: a permission setting asks even in Full; Deny holds.
  {
    const before = (await assistantSettings()).act_on_own;
    await fx.script("st3", [{ mcp: "settings_set", args: { changes: [{ key: "assistant.act_on_own", value: !before }] } }, { text: "ST3 done." }], { match: "ST3" });
    await send(desk, "ST3 let yourself act on your own");
    const card = desk.page.locator(CARD).last();
    await card.waitFor({ timeout: 60000 });
    assert.match(await card.innerText(), /asks even in Full mode/);
    await shot(desk, "approval-card-full", desk.page.locator(BODY).first());
    await card.getByRole("button", { name: "Deny", exact: true }).click();
    await desk.page.getByText("ST3 done.").first().waitFor({ timeout: 60000 });
    assert.equal((await assistantSettings()).act_on_own, before);
    pass("ST3", "a permission setting shows a card in Full mode; Deny changes nothing");
  }

  // ST4: Ask: an ordinary setting asks; Allow changes it.
  {
    await setPermission("ask");
    await fx.script("st4", [{ mcp: "settings_set", args: { changes: [{ key: "theme.mode", value: "light" }] } }, { text: "ST4 done." }], { match: "ST4" });
    await send(desk, "ST4 switch to the light theme");
    const card = desk.page.locator(CARD).last();
    await card.waitFor({ timeout: 60000 });
    await card.getByRole("button", { name: "Allow", exact: true }).click();
    await desk.page.getByText("ST4 done.").first().waitFor({ timeout: 60000 });
    assert.equal((await theme()).mode, "light");
    assert.match(await settingsCard(desk).innerText(), /Allowed on card/);
    pass("ST4", "Ask mode asks for an ordinary setting; Allow changes it");
    await setPermission("full");
  }

  // ST5: a secret is refused before any card; the canary never reaches the chat.
  {
    await fx.script("st5", [{ mcp: "settings_set", args: { changes: [{ key: "telegram.bot_token", value: "123:new" }] } }, { mcp: "settings_get", args: { keys: ["assistant.telegram.bot_token", "telegram.bot_token"] } }, { text: "ST5 done." }], { match: "ST5" });
    await send(desk, "ST5 change the bot token");
    await desk.page.getByText("ST5 done.").first().waitFor({ timeout: 60000 });
    const recs = await fx.recordsOf("st5");
    assert.equal(recs[0].isError, true, "ST5: a secret was written");
    assert.match(recs[1].text, /"set": true/, "ST5: the stored bot token is not reported as set");
    assert(!JSON.stringify(recs).includes(CANARY) && !(await desk.page.content()).includes(CANARY), "ST5: the secret reached the chat");
    pass("ST5", "a secret is refused, and its value reaches neither the tool answer nor the page");
  }

  // ST6: from Telegram, Full: the change comes back as a Telegram card; Undo there works.
  let tgMessages = [];
  {
    await fx.script("st6", [{ mcp: "settings_set", args: { changes: [{ key: "notifications.events.done", value: false }] } }, { text: "ST6 done." }], { match: "ST6" });
    await tg.send(TG_CHAT, "ST6 tắt thông báo khi chat xong");
    await tg.waitText(TG_CHAT, "ST6 done.", 120000);
    const cardMsg = await tg.waitFor(TG_CHAT, "settings card", (m) => m.text.includes("Changed 1 setting"), 30000);
    assert.equal((await notifications()).events.done, false);
    assert.deepEqual(labelsOf(cardMsg).filter((l) => l.includes("Undo")), ["↩️ Undo"]);
    tgMessages = [cardMsg];
    await tg.pressLabel(TG_CHAT, cardMsg, "↩️ Undo");
    await until("ST6 undo", async () => (await notifications()).events.done === true, 15000);
    const edited = await tg.waitFor(TG_CHAT, "card edited Undone", (m) => m.message_id === cardMsg.message_id && m.text.includes("Undone"), 15000);
    await telegramShot("telegram-changed", [cardMsg, edited]);
    pass("ST6", "a Telegram turn's change comes back as a card; its Undo puts the value back");
  }

  // ST7: from Telegram, a permission setting is a Telegram approval card; Deny holds.
  {
    const before = (await assistantSettings()).auto_readonly_commands;
    await fx.script("st7", [{ mcp: "settings_set", args: { changes: [{ key: "assistant.auto_readonly_commands", value: !before }] } }, { text: "ST7 done." }], { match: "ST7" });
    await tg.send(TG_CHAT, "ST7 stop running read-only commands by yourself");
    const approval = await tg.waitFor(TG_CHAT, "approval card", (m) => labelsOf(m).some((l) => /Allow/.test(l)) && m.text.includes("Run read-only commands"), 60000);
    await telegramShot("telegram-approval", [approval]);
    await tg.pressLabel(TG_CHAT, approval, labelsOf(approval).find((l) => /Deny/.test(l)));
    await tg.waitText(TG_CHAT, "ST7 done.", 60000);
    assert.equal((await assistantSettings()).auto_readonly_commands, before);
    pass("ST7", "from Telegram a permission setting is an Allow/Deny card; Deny holds");
  }

  // ST8: an install is always a card naming what it downloads; denied (this run has no network).
  {
    await fx.script("st8", [{ mcp: "settings_install", args: { component: "whisper", option: "base-q5_1" } }, { text: "ST8 done." }], { match: "ST8" });
    await openAssistant(desk, sid);
    await send(desk, "ST8 install Whisper");
    const card = desk.page.locator(CARD).last();
    await card.waitFor({ timeout: 60000 });
    assert.match(await card.innerText(), /Download and install[\s\S]*SHA-256[\s\S]*asks even in Full mode/);
    await shot(desk, "install-card", desk.page.locator(BODY).first());
    await card.getByRole("button", { name: "Deny", exact: true }).click();
    await desk.page.getByText("ST8 done.").first().waitFor({ timeout: 60000 });
    pass("ST8", "an install shows a card in Full mode, naming the download and its check");
  }

  // ST9: the Changes tab, desktop and phone; Undo from it.
  {
    await desk.page.goto(`${web}/?openSettings=assistant:changes`);
    const pane = desk.page.locator('[data-testid="assistant-settings-changes"]:visible').first();
    await pane.waitFor({ timeout: 30000 });
    await pane.locator("[data-setting-change]").first().waitFor({ timeout: 15000 });
    await shot(desk, "changes-tab");
    const delay = pane.locator("[data-setting-change]").filter({ hasText: "Wait before notifying" }).filter({ hasText: "120 seconds" }).first();
    await delay.locator("[data-undo-change]").click();
    await until("ST9 undo", async () => (await notifications()).delay_seconds !== 120, 15000);
    const mob = await device("phone");
    await mob.page.goto(`${web}/?openSettings=assistant:changes`);
    await mob.page.locator('[data-testid="assistant-settings-changes"]:visible').first().waitFor({ timeout: 30000 });
    await shot(mob, "changes-tab");
    await openAssistant(mob, sid);
    await mob.page.locator(`${BODY} [data-settings-tool-card="settings_set"]`).first().scrollIntoViewIfNeeded();
    await shot(mob, "chat-card");
    for (const d of [desk, mob]) assert.deepEqual(d.errors, [], `page errors on ${d.kind}`);
    pass("ST9", "Changes lists the Assistant's changes on 1440 and 390, and its Undo works");
  }

  console.log(`\nALL ${results.length} PASSED (${results.join(", ")}); fixture pids: ${pids.join(", ")}`);
} finally {
  await browser?.close().catch(() => {});
  await stopBackend().catch(() => {});
  await tg.exit();
  fake.child.kill();
  console.log(`stopped fixture pids ${pids.join(", ")} and fake Telegram pid ${fake.child.pid}`);
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
}
