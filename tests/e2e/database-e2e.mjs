// Database manager — end to end on a compiled build: the desktop flow, a readonly connection and
// a 390 × 844 phone (plans/260929-0027-database-dbgate, phase 06).
//
// It runs the release binary from a scratch build and never writes the live dist or PPM data:
// PPM_HOME, HOME and the project all live in one temp directory, auth is off on a loopback port
// nothing else uses, and the only process stopped at the end is the one it started.
//
//   PPM_E2E_DIST=<scratch dist> node tests/e2e/database-e2e.mjs
//
// <scratch dist> is built like a release: `web/` from `vite build --outDir <dist>/web` with Monaco
// staged under `web/assets/monaco/vs`, and `ppm` from `bun build src/index.ts
// src/services/extension-host-worker.ts --compile --outfile <dist>/ppm`.
//
// SQLite always runs. PostgreSQL and MySQL run when PPM_TEST_PG_URL / PPM_TEST_MYSQL_URL are set
// (the docker URLs the integration tests use): a database is created for the run and dropped
// after it. MySQL also installs its driver through the API, which needs the npm registry once.
// PPM_E2E_PERF=1 adds the 6.2 measurements (1M SQLite rows, 5M Postgres rows, 200 columns).
// PPM_PLAYWRIGHT_MODULE points at a Playwright install when `playwright` does not resolve.
// PPM_E2E_ARTIFACTS keeps screenshots and downloads somewhere other than the temp directory.
//
// Exits non-zero when any check fails.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PPM_PLAYWRIGHT_MODULE || "playwright");

const DIST = process.env.PPM_E2E_DIST;
assert(DIST, "Set PPM_E2E_DIST to a scratch build's dist directory (web/ + the compiled ppm)");
const REPO = resolve(import.meta.dirname, "../..");
const ROOT = await mkdtemp(join(tmpdir(), "ppm-database-e2e-"));
const HOME = join(ROOT, "home"), PPM = join(ROOT, "ppm"), PROJECT = join(ROOT, "project");
const ARTIFACTS = process.env.PPM_E2E_ARTIFACTS || join(ROOT, "artifacts");
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
await Promise.all([HOME, PPM, PROJECT, ARTIFACTS].map((p) => mkdir(p, { recursive: true })));

const env = { ...process.env, PPM_HOME: PPM, HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: join(HOME, ".claude"), CODEX_HOME: join(HOME, ".codex") };
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY", "PPM_ALLOW_PROD_DB"]) delete env[key];

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  return pass;
}
/** PPM_E2E_ONLY=desktop,phone runs only those scenarios. */
const ONLY = process.env.PPM_E2E_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
/**
 * Runs one scenario; a throw fails that scenario and the run goes on to the next. `open` opens a
 * page the scenario owns: each is screenshotted when the scenario throws, and closed after it.
 * Every scenario has a project of its own: PPM restores a project's open tabs, so a shared one
 * would start each scenario on the tabs the one before it left open.
 */
async function scenario(key, name, fn) {
  if (ONLY && !ONLY.includes(key)) return;
  console.log(`\n=== ${name} ===`);
  const contexts = [];
  let project;
  const open = async (viewport, extra) => {
    if (!project) {
      project = `db-e2e-${RUN}-${key}`;
      const path = join(PROJECT, key);
      await mkdir(path, { recursive: true });
      await api("/api/projects", { method: "POST", body: { name: project, path } });
    }
    const opened = await openPage(project, viewport, extra);
    contexts.push(opened.context);
    return opened;
  };
  try {
    await fn({ open });
  } catch (e) {
    check(`${name} finished`, false, String(e?.stack ?? e).split("\n").slice(0, 6).join("\n"));
    for (const [i, context] of contexts.entries()) {
      for (const page of context.pages()) await page.screenshot({ path: join(ARTIFACTS, `${key}-failure-${i}.png`) }).catch(() => {});
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
  }
}
/** One step of a flow, named in the log so a throw shows where the flow stopped. */
async function step(name, fn) {
  console.log(`  · ${name}`);
  return fn();
}
/** A connection URL with its password masked, for messages. */
const masked = (text) => String(text).replace(/(postgres|mysql|mariadb):\/\/[^@\s]*@/g, "$1://***@");

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** Runs a command to the end; resolves its output, rejects on a non-zero exit. */
function run(exe, args, options = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(exe, args, { env, ...options, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? ok(out) : fail(Object.assign(new Error(masked(out)), { code, out }))));
  });
}
/** A bun script of its own: the fixtures and the audit log are read with bun:sqlite. */
async function bunScript(name, source, args = []) {
  const path = join(ROOT, name);
  await writeFile(path, source);
  return run("bun", [path, ...args]);
}
async function freePort() {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const { port } = listener.address();
  await new Promise((r) => listener.close(r));
  return port;
}
async function until(label, fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`);
}

// ---------------------------------------------------------------------------
// Setup: config, fixtures, server, project, connections
// ---------------------------------------------------------------------------

const configModule = pathToFileURL(join(REPO, "src/services/config.service.ts")).href;
await bunScript("setup-config.ts", `import { configService } from ${JSON.stringify(configModule)};
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
`);

const SQLITE_FILE = join(ROOT, "shop.db");
/**
 * customers: 600 rows, so `score > 5` keeps 240 — two pages and part of a third. orders reference
 * every customer in Hanoi with score 9 (ids 9, 39, … 579), the rows `city ↑, score ↓` puts first,
 * so whichever of them the engine lists first is a row other rows refer to.
 */
const FIXTURE_ROWS = 600;
await bunScript("fixture-sqlite.ts", `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { create: true });
db.exec(\`
  CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, score INTEGER);
  WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < ${FIXTURE_ROWS})
    INSERT INTO customers SELECT n, 'customer ' || n, CASE n % 3 WHEN 0 THEN 'Hanoi' WHEN 1 THEN 'Hue' ELSE 'Saigon' END, n % 10 FROM r;
  CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), amount REAL);
  WITH RECURSIVE k(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM k WHERE n < 20) INSERT INTO orders SELECT n, 9 + 30 * (n - 1), n * 2.5 FROM k;
\`);
db.close();
`, [SQLITE_FILE]);

const PORT = await freePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn(join(DIST, "ppm"), ["__serve__", String(PORT), "127.0.0.1"], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
// Also when this script dies on an error nothing caught: the server would otherwise outlive it.
process.on("exit", () => { if (server.exitCode === null) server.kill("SIGTERM"); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(ORIGIN + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(`${method} ${path}: ${res.status} ${masked(json.error ?? "")}`);
  return json.data;
}

/** One row of a read of the SQLite fixture, as the database has it now. */
async function sqliteGet(sql) {
  const out = await bunScript("read-sqlite.ts", `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
console.log(JSON.stringify(db.query(process.argv[3]).get()));
`, [SQLITE_FILE, sql]);
  return JSON.parse(out.trim().split("\n").at(-1));
}

/** The audit rows a test cares about, newest first. */
async function auditRows(connectionName) {
  const out = await bunScript("read-audit.ts", `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
console.log(JSON.stringify(db.query("SELECT source, status, sql FROM query_log WHERE connection_name = ? ORDER BY id DESC").all(process.argv[3])));
`, [join(PPM, "query-audit.db"), connectionName]);
  return JSON.parse(out.trim().split("\n").at(-1));
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

const DISMISSED_ONBOARDING = JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null });

/** A fresh browser context on the project page; `errors` collects every uncaught page error. */
async function openPage(projectName, viewport, extra = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block", acceptDownloads: true, ...extra });
  await context.addInitScript((value) => localStorage.setItem("ppm-onboarding-v1", value), DISMISSED_ONBOARDING);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // PPM_E2E_TRACE=1 logs every API request the page makes, and how it ended.
  if (process.env.PPM_E2E_TRACE) {
    const t0 = Date.now();
    const api = (r) => new URL(r.url()).pathname.startsWith("/api/");
    const at = (r) => `+${Date.now() - t0}ms ${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`;
    page.on("request", (r) => api(r) && console.log(`    > ${at(r)}`));
    page.on("requestfinished", (r) => api(r) && console.log(`    < ${at(r)}`));
    page.on("requestfailed", (r) => api(r) && console.log(`    ! ${at(r)} ${r.failure()?.errorText}`));
  }
  await page.goto(`${ORIGIN}/project/${projectName}`);
  return { page, errors, context };
}
/** Hidden tabs stay mounted in the tab pool, so every lookup is narrowed to what is on screen. */
const visible = (locator) => locator.locator("visible=true").first();
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameRe = (name) => new RegExp(`^${escapeRe(name)}(\\s|$)`);

/** The Database side panel: CONNECTIONS above, TABLES, VIEWS, FUNCTIONS below. */
async function showDatabasePanel(page) {
  const tree = page.getByRole("tree", { name: "Connections" });
  const rail = page.locator('aside button:has([data-icon="Database"])').first();
  await rail.waitFor();
  // The side panel shown last is remembered, so it may already be the Database one: a click would close it.
  for (let i = 0; i < 3 && !(await tree.isVisible()); i++) {
    if (!(await tree.waitFor({ timeout: 1500 }).then(() => true, () => false))) await rail.click();
  }
  await tree.waitFor();
}
/** A connection's row in CONNECTIONS — first, as a MySQL server also lists a database named `mysql`. */
const connectionRow = (page, name) => page.getByRole("tree", { name: "Connections" }).getByRole("treeitem", { name: nameRe(name) }).first();
/** Makes one of a connection's databases the current one, which lists its tables below. */
async function useDatabase(page, connection, database) {
  // Already the one in use: the section's header names it, and there is nothing to switch to.
  const inUse = await page.getByRole("region", { name: "Tables, views, functions" }).getByTitle(`${connection} · ${database}`, { exact: true }).count();
  if (!inUse) {
    await connectionRow(page, connection).click();
    // "… on <connection>" when the database in use has the same name on another connection.
    await page.getByRole("button", { name: new RegExp(`^Switch to ${escapeRe(database)}( on ${escapeRe(connection)})?$`) }).click();
  }
  await page.getByRole("tree", { name: "Tables, views, functions" }).getByRole("treeitem").nth(1).waitFor();
}
/** Opens a table's data tab from the tree; resolves the ms from the click to the first page drawn. */
async function openTable(page, table) {
  const t0 = Date.now();
  const firstPage = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/grid") && r.request().method() === "POST");
  await page.getByRole("tree", { name: "Tables, views, functions" }).getByRole("treeitem", { name: nameRe(table) }).click();
  await firstPage;
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return Date.now() - t0;
}
const gridCanvas = (page) => visible(page.locator('[data-testid="data-grid-canvas"]'));
const statusRows = (page) => visible(page.locator("text=/Rows: /")).textContent();

/** Frame intervals while `act` runs, and the long tasks it caused. */
async function measureFrames(page, act) {
  await page.evaluate(() => {
    window.__e2eFrames = [];
    window.__e2eLong = [];
    window.__e2eStop = false;
    let last = performance.now();
    const tick = (t) => {
      window.__e2eFrames.push(t - last);
      last = t;
      if (!window.__e2eStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__e2eObserver = new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__e2eLong.push(Math.round(e.duration))));
    window.__e2eObserver.observe({ type: "longtask" });
  });
  await act();
  return page.evaluate(() => {
    window.__e2eStop = true;
    window.__e2eObserver.disconnect();
    const f = window.__e2eFrames.slice(2).sort((a, b) => a - b);
    const q = (p) => f[Math.min(f.length - 1, Math.floor(p * f.length))];
    return { frames: f.length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(f.at(-1)), longTasks: window.__e2eLong };
  });
}
/** Wheel steps over the visible grid; counts the pages fetched meanwhile. */
async function scrollGrid(page, dx, dy, steps) {
  const box = await gridCanvas(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let pages = 0;
  const count = (r) => { if (new URL(r.url()).pathname.endsWith("/grid")) pages++; };
  page.on("response", count);
  const timing = await measureFrames(page, async () => {
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(500);
  });
  page.off("response", count);
  return { ...timing, pages };
}

/**
 * Whether the HTML filter row lines up with the columns Glide draws on its canvas: each visible
 * filter cell's left edge must land on a column divider in the canvas's own pixels. `shift` moves
 * every edge by that many CSS pixels, which is how the check proves it can fail.
 */
async function filterRowAlignment(page, shift = 0) {
  return page.evaluate((shift) => {
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const canvas = [...document.querySelectorAll('[data-testid="data-grid-canvas"]')].filter(shown)[0];
    const scroller = [...document.querySelectorAll(".dvn-scroller")].filter(shown)[0];
    // The row's track is the translated element holding one absolutely placed cell per column.
    const trackOf = (input) => {
      let e = input;
      while (e && !/translateX/.test(e.getAttribute("style") || "")) e = e.parentElement;
      return e;
    };
    const track = [...document.querySelectorAll('input[aria-label^="Filter "]')].filter(shown).map(trackOf).find(Boolean);
    const translate = Number(/translateX\((-?[\d.]+)px\)/.exec(track.getAttribute("style"))[1]);
    const box = canvas.getBoundingClientRect();
    const dpr = canvas.width / box.width;
    const line = canvas.getContext("2d").getImageData(0, Math.round(box.height * 0.6 * dpr), canvas.width, 1).data;
    const lum = (x) => { const i = Math.round(x) * 4; return 0.2126 * line[i] + 0.7152 * line[i + 1] + 0.0722 * line[i + 2]; };
    const view = track.parentElement.getBoundingClientRect();
    const edges = [...track.children].map((c) => c.getBoundingClientRect().left).filter((left) => left > view.left + 4 && left < view.right - 30);
    const onDivider = edges.filter((left) => {
      const x = (left + shift - box.left) * dpr;
      let darkest = 255;
      for (let d = -2 * dpr; d <= 2 * dpr; d++) darkest = Math.min(darkest, lum(x + d));
      const background = [3, 4, 5, 6].map((d) => lum(x + d * dpr)).sort((a, b) => a - b)[2];
      return background - darkest >= 8;
    });
    return { scrollLeft: Math.round(scroller.scrollLeft), translate, edges: edges.length, onDivider: onDivider.length };
  }, shift);
}

/** Two frames, so what a click or a response changed has been drawn. */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** The next POST …/grid `match` accepts: what the page asked for and the rows it got back. */
function nextGrid(page, match = () => true) {
  const next = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/grid") && r.request().method() === "POST" && match(r.request().postDataJSON() ?? {}), { timeout: 15_000 })
    .then(async (r) => ({ request: r.request().postDataJSON(), data: (await r.json()).data }));
  // Waited for after the click that causes it: a click that fails first must not leave this unhandled.
  next.catch(() => {});
  return next;
}
/** A column of a /grid page by name: `rows.map(at("name"))`. */
const column = (data, name) => {
  const i = data.columns.findIndex((c) => c.name === name);
  assert(i >= 0, `no column ${name} in ${data.columns.map((c) => c.name)}`);
  return (row) => row[i];
};
/** How many rows the visible grid holds: Glide's accessibility table counts them, plus its header row. */
const loadedRows = async (page) => Number(await gridCanvas(page).locator('table[role="grid"]').getAttribute("aria-rowcount")) - 1;

/** The title band and the filter row Glide draws above the first row (a phone has no filter row), and its row height. */
const TITLE_BAND = 34;
/** A phone's title band: its titles are touch targets. */
const TITLE_BAND_TOUCH = 44;
const HEADER_HEIGHT = TITLE_BAND + 30;
const ROW_HEIGHT = 34;
/**
 * Where a cell of the visible grid is on screen, the grid scrolled to the top: its column is the
 * header slot holding that column's menu button, laid over the canvas column by column.
 */
async function cellAt(page, columnName, row, header = HEADER_HEIGHT) {
  const slot = await visible(page.getByRole("button", { name: `Column menu: ${columnName}`, exact: true })).locator("..").boundingBox();
  const canvas = await gridCanvas(page).boundingBox();
  const y = canvas.y + header + ROW_HEIGHT * row + ROW_HEIGHT / 2;
  return { x: slot.x + Math.min(slot.width / 2, 48), y, right: slot.x + slot.width };
}
async function clickCell(page, columnName, row, options) {
  const { x, y } = await cellAt(page, columnName, row);
  await page.mouse.click(x, y, options);
  await frames(page);
}
/** The active tab's toolbar button: hidden tabs keep theirs mounted. */
const toolButton = (page, name) => visible(page.getByRole("button", { name, exact: true }));
/** Presses a toggle button only when it is not already in the state wanted. */
async function setPressed(button, on) {
  if ((await button.getAttribute("aria-pressed")) !== String(on)) await button.click();
}

/** A Structure tab's Save changes: OK once the script is read, ticking Allow recreate when SQLite rebuilds the table. */
async function saveStructure(page) {
  const dialog = page.getByRole("dialog", { name: "Save changes" });
  const ok = dialog.getByRole("button", { name: "OK", exact: true });
  const recreate = dialog.getByRole("checkbox", { name: /^Allow recreate/ });
  await until("the script to read", async () => (await recreate.count()) > 0 || (await ok.isEnabled()), 10_000);
  if (await recreate.count()) await recreate.check();
  await ok.click();
  await page.getByText("Saved to database").first().waitFor();
}

/** The visible Query tab's script, typed over whatever it held. */
async function setQuery(page, sql) {
  await visible(page.locator(".monaco-editor")).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(sql);
}
/** Runs the visible Query tab's whole script, to its end: the run is one NDJSON response. */
async function runQuery(page) {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/query/script"));
  await visible(page.getByTitle(/^Run the whole script/)).click();
  await runEnded(page, await response);
}
/**
 * A Query tab's run, its response at an end. Chromium sometimes reports a streamed response the
 * page has read to its last line as cancelled (net::ERR_ABORTED) rather than finished, and
 * `response.finished()` settles only on the latter — so either counts, and what the run did is
 * read from the page afterwards.
 */
async function runEnded(page, response, timeout = 60_000) {
  const request = response.request();
  let timer, onEnd;
  const ended = new Promise((resolve, fail) => {
    onEnd = (r) => r === request && resolve();
    timer = setTimeout(() => fail(new Error(`the run's response did not end within ${timeout} ms`)), timeout);
  });
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);
  try {
    // Either may have happened already: finished() remembers a finish, failure() a failure.
    await Promise.race([ended, response.finished(), ...(request.failure() ? [Promise.resolve()] : [])]);
  } finally {
    clearTimeout(timer);
    page.off("requestfinished", onEnd);
    page.off("requestfailed", onEnd);
  }
  await frames(page);
}

/** Every entry of a zip archive (an .xlsx is one), read through its central directory. */
function zipEntries(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= 0, "not a zip archive");
  const entries = new Map();
  let at = buffer.readUInt32LE(end + 16);
  for (let i = buffer.readUInt16LE(end + 10); i > 0; i--) {
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const data = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(data, data + size);
    entries.set(buffer.toString("utf8", at + 46, at + 46 + nameLength), () => (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

let browser;
/** The Postgres and MySQL databases made for this run, when their URLs were given. */
let pg = null;
let my = null;
try {
  await until("binary healthy", async () => (await (await fetch(`${ORIGIN}/api/health`)).json()).ok, 60_000);
  console.log(`Isolated binary on ${ORIGIN} (PPM_HOME in ${ROOT})`);

  const sqliteRw = await api("/api/db/connections", { method: "POST", body: { type: "sqlite", name: "shop", connectionConfig: { type: "sqlite", path: SQLITE_FILE }, readonly: false } });
  const sqliteRo = await api("/api/db/connections", { method: "POST", body: { type: "sqlite", name: "shop-readonly", connectionConfig: { type: "sqlite", path: SQLITE_FILE } } });
  check("a new connection is readonly unless the form unticks it", sqliteRo.readonly === 1 && sqliteRw.readonly === 0, `rw=${sqliteRw.readonly} ro=${sqliteRo.readonly}`);

  if (process.env.PPM_TEST_PG_URL) {
    const { default: postgres } = await import("postgres");
    const database = `ppm_e2e_pg_${RUN}`;
    const server = postgres(process.env.PPM_TEST_PG_URL, { max: 1, onnotice: () => {} });
    await server.unsafe(`CREATE DATABASE ${database}`);
    await server.end();
    const url = new URL(process.env.PPM_TEST_PG_URL);
    url.pathname = `/${database}`;
    const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    pg = { database, admin, drop: async () => {
      await admin.end();
      const again = postgres(process.env.PPM_TEST_PG_URL, { max: 1, onnotice: () => {} });
      await again.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await again.end();
    } };
    await admin.unsafe(`
      CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL, city text, score integer);
      INSERT INTO customers SELECT n, 'customer ' || n, (ARRAY['Hanoi', 'Hue', 'Saigon'])[n % 3 + 1], n % 10 FROM generate_series(1, ${FIXTURE_ROWS}) n;
      CREATE TABLE orders (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers(id), amount numeric(10,2));
      INSERT INTO orders SELECT n, 9 + 30 * (n - 1), n * 2.5 FROM generate_series(1, 20) n;
    `);
    await api("/api/db/connections", { method: "POST", body: { type: "postgres", name: "pg", connectionConfig: { type: "postgres", connectionString: url.toString() }, readonly: false } });
  }
  if (process.env.PPM_TEST_MYSQL_URL) {
    const { default: mysql } = await import("mysql2/promise");
    const database = `ppm_e2e_my_${RUN}`;
    const admin = await mysql.createConnection({ uri: process.env.PPM_TEST_MYSQL_URL, multipleStatements: true });
    my = { database, admin, drop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    } };
    await admin.query(`
      CREATE DATABASE ${database}; USE ${database};
      CREATE TABLE customers (id int PRIMARY KEY, name varchar(50) NOT NULL, city varchar(20), score int);
      INSERT INTO customers WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < ${FIXTURE_ROWS})
        SELECT n, CONCAT('customer ', n), ELT(n % 3 + 1, 'Hanoi', 'Hue', 'Saigon'), n % 10 FROM r;
      CREATE TABLE orders (id int PRIMARY KEY, customer_id int NOT NULL, amount decimal(10,2), FOREIGN KEY (customer_id) REFERENCES customers(id));
      INSERT INTO orders WITH RECURSIVE k(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM k WHERE n < 20) SELECT n, 9 + 30 * (n - 1), n * 2.5 FROM k;
    `);
    // The driver is installed from Settings in real use; the API is what that button calls.
    await api("/api/db/drivers/mysql/install", { method: "POST" });
    const url = new URL(process.env.PPM_TEST_MYSQL_URL);
    url.pathname = `/${database}`;
    await api("/api/db/connections", { method: "POST", body: { type: "mysql", name: "mysql", connectionConfig: { type: "mysql", connectionString: url.toString() }, readonly: false } });
  }

  browser = await chromium.launch({ headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });

  await scenario("readonly-api", "Readonly connection: saving, the Query runner and `ppm db query` are refused and audited", async () => {
    const post = (path, body) => fetch(`${ORIGIN}/api/db/connections/${sqliteRo.id}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const save = await post("/changeset/apply", { table: "customers", updates: [{ key: { id: 1 }, set: { name: "changed" } }] });
    check("grid Save on a readonly connection answers 403", save.status === 403, `status ${save.status}`);
    // A readonly connection's script is refused whole, before any statement of it runs.
    const script = await post("/query/script", { sql: "SELECT 1; DELETE FROM orders", runId: `ro-${RUN}` });
    const refusal = await script.json().catch(() => ({}));
    check("the Query runner refuses a script that writes", script.status === 403 && /readonly/i.test(refusal.error ?? ""), `${script.status} ${refusal.error ?? ""}`);
    const cli = await run(join(DIST, "ppm"), ["db", "query", "shop-readonly", "DELETE FROM orders"]).then(() => ({ code: 0, out: "" }), (e) => e);
    check("`ppm db query` exits non-zero on a write", cli.code === 1 && /readonly/i.test(cli.out), `exit ${cli.code}`);
    const audit = await auditRows("shop-readonly");
    const blocked = new Set(audit.filter((r) => r.status === "blocked").map((r) => r.source));
    check("each refusal is in the audit log as blocked", ["grid", "editor", "cli"].every((s) => blocked.has(s)), JSON.stringify([...blocked]));
    const counts = JSON.parse((await bunScript("count-rows.ts", `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
console.log(JSON.stringify(db.query("SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT name FROM customers WHERE id = 1) AS name").get()));
`, [SQLITE_FILE])).trim());
    check("the file is unchanged", counts.orders === 20 && counts.name === "customer 1", JSON.stringify(counts));
  });

  await scenario("desktop", "Desktop on SQLite: filter, sort, page, edit and save with CASCADE, form, cell data, references, FK, copy, export, structure, query", async ({ open }) => {
    const { page, errors, context } = await open({ width: 1440, height: 900 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
    await showDatabasePanel(page);
    await useDatabase(page, "shop", "shop.db");

    await step("open customers from the tree", async () => {
      const first = nextGrid(page);
      await openTable(page, "customers");
      const { data } = await first;
      await until("Rows: 600", async () => (await statusRows(page)).includes("Rows: 600"), 10_000);
      check("a table opens on its first 100 rows and counts all of them", data.rows.length === 100 && data.hasMore && (await loadedRows(page)) === 100, `${data.rows.length} rows`);
    });

    const sorted = await step("filter score > 5, then sort city ↑ and score ↓", async () => {
      const filtered = nextGrid(page, (b) => b.filters?.length === 1);
      const filter = visible(page.locator('input[aria-label="Filter score"]:not([data-table-panel] *)'));
      await filter.fill(">5");
      await filter.press("Enter");
      const f = await filtered;
      check("the filter row's > 5 is applied by the server", f.data.rows.length === 100 && f.data.rows.every((r) => column(f.data, "score")(r) > 5), JSON.stringify(f.request.filters));
      await until("Rows: 240", async () => (await statusRows(page)).includes("Rows: 240"), 10_000);

      const one = nextGrid(page, (b) => b.sort?.length === 1);
      await toolButton(page, "Column menu: city").click();
      await page.getByRole("menuitem", { name: "Sort ascending", exact: true }).click();
      await one;
      const two = nextGrid(page, (b) => b.sort?.length === 2);
      await toolButton(page, "Column menu: score").click();
      await page.getByRole("menuitem", { name: "Add to sort - descending", exact: true }).click();
      const s = await two;
      const city = column(s.data, "city"), score = column(s.data, "score");
      const ordered = s.data.rows.every((r, i, rows) => i === 0 || city(rows[i - 1]) < city(r) || (city(rows[i - 1]) === city(r) && score(rows[i - 1]) >= score(r)));
      check(
        "a second sort column is added after the first, and the rows come back in that order",
        JSON.stringify(s.request.sort) === JSON.stringify([{ column: "city", dir: "ASC" }, { column: "score", dir: "DESC" }]) && ordered
          && city(s.data.rows[0]) === "Hanoi" && score(s.data.rows[0]) === 9 && s.request.filters?.length === 1,
        JSON.stringify(s.request.sort),
      );
      return s;
    });

    await step("scroll to the last row to read the next 100", async () => {
      const more = nextGrid(page, (b) => b.offset === 100);
      const box = await gridCanvas(page).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 5000);
      const m = await more;
      check("the next page keeps the filter and the sort", m.data.rows.length === 100 && m.request.sort?.length === 2 && m.request.filters?.length === 1, `offset ${m.request.offset}`);
      await until("200 rows in the grid", async () => (await loadedRows(page)) === 200, 5000);
      await page.mouse.wheel(0, -100_000);
      await page.waitForTimeout(300);
      await frames(page);
    });

    const id = column(sorted.data, "id");
    const [deleted, firstEdited, secondEdited] = sorted.data.rows.slice(0, 3).map(id);
    const reread = await step("edit two names, delete the first row, add a row, then Save with CASCADE", async () => {
      await clickCell(page, "name", 1);
      await page.keyboard.type("edited one", { delay: 15 });
      await page.keyboard.press("Enter");
      await page.keyboard.type("edited two", { delay: 15 });
      await page.keyboard.press("Enter");
      await toolButton(page, "Save 2 changed rows").waitFor();
      await clickCell(page, "city", 0);
      await toolButton(page, "Delete row(s)").click();
      await toolButton(page, "Save 3 changed rows").waitFor();
      await toolButton(page, "New row").click();
      await frames(page);
      await page.keyboard.type("new customer", { delay: 15 });
      await page.keyboard.press("Enter");
      await toolButton(page, "Save 4 changed rows").click();

      const dialog = page.getByRole("dialog", { name: "Save changes" });
      await dialog.getByRole("checkbox", { name: /^Delete references CASCADE/ }).check();
      const applied = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/changeset/apply"));
      const after = nextGrid(page, (b) => !b.offset);
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      const body = (await applied).request().postDataJSON();
      await page.getByText(/^5 changes saved in one transaction/).first().waitFor();
      check(
        "Save sends every change as one changeset, with the referencing table to delete from first",
        body.updates?.length === 2 && body.inserts?.length === 1 && body.deletes?.length === 1 && JSON.stringify(body.cascade) === JSON.stringify([{ schema: null, table: "orders" }]),
        JSON.stringify({ updates: body.updates?.length, inserts: body.inserts?.length, deletes: body.deletes?.length, cascade: body.cascade }),
      );
      const db = await sqliteGet(`SELECT
        (SELECT name FROM customers WHERE id = ${firstEdited}) AS one, (SELECT name FROM customers WHERE id = ${secondEdited}) AS two,
        (SELECT COUNT(*) FROM customers WHERE id = ${deleted}) AS gone, (SELECT COUNT(*) FROM orders WHERE customer_id = ${deleted}) AS orphans,
        (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM customers WHERE name = 'new customer' AND city IS NULL) AS added`);
      check("the database has the edits, the new row and neither the deleted row nor its order", db.one === "edited one" && db.two === "edited two" && db.gone === 0 && db.orphans === 0 && db.orders === 19 && db.added === 1, JSON.stringify(db));
      return after;
    });

    await step("F4 form view", async () => {
      await toolButton(page, "Switch to form").click();
      await visible(page.getByRole("grid", { name: "customers as a form" })).waitFor();
      const label = await visible(page.getByRole("status").filter({ hasText: /^Row: / })).textContent();
      check("Switch to form shows one row at a time, as Row: 1 / N", /^Row: 1 \/ \d/.test(label), label);
      await toolButton(page, "Switch to table").click();
      await gridCanvas(page).waitFor();
      await frames(page);
    });

    await step("Cell Data", async () => {
      const { data } = await reread;
      await clickCell(page, "name", 0);
      await setPressed(toolButton(page, "Cell Data"), true);
      const value = await visible(page.locator('aside[data-cell-data-view] textarea[aria-label="Edit name"]')).inputValue();
      check("Cell Data shows the selected cell", value === column(data, "name")(data.rows[0]), value);
      await setPressed(toolButton(page, "Cell Data"), false);
    });

    await step("References: orders under the grid, following the selected row", async () => {
      const { data } = await reread;
      const customer = column(data, "id")(data.rows[0]);
      await clickCell(page, "name", 0);
      await setPressed(toolButton(page, "View columns"), true);
      const detail = nextGrid(page, (b) => b.table === "orders");
      await visible(page.locator('section[aria-label="References"]').getByRole("button", { name: "orders (customer_id)" })).click();
      const d = await detail;
      check("the referencing table opens below, filtered to the selected row", d.data.rows.length === 1 && column(d.data, "customer_id")(d.data.rows[0]) === customer, JSON.stringify(d.request.filters));
      await visible(page.getByRole("button", { name: "Close orders", exact: true })).click();
    });

    const firstOrder = await step("↗ on a foreign key opens the row it points at", async () => {
      const first = nextGrid(page, (b) => b.table === "orders");
      await openTable(page, "orders");
      const { data } = await first;
      const target = column(data, "customer_id")(data.rows[0]);
      const opened = nextGrid(page, (b) => b.table === "customers");
      const cell = await cellAt(page, "customer_id", 0);
      await page.mouse.click(cell.right - 13, cell.y);
      const o = await opened;
      await visible(page.getByRole("grid", { name: "customers as a form" })).waitFor();
      check("the FK button opens the referenced row as a form in a new tab", o.data.rows.length === 1 && column(o.data, "id")(o.data.rows[0]) === target, JSON.stringify(o.request.filters));
      return { amount: column(data, "amount")(data.rows[0]) };
    });

    await step("Copy as SQL INSERTs and Export ▾ CSV on orders", async () => {
      await visible(page.locator("[data-tab-item]").filter({ hasText: /orders$/ })).click();
      await gridCanvas(page).waitFor();
      const cell = await cellAt(page, "amount", 0);
      await page.mouse.click(cell.x, cell.y, { button: "right" });
      await page.getByRole("menu", { name: "Cell menu" }).getByRole("menuitem", { name: "Copy advanced" }).hover();
      await page.getByRole("menuitem", { name: "Copy as SQL INSERTs", exact: true }).click();
      const copied = await until("clipboard", async () => {
        const text = await page.evaluate(() => navigator.clipboard.readText());
        return /INSERT INTO/i.test(text) && text;
      }, 5000);
      // DBGate's copy formats write what is selected: here one cell.
      check("Copy as SQL INSERTs puts the selected cell's INSERT on the clipboard", copied.trim() === `INSERT INTO "orders" ("amount") VALUES (${firstOrder.amount});`, copied.slice(0, 120));

      await toolButton(page, "Export").click();
      const download = page.waitForEvent("download");
      await page.getByRole("menuitem", { name: "CSV file", exact: true }).click();
      const file = await download;
      const path = join(ARTIFACTS, "orders.csv");
      await file.saveAs(path);
      const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/);
      check("Export ▾ CSV file downloads every row of the table", file.suggestedFilename() === "orders.csv" && lines.length === 20 && /customer_id/.test(lines[0]), `${file.suggestedFilename()}, ${lines.length} lines`);
    });

    await step("Export advanced: two tables into one Excel file", async () => {
      await connectionRow(page, "shop").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Export", exact: true }).click();
      const source = visible(page.getByPlaceholder("Choose tables or views"));
      await source.click();
      const list = page.getByRole("listbox", { name: "Tables and views" });
      await list.getByRole("option", { name: "customers", exact: true }).click();
      await list.getByRole("option", { name: "orders", exact: true }).click();
      await page.keyboard.press("Escape");
      const target = visible(page.getByRole("region", { name: "Target configuration" }));
      await target.getByLabel("Storage type").selectOption({ label: "MS Excel file(s)" });
      await visible(page.getByLabel("Create single file")).check();
      await toolButton(page, "Run").click();
      const download = page.waitForEvent("download");
      await visible(page.getByRole("button", { name: "Download data.xlsx" })).click({ timeout: 30_000 });
      const file = await download;
      const path = join(ARTIFACTS, "data.xlsx");
      await file.saveAs(path);
      const entries = zipEntries(await readFile(path));
      const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
      const workbook = entries.get("xl/workbook.xml")?.() ?? "";
      check("one .xlsx holds a sheet per table", sheets.length === 2 && /name="customers"/.test(workbook) && /name="orders"/.test(workbook), `${sheets.length} sheets`);
    });

    await step("Structure: add a column and rename one, then Alter table", async () => {
      await visible(page.locator("[data-tab-item]").filter({ hasText: /customers$/ })).click();
      await toolButton(page, "Structure").click();
      await toolButton(page, "Add column").click();
      const add = page.getByRole("dialog", { name: /^Add column/ });
      await add.locator("#table-column-name").fill("email");
      await add.locator("#table-column-type").fill("TEXT");
      await add.getByRole("button", { name: "Save", exact: true }).click();
      await visible(page.getByRole("row", { name: "Column city", exact: true })).click();
      const edit = page.getByRole("dialog", { name: "Edit column" });
      await edit.locator("#table-column-name").fill("town");
      await edit.getByRole("button", { name: "Save", exact: true }).click();
      await toolButton(page, "Alter table").click();
      await saveStructure(page);
      const columns = await sqliteGet("SELECT group_concat(name, ',') AS names FROM pragma_table_info('customers')");
      check("Alter table adds the column and renames the other", columns.names === "id,name,town,score,email", columns.names);
    });

    await step("New table", async () => {
      await page.getByRole("button", { name: "New object", exact: true }).click();
      await page.getByRole("menuitem", { name: "New table", exact: true }).click();
      await visible(page.locator("#table-prop-name")).fill("e2e_notes");
      await toolButton(page, "Create table").click();
      await saveStructure(page);
      const made = await sqliteGet("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'e2e_notes'");
      check("New table creates it", made.n === 1, JSON.stringify(made));
    });

    await step("SQL ↗ and a Query tab with several results", async () => {
      await visible(page.locator("[data-tab-item]").filter({ hasText: /orders$/ })).click();
      await toolButton(page, "SQL").click();
      await toolButton(page, "SELECT").click();
      await runQuery(page);
      await visible(page.getByRole("tab", { name: /^Result 1\b/ })).waitFor();
      await setQuery(page, "SELECT 1 AS one;\nSELECT 2 AS two;\nSELECT COUNT(*) AS n FROM orders;");
      await runQuery(page);
      const tabs = await visible(page.getByRole("tablist", { name: "Results" })).getByRole("tab").allTextContents();
      check("each statement that returns rows gets a result tab of its own", tabs.filter((t) => /^Result \d/.test(t)).length === 3, tabs.join(" | "));
    });

    await step("Stop between statements", async () => {
      await setQuery(page, "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 8000000) SELECT COUNT(*) AS n FROM r;\nSELECT 2 AS two;\nSELECT 3 AS three;");
      const response = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/query/script"));
      await visible(page.getByTitle(/^Run the whole script/)).click();
      await toolButton(page, "Stop").click();
      await runEnded(page, await response);
      const tabs = await visible(page.getByRole("tablist", { name: "Results" })).getByRole("tab").allTextContents();
      // A result shown takes the place of Messages.
      await visible(page.getByRole("tab", { name: /^Messages/ })).click();
      const said = await visible(page.getByRole("table", { name: "Messages" })).textContent();
      // bun:sqlite cannot be interrupted: the running statement ends, and none after it starts.
      check(
        "Stop keeps the statements after the running one from starting",
        !tabs.some((t) => /^Result [23]/.test(t)) && /[23] statements did not run/.test(said) && /Query execution finished/.test(said),
        `${tabs.join(" | ")} :: ${said.slice(-160)}`,
      );
    });

    await step("Format: Shift+Alt+F and the toolbar's Format lay the script out; one undo puts it back", async () => {
      // The visible Query tab's text, read from its editor: other tabs keep theirs mounted, hidden.
      const script = () => page.evaluate(() =>
        window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().checkVisibility({ visibilityProperty: true }))?.getValue() ?? null);
      const typed = "select id,name from customers where score>5 order by name";
      const laidOut = "select\n  id,\n  name\nfrom\n  customers\nwhere\n  score > 5\norder by\n  name";
      await setQuery(page, typed);
      await page.keyboard.press("Shift+Alt+KeyF");
      const byKey = await script();
      await page.keyboard.press("ControlOrMeta+Z");
      const undone = await script();
      await toolButton(page, "Format").click();
      const byButton = await script();
      check("Format lays the script out, by Shift+Alt+F and by its button, and one undo puts it back",
        byKey === laidOut && undone === typed && byButton === laidOut, JSON.stringify([byKey, undone, byButton]));
      // A stray ")": an opening bracket would be closed by the editor as it is typed.
      await setQuery(page, "select )");
      await toolButton(page, "Format").click();
      const toast = visible(page.locator("[data-sonner-toast]").filter({ hasText: "Could not format the SQL" }));
      await toast.waitFor();
      const said = await toast.textContent();
      check("SQL Format cannot read is left as typed, and the toast says where", (await script()) === "select )" && said.includes("at line 1 column 8"), said);
    });

    check("no page errors on the desktop flow", errors.length === 0, errors.join(" | ").slice(0, 300));
  });

  const engines = [
    pg && { key: "pg", label: "PostgreSQL", database: pg.database, sleep: "SELECT pg_sleep(30)", nameOf: async (id) => (await pg.admin.unsafe(`SELECT name FROM customers WHERE id = ${id}`))[0]?.name },
    my && { key: "mysql", label: "MySQL", database: my.database, sleep: "SELECT SLEEP(30)", nameOf: async (id) => (await my.admin.query(`SELECT name FROM ${my.database}.customers WHERE id = ${id}`))[0][0]?.name },
  ].filter(Boolean);
  for (const engine of engines) {
    await scenario(engine.key, `${engine.label}: open, filter, edit and save, a script of two results, Stop`, async ({ open }) => {
      const { page, errors } = await open({ width: 1440, height: 900 });
      await showDatabasePanel(page);
      await useDatabase(page, engine.key, engine.database);
      await openTable(page, "customers");
      await until("Rows: 600", async () => (await statusRows(page)).includes("Rows: 600"), 15_000);

      const filtered = nextGrid(page, (b) => b.filters?.length === 1);
      const filter = visible(page.locator('input[aria-label="Filter score"]:not([data-table-panel] *)'));
      await filter.fill(">5");
      await filter.press("Enter");
      const f = await filtered;
      check(`${engine.label}: the filter row's > 5 is applied by the server`, f.data.rows.length === 100 && f.data.rows.every((r) => Number(column(f.data, "score")(r)) > 5));
      await until("Rows: 240", async () => (await statusRows(page)).includes("Rows: 240"), 15_000);

      const id = column(f.data, "id")(f.data.rows[0]);
      await clickCell(page, "name", 0);
      await page.keyboard.type(`edited on ${engine.key}`, { delay: 15 });
      await page.keyboard.press("Enter");
      await toolButton(page, "Save 1 changed row").click();
      await page.getByRole("dialog", { name: "Save changes" }).getByRole("button", { name: "OK", exact: true }).click();
      await page.getByText(/^1 change saved in one transaction/).first().waitFor();
      const saved = await engine.nameOf(id);
      check(`${engine.label}: Save writes the edit`, saved === `edited on ${engine.key}`, saved);

      await connectionRow(page, engine.key).click({ button: "right" });
      await page.getByRole("menuitem", { name: "New query", exact: true }).click();
      await setQuery(page, `SELECT COUNT(*) AS n FROM customers WHERE score > 5;\nSELECT name FROM customers WHERE id = ${id};`);
      await runQuery(page);
      const tabs = await visible(page.getByRole("tablist", { name: "Results" })).getByRole("tab").allTextContents();
      check(`${engine.label}: a script of two SELECTs shows two results`, tabs.filter((t) => /^Result \d/.test(t)).length === 2, tabs.join(" | "));

      await setQuery(page, engine.sleep);
      const response = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/query/script"));
      await visible(page.getByTitle(/^Run the whole script/)).click();
      await visible(page.getByRole("status").filter({ hasText: /^Running statement 1/ })).waitFor();
      const stoppedAt = Date.now();
      await toolButton(page, "Stop").click();
      await runEnded(page, await response);
      const took = Date.now() - stoppedAt;
      await visible(page.getByRole("tab", { name: /^Messages/ })).click();
      const said = await visible(page.getByRole("table", { name: "Messages" })).textContent();
      check(`${engine.label}: Stop cancels the running statement on the server`, took < 5000 && /Stopped/.test(said), `${took} ms :: ${said.slice(-140)}`);
      check(`${engine.label}: no page errors`, errors.length === 0, errors.join(" | ").slice(0, 300));
    });
  }

  await scenario("readonly-ui", "Readonly connection in the UI: nothing editable, Save greyed out, the Query tab refused and in History", async ({ open }) => {
    const { page, errors } = await open({ width: 1440, height: 900 });
    await showDatabasePanel(page);
    await useDatabase(page, "shop-readonly", "shop.db");
    await openTable(page, "customers");
    const save = toolButton(page, "Save");
    check("Save is greyed out and says why", (await save.isDisabled()) && (await save.getAttribute("title")) === "The connection is read-only");
    const rowButtons = await page.getByRole("button", { name: /^(New row|Delete row\(s\))$/ }).locator("visible=true").count();
    check("New row and Delete row(s) are not offered", rowButtons === 0, `${rowButtons} shown`);
    check("the read-only switch is there to allow writes", await toolButton(page, "Read-only: allow writes").isVisible());
    const state = "SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT name FROM customers ORDER BY id LIMIT 1) AS name";
    const before = await sqliteGet(state);
    await clickCell(page, "name", 0);
    await page.keyboard.type("not saved", { delay: 15 });
    await page.keyboard.press("Enter");
    await frames(page);
    check("typing on a cell changes nothing", (await save.getAttribute("aria-label")) === "Save" && (await save.isDisabled()), await save.getAttribute("aria-label"));

    await connectionRow(page, "shop-readonly").click({ button: "right" });
    await page.getByRole("menuitem", { name: "New query", exact: true }).click();
    await setQuery(page, "DELETE FROM orders");
    await visible(page.getByTitle(/^Run the whole script/)).click();
    const messages = visible(page.getByRole("tab", { name: "Messages 1 error" }));
    await messages.click();
    const said = await visible(page.getByRole("table", { name: "Messages" })).textContent();
    check("the Query tab says the connection is read-only", /readonly/i.test(said), said.slice(0, 160));
    // Open by default on a wide screen: a click would close it.
    await setPressed(visible(page.getByRole("toolbar").filter({ has: page.getByTitle(/^Run the whole script/) })).getByRole("button", { name: "History", exact: true }), true);
    const history = visible(page.getByLabel("Query history"));
    await history.getByText("DELETE FROM orders").first().waitFor();
    check("History lists the refused script as Blocked", (await history.locator('[role="img"][aria-label="Blocked"]').count()) >= 1);
    const after = await sqliteGet(state);
    check("the database is unchanged", JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
    check("no page errors on the readonly flow", errors.length === 0, errors.join(" | ").slice(0, 300));
  });

  await scenario("phone", "Phone 390 × 844: the tree in the drawer, long-press menus, a filter in a sheet, a row as a form, Save in a sheet, Copy advanced, SQL", async ({ open }) => {
    const { page, errors, context } = await open({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const cdp = await context.newCDPSession(page);
    /**
     * A finger held still on a point for `ms`, then lifted. Desktop Chromium takes a touch for a long
     * press only after 1000 ms (a phone's browser after 500): anything shorter is a tap there, and
     * the click it ends in lands on the sheet the press just opened, which closes it.
     */
    const press = async (x, y, ms = 1200) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await page.waitForTimeout(ms);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await frames(page);
    };
    /** Where `locator` comes to rest: the drawer and the sheets slide in, and a box read mid-slide is somewhere else. */
    const restingBox = async (locator) => {
      let last = await locator.boundingBox();
      for (let i = 0; i < 40; i++) {
        await frames(page);
        const box = await locator.boundingBox();
        if (box && last && box.x === last.x && box.y === last.y) return box;
        last = box;
      }
      throw new Error("the element kept moving");
    };
    const pressOn = async (locator, ms) => {
      const box = await restingBox(locator);
      await press(box.x + box.width / 2, box.y + box.height / 2, ms);
    };
    /**
     * Every control a finger can reach that is smaller than 44 × 44 CSS px, per screen of the flow —
     * the app's own chrome too: the drawer's header, tabs and footer, a toast's close button. Reach
     * is what decides: a control under an open sheet's backdrop is out of it, and a control whose tap
     * area a positioned `::before`/`::after` widens (the filter chips, a toast's close) measures as
     * that area.
     */
    const small = [];
    /** How many reachable controls each screen had: a screen measured as none would pass for nothing. */
    const measured = [];
    /** Every control measured, by name, so the chrome's are known to have been among them. */
    const names = new Set();
    const measure = async (screen) => {
      const { found, total, all } = await page.evaluate(() => {
        const reachable = (e) => {
          const r = e.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
          const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
          const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
          const hit = document.elementFromPoint(x, y);
          return !!hit && (hit === e || e.contains(hit));
        };
        /** The element's box, or the larger tap area a positioned pseudo-element gives it. */
        const tapArea = (e) => {
          const r = e.getBoundingClientRect();
          let w = r.width;
          let h = r.height;
          for (const which of ["::before", "::after"]) {
            const cs = getComputedStyle(e, which);
            if (cs.content === "none" || cs.position !== "absolute" || cs.pointerEvents === "none") continue;
            w = Math.max(w, parseFloat(cs.width) || 0);
            h = Math.max(h, parseFloat(cs.height) || 0);
          }
          return { w: Math.round(w), h: Math.round(h) };
        };
        const controls = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"], [role="treeitem"], a[href]')]
          .filter((e) => !e.closest('[aria-hidden="true"], [inert]') && reachable(e))
          .map((e) => ({ name: (e.getAttribute("aria-label") || e.textContent || e.getAttribute("title") || e.tagName).trim().replace(/\s+/g, " ").slice(0, 40), ...tapArea(e) }));
        return { found: controls.filter((t) => t.w < 44 || t.h < 44), total: controls.length, all: controls.map((t) => t.name) };
      });
      measured.push([screen, total]);
      for (const name of all) names.add(name);
      // Each screen as measured, to look at afterwards (PPM_E2E_ARTIFACTS keeps them).
      await page.screenshot({ path: join(ARTIFACTS, `phone-${screen.replaceAll(" ", "-")}.png`) });
      for (const t of found) small.push(`${screen}: ${t.name} ${t.w}×${t.h}`);
    };
    const tree = page.getByRole("tree", { name: "Connections" });
    const tables = page.getByRole("tree", { name: "Tables, views, functions" });
    const openDrawer = async () => {
      await page.getByRole("button", { name: "Open menu", exact: true }).tap();
      await page.locator("[data-tabid]").first().waitFor();
      // The drawer opens on the panel shown last.
      if (await tree.isVisible()) return;
      const tab = page.locator('button[data-tabid="database"]');
      if (await tab.isVisible()) await tab.tap();
      else {
        await page.getByRole("button", { name: "More", exact: true }).tap();
        await page.getByRole("button", { name: "Database", exact: true }).tap();
      }
      await tree.waitFor();
    };

    await step("the tree in the drawer; a long press on a connection is its menu", async () => {
      await openDrawer();
      await measure("drawer");
      const connect = page.getByRole("button", { name: "Connect", exact: true });
      const disconnect = page.getByRole("button", { name: "Disconnect", exact: true });
      const newQuery = page.getByRole("button", { name: "New query", exact: true });
      await pressOn(connectionRow(page, "shop"));
      // The tree keeps what is open for every device, so a scenario before this one can leave shop
      // open, and its menu then offers Disconnect. This flow is the one that connects from a phone.
      await connect.or(disconnect).waitFor();
      if (await disconnect.isVisible()) {
        await disconnect.tap();
        await newQuery.waitFor({ state: "detached" });
        await pressOn(connectionRow(page, "shop"));
      }
      await connect.waitFor();
      const offered = await newQuery.isVisible();
      await measure("connection menu");
      await connect.tap();
      await tables.getByRole("treeitem", { name: nameRe("customers") }).waitFor();
      check("phone: a long press on a connection opens its menu as a sheet, and Connect lists the tables", offered);
    });

    const opened = await step("open customers from the drawer", async () => {
      const first = nextGrid(page);
      await tables.getByRole("treeitem", { name: nameRe("customers") }).tap();
      const f = await first;
      await gridCanvas(page).waitFor();
      // The drawer slides off the screen and stays mounted, which Playwright still calls visible.
      const away = await until("the drawer off the screen", async () => {
        const box = await tree.boundingBox();
        return !box || box.x + box.width <= 0;
      }, 5000).then(() => true, () => false);
      check("phone: a table opens from the drawer, and the drawer gets out of the way", f.data.rows.length === 100 && away, `${f.data.rows.length} rows`);
      await measure("table");
      return f;
    });

    const filtered = await step("filter score > 5 in the column's sheet", async () => {
      const scoreMenu = toolButton(page, "Column menu: score");
      // A finger taps the part of the ⌄ it can see. Playwright's own tap would first scroll the ⌄
      // into view inside the box that clips it, which no finger does.
      const menu = await scoreMenu.boundingBox();
      await page.touchscreen.tap((menu.x + Math.min(menu.x + menu.width, page.viewportSize().width)) / 2, menu.y + menu.height / 2);
      const input = page.getByLabel("Filter score", { exact: true });
      const sheet = page.getByRole("dialog").filter({ has: input });
      await sheet.waitFor();
      await measure("filter sheet");
      const response = nextGrid(page, (b) => b.filters?.length === 1);
      await input.fill(">5");
      await sheet.getByRole("button", { name: "Apply", exact: true }).tap();
      const f = await response;
      const chips = await page.getByRole("group", { name: "Filters" }).textContent();
      check("phone: a filter set in the column's sheet is applied by the server and shown as a chip",
        f.data.rows.length > 0 && f.data.rows.every((r) => column(f.data, "score")(r) > 5) && /score/.test(chips) && /5/.test(chips), chips);
      await sheet.waitFor({ state: "detached" });
      await measure("filtered table");
      return f;
    });

    await step("tap a row: its form; edit the name; Save in the sheet", async () => {
      const id = column(filtered.data, "id")(filtered.data.rows[0]);
      const { x, y } = await cellAt(page, "name", 0, TITLE_BAND_TOUCH);
      await page.touchscreen.tap(x, y);
      const sheet = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Next row", exact: true }) });
      await sheet.waitFor();
      // The label is the column's name, then its type: "nameTEXT" as text.
      const field = sheet.getByLabel(/^name/);
      const was = await field.inputValue();
      await measure("row sheet");
      await field.fill("edited on a phone");
      await sheet.getByRole("button", { name: /^Save( \d+ changed rows?)?$/ }).tap();
      const save = page.getByRole("dialog", { name: "Save changes" });
      await save.waitFor();
      await measure("save sheet");
      await save.getByRole("button", { name: "OK", exact: true }).tap();
      await page.getByText(/^1 change saved in one transaction/).first().waitFor();
      // The toast that says so, with its close button: measured while it is still up.
      await measure("saved");
      const row = await sqliteGet(`SELECT name FROM customers WHERE id = ${id}`);
      check("phone: tapping a row opens it as a form, and a field edited there is saved through the Save changes sheet",
        was === column(filtered.data, "name")(filtered.data.rows[0]) && row?.name === "edited on a phone", `${was} → ${row?.name}`);
    });

    await step("long-press a cell: Copy advanced, then Back", async () => {
      // name, since the desktop scenario renames city in this same database.
      const { x, y } = await cellAt(page, "name", 1, TITLE_BAND_TOUCH);
      await press(x, y, 600);
      const menu = page.getByRole("menu", { name: "Cell menu" });
      await menu.waitFor();
      await measure("cell menu");
      await menu.getByRole("menuitem", { name: "Copy advanced", exact: true }).tap();
      const sub = page.getByRole("menu", { name: "Copy advanced" });
      await sub.waitFor();
      const items = await sub.getByRole("menuitem").allTextContents();
      await measure("copy advanced");
      await sub.getByRole("menuitem", { name: "Back", exact: true }).tap();
      await menu.waitFor();
      const back = await menu.getByRole("menuitem", { name: "Copy advanced", exact: true }).isVisible();
      check("phone: a long press on a cell opens its menu; Copy advanced opens in its place and Back returns to it",
        items.includes("Copy as CSV") && items.includes("Set format: CSV") && back, items.slice(0, 4).join(" | "));
      // A finger closes a sheet on its backdrop: just above the sheet, since the top of the screen
      // still holds the toast the save left there, and a tap on a toast is the toast's.
      const sheetTop = await menu.evaluate((el) => {
        for (let p = el; p.parentElement; p = p.parentElement) {
          if (getComputedStyle(p.parentElement).position === "fixed") return p.getBoundingClientRect().top;
        }
        return null;
      });
      await page.touchscreen.tap(195, sheetTop - 24);
      await menu.waitFor({ state: "detached" });
    });

    await step("run SQL from a New query tab", async () => {
      await openDrawer();
      await pressOn(connectionRow(page, "shop"));
      await page.getByRole("button", { name: "New query", exact: true }).tap();
      await visible(page.locator(".monaco-editor")).waitFor();
      await setQuery(page, "SELECT COUNT(*) AS n FROM customers WHERE score > 5;");
      const response = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/query/script"));
      await visible(page.getByRole("button", { name: "Whole script", exact: true })).tap();
      await runEnded(page, await response);
      await visible(page.getByRole("tab", { name: /^Result 1\b/ })).waitFor();
      const shown = await gridCanvas(page).locator('table[role="grid"]').textContent();
      const { n } = await sqliteGet("SELECT COUNT(*) AS n FROM customers WHERE score > 5");
      check("phone: Whole script runs the Query tab and shows the result", shown.includes(String(n)), `${n} :: ${shown.slice(0, 80)}`);
      await measure("query");
    });

    check("phone: every control the flow touches is at least 44 × 44 px",
      small.length === 0 && measured.length > 0 && measured.every(([, n]) => n > 0),
      small.length ? small.join("\n    ") : measured.map(([screen, n]) => `${screen} ${n}`).join(", "));
    const chrome = ["Close drawer", "Close toast"].filter((n) => names.has(n));
    const version = [...names].find((n) => /^(New version · )?v\d/.test(n));
    check("phone: the drawer's close button and version line, and a toast's close button, were among them",
      chrome.length === 2 && !!version, [...chrome, version ?? "no version line"].join(", "));
    check("phone: no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  });

  if (process.env.PPM_E2E_PERF) await scenario("perf", "Performance: 1M SQLite rows, 5M Postgres rows, 200 columns", async ({ open }) => {
    const perfFile = join(ROOT, "perf.db");
    await bunScript("fixture-perf.ts", `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { create: true });
db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
db.exec(\`CREATE TABLE big (id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount REAL, created TEXT, flag INTEGER, note TEXT);
  WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 1000000)
  INSERT INTO big SELECT n, 'name ' || n, n * 1.5, datetime('2024-01-01', '+' || (n % 100000) || ' minutes'), n % 2,
    CASE WHEN n % 7 = 0 THEN NULL ELSE 'note ' || (n % 1000) END FROM r;\`);
const cols = Array.from({ length: 200 }, (_, i) => \`c\${String(i + 1).padStart(3, "0")} \${i % 3 === 0 ? "INTEGER" : "TEXT"}\`);
db.exec(\`CREATE TABLE wide (id INTEGER PRIMARY KEY, \${cols.join(", ")})\`);
const vals = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? \`n * \${i + 1}\` : \`'r' || n || 'c\${i + 1}'\`));
db.exec(\`WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 2000) INSERT INTO wide SELECT n, \${vals.join(", ")} FROM r\`);
db.close();
`, [perfFile]);
    await api("/api/db/connections", { method: "POST", body: { type: "sqlite", name: "perf-sqlite", connectionConfig: { type: "sqlite", path: perfFile } } });
    const targets = [{ connection: "perf-sqlite", database: "perf.db", big: "big", rows: "1,000,000" }];
    if (pg) {
      await pg.admin.unsafe(`CREATE TABLE big5m AS SELECT g AS id, 'name ' || g AS name, (g * 1.5)::numeric(14,2) AS amount,
        timestamp '2024-01-01' + g * interval '1 second' AS created, (g % 2 = 0) AS flag,
        CASE WHEN g % 7 = 0 THEN NULL ELSE 'note ' || (g % 1000) END AS note FROM generate_series(1, 5000000) g`);
      await pg.admin.unsafe("ALTER TABLE big5m ADD PRIMARY KEY (id)");
      await pg.admin.unsafe("ANALYZE big5m");
      targets.push({ connection: "pg", database: pg.database, big: "big5m", rows: "5,000,000" });
    }
    const { page, errors } = await open({ width: 1440, height: 900 });
    await showDatabasePanel(page);
    for (const t of targets) {
      await useDatabase(page, t.connection, t.database);
      const opened = await openTable(page, t.big);
      check(`${t.connection}: ${t.big} opens in under 1 s`, opened < 1000, `${opened} ms`);
      await until(`${t.big} row count`, async () => (await statusRows(page)).includes(t.rows), 10_000);
      const down = await scrollGrid(page, 0, 400, 80);
      check(`${t.connection}: ${t.big} scrolls smoothly and loads pages as it goes`, down.p95 <= 50 && down.max <= 150 && down.pages >= 3, JSON.stringify(down));
    }
    await useDatabase(page, "perf-sqlite", "perf.db");
    const opened = await openTable(page, "wide");
    check("200 columns open in under 1 s", opened < 1000, `${opened} ms`);
    const across = await scrollGrid(page, 150, 0, 60);
    check("200 columns scroll sideways smoothly", across.p95 <= 50 && across.max <= 150, JSON.stringify(across));
    const aligned = await filterRowAlignment(page);
    const shifted = await filterRowAlignment(page, 4);
    check("the filter row moves with the grid", aligned.scrollLeft > 1000 && aligned.translate === -aligned.scrollLeft, JSON.stringify(aligned));
    check("every visible filter cell starts on a column divider", aligned.edges >= 5 && aligned.onDivider === aligned.edges && shifted.onDivider === 0, `${JSON.stringify(aligned)} shifted ${JSON.stringify(shifted)}`);
    // Tab from the last filter box in view reaches one past the grid's right edge, and the browser
    // scrolls the box clipping the filter row to show it — which used to leave every filter box
    // beside the wrong column for as long as the tab stayed open. The grid scrolls there instead.
    // The box clipping the filter row is the parent of the translated track holding its cells.
    const lastInView = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[aria-label^="Filter "]')].filter((e) => e.getBoundingClientRect().width > 0);
      let track = inputs[0];
      while (!/translateX/.test(track.getAttribute("style") || "")) track = track.parentElement;
      const view = track.parentElement.getBoundingClientRect();
      return inputs.filter((e) => { const r = e.getBoundingClientRect(); return r.left >= view.left && r.right <= view.right; }).at(-1).getAttribute("aria-label");
    });
    await page.getByLabel(lastInView, { exact: true }).focus();
    let reached = lastInView;
    for (let i = 0; i < 8 && reached === lastInView; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => (document.activeElement?.matches('input[aria-label^="Filter "]') ? document.activeElement.getAttribute("aria-label") : null)) ?? lastInView;
    }
    await frames(page);
    const tabbed = await filterRowAlignment(page);
    const inView = await page.evaluate((label) => {
      const input = document.querySelector(`input[aria-label="${label}"]`);
      let track = input;
      while (!/translateX/.test(track.getAttribute("style") || "")) track = track.parentElement;
      const view = track.parentElement.getBoundingClientRect();
      const r = input.getBoundingClientRect();
      return r.left >= view.left && r.right <= view.right && track.parentElement.scrollLeft === 0;
    }, reached);
    check("Tab to a filter box past the edge scrolls the grid there, every filter box still on its column",
      reached !== lastInView && inView && tabbed.edges >= 5 && tabbed.onDivider === tabbed.edges && tabbed.translate === -tabbed.scrollLeft,
      `${lastInView} → ${reached} ${JSON.stringify(tabbed)}`);
    await page.screenshot({ path: join(ARTIFACTS, "perf-wide-scrolled.png") });
    check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  });
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
  await new Promise((r) => (server.exitCode !== null ? r() : server.once("exit", r)));
  for (const engine of [pg, my]) await engine?.drop().catch((e) => console.log(`could not drop ${engine.database}: ${masked(e.message)}`));
  if (!process.env.PPM_E2E_KEEP) await rm(ROOT, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`Server log (last 40 lines):\n${masked(serverLog.split("\n").slice(-40).join("\n"))}`);
  process.exit(1);
}
