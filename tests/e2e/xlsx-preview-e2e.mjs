// The Excel preview on a disposable PPM: the production bundle from `bun run build`, served by
// `src/index.ts __serve__` on loopback (no tunnel), with its own PPM_HOME and HOME.
// Run `bun run build` first. PPM_PLAYWRIGHT_MODULE may point at an external Playwright index.mjs.
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const repo = process.cwd();
assert(readdirSync(join(repo, "dist/web/assets")).some((f) => /^xlsx-preview-.*\.js$/.test(f)), "run `bun run build` first");
const shots = resolve(repo, ".playwright-mcp");
await mkdir(shots, { recursive: true });

const sandbox = await mkdtemp(join(tmpdir(), "ppm-xlsx-e2e-"));
const ppmHome = join(sandbox, "ppm"), home = join(sandbox, "home"), scan = join(sandbox, "scan");
const project = join(sandbox, "sheets"), fixtures = join(sandbox, "fixtures");
await Promise.all([ppmHome, home, scan, project, fixtures].map((p) => mkdir(p, { recursive: true })));

const PASSWORD = "xlsx-e2e-pass";
const env = { PATH: process.env.PATH, HOME: home, PPM_HOME: ppmHome };

function run(args) {
  const r = spawnSync("env", ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...args], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${args.join(" ")} exited ${r.status}: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

async function freePort() {
  for (;;) {
    const s = createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const port = s.address().port;
    await new Promise((r) => s.close(r));
    const listening = spawnSync("ss", ["-ltn"], { encoding: "utf8" }).stdout;
    if (!new RegExp(`[:.]${port}\\s`).test(listening)) return port;
  }
}

async function until(label, fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn().catch(() => false);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timeout: ${label}`);
}

let server, browser, serverLog = "";
const results = [];
try {
  const fx = JSON.parse(run(["bun", "tests/e2e/fixtures/xlsx-preview-fixtures.ts", fixtures]));
  // One file per device: the workspace is saved on the server, so a file the desktop left open
  // would already be a tab on the phone.
  for (const f of ["book.xlsx", "book-phone.xlsx", "book-tablet.xlsx"]) await copyFile(join(fixtures, "book.xlsx"), join(project, f));
  spawnSync("git", ["init", "-q", project]);

  const port = await freePort();
  run(["bun", "src/index.ts", "init", "-y", "--scan", scan, "--port", String(port), "--auth", "--password", PASSWORD]);
  run(["bun", "src/index.ts", "projects", "add", project]);

  server = spawn("env", ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "bun", "src/index.ts", "__serve__", String(port), "127.0.0.1"],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (s) => serverLog += s);
  server.stderr.on("data", (s) => serverLog += s);
  const web = `http://127.0.0.1:${port}`;
  await until("server up", async () => (await fetch(`${web}/api/health`)).ok, 60000);
  console.log("PPM serving on", web, "pid", server.pid);

  const pw = process.env.PPM_PLAYWRIGHT_MODULE ? await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true });

  async function openBook(page, file = "book.xlsx") {
    await page.goto(`${web}/project/sheets`);
    // First-run prompts of a fresh PPM.
    for (let i = 0; i < 3; i++) {
      for (const name of ["Not yet", "Close", "Maybe later"]) {
        const b = page.getByRole("button", { name, exact: true });
        if (await b.first().isVisible().catch(() => false)) await b.first().click().catch(() => {});
      }
      await page.waitForTimeout(400);
    }
    await page.evaluate((f) => window.dispatchEvent(new CustomEvent("open-command-palette", { detail: f })), file);
    // The file is the palette's first hit once it shows up; Enter opens it.
    await page.getByText(file, { exact: true }).last().waitFor({ timeout: 15000 });
    await page.keyboard.press("Enter");
    await page.getByRole("tablist", { name: "Sheets" }).waitFor({ timeout: 20000 });
  }
  const tab = (page, name) => page.getByRole("tablist", { name: "Sheets" }).getByRole("tab", { name, exact: true });
  const tabHeight = async (page) => (await tab(page, "Summary").boundingBox()).height;

  async function newPage(viewport, extra = {}) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block", ...extra });
    await context.addInitScript((token) => localStorage.setItem("ppm-auth-token", token), PASSWORD);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    return { context, page, errors };
  }

  // ── Desktop, mouse ────────────────────────────────────────────────────
  {
    const { context, page, errors } = await newPage({ width: 1440, height: 900 });
    await openBook(page);
    const elapsed = page.locator('[data-cell="A2"]:visible');
    assert.equal((await elapsed.innerText()).trim(), "36:00", "[h]:mm of 1.5 days");
    results.push({ check: "[h]:mm 1.5 → 36:00", ok: true });

    const when = page.locator('[data-cell="B2"]:visible');
    const whenText = await when.locator("span").evaluate((el) => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth }));
    assert.equal(whenText.text, "2024-03-05 12:00:00");
    assert.equal(whenText.cut, false, "date-time cell is not cut");
    results.push({ check: "date-time cell shown whole", ok: true, text: whenText.text });

    await page.locator('[data-cell="C2"]:visible').click();
    assert.equal((await page.locator('[data-testid="xlsx-cell-ref"]:visible').innerText()).trim(), "C2");
    assert.equal((await page.locator('[data-testid="xlsx-cell-value"]:visible').innerText()).trim(), fx.longNote);
    results.push({ check: "tapping the long note shows it whole in the cell bar", ok: true });

    const h = await tabHeight(page);
    assert(h >= 31 && h < 40, `mouse tab height ${h}`);
    results.push({ check: "sheet tab height, 1440×900 mouse", ok: true, height: h });

    await page.screenshot({ path: join(shots, "xlsx-e2e-desktop.png") });

    // Second sheet, then a half-written copy, then the full one again.
    await tab(page, "Data").click();
    await page.locator('[data-cell="A1"]:visible', { hasText: "data row 1" }).waitFor();
    await copyFile(join(fixtures, "book-cut.xlsx"), join(project, "book.xlsx"));
    await page.locator('[data-testid="xlsx-error"]:visible').waitFor({ timeout: 20000 });
    assert.equal(await tab(page, "Data").getAttribute("aria-selected"), "true");
    assert.equal((await page.locator('[data-cell="A1"]:visible').innerText()).trim(), "data row 1");
    results.push({ check: "half-written file: still on Data, error banner shown", ok: true, banner: await page.locator('[data-testid="xlsx-error"]:visible').innerText() });
    await page.screenshot({ path: join(shots, "xlsx-e2e-desktop-error.png") });

    await copyFile(join(fixtures, "book-full.xlsx"), join(project, "book.xlsx"));
    await until("banner gone", async () => (await page.locator('[data-testid="xlsx-error"]:visible').count()) === 0, 20000);
    assert.equal(await tab(page, "Data").getAttribute("aria-selected"), "true");
    assert.equal((await page.locator('[data-cell="A1"]:visible').innerText()).trim(), "data row 1");
    results.push({ check: "full file back: banner gone, still on Data", ok: true });

    await tab(page, "Big").click();
    await page.getByText("data row", { exact: false }).first().waitFor({ state: "detached" }).catch(() => {});
    await page.locator('[data-cell="B1"]:visible', { hasText: "item 1" }).waitFor();
    results.push({ check: "Big sheet (20,000 rows) opens", ok: true });

    await tab(page, "Wide").click();
    await page.getByText("Showing the first 200 columns").waitFor();
    results.push({ check: "Wide sheet: 200-column notice", ok: true });

    assert.deepEqual(errors, []);
    await context.close();
  }

  // ── Phone ─────────────────────────────────────────────────────────────
  {
    const { context, page, errors } = await newPage({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
    await openBook(page, "book-phone.xlsx");
    const h = await tabHeight(page);
    assert(h >= 44, `phone tab height ${h}`);
    results.push({ check: "sheet tab height, 390×844 touch", ok: true, height: h });
    // The desktop's book.xlsx tab is in the saved workspace too; only the visible grid counts.
    await page.locator('[data-cell="C2"]:visible').tap();
    assert.equal((await page.locator('[data-testid="xlsx-cell-value"]:visible').innerText()).trim(), fx.longNote);
    results.push({ check: "phone: tapping the note shows it in the cell bar", ok: true });
    await page.screenshot({ path: join(shots, "xlsx-e2e-mobile.png") });
    assert.deepEqual(errors, []);
    await context.close();
  }

  // ── Tablet with touch ─────────────────────────────────────────────────
  {
    const { context, page, errors } = await newPage({ width: 1024, height: 768 }, { hasTouch: true });
    await openBook(page, "book-tablet.xlsx");
    const h = await tabHeight(page);
    assert(h >= 44, `tablet tab height ${h}`);
    results.push({ check: "sheet tab height, 1024×768 touch", ok: true, height: h });
    await page.screenshot({ path: join(shots, "xlsx-e2e-tablet.png") });
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log(JSON.stringify({ passed: true, results, screenshots: readdirSync(shots).filter((f) => f.startsWith("xlsx-e2e-")).map((f) => join(shots, f)) }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ passed: false, results }, null, 2));
  console.error(error);
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.screenshot({ path: join(shots, "xlsx-e2e-failure.png") }).catch(() => {});
  }
  console.error(serverLog.split("\n").slice(-40).join("\n"));
} finally {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((r) => server.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  // The server's child can still write into HOME for a moment after the parent exits.
  for (let i = 0; i < 5; i++) {
    await rm(sandbox, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 1000));
    if (!existsSync(sandbox)) break;
  }
  console.log("cleaned up", sandbox, existsSync(sandbox) ? "(still there)" : "");
}
