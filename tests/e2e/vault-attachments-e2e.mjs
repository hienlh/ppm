// Multi-line vault values and files on Secure/Sealed items, end to end: the production Vite bundle
// against the vault canary's disposable server (tests/e2e/fixtures/vault-server.ts, one scripted
// provider), the fake Telegram Bot API behind the PPM Assistant's bridge, and the fake ntfy. Fake
// marker values only.
//
// a. Settings → Vault: Secure and Sealed turned on; a Secure item whose value has four lines,
//    hidden while typed (discs; and the dots block where a browser cannot draw discs), shown
//    whole on Show, and read back whole from the row after saving.
// b. Files: a JPEG kept as it is on the Secure item (row, preview, byte-identical download,
//    rename, delete), an SVG refused, and a shrunk JPEG on the Sealed item with the password asked
//    at every step.
// c. A chat's vault_propose card with a multi-line value the AI filled in: hidden, then shown.
// d. Telegram: a sealed read's notice names the item and tier, links "Open in PPM" and
//    "Open Vault" (inline on a localhost address, buttons on a public https one), and opening the
//    Open Vault address lands on that item in Settings → Vault.
// e. The scan: the multi-line value, the propose value, the file's marker bytes and its original
//    name appear nowhere under PPM_HOME (files, every SQLite row, logs); the files on disk are
//    ciphertext.
// Then screenshots at 390, 768 and 1440.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/e2e/vault-attachments-e2e.mjs
//
// Meant for the capped e2e image (tests/e2e/docker/Dockerfile). PPM_VAULT_WEB_DIR reuses a web
// build; without it one is built into PPM_VAULT_OUT/web. Screenshots go to PPM_VAULT_SHOTS
// (default PPM_VAULT_OUT/screenshots), logs and the results to PPM_VAULT_OUT.
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

const sandbox = await mkdtemp(join(tmpdir(), "ppm-vault-attach-"));
const out = resolve(process.env.PPM_VAULT_OUT ?? join(sandbox, "out"));
const shots = resolve(process.env.PPM_VAULT_SHOTS ?? join(out, "screenshots"));
const logs = join(out, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project"), providerDir = join(sandbox, "provider");
const files = join(sandbox, "files");
await Promise.all([out, shots, logs, ppm, home, project, providerDir, files].map((p) => mkdir(p, { recursive: true })));

// ------------------------------------------------------------------ markers
const hex = (n) => randomBytes(n).toString("hex").toUpperCase();
const ML_LINES = [`MLV-L1-${hex(6)}`, `MLV-L2-${hex(6)}`, `  MLV-L3-${hex(6)} (indented)`, `MLV-L4-${hex(6)}`];
const ML = ML_LINES.join("\n");
const ML_EDIT = [`MLE-L1-${hex(6)}`, `MLE-L2-${hex(6)}`, `MLE-L3-${hex(6)}`].join("\n"); // typed for screenshots, never saved
const PROP_LINES = [`PROPV-L1-${hex(6)}`, `PROPV-L2-${hex(6)}`, `PROPV-L3-${hex(6)}`];
const PROP = PROP_LINES.join("\n");
const SEALV = `SEALV-${hex(8)}`;
const JPG_MARK = `JPGMARK-${hex(10)}`;
const FILE_NAME = `scan-${hex(5).toLowerCase()}-fname.jpg`;
const PW2 = `pw2-marker-${hex(8)}`;
const PW3 = `pw3-marker-sealed-${hex(8)}`;
const PURPOSE = `PURPOSE-MARK-${hex(4)}`;
const AUTH = randomBytes(16).toString("hex");
const NAMES = { ml: "Recovery codes", sealed: "Sealed passport", propose: "Bank recovery words" };
const LABELS = { photo: "Passport photo", renamed: "Passport photo page", sealedPhoto: "Sealed scan", sealedRenamed: "Sealed scan front" };
const TG_CHAT = 1001;
const PUBLIC_URL = "https://ppm-e2e.example.com";

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

const started = [];
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
  PPM_VAULT_WEB_DIR: webDir, PPM_VAULT_E2E_TOKEN: AUTH, PPM_VAULT_TRANSCRIPT: join(providerDir, "transcript.jsonl"),
  PPM_VAULT_PROVIDER_STATE: join(providerDir, "state.json"), PPM_VAULT_NTFY_URL: ntfyInfo.url, PPM_LOG_LEVEL: "debug",
  PPM_TELEGRAM_API_BASE: tgInfo.api, PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: tgInfo.token,
  PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify([[String(TG_CHAT), String(TG_CHAT), "Phone owner"]]),
  PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "300",
};
for (const k of ["PPM_ALLOW_PROD_DB", "NOTIFY_SOCKET", "PPM_VAULT_FIXTURE_RESUME"]) delete fixtureEnv[k];

let backend = null;
async function startBackend() {
  const s = startChild("bun", ["tests/e2e/fixtures/vault-server.ts"], { env: fixtureEnv, log: join(logs, "fixture.log"), ready: /Vault fixture ready/ });
  backend = s.child;
  started.push(["fixture", s.child]);
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
async function turnDone(label, timeout = 60000) {
  return until(`${label} done`, async () => {
    const s = await fx();
    const turn = s.turns.find((t) => t.label === label);
    return turn?.done ? { turn, calls: s.calls.filter((c) => c.label === label) } : null;
  }, timeout);
}
const itemsNow = async () => (await api("/api/vault/items")).data;

// ------------------------------------------------------------------ results
const results = [];
const record = (name, passed, detail = "") => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const check = async (name, fn) => {
  try { await fn(); record(name, true); } catch (e) { record(name, false, String(e.message ?? e).replace(/\s+/g, " ").slice(0, 400)); }
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
  if (window.top !== window || location.protocol !== "http:") return;
  localStorage.setItem("ppm-auth-token", token);
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
};
/** Firefox's case in Chromium: a browser that cannot draw a textarea's characters as discs. */
const noDiscs = () => {
  const own = CSS.supports.bind(CSS);
  CSS.supports = (...a) => (String(a[0]).includes("text-security") ? false : own(...a));
};
const VIEWPORTS = {
  390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  768: { viewport: { width: 768, height: 1024 }, hasTouch: true, deviceScaleFactor: 1 },
  1440: { viewport: { width: 1440, height: 900 } },
};
let browser;
const pageErrors = [];
async function newPage(width, { height, discs = true } = {}) {
  const spec = VIEWPORTS[width];
  const context = await browser.newContext({ ...spec, viewport: { ...spec.viewport, ...(height ? { height } : {}) }, serviceWorkers: "block", acceptDownloads: true });
  await context.addInitScript(signedIn, [AUTH]);
  if (!discs) await context.addInitScript(noDiscs);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${width} ${page.url()}: ${e}`));
  return page;
}
const visible = (loc) => loc.filter({ visible: true });
async function send(page, text) {
  const box = page.locator(COMPOSER).first();
  await box.waitFor({ timeout: 30000 });
  await box.fill(text);
  await box.press("Enter");
}
const PROJECT = "vaultproj";
let chatSessionId;
const layoutFor = (sessionId) => {
  const tab = { id: `chat-${sessionId}`, type: "chat", title: "Vault attachments", projectId: PROJECT, closable: true, metadata: { projectName: PROJECT, sessionId, providerId: "claude" } };
  return { layout: { panels: { main: { id: "main", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } }, grid: [["main"]], focusedPanelId: "main" } };
};
async function openChat(width) {
  await api(`/api/project/${PROJECT}/workspace`, { method: "PUT", body: JSON.stringify(layoutFor(chatSessionId)) });
  const page = await newPage(width);
  await page.goto(`${web}/project/${PROJECT}`);
  await page.locator(COMPOSER).first().waitFor({ timeout: 30000 });
  return page;
}
/** Settings → Vault through the address a Telegram notice gives (`/?openVault=<id>`). */
async function openVault(width, itemId, opts) {
  // A phone run leaves Settings open as a tab in the project's saved layout; on a wider screen the
  // link then opens a Settings window over that tab. Start from the chat layout instead.
  if (chatSessionId) await api(`/api/project/${PROJECT}/workspace`, { method: "PUT", body: JSON.stringify(layoutFor(chatSessionId)) });
  const page = await newPage(width, opts);
  await page.goto(`${web}/?openVault=${itemId ?? "all"}`);
  await visible(page.locator('[data-vault-tier="secure"]')).first().waitFor({ timeout: 30000 });
  const bar = visible(page.locator('[aria-label="Settings title bar"]'));
  if (await bar.count()) { await bar.first().dblclick(); await page.waitForTimeout(400); }
  return page;
}

/**
 * Answers Settings → Vault's confirm-and-password prompt titled `title`, when it shows (a locked
 * Secure tier, always for Sealed). Returns whether it showed and whether it asked for the password.
 */
async function answerPrompt(page, title, confirm, pwLabel, pw, { required = false } = {}) {
  const heading = visible(page.getByText(title, { exact: true }));
  try { await heading.first().waitFor({ timeout: required ? 15000 : 3000 }); } catch (e) { if (required) throw e; return { shown: false, asked: false }; }
  const pwBox = visible(page.getByLabel(pwLabel, { exact: true }));
  let asked = (await pwBox.count()) > 0;
  if (asked) await pwBox.last().fill(pw);
  const button = visible(page.getByRole("button", { name: confirm, exact: true })).last();
  await button.click();
  const end = await until(`prompt "${title}" closes`, async () => {
    if (!(await heading.count())) return "closed";
    if (!asked && await pwBox.count()) return "needs";
    const alert = visible(page.locator('[role="alert"]'));
    if (asked && await alert.count()) throw new Error(`prompt refused: ${await alert.first().innerText()}`);
    return null;
  }, 20000);
  if (end === "needs") {
    asked = true;
    await pwBox.last().fill(pw);
    await button.click();
    await until(`prompt "${title}" closes`, async () => (await heading.count()) === 0, 20000);
  }
  return { shown: true, asked };
}

/** Opens a locked item's upload dialog, chooses `path`, and attaches it; returns the alert text on a refusal. */
async function attach(page, itemId, itemName, path, { label, keepOriginal, pwLabel, pw, expectRefusal = false, shotName }) {
  await visible(page.locator(`[data-vault-item="${itemId}"]`)).first().getByRole("button", { name: "Attach a photo or PDF", exact: true }).click();
  const title = visible(page.getByText(`Attach a file to “${itemName}”`, { exact: true }));
  await title.first().waitFor({ timeout: 15000 });
  await page.locator("[data-vault-upload-input]").last().setInputFiles(path);
  await visible(page.locator("[data-vault-upload-chosen]")).first().waitFor({ timeout: 10000 });
  if (label) await visible(page.getByRole("textbox", { name: "Label", exact: true })).last().fill(label);
  if (keepOriginal) await visible(page.locator('[data-vault-check="keep-original"] input')).last().check();
  const pwBox = visible(page.getByLabel(pwLabel, { exact: true }));
  const asked = (await pwBox.count()) > 0;
  if (asked) await pwBox.last().fill(pw);
  if (shotName) await shot(page, shotName.name, shotName.note);
  const button = visible(page.getByRole("button", { name: "Attach", exact: true })).last();
  await button.click();
  const alert = visible(page.locator('[role="alert"]'));
  const end = await until("upload answered", async () => {
    if (!(await title.count())) return "closed";
    if (await alert.count()) return "alert";
    return null;
  }, 30000);
  if (end === "alert" && !asked && await pwBox.count()) {
    await pwBox.last().fill(pw);
    await button.click();
    await until("upload answered", async () => (!(await title.count()) ? "closed" : (await alert.count()) ? "alert" : null), 30000);
  }
  if (await title.count()) {
    const text = await alert.first().innerText().catch(() => "");
    if (!expectRefusal) throw new Error(`upload refused: ${text}`);
    await visible(page.getByRole("button", { name: "Cancel", exact: true })).last().click();
    await until("upload dialog closed", async () => (await title.count()) === 0, 10000);
    return { refused: text, asked };
  }
  return { refused: null, asked };
}

// A row's button can sit under a sticky section header inside the Settings window (768 px):
// centre it first, then click.
const tap = async (loc) => { await loc.evaluate((el) => el.scrollIntoView({ block: "center" })); await loc.click(); };
const fileRow = (page, fileId) => visible(page.locator(`[data-vault-file="${fileId}"]`)).first();

// ------------------------------------------------------------------ JPEG / SVG fixtures
/** A small JPEG drawn on a canvas, with a COM segment holding `JPG_MARK` right after SOI. */
async function makeJpeg(page) {
  await page.setContent("<canvas id=c width=480 height=300></canvas>");
  const b64 = await page.evaluate(() => {
    const c = document.getElementById("c");
    const g = c.getContext("2d");
    g.fillStyle = "#2b6cb0"; g.fillRect(0, 0, 480, 300);
    g.fillStyle = "#f6e05e"; g.fillRect(30, 40, 140, 180);
    g.fillStyle = "#fff"; g.font = "bold 28px sans-serif"; g.fillText("TEST ID CARD", 200, 110);
    g.font = "18px sans-serif"; g.fillText("fake document for an e2e", 200, 150);
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  });
  const jpeg = Buffer.from(b64, "base64");
  const mark = Buffer.from(JPG_MARK, "ascii");
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, (mark.length + 2) >> 8, (mark.length + 2) & 0xff]), mark]);
  return Buffer.concat([jpeg.subarray(0, 2), com, jpeg.subarray(2)]);
}

// ------------------------------------------------------------------ scanning
function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...walk(p)); else found.push(p);
  }
  return found;
}
const filesWith = (dir, needle) => {
  const n = Buffer.isBuffer(needle) ? needle : Buffer.from(needle, "utf8");
  return walk(dir).filter((f) => { try { return readFileSync(f).includes(n); } catch { return false; } }).map((f) => f.slice(dir.length + 1));
};

// ================================================================== run
const failures = [];
let mlId, sealedId, jpeg;
try {
  await startBackend();
  await post("/api/projects", { name: PROJECT, path: project });
  chatSessionId = (await post(`/api/project/${PROJECT}/chat/sessions`, { providerId: "claude", title: "Vault attachments" })).data.id;
  await until("bridge running", async () => (await api("/__vault-test/tg/bridge")).running, 30000);

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });

  {
    const p = await browser.newPage();
    jpeg = await makeJpeg(p);
    await p.close();
  }
  const jpegPath = join(files, FILE_NAME);
  await writeFile(jpegPath, jpeg);
  const sealedJpegPath = join(files, "sealed-scan.jpg");
  await writeFile(sealedJpegPath, jpeg);
  const svgPath = join(files, "drawing.svg");
  await writeFile(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>`);
  record("fixture: the generated JPEG is a JPEG and carries the marker bytes (control)", jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg.includes(Buffer.from(JPG_MARK)));

  // ---------------------------------------------------------------- a. Settings → Vault, multi-line
  {
    const page = await newPage(1440, { height: 1500 });
    await page.goto(`${web}/project/${PROJECT}`);
    await page.locator('button[aria-label="Settings"]').first().click();
    await page.locator('[data-testid="settings-rail-vault"]').click();
    const secure = page.locator('[data-vault-tier="secure"]');
    const sealed = page.locator('[data-vault-tier="sealed"]');
    await secure.waitFor({ timeout: 20000 });
    for (const [group, label, password] of [[secure, "Secure tier password", PW2], [sealed, "Sealed tier password", PW3]]) {
      await group.getByRole("button", { name: "Turn on" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(label).fill(password);
      await dialog.getByLabel("Type it again").fill(password);
      await dialog.locator('[data-vault-check="forget-ack"] input').check();
      await dialog.getByRole("button", { name: "Turn on" }).click();
      await dialog.waitFor({ state: "detached", timeout: 20000 });
      await group.getByRole("button", { name: "Change password" }).waitFor({ timeout: 20000 });
    }
    await page.locator('[aria-label="Settings title bar"]').dblclick().catch(() => {});

    // Add the multi-line Secure item, checking the field while it is hidden and shown.
    await secure.getByRole("button", { name: "Add", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(NAMES.ml);
    const valueBox = dialog.getByRole("textbox", { name: "Value", exact: true });
    await valueBox.fill(ML);
    const hidden = await valueBox.evaluate((el) => ({
      masked: el.hasAttribute("data-vault-value-masked"),
      security: getComputedStyle(el).getPropertyValue("-webkit-text-security"),
      tag: el.tagName,
    }));
    const dialogText = await dialog.innerText();
    await check("a: the value field is a textarea drawn as discs while hidden, and no line is in the dialog's text", () => {
      assert.equal(hidden.tag, "TEXTAREA");
      assert.equal(hidden.masked, true);
      assert.equal(hidden.security.trim(), "disc");
      for (const l of ML_LINES) assert.ok(!dialogText.includes(l.trim()), `"${l}" visible`);
      assert.match(dialogText, /4 lines · /);
    });
    await shot(page, "after-a-add-dialog-multiline-hidden-1440", "Add Secure item: a four-line value, hidden (discs)");
    await dialog.getByRole("button", { name: "Show value", exact: true }).click();
    const shownState = await valueBox.evaluate((el) => ({ masked: el.hasAttribute("data-vault-value-masked"), value: el.value, security: getComputedStyle(el).getPropertyValue("-webkit-text-security") }));
    await check("a: Show value reveals every line in the field", () => {
      assert.equal(shownState.masked, false);
      assert.equal(shownState.value, ML);
      assert.notEqual(shownState.security.trim(), "disc");
    });
    await shot(page, "after-a-add-dialog-multiline-shown-1440", "Add Secure item: the same value after Show value");
    await dialog.getByRole("button", { name: "Hide value", exact: true }).click();
    const pwBox = dialog.getByLabel("Secure tier password");
    if (await pwBox.count()) await pwBox.fill(PW2);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.waitFor({ state: "detached", timeout: 20000 });

    // A single-line Sealed item for the sealed read.
    await sealed.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(NAMES.sealed);
    await dialog.getByRole("combobox", { name: "Kind" }).selectOption("passport");
    await dialog.getByRole("textbox", { name: "Value", exact: true }).fill(SEALV);
    if (await dialog.getByLabel("Sealed tier password").count()) await dialog.getByLabel("Sealed tier password").fill(PW3);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.waitFor({ state: "detached", timeout: 20000 });

    const items = await itemsNow();
    mlId = items.find((i) => i.name === NAMES.ml)?.id;
    sealedId = items.find((i) => i.name === NAMES.sealed)?.id;
    await check("a: both items saved in their tiers, and /api/vault/items carries no value", () => {
      assert.ok(mlId && sealedId);
      assert.equal(items.find((i) => i.id === mlId).tier, "secure");
      assert.equal(items.find((i) => i.id === sealedId).tier, "sealed");
      const text = JSON.stringify(items);
      for (const l of [...ML_LINES, SEALV]) assert.ok(!text.includes(l.trim()));
    });
    const row = page.locator(`[data-vault-item="${mlId}"]`);
    await row.waitFor({ timeout: 10000 });
    const html = await page.content();
    await check("a: hidden in the row — no value element and no line anywhere in the page's DOM", async () => {
      assert.equal(await row.locator("[data-vault-value]").count(), 0);
      for (const l of ML_LINES) assert.ok(!html.includes(l.trim()), `"${l.trim()}" in DOM`);
    });
    await row.getByRole("button", { name: "Show", exact: true }).click();
    await answerPrompt(page, `Show “${NAMES.ml}”`, "Show", "Secure tier password", PW2);
    const shownValue = row.locator("[data-vault-value]");
    await shownValue.waitFor({ timeout: 15000 });
    const shownText = await shownValue.innerText();
    await check("a: Show in the row reads the saved value back with all four lines (round trip)", () => {
      assert.equal(shownText.replace(/\r/g, ""), ML);
    });
    await shot(page, "after-a-row-multiline-shown-1440", "Settings → Vault: the saved four-line value shown in the row");
    await row.getByRole("button", { name: "Hide", exact: true }).click();
    await page.context().close();

    // Firefox's case: no discs, a dots block holding no value at all.
    const ff = await openVault(390, mlId, { discs: false });
    await visible(ff.locator('[data-vault-tier="secure"]')).first().getByRole("button", { name: "Add", exact: true }).click();
    const block = visible(ff.locator("[data-vault-value-hidden]")).last();
    await block.waitFor({ timeout: 10000 });
    const emptyText = await block.innerText();
    await visible(ff.getByRole("button", { name: "Show value", exact: true })).last().click();
    await visible(ff.getByRole("textbox", { name: "Value", exact: true })).last().fill(ML);
    await visible(ff.getByRole("button", { name: "Hide value", exact: true })).last().click();
    await block.waitFor({ timeout: 10000 });
    const blockText = await block.innerText();
    const ffHtml = await ff.content();
    await check("a (no-discs browser): hidden is a dots block, the value is in no element of the DOM", () => {
      assert.match(emptyText, /Hidden\. Tap Show to type\./);
      assert.match(blockText, /•+ \(4 lines\)/);
      for (const l of ML_LINES) assert.ok(!ffHtml.includes(l.trim()), `"${l.trim()}" in DOM`);
    });
    await shot(ff, "after-a-dots-block-no-discs-390", "Phone, browser without text-security: the hidden value as a dots block");
    await visible(ff.getByRole("button", { name: "Cancel", exact: true })).last().click();
    await ff.context().close();
  }

  // ---------------------------------------------------------------- b. Files
  let photoId, sealedFileId;
  {
    const page = await openVault(1440, mlId, { height: 1200 });
    // An SVG is refused.
    const before = (await itemsNow()).find((i) => i.id === mlId).attachments?.length ?? 0;
    const svg = await attach(page, mlId, NAMES.ml, svgPath, { label: "Drawing", pwLabel: "Secure tier password", pw: PW2, expectRefusal: true });
    const afterSvg = (await itemsNow()).find((i) => i.id === mlId).attachments?.length ?? 0;
    await check("b: an SVG is refused with the file-type message, and nothing is attached", () => {
      assert.match(svg.refused ?? "", /Only JPEG, PNG and WebP photos and PDF files can be kept in the vault/);
      assert.equal(afterSvg, before);
    });

    // The JPEG, kept as it is.
    await attach(page, mlId, NAMES.ml, jpegPath, {
      label: LABELS.photo, keepOriginal: true, pwLabel: "Secure tier password", pw: PW2,
      shotName: { name: "after-b-upload-dialog-filled-1440", note: "Attach a file: JPEG chosen, label, Keep the original ticked" },
    });
    const att = (await itemsNow()).find((i) => i.id === mlId).attachments ?? [];
    photoId = att.find((a) => a.label === LABELS.photo)?.id;
    await check("b: the JPEG is attached with its label, type and the original's exact size", () => {
      assert.ok(photoId, JSON.stringify(att));
      const a = att.find((x) => x.id === photoId);
      assert.equal(a.type, "image/jpeg");
      assert.equal(a.size, jpeg.length);
      assert.ok(!JSON.stringify(att).includes(FILE_NAME), "the original file name is in the listing");
    });
    const rowEl = fileRow(page, photoId);
    await rowEl.waitFor({ timeout: 15000 });
    const rowText = await rowEl.innerText();
    await check("b: the file row shows the label, JPEG and its size", () => {
      assert.ok(rowText.includes(LABELS.photo));
      assert.match(rowText, /JPEG · \d+ (KB|B)/);
    });
    await check("b: the item row counts one file", async () => assert.match(await page.locator(`[data-vault-item="${mlId}"] [data-vault-file-count]`).innerText(), /1/));
    await shot(page, "after-b-item-with-file-1440", "Settings → Vault: the Secure item with its attached JPEG");

    // Preview.
    await rowEl.getByRole("button", { name: `Preview ${LABELS.photo}`, exact: true }).click();
    await answerPrompt(page, `Open “${LABELS.photo}”`, "Open", "Secure tier password", PW2);
    const viewer = page.locator("[data-vault-viewer]");
    const img = viewer.locator("img[data-vault-viewer-image]");
    await img.waitFor({ timeout: 15000 });
    await until("image decoded", () => img.evaluate((el) => el.complete && el.naturalWidth > 0), 10000);
    const natural = await img.evaluate((el) => [el.naturalWidth, el.naturalHeight, el.src.slice(0, 5)]);
    await check("b: Preview opens the viewer with the decoded image from a blob: URL", () => {
      assert.deepEqual(natural, [480, 300, "blob:"]);
    });
    await shot(page, "after-b-image-viewer-1440", "The vault file viewer showing the JPEG, with its countdown");
    await viewer.getByRole("button", { name: "Close", exact: true }).click();
    await viewer.waitFor({ state: "detached", timeout: 10000 });

    // Download: the original bytes.
    const downloadP = page.waitForEvent("download", { timeout: 30000 });
    await fileRow(page, photoId).getByRole("button", { name: `Download ${LABELS.photo}`, exact: true }).click();
    await answerPrompt(page, `Download “${LABELS.photo}”`, "Download", "Secure tier password", PW2);
    const download = await downloadP;
    const got = readFileSync(await download.path());
    await check("b: Download yields the original bytes and the original file name", () => {
      assert.ok(got.equals(jpeg), `${got.length} bytes vs ${jpeg.length}`);
      assert.equal(download.suggestedFilename(), FILE_NAME);
    });

    // Rename.
    await fileRow(page, photoId).getByRole("button", { name: `Rename ${LABELS.photo}`, exact: true }).click();
    await visible(page.getByText("Rename file", { exact: true })).first().waitFor({ timeout: 10000 });
    await visible(page.getByRole("textbox", { name: "Label", exact: true })).last().fill(LABELS.renamed);
    await visible(page.getByRole("button", { name: "Rename", exact: true })).last().click();
    await answerPrompt(page, `Rename “${LABELS.photo}”`, "Rename", "Secure tier password", PW2);
    await until("renamed", async () => (await itemsNow()).find((i) => i.id === mlId).attachments?.find((a) => a.id === photoId)?.label === LABELS.renamed, 15000);
    await fileRow(page, photoId).getByText(LABELS.renamed, { exact: true }).waitFor({ timeout: 10000 });
    record("b: Rename changes the label in the list and the API", true);

    // A second file to delete (the first stays for the screenshots).
    await attach(page, mlId, NAMES.ml, jpegPath, { label: "Throwaway copy", keepOriginal: true, pwLabel: "Secure tier password", pw: PW2 });
    const throwaway = (await itemsNow()).find((i) => i.id === mlId).attachments.find((a) => a.label === "Throwaway copy");
    await fileRow(page, throwaway.id).getByRole("button", { name: "Delete Throwaway copy", exact: true }).click();
    await answerPrompt(page, "Delete “Throwaway copy”?", "Delete", "Secure tier password", PW2, { required: true });
    await until("deleted", async () => !(await itemsNow()).find((i) => i.id === mlId).attachments?.some((a) => a.id === throwaway.id), 15000);
    await check("b: Delete removes the file from the list and the API", async () => assert.equal(await page.locator(`[data-vault-file="${throwaway.id}"]`).count(), 0));
    await page.context().close();

    // Sealed: the photo shrunk (no Keep the original), the password asked at every step.
    const sp = await openVault(1440, sealedId, { height: 1200 });
    const up = await attach(sp, sealedId, NAMES.sealed, sealedJpegPath, { label: LABELS.sealedPhoto, keepOriginal: false, pwLabel: "Sealed tier password", pw: PW3 });
    sealedFileId = (await itemsNow()).find((i) => i.id === sealedId).attachments?.find((a) => a.label === LABELS.sealedPhoto)?.id;
    await check("sealed: the upload dialog asked for the Sealed password, and the file is attached", () => { assert.equal(up.asked, true); assert.ok(sealedFileId); });
    await fileRow(sp, sealedFileId).waitFor({ timeout: 15000 });
    await fileRow(sp, sealedFileId).getByRole("button", { name: `Preview ${LABELS.sealedPhoto}`, exact: true }).click();
    const sPrev = await answerPrompt(sp, `Open “${LABELS.sealedPhoto}”`, "Open", "Sealed tier password", PW3, { required: true });
    await sp.locator("[data-vault-viewer] img[data-vault-viewer-image]").waitFor({ timeout: 15000 });
    await sp.locator("[data-vault-viewer]").getByRole("button", { name: "Close", exact: true }).click();
    const sDlP = sp.waitForEvent("download", { timeout: 30000 });
    await fileRow(sp, sealedFileId).getByRole("button", { name: `Download ${LABELS.sealedPhoto}`, exact: true }).click();
    const sDl = await answerPrompt(sp, `Download “${LABELS.sealedPhoto}”`, "Download", "Sealed tier password", PW3, { required: true });
    const sGot = readFileSync(await (await sDlP).path());
    await check("sealed: the shrunk photo downloads as a JPEG without the original's marker bytes (redrawn, metadata dropped)", () => {
      assert.ok(sGot[0] === 0xff && sGot[1] === 0xd8 && sGot[2] === 0xff);
      assert.ok(!sGot.includes(Buffer.from(JPG_MARK)));
    });
    await fileRow(sp, sealedFileId).getByRole("button", { name: `Rename ${LABELS.sealedPhoto}`, exact: true }).click();
    await visible(sp.getByRole("textbox", { name: "Label", exact: true })).last().fill(LABELS.sealedRenamed);
    await visible(sp.getByRole("button", { name: "Rename", exact: true })).last().click();
    const sRen = await answerPrompt(sp, `Rename “${LABELS.sealedPhoto}”`, "Rename", "Sealed tier password", PW3, { required: true });
    await until("sealed renamed", async () => (await itemsNow()).find((i) => i.id === sealedId).attachments?.[0]?.label === LABELS.sealedRenamed, 15000);
    await fileRow(sp, sealedFileId).getByRole("button", { name: `Delete ${LABELS.sealedRenamed}`, exact: true }).click();
    const sDel = await answerPrompt(sp, `Delete “${LABELS.sealedRenamed}”?`, "Delete", "Sealed tier password", PW3, { required: true });
    await until("sealed deleted", async () => !((await itemsNow()).find((i) => i.id === sealedId).attachments?.length), 15000);
    await check("sealed: preview, download, rename and delete each asked for the Sealed password", () => {
      assert.deepEqual([sPrev.asked, sDl.asked, sRen.asked, sDel.asked], [true, true, true, true]);
    });
    await sp.context().close();
  }

  // ---------------------------------------------------------------- c. propose card (per width) + screenshots
  const proposeTurn = async (width) => {
    const label = `propose-${width}`;
    const match = `vault attach propose ${width}`;
    await script(label, match, [{ call: "vault_propose", via: "sessions", args: { name: NAMES.propose, kind: "other", tier: "secure", value: PROP } }]);
    const page = await openChat(width);
    const tgBefore = (await tg.sent(TG_CHAT)).length;
    await send(page, match);
    const card = visible(page.locator('[data-vault-card="propose"]')).last();
    await card.waitFor({ timeout: 30000 });
    await card.locator("[data-vault-prefill-warning]").waitFor({ timeout: 15000 });
    const box = card.getByRole("textbox", { name: "Value", exact: true });
    await card.scrollIntoViewIfNeeded();
    const st = await box.evaluate((el) => ({ masked: el.hasAttribute("data-vault-value-masked"), security: getComputedStyle(el).getPropertyValue("-webkit-text-security") }));
    const cardText = await card.innerText();
    await check(`c (${width}): the propose card's prefilled value is hidden by default (discs, no line in the card's text)`, () => {
      assert.equal(st.masked, true);
      assert.equal(st.security.trim(), "disc");
      for (const l of PROP_LINES) assert.ok(!cardText.includes(l));
      assert.match(cardText, /3 lines · /);
    });
    await shot(page, `after-c-propose-card-hidden-${width}`, `Chat (${width}px): vault_propose card, prefilled three-line value hidden`);
    await card.getByRole("button", { name: "Show value", exact: true }).click();
    await check(`c (${width}): Show value reveals all three lines`, async () => assert.equal(await box.inputValue(), PROP));
    await box.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(page, `after-c-propose-card-shown-${width}`, `Chat (${width}px): the same card after Show value`);
    if (width === 1440) {
      const notice = await tg.waitFor(TG_CHAT, "propose notice", (m) => m.text.includes("Save to the vault?"), 30000);
      await check("c: the propose card's Telegram notice gives the tier, not the AI's proposed name or the value, and links to Vault", () => {
        assert.ok(!notice.text.includes(NAMES.propose), notice.text);
        assert.ok(notice.text.includes("Secure"), notice.text);
        for (const l of PROP_LINES) assert.ok(!JSON.stringify(notice).includes(l));
        assert.ok(notice.text.includes("Open Vault") && notice.text.includes("openVault=all"), notice.text);
      });
      void tgBefore;
    }
    await card.getByRole("button", { name: "Decline", exact: true }).click();
    await turnDone(label);
    await page.context().close();
  };
  for (const w of [1440, 768, 390]) await proposeTurn(w);

  // ---------------------------------------------------------------- d. Telegram notice for a sealed read
  let vaultPath;
  {
    const chat = await openChat(1440);
    const sealedRead = async (label, match) => {
      await script(label, match, [{ call: "vault_read", via: "sessions", args: { items: [NAMES.sealed], purpose: `${PURPOSE} ${label}` } }]);
      await send(chat, match);
      const card = visible(chat.locator('[data-vault-card="read-sealed"]')).last();
      await card.waitFor({ timeout: 30000 });
      return card;
    };
    const card1 = await sealedRead("d1-sealed-localhost", "vault attach sealed read one");
    const n1 = await tg.waitFor(TG_CHAT, "sealed notice (localhost)", (m) => m.text.includes("Vault unlock requested") && m.text.includes(NAMES.sealed), 30000);
    const raw1 = JSON.stringify(n1);
    const link = /Open Vault: (\S+)/.exec(n1.text)?.[1];
    await check("d: the sealed notice names the item and the Sealed tier, never the value or the purpose", () => {
      assert.match(n1.text, new RegExp(`asks to open the Sealed item ${NAMES.sealed}`));
      assert.ok(!raw1.includes(SEALV) && !raw1.includes(PURPOSE));
    });
    await check("d: on a localhost address both links are inline text (Telegram takes only public https as buttons)", () => {
      assert.ok(/Open in PPM: http:\/\/localhost:\d+\//.test(n1.text), n1.text);
      assert.ok(link && link.endsWith(`/?openVault=${sealedId}`), n1.text);
      assert.equal(n1.reply_markup?.inline_keyboard?.flat().length ?? 0, 0);
    });
    await card1.getByRole("button", { name: "Decline", exact: true }).click();
    await turnDone("d1-sealed-localhost");

    await post("/__vault-test/public-url", { url: PUBLIC_URL });
    const card2 = await sealedRead("d2-sealed-public", "vault attach sealed read two");
    const n2 = await tg.waitFor(TG_CHAT, "sealed notice (public)", (m) => m.text.includes("Vault unlock requested") && (m.reply_markup?.inline_keyboard?.flat().length ?? 0) > 0, 30000);
    await post("/__vault-test/public-url", { url: null });
    const buttons = n2.reply_markup.inline_keyboard.flat();
    await check("d: on a public https address the notice carries two URL buttons, Open in PPM and Open Vault", () => {
      assert.deepEqual(buttons.map((b) => b.text), ["Open in PPM", "Open Vault"]);
      assert.equal(buttons[1].url, `${PUBLIC_URL}/?openVault=${sealedId}`);
      assert.ok(buttons[0].url.startsWith(`${PUBLIC_URL}/`));
      assert.ok(!JSON.stringify(n2).includes(SEALV) && !JSON.stringify(n2).includes(PURPOSE));
    });
    await card2.getByRole("button", { name: "Decline", exact: true }).click();
    await turnDone("d2-sealed-public");
    await chat.context().close();

    // The notice rendered as Telegram would show it.
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const render = (m, note) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="margin:0;font:15px -apple-system,Segoe UI,Roboto,sans-serif;background:#8eb8d6;min-height:100vh">
<div style="background:#517da2;color:#fff;padding:12px 16px;font-weight:600">PPM bot <span style="font-weight:400;opacity:.8;font-size:12px">(fake Telegram)</span></div>
<div style="padding:12px;max-width:480px">
<div style="background:#fff;border-radius:12px 12px 12px 4px;padding:8px 11px;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 1px rgba(0,0,0,.15)">${m.html ?? esc(m.text)}</div>
${(m.reply_markup?.inline_keyboard ?? []).map((r) => `<div style="display:flex;gap:4px;margin-top:4px">${r.map((b) => `<div style="flex:1;text-align:center;background:rgba(0,0,0,.25);color:#fff;border-radius:8px;padding:9px 6px">${esc(b.text)} &#8599;</div>`).join("")}</div>`).join("")}
<p style="font-size:11px;color:#234;margin-top:12px">${esc(note)}</p></div></body>`;
    for (const w of [390, 768, 1440]) {
      const tp = await browser.newPage({ viewport: { width: w, height: 640 } });
      await tp.setContent(render(n2, `As received by the fake Bot API (parse_mode ${n2.parse_mode}); link base ${PUBLIC_URL}.`));
      await shot(tp, `after-telegram-vault-notice-${w}`, `Telegram notice for a sealed read, URL buttons (${w}px)`);
      await tp.close();
    }
    const tp = await browser.newPage({ viewport: { width: 390, height: 640 } });
    await tp.setContent(render(n1, "As received with PPM on localhost: links are inline text."));
    await shot(tp, "after-telegram-vault-notice-inline-390", "Telegram notice when PPM's address is localhost: inline links");
    await tp.close();

    // Open Vault's address lands on the item.
    vaultPath = new URL(link).pathname + new URL(link).search;
    for (const w of [1440, 390]) {
      const p = await newPage(w);
      await p.goto(`${web}${vaultPath}`);
      const target = visible(p.locator(`[data-vault-item="${sealedId}"]`)).first();
      await target.waitFor({ timeout: 30000 });
      await sleep(900);
      const inView = await target.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
      const ring = await target.evaluate((el) => el.classList.contains("ring-2"));
      await check(`d (${w}): opening the Open Vault address shows Settings → Vault on that item, in view and marked`, () => {
        assert.equal(inView, true);
        assert.equal(ring, true);
        assert.ok(!p.url().includes("openVault"), p.url());
      });
      await shot(p, `after-d-open-vault-link-${w}`, `Opened from the Open Vault link (${w}px): Settings → Vault on the sealed item`);
      await p.context().close();
    }
  }

  // ---------------------------------------------------------------- screenshots of Settings → Vault, three widths
  for (const w of [390, 768, 1440]) {
    const page = await openVault(w, mlId);
    const row = visible(page.locator(`[data-vault-item="${mlId}"]`)).first();
    await row.waitFor({ timeout: 20000 });
    await sleep(4300); // the item the address named is marked for 4 s
    await row.scrollIntoViewIfNeeded();
    await shot(page, `after-vault-list-hidden-${w}`, `Settings → Vault (${w}px): multi-line Secure item hidden, one file attached`);
    await tap(row.getByRole("button", { name: "Show", exact: true }));
    await answerPrompt(page, `Show “${NAMES.ml}”`, "Show", "Secure tier password", PW2);
    await row.locator("[data-vault-value]").waitFor({ timeout: 15000 });
    await row.scrollIntoViewIfNeeded();
    await shot(page, `after-vault-value-shown-${w}`, `Settings → Vault (${w}px): the four-line value shown in the row`);
    await tap(row.getByRole("button", { name: "Hide", exact: true }));

    await tap(row.getByRole("button", { name: "Edit", exact: true }));
    const valueBox = visible(page.getByRole("textbox", { name: "Value", exact: true })).last();
    await valueBox.waitFor({ timeout: 10000 });
    await valueBox.fill(ML_EDIT);
    await shot(page, `after-vault-edit-dialog-hidden-${w}`, `Edit Secure item (${w}px): a new three-line value typed, hidden`);
    await visible(page.getByRole("button", { name: "Show value", exact: true })).last().click();
    await shot(page, `after-vault-edit-dialog-shown-${w}`, `Edit Secure item (${w}px): the same after Show value`);
    await visible(page.getByRole("button", { name: "Cancel", exact: true })).last().click();
    await sleep(400);

    await tap(row.getByRole("button", { name: "Attach a photo or PDF", exact: true }));
    await visible(page.getByText(`Attach a file to “${NAMES.ml}”`, { exact: true })).first().waitFor({ timeout: 10000 });
    await page.locator("[data-vault-upload-input]").last().setInputFiles(jpegPath);
    await visible(page.locator("[data-vault-upload-chosen]")).first().waitFor({ timeout: 10000 });
    await visible(page.getByRole("textbox", { name: "Label", exact: true })).last().fill("Driving licence");
    await shot(page, `after-vault-upload-dialog-${w}`, `Attach a photo or PDF (${w}px)`);
    await visible(page.getByRole("button", { name: "Cancel", exact: true })).last().click();
    await sleep(400);

    await tap(fileRow(page, photoId).getByRole("button", { name: `Preview ${LABELS.renamed}`, exact: true }));
    await answerPrompt(page, `Open “${LABELS.renamed}”`, "Open", "Secure tier password", PW2);
    await page.locator("[data-vault-viewer] img[data-vault-viewer-image]").waitFor({ timeout: 15000 });
    await sleep(300);
    await shot(page, `after-vault-image-viewer-${w}`, `The file viewer (${w}px)`);
    await page.locator("[data-vault-viewer]").getByRole("button", { name: "Close", exact: true }).click();
    if (w !== 390) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await check(`layout (${w}): Settings → Vault has no sideways scroll`, () => assert.ok(overflow <= 0, `${overflow}px`));
    } else {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await check("layout (390): Settings → Vault has no sideways scroll", () => assert.ok(overflow <= 0, `${overflow}px`));
    }
    await page.context().close();
  }

  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  await check("no page errors", () => assert.equal(unexpected.length, 0, unexpected.join(" || ").slice(0, 400)));
} catch (error) {
  failures.push(String(error.stack ?? error));
  record("scenario ran to the end", false, String(error.message ?? error).split("\n")[0]);
  console.error(error.stack ?? error);
}

// ================================================================== e. scan
try {
  await browser?.close().catch(() => {});
  await stopBackend();
  const dumpScript = join(sandbox, "dump-sqlite.ts");
  const dumpOut = join(sandbox, "dump.json");
  await writeFile(dumpScript, `import { Database } from "bun:sqlite";
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [root, out] = process.argv.slice(2);
const res: Record<string, string> = {};
function walk(d: string) { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (s.size >= 100 && readFileSync(p).subarray(0, 16).toString("latin1") === "SQLite format 3\\u0000") dump(p); } }
function dump(p: string) {
  const db = new Database(p, { readonly: true });
  const parts: string[] = [];
  for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
    try {
      const rows = db.query(\`SELECT * FROM "\${name.replace(/"/g, '""')}"\`).values();
      parts.push(rows.map((r) => r.map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v === null ? "" : String(v))).join("\\u0001")).join("\\n"));
    } catch (e) { parts.push("<unreadable " + e + ">"); }
  }
  res[p] = parts.join("\\n");
  db.close();
}
walk(root);
writeFileSync(out, JSON.stringify(res));
`);
  await command("bun", [dumpScript, ppm, dumpOut]);
  const dbs = JSON.parse(readFileSync(dumpOut, "utf8"));
  const allDb = Object.values(dbs).join("\n");
  const logFiles = walk(ppm).filter((f) => /\.log(\.\d+)?$/.test(f));
  const logsText = logFiles.map((f) => readFileSync(f, "utf8")).join("\n");
  const needles = [
    ...ML_LINES.map((l, i) => [`multi-line value line ${i + 1}`, l.trim()]),
    ...PROP_LINES.map((l, i) => [`propose value line ${i + 1}`, l]),
    ["sealed value", SEALV], ["file marker bytes", JPG_MARK], ["original file name", FILE_NAME],
    ["Secure password", PW2], ["Sealed password", PW3],
  ];
  for (const [what, needle] of needles) {
    await check(`e: ${what} is in no file, SQLite row or log under PPM_HOME`, () => {
      const hits = [];
      const f = filesWith(ppm, needle);
      if (f.length) hits.push(`files: ${f.join(", ")}`);
      if (allDb.includes(needle)) hits.push("SQLite rows");
      if (logsText.includes(needle)) hits.push("logs");
      assert.equal(hits.length, 0, hits.join("; "));
    });
  }
  const vaultFiles = walk(ppm).filter((f) => /vault-files/.test(f) && f.endsWith(".bin"));
  await check("e: the attached file is on disk as ciphertext (vault-files/*.bin, no JPEG header, no marker)", () => {
    assert.ok(vaultFiles.length >= 1, "no .bin under vault-files");
    for (const f of vaultFiles) {
      const b = readFileSync(f);
      assert.ok(!(b[0] === 0xff && b[1] === 0xd8), `${f} starts like a JPEG`);
      assert.ok(!b.includes(Buffer.from(JPG_MARK)) && !b.includes(jpeg.subarray(0, 64)), `${f} holds plaintext`);
    }
  });
  await check("e: the scan is not vacuous (ppm.log written, databases dumped)", () => {
    assert.ok(logFiles.some((f) => f.endsWith("ppm.log")) && logsText.length > 1000);
    assert.ok(Object.keys(dbs).length >= 1 && allDb.length > 1000);
  });
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
const lines = [...results.map((r) => `${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : ` — ${r.detail}`}`), "", `${passed} passed, ${failed} failed (${results.length} checks)`];
console.log(`\n${lines.join("\n")}`);
console.log(`processes started and stopped: ${stopped.join(", ")}`);
await writeFile(join(out, "vault-attachments-summary.txt"), `${lines.join("\n")}\n`);
await writeFile(join(out, "vault-attachments-results.json"), JSON.stringify({ results, failures, screenshots, stopped }, null, 2));
process.exit(failed || failures.length ? 1 : 0);
