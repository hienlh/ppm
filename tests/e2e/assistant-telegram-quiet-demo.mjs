// "Quiet while I'm at PPM", shown end to end: the production Vite bundle against a disposable PPM
// (tests/e2e/fixtures/assistant-server.ts with PPM_ASSISTANT_FAKE_TELEGRAM=1, a scratch PPM_HOME and
// a free port), a scripted provider in place of the model, and the fake Telegram Bot API in place
// of the phone. A desktop (1366×900) and a phone (390×844) browser play PPM. Every message the bot
// sends is written to a log with whether it carried `disable_notification`.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/e2e/assistant-telegram-quiet-demo.mjs
//
// PPM_TELEGRAM_QUIET_MS shortens "five minutes" to 20 s so the run takes about two minutes.
// Screenshots, telegram-log.txt and results.json go to PPM_QUIET_DEMO_OUT. Needs a scratch web
// build (dist/web with Monaco staged, or PPM_ASSISTANT_WEB_DIR).
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { browserKit, fixtureApi, phone, sleep, startChild, until } from "./assistant-telegram/harness.mjs";

const QUIET_MS = 20_000;
const OWNER = 1001;
const out = resolve(process.env.PPM_QUIET_DEMO_OUT ?? "plans/reports/screenshots-261114-telegram-quiet");
const sandbox = await mkdtemp(join(tmpdir(), "ppm-tg-quiet-demo-"));
const logs = resolve(process.env.PPM_QUIET_DEMO_LOGS ?? join(sandbox, "logs")), ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), alpha = join(sandbox, "alpha");
await Promise.all([out, logs, ppm, home, alpha].map((p) => mkdir(p, { recursive: true })));
await writeFile(join(alpha, "README.md"), "# Alpha\n");
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port;
  await new Promise((r) => l.close(r));
  return port;
}

const steps = [];
const results = [];
let fake, backend, browser, web, backendPid = null;

/** Every send to the owner's chat since call index `from`, as the log shows it. */
async function sendsSince(tg, from) {
  const { calls } = await tg.calls(from);
  return calls.filter((c) => c.chatId === OWNER && c.method === "sendMessage" && c.failed === null).map((c) => {
    const body = JSON.parse(c.raw);
    return { text: c.text ?? "", silent: body.disable_notification === true, replyTo: body.reply_parameters?.message_id ?? null };
  });
}

async function step(tg, title, fn) {
  const from = (await tg.calls(0)).total;
  const startedAt = new Date().toISOString();
  await fn();
  await sleep(800);
  const sends = await sendsSince(tg, from);
  steps.push({ title, startedAt, from, sends });
  return sends;
}

/** The titlebar (or head) around the bell, wide enough to see the title and the gear beside it. */
async function closeup(dev, locator, file) {
  const box = await locator.boundingBox();
  const vp = dev.page.viewportSize();
  const width = Math.min(420, vp.width), height = 56;
  const x = Math.max(0, Math.min(vp.width - width, box.x + box.width + 60 - width));
  const y = Math.max(0, box.y + box.height / 2 - height / 2);
  await dev.page.screenshot({ path: join(out, file), clip: { x, y, width, height } });
}

/** Telegram HTML as the phone shows it. */
const plain = (html) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const pass = (name, detail = {}) => { results.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };

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
    PPM_ASSISTANT_FAKE_TELEGRAM: "1",
    PPM_TELEGRAM_API_BASE: fakeInfo.api,
    PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: fakeInfo.token,
    PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify([[String(OWNER), String(OWNER), "Owner's phone"]]),
    PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "300",
    PPM_ASSISTANT_FIXTURE_TG_DELAY_SCALE: "0.05",
    PPM_TELEGRAM_QUIET_MS: String(QUIET_MS),
    // Manager chats and their cards ("Waiting on you"), as the manager-loop e2e runs them.
    PPM_ASSISTANT_MANAGER_LOOP: "1",
  };
  delete env.PPM_ALLOW_PROD_DB;
  const started = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], { env, log: join(logs, "fixture.log"), ready: /Assistant fixture ready/ });
  backend = started.child;
  backendPid = backend.pid;
  await started.ready;
  console.log(`temporary PPM pid=${backendPid} at ${web} (PPM_HOME=${ppm})`);
  const fx = fixtureApi(web);
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000);
  await fx.post("/api/projects", { name: "alpha", path: alpha });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, channel: process.env.PPM_PLAYWRIGHT_CHANNEL || undefined,
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  const kit = browserKit({ web, shotsDir: out, browser });
  const desk = await kit.open("desktop", "desktop");
  const mobile = await kit.open("phone", "phone");
  const tg = phone(fakeInfo.control);
  const bell = (dev) => dev.page.locator('button[aria-label^="Quiet while I\'m at PPM"]:visible').first();

  // 1. Typed on Telegram: answered as before, with a sound.
  await fx.script("demo-phone", [{ text: "Chào anh, em là PPM Assistant." }], { match: "chào từ điện thoại" });
  let sends = await step(tg, "1. Typed on Telegram (phone in hand): answered as before", async () => {
    await tg.send(OWNER, "chào từ điện thoại");
    await tg.waitText(OWNER, "Chào anh, em là PPM Assistant.");
  });
  assert.ok(sends.length > 0 && sends.every((s) => !s.silent), "a turn typed on Telegram rings");
  pass("typed on Telegram: every send rings");
  const binding = await until("bound", async () => (await fx.tg("bindings")).find((b) => b.telegramChatId === String(OWNER)));
  const link = `${web}/assistant?session=${binding.providerId}/${binding.sessionId}`;

  // The Assistant on both devices, and the bell beside its gear.
  await kit.openLink(desk, link);
  await bell(desk).waitFor({ timeout: 20000 });
  assert.equal(await bell(desk).getAttribute("aria-pressed"), "true");
  await kit.openLink(mobile, link);
  await bell(mobile).waitFor({ timeout: 20000 });
  pass("the bell shows in the Assistant window on desktop and on the phone, on");

  // 2. Typed in PPM: mirrored and answered, without a sound.
  await fx.script("demo-ppm", [{ text: "Đây là câu trả lời cho câu gõ ở PPM." }], { match: "câu hỏi gõ ở PPM" });
  sends = await step(tg, "2. Typed in PPM: mirrored and answered without a sound", async () => {
    await kit.typeAndSend(desk, "câu hỏi gõ ở PPM");
    await tg.waitText(OWNER, "Đây là câu trả lời cho câu gõ ở PPM.");
  });
  assert.ok(sends.length >= 2 && sends.every((s) => s.silent), `typed in PPM: all silent (${JSON.stringify(sends)})`);
  pass("typed in PPM: the copy and the answer are silent");
  await kit.shot(desk, "02-typed-in-ppm");

  // 3. A card while at PPM: silent, then one reminder with a sound after the window.
  await fx.script("demo-card", [{ builtin: "Bash", input: { command: "git push origin main" } }], { match: "đẩy code lên" });
  let card;
  sends = await step(tg, `3. A card while at PPM: silent; unanswered for ${QUIET_MS / 1000} s ("5 minutes"), one reminder with a sound`, async () => {
    await kit.typeAndSend(desk, "đẩy code lên");
    card = await tg.waitText(OWNER, "git push origin main");
    await tg.waitFor(OWNER, "reminder", (m) => m.reply_to === card.message_id, QUIET_MS + 15000);
  });
  const cardSend = sends.find((s) => s.text.includes("git push origin main"));
  const reminder = sends.find((s) => s.replyTo === card.message_id);
  assert.ok(cardSend?.silent, "the card went out silently");
  assert.ok(reminder && !reminder.silent, "the reminder rings");
  pass("card while at PPM: silent, then one reminder that rings, as a reply to the card");
  await kit.shot(desk, "03-card-waiting");
  await sleep(QUIET_MS + 2000);
  assert.equal((await tg.sent(OWNER)).filter((m) => m.reply_to === card.message_id).length, 1, "only one reminder");
  pass("only one reminder per card");
  await tg.pressLabel(OWNER, await tg.message(OWNER, card.message_id), "Deny");
  await tg.waitFor(OWNER, "card answered", (m) => m.message_id === card.message_id && /Denied/.test(m.text));

  // 4. Typed in PPM, then the user leaves: the final answer rings.
  await fx.script("demo-long", [{ text: "Đang chạy kiểm tra…" }, { sleep: QUIET_MS + 6000 }, { text: " Xong, mọi thứ ổn." }], { match: "việc dài" });
  sends = await step(tg, `4. Typed in PPM, then no input for ${(QUIET_MS + 6000) / 1000} s before the turn ends: the final answer rings`, async () => {
    await kit.typeAndSend(desk, "việc dài");
    await tg.waitFor(OWNER, "final answer", (m) => m.text.includes("Xong, mọi thứ ổn."), QUIET_MS + 30000);
  });
  const final = sends.findLast((s) => s.text.includes("Xong, mọi thứ ổn."));
  assert.ok(final && !final.silent, "the final answer rings after the user left");
  assert.ok(sends.filter((s) => !s.text.includes("Xong")).every((s) => s.silent), "the copy and the draft were silent");
  pass("left PPM before the turn ended: the final answer rings, earlier messages were silent");

  // 5. /quiet on the phone turns it off; the bell follows; everything rings again.
  sends = await step(tg, "5. /quiet on the phone, then Turn off", async () => {
    await tg.send(OWNER, "/quiet");
    const status = await tg.waitText(OWNER, "Quiet while you are at PPM: on.");
    await tg.pressLabel(OWNER, status, "Turn off");
    await tg.waitText(OWNER, "Quiet while you are at PPM: off.");
  });
  await until("desktop bell off", async () => (await bell(desk).getAttribute("aria-pressed")) === "false", 15000);
  await kit.shot(desk, "05-bell-off-after-quiet-off");
  await closeup(desk, bell(desk), "desktop-05b-bell-off-closeup.png");
  pass("/quiet off from the phone: the desktop bell follows without a reload");
  await fx.script("demo-off", [{ text: "Công tắc tắt: tin này có chuông." }], { match: "gõ khi đã tắt" });
  sends = await step(tg, "6. Switch off: typed in PPM rings as before", async () => {
    await kit.typeAndSend(desk, "gõ khi đã tắt");
    await tg.waitText(OWNER, "Công tắc tắt: tin này có chuông.");
  });
  assert.ok(sends.length >= 2 && sends.every((s) => !s.silent), "with the switch off everything rings");
  pass("switch off: everything rings as before");

  // 7. The bell turns it back on.
  await bell(desk).click();
  await until("desktop bell on", async () => (await bell(desk).getAttribute("aria-pressed")) === "true", 15000);
  await kit.shot(desk, "07-bell-on-again");
  pass("the bell turns it back on");

  // 8. A manager chat's cards: a decision while at PPM is silent and waits in "Waiting on you";
  //    an urgent one rings even while at PPM.
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" } }) });
  const lead = (await fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: "Alpha lead" })).data.id;
  const managerSay = async (label, ops, text) => {
    await fx.script(label, ops, { match: text, sessionId: lead });
    await fx.post("/__assistant-test/say", { project: "alpha", sessionId: lead, text, permissionMode: "default" });
    await until(`${label} ran`, () => fx.turnOf(label), 30000);
    await until(`${label} done`, async () => {
      const mine = await fx.recordsOf(label);
      return mine.every((c) => c.done) ? true : null;
    }, 30000);
  };
  await managerSay("mgr-seed", [], "Keep the alpha release plan");
  await fx.api("/api/assistant/managers/alpha", { method: "PUT", body: JSON.stringify({ sessionId: lead }) });
  const DECISION = "Release 0.25.6 to npm tonight?";
  const URGENT = "Staging is down after the deploy";
  sends = await step(tg, "8. A manager chat's cards while at PPM: a decision is silent, an urgent card rings", async () => {
    await managerSay("mgr-decision", [{ session: "report_to_assistant", args: { kind: "needs_decision", title: DECISION, body: "All tests pass; the changelog is written." } }], "Prepare the release");
    await tg.waitText(OWNER, DECISION);
    await managerSay("mgr-urgent", [{ session: "report_to_assistant", args: { kind: "urgent", title: URGENT, body: "The health check fails since 14:02." } }], "Watch staging");
    await tg.waitText(OWNER, URGENT);
  });
  assert.ok(sends.find((s) => s.text.includes(DECISION))?.silent, "the decision card is silent while at PPM");
  assert.equal(sends.find((s) => s.text.includes(URGENT))?.silent, false, "the urgent card rings while at PPM");
  pass("manager cards while at PPM: the decision is silent, the urgent card rings");

  // The bell in the Assistant's head, with the "Waiting" chip in the chat footer, on both devices.
  const waitingBar = (dev) => dev.page.locator("[data-waiting-dock]:visible").first();
  await waitingBar(desk).waitFor({ timeout: 30000 });
  await sleep(600);
  await kit.shot(desk, "01-assistant-window-bell-on");
  await closeup(desk, bell(desk), "desktop-01b-bell-on-closeup.png");
  await mobile.page.reload();
  await waitingBar(mobile).waitFor({ timeout: 30000 });
  await bell(mobile).waitFor({ timeout: 20000 });
  await sleep(600);
  await kit.shot(mobile, "01-assistant-head-bell-on");
  pass("the bell sits in the Assistant's titlebar (desktop) and head (phone), with the Waiting chip in the chat footer");

  // Settings → PPM Assistant → Sessions & Telegram, on both devices.
  for (const dev of [desk, mobile]) {
    await dev.page.locator('button[aria-label="PPM Assistant settings"]:visible').first().click();
    await dev.page.locator('[data-testid="assistant-settings-tab-sessions"]:visible').first().click();
    const row = dev.page.getByText("Quiet while I'm at PPM", { exact: true }).first();
    await row.waitFor({ timeout: 20000 });
    await row.scrollIntoViewIfNeeded();
    await sleep(400);
    await kit.shot(dev, "08-settings-quiet-switch");
  }
  pass("the switch shows in Settings on desktop and on the phone");

  for (const dev of Object.values(kit.devices)) {
    const unexpected = dev.errors.filter((e) => !/read the 'serviceWorker' property/.test(e));
    assert.equal(unexpected.length, 0, `page errors on ${dev.name}: ${unexpected.join("\n")}`);
  }
} catch (error) {
  results.push({ name: "demo", passed: false, error: String(error.stack ?? error) });
  console.error(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  // The Telegram log: every message the bot sent the owner, in order, and whether the phone rang.
  const lines = [
    "# Telegram messages the bot sent during the demo",
    `# "5 minutes" shortened to ${QUIET_MS / 1000} s (PPM_TELEGRAM_QUIET_MS). 🔕 = disable_notification (no sound), 🔔 = rings.`,
    "# Edits of a message (a streaming answer) never notify and are not listed.",
    "",
  ];
  for (const s of steps) {
    lines.push(`## ${s.title}`, `   started ${s.startedAt}`);
    for (const m of s.sends) {
      lines.push(`   ${m.silent ? "🔕 silent" : "🔔 rings "}${m.replyTo ? `  (reply to #${m.replyTo})` : ""}  ${plain(m.text).split("\n")[0].slice(0, 110)}`);
    }
    lines.push("");
  }
  await writeFile(join(out, "telegram-log.txt"), `${lines.join("\n")}\n`).catch(() => {});
  await browser?.close().catch(() => {});
  if (backend && backend.exitCode === null) {
    const exited = new Promise((r) => backend.once("exit", r));
    await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
    const timer = setTimeout(() => backend.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  let stopped = true;
  try { process.kill(backendPid, 0); stopped = false; } catch { /* gone */ }
  console.log(`temporary PPM pid=${backendPid} stopped=${stopped}`);
  if (fake && fake.exitCode === null) fake.kill();
  await writeFile(join(out, "results.json"), JSON.stringify({ backendPid, backendStopped: stopped, web, results }, null, 2)).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
