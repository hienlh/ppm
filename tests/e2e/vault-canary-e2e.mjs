// The secret vault's canary, end to end: the production Vite bundle against a disposable server
// (tests/e2e/fixtures/vault-server.ts) whose only provider is scripted, a fake Telegram Bot API
// (fixtures/fake-telegram-server.ts) behind the PPM Assistant's bridge, and a fake ntfy
// (tests/helpers/fake-ntfy-server.ts). Fake marker values only: CANARY-T1-… (public),
// CANARY-T2-… (secure), CANARY-T3-… (sealed) and two marker passwords.
//
// 1. Settings → Vault on a desktop: turn on Secure and Sealed through their dialogs, add one item
//    per tier (two secure); the pane and its bottom sheets on a phone.
// 2. A PPM Assistant session: bound from Telegram, then a turn typed in PPM reads the secure tier
//    through its card, tries to write a value into the notebook and to another chat; a turn started
//    from Telegram is refused the secure tier outright and gets a sealed card with no give-to-AI.
// 3. An ordinary chat with the vault tools on: list, public read, a secure card (an extra item
//    ticked, a wrong password, then the right one, once), sealed shown to the user only, sealed
//    given to the AI, a smuggling attempt through send_to_session, the cards on a phone, a
//    five-minute window and a read inside it that needs no card.
//    Then, with T2/T3 held, Telegram: the chat made its project's manager files reports — one with
//    T2/T3 in its body (refused, as given and spelled out), one clean Markdown report with a design
//    screenshot that reaches the fake as parsed HTML plus a photo caption; a caption carrying T2/T3
//    through PPM's own sendPhotos; and the user's replies on Telegram to the card, to the
//    Assistant's answer and to a bot message holding raw values, each turn's input checked alone.
// 4. A restart on the same PPM_HOME: nothing is unlocked, and the same read needs a card again.
// 5. The scan: ppm.log and every log, session-trace.db, the notebook, every file under PPM_HOME,
//    everything the fake Telegram and ntfy received, the captured web pushes, the provider's
//    transcript, and vault_items' ciphertext — then a PASS/FAIL table.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/e2e/vault-canary-e2e.mjs
//
// Meant for the capped e2e image (tests/e2e/docker/Dockerfile). PPM_VAULT_WEB_DIR reuses a web
// build (Monaco staged under assets/monaco/vs); without it one is built into PPM_VAULT_OUT/web.
// Screenshots go to PPM_VAULT_OUT/screenshots, logs and the results to PPM_VAULT_OUT.
import { spawn } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { phone, startChild, until, sleep } from "./assistant-telegram/harness.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-vault-canary-"));
const out = resolve(process.env.PPM_VAULT_OUT ?? join(sandbox, "out"));
const shots = join(out, "screenshots"), logs = join(out, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project"), providerDir = join(sandbox, "provider");
await Promise.all([out, shots, logs, ppm, home, project, providerDir].map((p) => mkdir(p, { recursive: true })));
const transcriptPath = join(providerDir, "transcript.jsonl");
const providerState = join(providerDir, "state.json");

// ------------------------------------------------------------------ markers
const hex = (n) => randomBytes(n).toString("hex").toUpperCase();
const T1 = `CANARY-T1-${hex(6)}`;
const T2A = `CANARY-T2-A${hex(6)}`;
const T2B = `CANARY-T2-B${hex(6)}`;
const T3 = `CANARY-T3-${hex(6)}`;
const PW2 = `pw2-marker-${hex(8)}`; // ≥ 12
const PW3 = `pw3-marker-sealed-${hex(8)}`; // ≥ 16
const PURPOSE = `PURPOSE-MARK-${hex(4)}`;
const AUTH = randomBytes(16).toString("hex");
const NAMES = { pub: "Canary public", a: "Canary secure A", b: "Canary secure B", sealed: "Canary sealed" };
const TG_CHAT = 1001;

// ------------------------------------------------------------------ processes
async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log.slice(-4000)}`);
  return log;
}

let webDir = process.env.PPM_VAULT_WEB_DIR;
if (!webDir) {
  webDir = join(out, "web");
  if (!existsSync(join(webDir, "assets/monaco/vs/loader.js"))) {
    await writeFile(join(logs, "web.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
    cpSync(resolve("node_modules/monaco-editor/min/vs"), join(webDir, "assets/monaco/vs"), { recursive: true });
  }
}
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), "Monaco is not staged in the web bundle");

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

const started = []; // [label, child] — every process this run started, stopped by its own handle
const fakeTg = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: join(logs, "fake-telegram.log"), ready: /FAKE_TELEGRAM (\{.*\})/ });
started.push(["fake-telegram", fakeTg.child]);
const tgInfo = JSON.parse((await fakeTg.ready)[1]);
const tg = phone(tgInfo.control);

const ntfyScript = `const { startFakeNtfy } = await import(${JSON.stringify(resolve("tests/helpers/fake-ntfy-server.ts"))});
const f = startFakeNtfy();
const c = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/published") return Response.json(f.published);
  if (u.pathname === "/exit") { setTimeout(() => { f.stop(); c.stop(true); process.exit(0); }, 20); return Response.json({ ok: true }); }
  return new Response("unknown", { status: 404 });
} });
console.log("FAKE_NTFY " + JSON.stringify({ url: f.url, control: "http://127.0.0.1:" + c.port }));`;
const fakeNtfy = startChild("bun", ["-e", ntfyScript], { env: { ...process.env }, log: join(logs, "fake-ntfy.log"), ready: /FAKE_NTFY (\{.*\})/ });
started.push(["fake-ntfy", fakeNtfy.child]);
const ntfyInfo = JSON.parse((await fakeNtfy.ready)[1]);

const port = await freePort();
const web = `http://127.0.0.1:${port}`;
const fixtureEnv = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
  PPM_VAULT_WEB_DIR: webDir, PPM_VAULT_E2E_TOKEN: AUTH, PPM_VAULT_TRANSCRIPT: transcriptPath, PPM_VAULT_PROVIDER_STATE: providerState,
  PPM_VAULT_NTFY_URL: ntfyInfo.url, PPM_LOG_LEVEL: "debug",
  PPM_TELEGRAM_API_BASE: tgInfo.api, PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: tgInfo.token,
  PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify([[String(TG_CHAT), String(TG_CHAT), "Phone owner"]]),
  PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "300",
};
delete fixtureEnv.PPM_ALLOW_PROD_DB;
delete fixtureEnv.NOTIFY_SOCKET;
delete fixtureEnv.PPM_VAULT_FIXTURE_RESUME;

let backend = null;
async function startBackend(resume) {
  const s = startChild("bun", ["tests/e2e/fixtures/vault-server.ts"], {
    env: resume ? { ...fixtureEnv, PPM_VAULT_FIXTURE_RESUME: "1" } : fixtureEnv,
    log: join(logs, "fixture.log"), ready: /Vault fixture ready/,
  });
  backend = s.child;
  started.push([resume ? "fixture (resumed)" : "fixture", s.child]);
  await s.ready;
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000);
}
async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((r) => backend.once("exit", r));
  await fetch(`${web}/__vault-test/exit`, { method: "POST" }).catch(() => {});
  const timer = setTimeout(() => backend.kill(), 5000);
  await exited;
  clearTimeout(timer);
}

// ------------------------------------------------------------------ API
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH}`, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  assert(response.ok, `${path}: ${response.status} ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const fx = () => api("/__vault-test/calls");
const script = (label, match, ops) => post("/__vault-test/script", { label, match, ops });
const read = (items, purpose) => ({ call: "vault_read", via: "sessions", args: { items, purpose } });
/** Resolves once the scripted turn `label` has ended, with its calls. */
async function turnDone(label, timeout = 60000) {
  return until(`${label} done`, async () => {
    const s = await fx();
    const turn = s.turns.find((t) => t.label === label);
    return turn?.done ? { turn, calls: s.calls.filter((c) => c.label === label) } : null;
  }, timeout);
}
async function callDone(label, index, timeout = 60000) {
  return until(`${label} call ${index}`, async () => {
    const c = (await fx()).calls.filter((x) => x.label === label)[index];
    return c?.done ? c : null;
  }, timeout);
}

// ------------------------------------------------------------------ results
const results = [];
const record = (name, passed, detail = "") => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const check = (name, fn) => {
  try { fn(); record(name, true); } catch (e) { record(name, false, String(e.message ?? e).replace(/\s+/g, " ").slice(0, 400)); }
};
const screenshots = [];
async function shot(page, name, note) {
  const path = join(shots, `${name}.png`);
  await page.screenshot({ path });
  screenshots.push({ path, note });
}

// ------------------------------------------------------------------ browser
const COMPOSER = ["Ask anything...", "Follow-up...", "Follow-up or Stop..."].map((p) => `textarea[placeholder="${p}"]:visible`).join(", ");
const signedIn = ([token]) => {
  // PPM's own pages only: a page that reloads while the server restarts lands on Chrome's error
  // page (chrome-error://chromewebdata/), which has no storage, and this script runs there too.
  if (window.top !== window || location.protocol !== "http:") return;
  localStorage.setItem("ppm-auth-token", token);
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
};
let browser;
const pageErrors = [];
async function newPage(kind, viewport) {
  const context = await browser.newContext(kind === "phone"
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" }
    : { viewport: viewport ?? { width: 1366, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(signedIn, [AUTH]);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${kind} ${page.url()}: ${e} :: ${String(e.stack ?? "").replace(/\s+/g, " ").slice(0, 300)}`));
  return page;
}
async function send(root, text) {
  const box = root.locator(COMPOSER).first();
  await box.waitFor({ timeout: 30000 });
  await box.fill(text);
  await box.press("Enter");
}
const PROJECT = "vaultproj";
let chatSessionId, assistantSessionId, items;
const layoutFor = (sessionId) => {
  const tab = { id: `chat-${sessionId}`, type: "chat", title: "Vault canary", projectId: PROJECT, closable: true, metadata: { projectName: PROJECT, sessionId, providerId: "claude" } };
  return { layout: { panels: { main: { id: "main", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } }, grid: [["main"]], focusedPanelId: "main" } };
};
async function openChat(kind) {
  await api(`/api/project/${PROJECT}/workspace`, { method: "PUT", body: JSON.stringify(layoutFor(chatSessionId)) });
  const page = await newPage(kind);
  await page.goto(`${web}/project/${PROJECT}`);
  await page.locator(COMPOSER).first().waitFor({ timeout: 30000 });
  return page;
}

// ------------------------------------------------------------------ scanning
const has = (text, needle) => typeof text === "string" && text.includes(needle);
function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  return files;
}
/** Files under `dir` whose bytes contain `needle` (binary-safe). */
function filesWith(dir, needle) {
  const n = Buffer.from(needle, "utf8");
  return walk(dir).filter((f) => { try { return readFileSync(f).includes(n); } catch { return false; } }).map((f) => f.slice(dir.length + 1));
}
const transcriptText = () => (existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "");
async function telegramText() {
  const r = await (await fetch(`${tgInfo.control}/calls?from=0`)).json();
  return r.calls.map((c) => c.raw).join("\n");
}
async function ntfyText() {
  return JSON.stringify(await (await fetch(`${ntfyInfo.control}/published`)).json());
}
async function pushesText() {
  return JSON.stringify(await api("/__vault-test/tg/pushes"));
}

// ================================================================== run
const failures = [];
try {
  await startBackend(false);
  await post("/api/projects", { name: PROJECT, path: project });
  const created = await post(`/api/project/${PROJECT}/chat/sessions`, { providerId: "claude", title: "Vault canary" });
  chatSessionId = created.data.id;
  await until("bridge running", async () => (await api("/__vault-test/tg/bridge")).running, 30000);

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true,
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });

  // ---------------------------------------------------------------- 1. Settings → Vault
  {
    const page = await newPage("desktop", { width: 1440, height: 1500 });
    await page.goto(`${web}/project/${PROJECT}`);
    await page.locator('button[aria-label="Settings"]').first().click();
    await page.locator('[data-testid="settings-rail-vault"]').click();
    const secure = page.locator('[data-vault-tier="secure"]');
    const sealed = page.locator('[data-vault-tier="sealed"]');
    await secure.waitFor({ timeout: 20000 });
    for (const [tier, group, label, password] of [["secure", secure, "Secure tier password", PW2], ["sealed", sealed, "Sealed tier password", PW3]]) {
      await group.getByRole("button", { name: "Turn on" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(label).fill(password);
      await dialog.getByLabel("Type it again").fill(password);
      await dialog.locator('[data-vault-check="forget-ack"] input').check();
      if (tier === "sealed") await shot(page, "desktop-settings-turn-on-sealed-dialog", "Desktop: turning on the Sealed tier (password twice, the forget warning, the tick)");
      await dialog.getByRole("button", { name: "Turn on" }).click();
      await dialog.waitFor({ state: "detached", timeout: 20000 });
      await group.getByRole("button", { name: "Change password" }).waitFor({ timeout: 20000 });
    }
    const add = async (group, { name, value, kind, password, passwordLabel }) => {
      await group.getByRole("button", { name: "Add", exact: true }).click();
      const dialog = page.getByRole("dialog");
      // By role: the value field's reveal button is labelled "Show value"/"Hide value" too.
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
      if (kind) await dialog.getByRole("combobox", { name: "Kind" }).selectOption(kind);
      await dialog.getByRole("textbox", { name: "Value", exact: true }).fill(value);
      if (passwordLabel && await dialog.getByLabel(passwordLabel).count()) await dialog.getByLabel(passwordLabel).fill(password);
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await dialog.waitFor({ state: "detached", timeout: 20000 });
      await group.locator("[data-vault-item]", { hasText: name }).waitFor({ timeout: 10000 });
    };
    await add(page.locator('[data-vault-tier="public"]'), { name: NAMES.pub, value: T1 });
    await add(secure, { name: NAMES.a, value: T2A, kind: "ni_number", password: PW2, passwordLabel: "Secure tier password" });
    await add(secure, { name: NAMES.b, value: T2B, kind: "address", password: PW2, passwordLabel: "Secure tier password" });
    await add(sealed, { name: NAMES.sealed, value: T3, kind: "passport", password: PW3, passwordLabel: "Sealed tier password" });
    // Maximized (double-click on the title bar), so the pane shows all three groups at once.
    await page.locator('[aria-label="Settings title bar"]').dblclick();
    await page.waitForTimeout(500);
    await page.locator('[data-vault-tier="public"]').scrollIntoViewIfNeeded();
    await shot(page, "desktop-settings-vault-three-tiers", "Desktop: Settings → Vault with Public, Secure (unlocked, 2 items) and Sealed (1 item)");
    items = (await api("/api/vault/items")).data;
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    check("settings: three tiers on, four items in the right tiers", () => {
      assert.equal(byName[NAMES.pub]?.tier, "public");
      assert.equal(byName[NAMES.a]?.tier, "secure");
      assert.equal(byName[NAMES.b]?.tier, "secure");
      assert.equal(byName[NAMES.sealed]?.tier, "sealed");
    });
    check("settings: /api/vault/items never carries a value", () => assert.ok(![T1, T2A, T2B, T3].some((v) => JSON.stringify(items).includes(v))));
    await page.context().close();

    const mobile = await newPage("phone");
    await mobile.goto(`${web}/project/${PROJECT}`);
    await mobile.locator('button[aria-label="Open menu"]').click();
    await mobile.locator("button", { hasText: /^Settings$/ }).filter({ visible: true }).first().tap();
    await mobile.locator('[data-testid="settings-index-vault"]').tap();
    const mSecure = mobile.locator('[data-vault-tier="secure"]');
    await mSecure.waitFor({ timeout: 20000 });
    await shot(mobile, "phone-settings-vault-top", "Phone: Settings → Vault, Public and Secure groups");
    await mobile.locator('[data-vault-tier="sealed"]').scrollIntoViewIfNeeded();
    await shot(mobile, "phone-settings-vault-sealed", "Phone: Settings → Vault scrolled to the Sealed group");
    await mSecure.getByRole("button", { name: "Add", exact: true }).tap();
    await mobile.getByText("Add Secure item", { exact: true }).waitFor({ timeout: 10000 });
    await shot(mobile, "phone-settings-add-secure-sheet", "Phone: Add Secure item as a bottom sheet");
    await mobile.getByRole("button", { name: "Cancel" }).filter({ visible: true }).first().tap();
    await mobile.locator('[data-vault-tier="sealed"]').getByRole("button", { name: "Change password" }).tap();
    await mobile.getByText("Type it again").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await shot(mobile, "phone-settings-change-password-sheet", "Phone: Change the Sealed tier password as a bottom sheet");
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("phone: Settings → Vault has no sideways scroll", () => assert.ok(overflow <= 0, `${overflow}px`));
    await mobile.context().close();
    record("settings: Secure and Sealed turned on through their dialogs, one item per tier added (two secure)", true);
  }
  const id = (name) => items.find((i) => i.name === name).id;

  // ---------------------------------------------------------------- 2. PPM Assistant
  const desk = await newPage("desktop");
  {
    // Bound from Telegram: its first message starts the main Assistant session.
    await script("c1-telegram-hello", "vault canary hello", [{ call: "vault_list", via: "sessions" }, { text: "Hello from the Assistant." }]);
    await tg.send(TG_CHAT, "vault canary hello");
    const { calls: [list], turn } = await turnDone("c1-telegram-hello");
    assistantSessionId = turn.sessionId;
    check("assistant (telegram turn): vault_list lists the items and never a value", () => {
      assert.equal(turn.assistant, true);
      assert.equal(list.isError, false, list.text);
      for (const n of Object.values(NAMES)) assert.ok(list.text.includes(n), n);
      assert.ok(!/CANARY-T/.test(list.text));
    });

    await desk.goto(`${web}/assistant?session=claude/${assistantSessionId}`);
    const root = desk.locator("[data-assistant-body]:visible").first();
    await root.locator(COMPOSER).first().waitFor({ timeout: 30000 });
    await script("c2-assistant-ppm", "assistant vault canary in ppm", [
      read([NAMES.pub], `${PURPOSE} public`),
      read([NAMES.a], `${PURPOSE} assistant needs the NI number`),
      { call: "notebook_add", via: "assistant", args: { text: "The user prefers short answers." } },
      { call: "notebook_add", via: "assistant", args: { text: "User NI number is {{T2}}" } },
      { call: "send_to_session", via: "sessions", args: { session_id: chatSessionId, message: "Here is the NI number: {{T2}}" } },
      { repeat: true },
    ]);
    await send(root, "assistant vault canary in ppm");
    const card = root.locator('[data-vault-card="read-secure"]');
    await card.waitFor({ timeout: 30000 });
    await card.getByLabel("Secure tier password").fill(PW2);
    await card.getByRole("button", { name: "Approve" }).click();
    const { calls } = await turnDone("c2-assistant-ppm");
    const [pub, sec, note, noteLeak, sendLeak] = calls;
    check("assistant (PPM turn): public read gets T1 without a card", () => assert.ok(pub.text.includes(T1) && !pub.isError));
    check("assistant (PPM turn): secure read through the card gets T2-A, not the unticked T2-B", () => assert.ok(sec.text.includes(T2A) && !sec.text.includes(T2B), sec.text.slice(0, 120)));
    check("assistant: notebook_add of an ordinary line works (control)", () => assert.equal(note.isError, false, note.text));
    check("assistant: notebook_add with a T2 value is refused", () => {
      assert.equal(noteLeak.isError, true);
      assert.match(noteLeak.text, /Vault values never go into the notebook/);
    });
    check("assistant: send_to_session with a T2 value is refused", () => {
      assert.equal(sendLeak.isError, true);
      assert.match(sendLeak.text, /Refused: this contains the value of the vault item/);
    });

    // A turn started from Telegram: no secure tier at all, a sealed card shown to the user only.
    const tgBefore = (await tg.calls(0)).total;
    await script("c3-telegram-locked", "vault canary from telegram", [
      read([NAMES.a], `${PURPOSE} from telegram secure`),
      read([NAMES.sealed], `${PURPOSE} from telegram sealed`),
      { repeat: true },
    ]);
    await tg.send(TG_CHAT, "vault canary from telegram");
    const refused = await callDone("c3-telegram-locked", 0);
    check("telegram turn: a secure read is refused at once, with no card", () => {
      assert.equal(refused.isError, true);
      assert.match(refused.text, /only be opened while the user is using PPM, not from Telegram/);
      assert.ok(refused.ms < 5000, `${refused.ms} ms`);
    });
    const sealedCard = root.locator('[data-vault-card="read-sealed"]');
    await sealedCard.waitFor({ timeout: 30000 });
    const giveCount = await sealedCard.locator("[data-vault-give-to-ai]").count();
    const fromTgNote = await sealedCard.getByText("This turn came from Telegram, so the value can only be shown to you.").count();
    check("telegram turn: the sealed card has no give-to-AI tick and says why", () => { assert.equal(giveCount, 0); assert.equal(fromTgNote, 1); });
    await shot(desk, "desktop-assistant-sealed-card-from-telegram", "Desktop: Assistant's sealed card for a Telegram turn (no give-to-AI tick)");
    await sealedCard.getByLabel("Sealed tier password").fill(PW3);
    await sealedCard.getByRole("button", { name: "Show to me" }).click();
    const shown = desk.locator("[data-vault-shown-value]");
    await shown.waitFor({ timeout: 15000 });
    const shownValue = (await shown.innerText()).trim();
    check("telegram turn: the sealed value is shown to the user in PPM", () => assert.equal(shownValue, T3));
    const { calls: c3 } = await turnDone("c3-telegram-locked");
    check("telegram turn: the AI hears 'shown to the user only', never T3", () => {
      assert.match(c3[1].text, /shown to them only, not to you/);
      assert.ok(!c3[1].text.includes(T3));
    });
    // Telegram HTML escapes the quotes around the label, so the label alone is looked for.
    await tg.waitText(TG_CHAT, "c3-telegram-locked", 30000);
    const tgNow = await tg.calls(tgBefore);
    const tgTexts = tgNow.calls.map((c) => c.raw).join("\n");
    check("telegram: the vault card is announced as one 'Unlock needed in PPM' line", () => assert.ok(tgTexts.includes("Unlock needed in PPM"), "no unlock line"));
    check("telegram: the reply repeating T2 reached Telegram scrubbed to [vault:<name>]", () => {
      assert.ok(tgTexts.includes(`[vault:${NAMES.a}]`), "no scrubbed placeholder");
      assert.ok(!tgTexts.includes("CANARY-T2-") && !tgTexts.includes("CANARY-T3-"));
    });
    check("telegram: the vault card's purpose never reaches Telegram", () => assert.ok(!tgTexts.includes(PURPOSE)));
  }

  // ---------------------------------------------------------------- 3. Ordinary chat
  const chat = await openChat("desktop");
  {
    await script("s1-secure-once", "canary read secure once", [
      { call: "vault_list", via: "sessions" },
      read([NAMES.pub], `${PURPOSE} public`),
      read([NAMES.a], `${PURPOSE} need the NI number`),
      { repeat: true },
    ]);
    await send(chat, "canary read secure once");
    const [list, pub] = [await callDone("s1-secure-once", 0), await callDone("s1-secure-once", 1)];
    check("chat: vault_list returns no CANARY value", () => { assert.equal(list.isError, false, list.text); assert.ok(!/CANARY-T/.test(list.text)); });
    check("chat: vault_read public returns T1", () => assert.ok(pub.text.includes(T1)));
    const card = chat.locator('[data-vault-card="read-secure"]');
    await card.waitFor({ timeout: 30000 });
    await card.locator(`[data-vault-check="${id(NAMES.b)}"] input`).check();
    await shot(chat, "desktop-secure-card", "Desktop: secure card, the requested item and one extra item ticked");
    await card.getByLabel("Secure tier password").fill("not-the-vault-password");
    await card.getByRole("button", { name: "Approve" }).click();
    const err = card.locator("[data-vault-card-error]");
    await err.waitFor({ timeout: 15000 });
    const errText = await err.innerText();
    check("chat: a wrong password keeps the card and says how many tries are left", () => assert.match(errText, /4 attempts left/));
    await shot(chat, "desktop-secure-card-wrong-password", "Desktop: secure card after a wrong password (4 attempts left)");
    await card.getByLabel("Secure tier password").fill(PW2);
    await card.getByRole("button", { name: "Approve" }).click();
    await card.waitFor({ state: "detached", timeout: 15000 });
    const { calls } = await turnDone("s1-secure-once");
    check("chat: Read once gives the AI both ticked items (T2-A asked, T2-B ticked by the user)", () => {
      assert.equal(calls[2].isError, false, calls[2].text);
      assert.ok(calls[2].text.includes(T2A) && calls[2].text.includes(T2B));
    });
    const toolCard = await chat.locator('[data-vault-tool-card="vault_read"]').allInnerTexts();
    check("chat: the vault_read tool cards never draw a T2 value", () => assert.ok(!toolCard.join("\n").includes("CANARY-T2-")));

    // Sealed, shown to the user only.
    await script("s4-sealed-show", "canary sealed show", [read([NAMES.sealed], `${PURPOSE} passport number`), { repeat: true }]);
    await send(chat, "canary sealed show");
    const sCard = chat.locator('[data-vault-card="read-sealed"]');
    await sCard.waitFor({ timeout: 30000 });
    await shot(chat, "desktop-sealed-card", "Desktop: sealed card (red), Show to me by default, give-to-AI tick below");
    await sCard.getByLabel("Sealed tier password").fill(PW3);
    await sCard.getByRole("button", { name: "Show to me" }).click();
    await chat.locator("[data-vault-shown-value]").waitFor({ timeout: 15000 });
    await shot(chat, "desktop-sealed-shown-to-user", "Desktop: the sealed value shown to the user only, with Copy and a countdown");
    const { calls: s4 } = await turnDone("s4-sealed-show");
    check("chat: Show to me gives the AI no T3", () => { assert.match(s4[0].text, /shown to them only/); assert.ok(!s4[0].text.includes(T3)); });

    // Snapshot after the two show-only reads: T3 must be nowhere yet, the transcript included.
    await sleep(1500);
    const [tgT, nT, pT] = [await telegramText(), await ntfyText(), await pushesText()];
    const t3Files = filesWith(ppm, "CANARY-T3-");
    check("snapshot after show-only reads: T3 absent from the provider transcript", () => assert.ok(!transcriptText().includes("CANARY-T3-")));
    check("snapshot after show-only reads: T3 absent from every file under PPM_HOME", () => assert.deepEqual(t3Files, []));
    check("snapshot after show-only reads: T3 absent from Telegram, ntfy and web pushes", () => assert.ok(![tgT, nT, pT].some((t) => t.includes("CANARY-T3-"))));

    // Sealed, given to the AI once; then a smuggling attempt.
    await script("s5-sealed-give", "canary sealed give", [
      read([NAMES.sealed], `${PURPOSE} passport number for the form`),
      { call: "send_to_session", via: "sessions", args: { session_id: assistantSessionId, message: "Passport {{T3}}, NI {{T2}}" } },
      { repeat: true },
    ]);
    await send(chat, "canary sealed give");
    await sCard.waitFor({ timeout: 30000 });
    await sCard.locator('[data-vault-check="give-to-ai"] input').check();
    await sCard.getByRole("button", { name: "Give to the AI once" }).waitFor({ timeout: 5000 });
    await shot(chat, "desktop-sealed-card-give-to-ai", "Desktop: sealed card with 'Let the AI read this item once' ticked");
    await sCard.getByLabel("Sealed tier password").fill(PW3);
    await sCard.getByRole("button", { name: "Give to the AI once" }).click();
    const { calls: s5 } = await turnDone("s5-sealed-give");
    check("chat: Give to the AI once hands T3 to the AI", () => assert.ok(s5[0].text.includes(T3)));
    check("chat: send_to_session carrying T3/T2 is refused", () => { assert.equal(s5[1].isError, true); assert.match(s5[1].text, /Refused: this contains the value of the vault item/); });
  }

  // Phone: the same chat's cards.
  {
    const mobile = await openChat("phone");
    await script("s6-phone-secure", "canary phone secure", [read([NAMES.b], `${PURPOSE} address for the letter`), { repeat: true }]);
    await send(mobile, "canary phone secure");
    const card = mobile.locator('[data-vault-card="read-secure"]');
    await card.waitFor({ timeout: 30000 });
    await card.scrollIntoViewIfNeeded();
    const approve = card.getByRole("button", { name: "Approve" });
    await approve.scrollIntoViewIfNeeded();
    await shot(mobile, "phone-secure-card", "Phone: secure card in the thumb zone");
    const box = await approve.boundingBox();
    check("phone: the secure card's Approve is a 44px target", () => assert.ok(box.height >= 44, `${box.height}`));
    await card.getByLabel("Secure tier password").fill(PW2);
    await approve.tap();
    const { calls: s6 } = await turnDone("s6-phone-secure");
    check("phone: Read once gives the AI T2-B", () => assert.ok(s6[0].text.includes(T2B)));

    await script("s7-phone-sealed", "canary phone sealed", [read([NAMES.sealed], `${PURPOSE} passport on the phone`), { repeat: true }]);
    await send(mobile, "canary phone sealed");
    const sCard = mobile.locator('[data-vault-card="read-sealed"]');
    await sCard.waitFor({ timeout: 30000 });
    const show = sCard.getByRole("button", { name: "Show to me" });
    await show.scrollIntoViewIfNeeded();
    await shot(mobile, "phone-sealed-card", "Phone: sealed card, Show to me lowest");
    await sCard.getByLabel("Sealed tier password").fill(PW3);
    await show.tap();
    await mobile.locator("[data-vault-shown-value]").waitFor({ timeout: 15000 });
    await shot(mobile, "phone-sealed-shown-to-user", "Phone: the sealed value shown to the user only");
    const { calls: s7 } = await turnDone("s7-phone-sealed");
    check("phone: Show to me gives the AI no T3", () => assert.ok(!s7[0].text.includes(T3)));
    await mobile.context().close();
  }

  // Telegram after the AI was given T2 and T3: a manager report (Markdown → Telegram HTML) with a
  // design screenshot, a caption through PPM's own client, and the user's replies on Telegram.
  {
    const botId = Number(tgInfo.token.split(":")[0]);
    const telegramSent = () => tg.sent(TG_CHAT);
    // A design screenshot as design_screenshot leaves it (record + PNG), for the card's picture.
    const shotId = hex(16).toLowerCase();
    await mkdir(join(ppm, "design-shots"), { recursive: true });
    await writeFile(join(ppm, "design-shots", `${shotId}.png`), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await writeFile(join(ppm, "design-shots", `${shotId}.json`), JSON.stringify({
      id: shotId, projectPath: project, slug: "form", designTitle: "Canary form", file: "index.html", label: "Filled form",
      width: 1280, height: 800, createdAt: new Date().toISOString(),
    }));
    await api(`/api/assistant/managers/${PROJECT}`, { method: "PUT", body: JSON.stringify({ sessionId: chatSessionId }) });
    await api(`/api/assistant/managers/${PROJECT}`, { method: "PATCH", body: JSON.stringify({ telegramDetail: "full" }) });

    // (a) A report whose body holds T2/T3 — as given, and spelled out letter by letter — is refused at
    // the door; a clean Markdown report with a picture reaches Telegram as HTML.
    const spaced = T2A.split("").join(" ");
    const report = (title, body, extra = {}) => ({ call: "report_to_assistant", via: "sessions", args: { kind: "needs_decision", title, body, ...extra } });
    await script("t1-manager-report", "canary manager report", [
      report("Vault canary: NI found", "## Form\n- **NI**: {{T2}}\n- **Passport**: {{T3}}"),
      report("Vault canary: NI spelled out", `The NI is ${spaced}.`),
      report("Vault canary form ready", "## Form ready\n- **Name**: filled from the public tier\n- NI: kept in the vault as `Canary secure A`\n\nOK to submit?", { images: [shotId] }),
      { repeat: true },
    ]);
    await send(chat, "canary manager report");
    const { calls: t1 } = await turnDone("t1-manager-report");
    check("telegram (a): a manager report whose body holds T2/T3 is refused", () => {
      assert.equal(t1[0].isError, true, t1[0].text);
      assert.match(t1[0].text, /Refused: this contains the value of the vault item/);
    });
    check("telegram (a): a report with T2 spelled out letter by letter is refused", () => {
      assert.equal(t1[1].isError, true, t1[1].text);
      assert.match(t1[1].text, /Refused: this contains the value of the vault item/);
    });
    check("telegram (a): a clean report with a picture is filed (control)", () => assert.equal(t1[2].isError, false, t1[2].text));
    const cardMsg = await tg.waitFor(TG_CHAT, "the report card", (m) => !m.photo && m.text.includes("Vault canary form ready"), 30000);
    const photoMsg = await tg.waitFor(TG_CHAT, "the report's picture", (m) => !!m.photo && m.text.includes("Canary form"), 30000);
    const tgCardPage = await browser.newPage({ viewport: { width: 420, height: 600 } });
    await tgCardPage.setContent(`<!doctype html><meta charset="utf-8"><body style="font:15px sans-serif;background:#8eb8d6;padding:12px"><p style="font-size:11px">Fake Telegram: the HTML PPM sent (parse_mode ${cardMsg.parse_mode}).</p><div style="background:#fff;border-radius:12px;padding:8px 11px;white-space:pre-wrap">${cardMsg.html}</div><p style="font-size:11px;margin-top:12px">Photo caption: ${photoMsg.text.replace(/</g, "&lt;")}</p></body>`);
    await shot(tgCardPage, "telegram-report-card-html", "Fake Telegram: the manager report card as the HTML PPM sent, and its picture's caption");
    await tgCardPage.close();
    check("telegram (a): the report reached Telegram as parsed HTML with no T2/T3", () => {
      assert.equal(cardMsg.parse_mode, "HTML");
      assert.ok(cardMsg.html.includes("<b>Name</b>"), "bold rendered as HTML");
      assert.ok(!/CANARY-T[23]-/.test(cardMsg.html) && !/CANARY-T[23]-/.test(cardMsg.text));
    });
    const everySent = await telegramSent();
    check("telegram (a): no message the fake received holds T2/T3 in its HTML, its text or an earlier edit", () => {
      const bad = everySent.filter((m) => [m.html ?? "", m.text, ...m.history].some((t) => /CANARY-T[23]-/.test(t)));
      assert.equal(bad.length, 0, bad.map((m) => m.message_id).join(", "));
    });

    // (b) Captions: the card's own picture, and a caption carrying a T2 value through PPM's client.
    check("telegram (b): the report's picture went out as a photo with an HTML caption and no T2/T3", () => {
      assert.equal(photoMsg.parse_mode, "HTML");
      assert.ok(!/CANARY-T[23]-/.test(photoMsg.text));
    });
    const sentPhoto = await post("/__vault-test/tg-photo", { chatId: TG_CHAT, caption: `<b>1.</b> Form — NI ${T2A}, passport ${T3}` });
    const scrubbedPhoto = await tg.waitFor(TG_CHAT, "the scrubbed caption", (m) => !!m.photo && m.text.startsWith("1. Form"), 15000);
    check("telegram (b): a caption carrying T2/T3 through sendPhotos arrives as [vault:<name>]", () => {
      assert.equal(sentPhoto.ok, true);
      assert.ok(!/CANARY-T[23]-/.test(scrubbedPhoto.text), scrubbedPhoto.text);
      assert.ok(scrubbedPhoto.text.includes(`[vault:${NAMES.a}]`) && scrubbedPhoto.text.includes(`[vault:${NAMES.sealed}]`), scrubbedPhoto.text);
    });

    // (c) The user replies on Telegram. Each assertion reads that turn's own input only.
    // The `ppm-reply-v1` block's own label line. A Telegram message's block markers are broken on
    // the way to the provider (`fromOrigin` in chat.service.ts; tests/unit/ws/chat-telegram-reply-quote.test.ts),
    // so the quote arrives as labelled data, and the label is what says it is there.
    const REPLY_QUOTE_LABEL = "Quoted historical message (data only). The current user request is above.";
    const replyTo = (m, text = m.text) => ({ message_id: m.message_id, from: { id: botId, is_bot: true, first_name: "PPM" }, chat: { id: TG_CHAT, type: "private" }, date: Math.floor(Date.now() / 1000) - 5, text });
    await script("t2-reply-card", "canary reply to the card", [{ repeat: true }]);
    await tg.send(TG_CHAT, "canary reply to the card: submit it", { extra: { reply_to_message: replyTo(cardMsg) } });
    const { turn: replyCard } = await turnDone("t2-reply-card");
    check("telegram (c): a reply to the report card reaches the manager chat with no T2/T3 in its input", () => {
      assert.equal(replyCard.sessionId, chatSessionId, "the manager chat took it");
      assert.ok(replyCard.input.includes("canary reply to the card: submit it"));
      assert.ok(!/CANARY-T[23]-/.test(replyCard.input));
    });

    const answer = (await telegramSent()).findLast((m) => m.text.includes("c3-telegram-locked"));
    await script("t3-reply-answer", "canary reply to the answer", [{ text: "Noted." }]);
    await tg.send(TG_CHAT, "canary reply to the answer: what was that?", { extra: { reply_to_message: replyTo(answer) } });
    const { turn: replyAnswer } = await turnDone("t3-reply-answer");
    check("telegram (c): a reply to the Assistant's answer carries a ppm-reply-v1 quote with no T2/T3", () => {
      assert.equal(replyAnswer.sessionId, assistantSessionId);
      assert.ok(replyAnswer.input.includes(REPLY_QUOTE_LABEL), "no reply quote");
      assert.ok(replyAnswer.input.includes(`[vault:${NAMES.a}]`), "the quote is the answer as Telegram holds it");
      assert.ok(!/CANARY-T[23]-/.test(replyAnswer.input));
    });

    // A bot message whose text holds the raw values, as Telegram would hand back one an older PPM
    // sent unscrubbed: the quote PPM builds from it must still carry none.
    const hello = (await telegramSent()).find((m) => m.text.includes("c1-telegram-hello"));
    await script("t4-reply-raw", "canary reply to the old message", [{ text: "Noted." }]);
    await tg.send(TG_CHAT, "canary reply to the old message", { extra: { reply_to_message: replyTo(hello, `Your NI is ${T2A} and passport ${T3}.`) } });
    const { turn: replyRaw } = await turnDone("t4-reply-raw");
    check("telegram (c): a reply to a bot message holding raw T2/T3 is quoted as [vault:<name>]", () => {
      assert.ok(replyRaw.input.includes(REPLY_QUOTE_LABEL), "no reply quote");
      assert.ok(replyRaw.input.includes(`[vault:${NAMES.a}]`) && replyRaw.input.includes(`[vault:${NAMES.sealed}]`), "values not replaced");
      assert.ok(!/CANARY-T[23]-/.test(replyRaw.input));
    });
  }

  // A five-minute window, a read inside it with no card, and what the status says.
  {
    await chat.reload();
    await chat.locator(COMPOSER).first().waitFor({ timeout: 30000 });
    await script("s2-window", "canary open window", [read([NAMES.a], `${PURPOSE} again`), { repeat: true }]);
    await send(chat, "canary open window");
    const card = chat.locator('[data-vault-card="read-secure"]');
    await card.waitFor({ timeout: 30000 });
    await card.getByRole("radio", { name: "Open 5 min for this chat" }).click();
    await card.getByLabel("Secure tier password").fill(PW2);
    await card.getByRole("button", { name: "Approve" }).click();
    const { calls: s2 } = await turnDone("s2-window");
    check("chat: Open 5 min returns T2-A", () => assert.ok(s2[0].text.includes(T2A)));

    await script("s3-in-window", "canary repeat read", [read([NAMES.a], `${PURPOSE} once more`), { repeat: true }]);
    await send(chat, "canary repeat read");
    const { calls: s3 } = await turnDone("s3-in-window", 15000);
    const cardsNow = await chat.locator("[data-vault-card]").count();
    check("chat: a read inside the window needs no card", () => { assert.ok(s3[0].text.includes(T2A)); assert.equal(cardsNow, 0); assert.ok(s3[0].ms < 5000, `${s3[0].ms} ms`); });
    const status = (await api("/api/vault/status")).data;
    check("status before restart: a chat window on the secure tier is open", () => assert.ok(status.grants.some((g) => g.tier === "secure" && !g.settings), JSON.stringify(status.grants)));
  }

  // ---------------------------------------------------------------- 4. Restart
  {
    await stopBackend();
    await startBackend(true);
    const status = (await api("/api/vault/status")).data;
    check("after restart: GET /api/vault/status shows nothing unlocked", () => {
      assert.deepEqual(status.grants, []);
      assert.equal(status.tiers.secure.settingsOpenUntil, 0);
      assert.equal(status.tiers.sealed.settingsOpenUntil, 0);
      assert.equal(status.tiers.secure.enabled, true);
      assert.equal(status.tiers.sealed.enabled, true);
    });
    await chat.reload();
    await chat.locator(COMPOSER).first().waitFor({ timeout: 30000 });
    await script("d1-after-restart", "canary after restart", [read([NAMES.a], `${PURPOSE} after restart`)]);
    await send(chat, "canary after restart");
    const card = chat.locator('[data-vault-card="read-secure"]');
    await card.waitFor({ timeout: 30000 });
    await shot(chat, "desktop-secure-card-after-restart", "Desktop: after a restart the same read inside the old window needs a card again");
    await card.getByRole("button", { name: "Decline" }).click();
    const { calls: d1 } = await turnDone("d1-after-restart");
    check("after restart: the read inside the old window asks again (card shown, declined)", () => { assert.equal(d1[0].isError, true); assert.match(d1[0].text, /declined/); });
  }
  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  check("no page errors", () => assert.equal(unexpected.length, 0, unexpected.join(" || ").slice(0, 400)));
} catch (error) {
  failures.push(String(error.stack ?? error));
  record("scenario ran to the end", false, String(error.message ?? error).split("\n")[0]);
  console.error(error.stack ?? error);
}

// ================================================================== scan
try {
  const tgAll = await telegramText().catch(() => "");
  const ntfyAll = await ntfyText().catch(() => "");
  const pushesAll = backend && backend.exitCode === null ? await pushesText().catch(() => "") : "";
  const notesBeforeStop = backend && backend.exitCode === null ? JSON.stringify(await api("/api/assistant/notes").catch((e) => ({ error: String(e) }))) : "";
  await browser?.close().catch(() => {});
  await stopBackend();

  // Every SQLite database under PPM_HOME, row by row (a value split across overflow pages escapes a raw byte search).
  const dumpScript = join(sandbox, "dump-sqlite.ts");
  const dumpOut = join(sandbox, "dump.json");
  await writeFile(dumpScript, `import { Database } from "bun:sqlite";
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [root, out] = process.argv.slice(2);
const res: Record<string, Record<string, string>> = {};
const vault: unknown[] = [];
function walk(d: string) { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (s.size >= 100 && readFileSync(p).subarray(0, 16).toString("latin1") === "SQLite format 3\\u0000") dump(p); } }
function dump(p: string) {
  const db = new Database(p, { readonly: true });
  const parts: Record<string, string> = {};
  for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
    try {
      const rows = db.query(\`SELECT * FROM "\${name.replace(/"/g, '""')}"\`).values();
      parts[name] = rows.map((r) => r.map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v === null ? "" : String(v))).join("\\u0001")).join("\\n");
    } catch (e) { parts[name] = "<unreadable " + e + ">"; }
  }
  if (parts.vault_items !== undefined) {
    for (const r of db.query("SELECT tier, value_plain, ciphertext FROM vault_items").all() as { tier: string; value_plain: string | null; ciphertext: Uint8Array | null }[]) {
      vault.push({ file: p, tier: r.tier, plain: r.value_plain, cipher: r.ciphertext ? Buffer.from(r.ciphertext).toString("latin1") : null });
    }
  }
  res[p] = parts;
  db.close();
}
walk(root);
writeFileSync(out, JSON.stringify({ dbs: res, vault }));
`);
  await command("bun", [dumpScript, ppm, dumpOut]);
  const { dbs, vault } = JSON.parse(readFileSync(dumpOut, "utf8"));
  const dbText = (pred) => Object.entries(dbs).filter(([f]) => pred(f)).map(([, parts]) => Object.values(parts).join("\n")).join("\n");
  const allDbText = dbText(() => true);
  const traceDb = dbText((f) => f.endsWith("session-trace.db"));
  const notebook = Object.values(dbs).map((parts) => parts.assistant_notes ?? "").join("\n");
  const logFiles = walk(ppm).filter((f) => /\.log(\.\d+)?$/.test(f));
  const logsText = logFiles.map((f) => readFileSync(f, "utf8")).join("\n");
  const transcript = transcriptText();
  const providerStore = `${transcript}\n${existsSync(providerState) ? readFileSync(providerState, "utf8") : ""}`;
  const fixtureLog = readFileSync(join(logs, "fixture.log"), "utf8");
  const where = (needle) => {
    const hits = [];
    const files = filesWith(ppm, needle);
    if (files.length) hits.push(`PPM_HOME files: ${files.join(", ")}`);
    if (has(allDbText, needle)) hits.push("SQLite rows under PPM_HOME");
    if (has(logsText, needle)) hits.push("logs under PPM_HOME");
    if (has(tgAll, needle)) hits.push("fake Telegram");
    if (has(ntfyAll, needle)) hits.push("fake ntfy");
    if (has(pushesAll, needle)) hits.push("web pushes");
    if (has(notesBeforeStop, needle)) hits.push("notebook (API)");
    if (has(fixtureLog, needle)) hits.push("fixture stdout/stderr");
    if (has(providerStore, needle)) hits.push("provider transcript/store");
    return hits;
  };
  check("scan: the marker passwords are nowhere (PPM_HOME, DBs, logs, Telegram, ntfy, pushes, transcript, fixture output)", () => {
    const hits = [...where(PW2).map((h) => `PW2 in ${h}`), ...where(PW3).map((h) => `PW3 in ${h}`)];
    assert.equal(hits.length, 0, hits.join("; "));
  });
  check("scan: CANARY-T1 is not in ppm.log or any log under PPM_HOME", () => assert.ok(!has(logsText, "CANARY-T1-"), logFiles.filter((f) => readFileSync(f, "utf8").includes("CANARY-T1-")).join(", ")));
  check("scan: ppm.log exists and was written (the log check is not vacuous)", () => assert.ok(logFiles.some((f) => f.endsWith("ppm.log")) && logsText.length > 1000, `${logFiles.length} log files, ${logsText.length} chars`));
  check("scan: CANARY-T1 reached the AI (control)", () => assert.ok(transcript.includes(T1)));
  check("scan: CANARY-T2 reached the AI and sits in the provider transcript (control)", () => assert.ok(transcript.includes(T2A) && transcript.includes(T2B)));
  check("scan: CANARY-T2 only in the provider transcript", () => {
    const hits = where("CANARY-T2-").filter((h) => h !== "provider transcript/store");
    assert.equal(hits.length, 0, `also in: ${hits.join("; ")}`);
  });
  check("scan: CANARY-T3 (given to the AI once) only in the provider transcript", () => {
    assert.ok(transcript.includes(T3), "the give-to-AI read did not reach the transcript");
    const hits = where("CANARY-T3-").filter((h) => h !== "provider transcript/store");
    assert.equal(hits.length, 0, `also in: ${hits.join("; ")}`);
  });
  check("scan: session-trace.db was written and holds no T2/T3", () => {
    assert.ok(traceDb.length > 1000, `trace ${traceDb.length} chars`);
    assert.ok(!traceDb.includes("CANARY-T2-") && !traceDb.includes("CANARY-T3-"));
    assert.ok(traceDb.includes('"withheld":true'), "no withheld vault_read record");
  });
  check("scan: the notebook holds the ordinary line and no T2/T3", () => {
    assert.ok(notebook.includes("The user prefers short answers."), "control line missing");
    assert.ok(!notebook.includes("CANARY-T2-") && !notebook.includes("CANARY-T3-"));
  });
  check("scan: Telegram, ntfy and web pushes never received T2/T3", () => {
    const hits = [["Telegram", tgAll], ["ntfy", ntfyAll], ["web pushes", pushesAll]]
      .filter(([, t]) => t.includes("CANARY-T2-") || t.includes("CANARY-T3-")).map(([n]) => n);
    assert.equal(hits.length, 0, `received by: ${hits.join(", ")}`);
  });
  check("scan: ntfy received the fixed vault notification (control)", () => assert.ok(ntfyAll.includes("Unlock needed in the PPM vault")));
  check("scan: no vault card's purpose ever reached Telegram or ntfy (the manager chat's cards included)", () => {
    const hits = [["Telegram", tgAll], ["ntfy", ntfyAll]].filter(([, t]) => t.includes(PURPOSE)).map(([n]) => n);
    assert.equal(hits.length, 0, `in: ${hits.join(", ")}`);
  });
  check("scan: vault_items ciphertext holds no T2/T3 marker, and locked rows have no plain value", () => {
    assert.equal(vault.length, 4);
    for (const r of vault) {
      if (r.tier === "public") assert.equal(r.plain, T1);
      else { assert.equal(r.plain, null); assert.ok(r.cipher && !r.cipher.includes("CANARY-T")); }
    }
  });
  if (process.env.PPM_VAULT_KEEP_HOME === "1") cpSync(ppm, join(out, "ppm-home-copy"), { recursive: true });
} catch (error) {
  failures.push(String(error.stack ?? error));
  record("scan ran", false, String(error.message ?? error).split("\n")[0]);
}

// ================================================================== teardown + report
await browser?.close().catch(() => {});
await stopBackend().catch(() => {});
await fetch(`${ntfyInfo.control}/exit`).catch(() => {});
await tg.exit();
await sleep(300);
const stopped = [];
for (const [label, child] of started) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  stopped.push(`${label} pid=${child.pid}`);
}
const passed = results.filter((r) => r.passed).length, failed = results.length - passed;
const width = Math.max(...results.map((r) => r.name.length), 10);
const table = [
  `| ${"Check".padEnd(width)} | Result |`,
  `| ${"-".repeat(width)} | ------ |`,
  ...results.map((r) => `| ${r.name.padEnd(width)} | ${r.passed ? "PASS  " : "FAIL  "} |${r.passed ? "" : ` ${r.detail}`}`),
  "",
  `${passed} passed, ${failed} failed (${results.length} checks)`,
].join("\n");
console.log(`\n${table}`);
console.log(`processes started and stopped: ${stopped.join(", ")}`);
await writeFile(join(out, "vault-canary-summary.txt"), `${table}\n`);
await writeFile(join(out, "vault-canary-results.json"), JSON.stringify({ results, failures, screenshots, stopped }, null, 2));
process.exit(failed || failures.length ? 1 : 0);
