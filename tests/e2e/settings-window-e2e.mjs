// Settings window — real browser end-to-end harness (headless Chrome via raw CDP, same
// conventions as tests/e2e/system-monitor-e2e.mjs: no puppeteer, auth token read read-only
// from the PPM database and never printed, PID-scoped teardown).
//
// Deliberately FRONTEND-ONLY by default: it starts vite and points it at a backend that is
// already running (PPM_DEV_API), and never starts `dev:server`. `dev:server` writes the
// shared `.server-port` inside the PPM directory, which can steal a running production
// instance's tunnel route — not something a UI test should risk. Vite defaults to 5174, not
// 5173, so a dev stack you already have open is left alone too.
//
// What it does:
//   1. Starts vite (5174) unless one is already up, or skip entirely with
//      PPM_E2E_NO_SERVERS=1 to reuse a stack you started yourself.
//   2. Launches headless Chrome, injects the auth token into localStorage.
//   3. Desktop (1280x900): asserts the nav rail has EXACTLY ONE Settings button, clicks it,
//      asserts a floating WINDOW opens with a split layout (rail + pane), switches category
//      from the rail, reloads and asserts the category came back, then clicks Settings again
//      and asserts no second window appeared.
//   4. Accounts pane: asserts it lists accounts (or shows its empty state) and offers every
//      management action, and that the add-account dialog opens and cancels. STRICTLY
//      read-only — it never adds, removes, enables or exports an account, because the
//      backend it points at may be the user's own.
//   5. URL route (desktop, hard load): loads /project/{name}/settings directly and asserts it
//      opens a window rather than a tab — the case that regresses if the open races the
//      window layer's restore and gets wiped.
//   6. Mobile (390x844): asserts the desktop rail is unreachable, that Settings opens as a
//      TAB via the drawer's own tile, and that the index -> pane -> back drill-down works.
//   7. Closes any settings tab it opened: the panel layout is server-persisted, so a leftover
//      tab would come back on the next run and in the user's own session.
//   8. Screenshots at each major step under PPM_E2E_SHOTS
//      (default: plans/reports/screenshots/).
//   9. Stops ONLY what this script started, by exact PID.
//
// Run (against an already-running PPM on port 3214):
//   PPM_DEV_API=http://localhost:3214 PPM_DB=~/.ppm/ppm.db bun tests/e2e/settings-window-e2e.mjs
//   PPM_E2E_NO_SERVERS=1 bun tests/e2e/settings-window-e2e.mjs   # reuse your own vite
//   PPM_E2E_KEEP=1 ...                                           # leave vite running after
//
// Exits non-zero if any scenario fails.

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const REPO = process.cwd();
const API = process.env.PPM_DEV_API || "http://localhost:8081";
const WEB_PORT = Number(process.env.PPM_E2E_WEB_PORT || 5174);
const WEB = `http://localhost:${WEB_PORT}`;
const CDP_PORT = Number(process.env.PPM_E2E_CDP_PORT || 9236);
// Whichever database the target backend is actually using — the token has to match it.
const DB = (process.env.PPM_DB || join(homedir(), ".ppm", "ppm.dev.db")).replace(/^~(?=[/\\])/, homedir());
const SHOTS = process.env.PPM_E2E_SHOTS || join(REPO, "plans", "reports", "screenshots");
const CHROME = process.env.CHROME_PATH || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
const KEEP = !!process.env.PPM_E2E_KEEP;
const NO_SERVERS = !!process.env.PPM_E2E_NO_SERVERS;
const TOKEN_KEY = "ppm-auth-token"; // src/web/lib/api-client.ts

// Never log TOKEN's value anywhere below.
const TOKEN = (() => {
  try {
    const db = new Database(DB, { readonly: true });
    try {
      const row = db.query("SELECT value FROM config WHERE key='auth'").get();
      return row ? (JSON.parse(row.value)?.token ?? null) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
})();

const started = { web: null, chrome: null, chromeProfile: null };
/** Chat tab this harness opened (if any) — closed again in teardown. */
let harnessChatTabId = null;
let chatChipText = null;
const results = [];
const log = (...a) => console.log(...a);
const step = (t) => log("\n=== " + t + " ===");

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

async function scenario(name, fn) {
  try {
    await fn();
    if (!results.some((r) => r.name === name)) record(name, true);
  } catch (e) {
    record(name, false, e?.message || String(e));
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle — vite only, never dev:server
// ---------------------------------------------------------------------------
async function isUp(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.status > 0;
  } catch {
    return false;
  }
}

async function waitUp(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) {
      log(`  ${label} is up: ${url}`);
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`${label} did not come up within ${timeoutMs}ms (${url})`);
}

function spawnBg(cmd, args, name, env) {
  const child = spawn(cmd, args, {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

async function ensureServers() {
  // The backend is never started here: this harness attaches to one that already exists.
  if (!(await isUp(`${API}/api/health`))) {
    throw new Error(`No backend at ${API}. Start PPM (or set PPM_DEV_API) — this harness never starts dev:server, because it would rewrite the shared .server-port.`);
  }
  log(`  backend reachable: ${API}`);

  if (NO_SERVERS) {
    log("  PPM_E2E_NO_SERVERS set — assuming vite already running");
    await waitUp(WEB, "web");
    return;
  }
  if (await isUp(WEB)) {
    log("  web already up — reusing");
    return;
  }
  // vite is invoked directly rather than through the `dev:web` script so the port flags
  // actually reach it, and `--strictPort` makes a busy port fail loudly instead of silently
  // landing on a neighbouring one (which would test somebody else's stack).
  log(`  starting web: vite (port ${WEB_PORT}, api ${API})`);
  started.web = spawnBg(
    "bun",
    ["run", "vite", "--config", "vite.config.ts", "--port", String(WEB_PORT), "--strictPort"],
    "web",
    { PPM_DEV_API: API },
  );
  await waitUp(WEB, "web");
}

function killPid(child, name) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
    log(`  killed ${name} (pid ${child.pid})`);
  } catch (e) {
    log(`  failed to kill ${name}: ${e.message}`);
  }
}

async function cleanup() {
  step("Cleanup");
  killPid(started.chrome, "chrome");
  // Only ever the vite this script spawned, by PID. Never a port sweep and never by image
  // name — that has taken down a production tunnel before.
  if (!KEEP) killPid(started.web, "web");
  else log("  PPM_E2E_KEEP set — leaving vite running");
  if (started.chromeProfile) {
    await rm(started.chromeProfile, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Raw CDP driver
// ---------------------------------------------------------------------------
async function launchChrome() {
  const profile = join(tmpdir(), `ppm-e2e-settings-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  started.chromeProfile = profile;
  const args = [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ];
  log(`  launching Chrome: ${CHROME}`);
  started.chrome = spawn(CHROME, args, { stdio: "ignore" });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) });
      const page = (await r.json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
    await Bun.sleep(500);
  }
  throw new Error("Chrome DevTools endpoint never became ready");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP ws error")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error("evaluate threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await Bun.sleep(300);
  }

  async setViewport(width, height, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  }

  async screenshot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(r.data, "base64"));
    log(`  screenshot -> ${path}`);
  }
}

async function waitFor(cdp, expr, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(`Boolean(${expr})`)) return true;
    } catch {
      /* page mid-navigation */
    }
    await Bun.sleep(300);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const q = (testId) => `document.querySelector('[data-testid=${JSON.stringify(testId)}]')`;

/**
 * The visible one of many matches.
 *
 * Tabs stay mounted in the pool while hidden, so a chat control exists once per open chat
 * tab and `querySelector` hands back whichever comes first in the DOM - usually one belonging
 * to a hidden tab. Anything inside a tab has to be addressed this way.
 */
const visibleOne = (selector) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => ${VISIBLE}(el))`;

/** Expression that is true once the pane body contains the given text.
 *  Switching `data-category` only proves the shell moved — the lazy section behind it can
 *  still be in Suspense, or have thrown. Asserting on real text inside the pane is what
 *  distinguishes "the pane changed" from "the pane works". */
const paneHasText = (text) => `(() => {
  const body = ${q("settings-window")};
  if (!body) return false;
  const index = ${q("settings-index")};
  // The narrow layout's index overlays the pane; its text must not count as pane content.
  const inIndex = (el) => index && index.contains(el);
  const target = [...body.querySelectorAll("h3, h2, label, p, span, button")]
    .find((el) => el.textContent?.trim() === ${JSON.stringify(text)} && !inIndex(el));
  return Boolean(target);
})()`;

/** `el.click()` fires handlers on a `display:none` element just fine, which would let a
 *  scenario "pass" by driving a control the user cannot actually see — the desktop rail is
 *  `hidden md:flex`, so on a phone every rail button is exactly that trap. Every click here
 *  goes through this check instead. */
const VISIBLE = `((el) => Boolean(el && el.offsetParent !== null && el.getClientRects().length > 0))`;

async function clickVisible(cdp, selectorExpr, label) {
  const res = await cdp.evaluate(`(() => {
    const el = ${selectorExpr};
    if (!el) return "missing";
    if (!${VISIBLE}(el)) return "hidden";
    el.scrollIntoView({ block: "center" });
    el.click();
    return "ok";
  })()`);
  if (res === "missing") throw new Error(`click target not found: ${label}`);
  if (res === "hidden") throw new Error(`click target is not visible to a user: ${label}`);
}

const clickTestId = (cdp, testId) => clickVisible(cdp, q(testId), `[data-testid="${testId}"]`);

/** The rail's Settings button carries no testid — FooterUtil labels itself via aria-label. */
const clickRailSettings = (cdp) =>
  clickVisible(cdp, `document.querySelector('button[aria-label="Settings"]')`, 'nav rail button[aria-label="Settings"]');

/** Mobile has no rail. The drawer's footer tile is the reachable entry point, so open the
 *  drawer the way a user does (the header hamburger) and click the tile inside it. */
async function clickMobileDrawerSettings(cdp) {
  await clickVisible(cdp, `document.querySelector('button[aria-label="Open menu"]')`, "mobile header menu button");
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === "Settings" && ${VISIBLE}(b))`,
    "drawer Settings tile",
  );
  await clickVisible(
    cdp,
    `[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === "Settings" && ${VISIBLE}(b))`,
    "drawer Settings tile",
  );
}

/** True when the Settings body is inside a floating window frame rather than a tab panel.
 *  The frame identifies itself semantically (`role="group"` + this roledescription) rather
 *  than with a test hook, so that is what we match on. */
const IN_WINDOW = `(() => {
  const body = ${q("settings-window")};
  return Boolean(body && body.closest('[aria-roledescription="window"]'));
})()`;

/** Settings bodies that are inside a window frame. Counting the bare testid would also count
 *  a settings TAB, which is a different presentation, not a duplicate window. */
const SETTINGS_WINDOW_COUNT = `[...document.querySelectorAll('[data-testid="settings-window"]')]
  .filter((el) => el.closest('[aria-roledescription="window"]')).length`;

/**
 * Close every settings TAB in the workspace.
 *
 * The panel layout is persisted per project on the SERVER, so a settings tab opened by the
 * mobile scenario comes back on the next run — and on the user's own machine. Two reasons to
 * clean it up: the desktop scenarios must not find a stale tab and mistake it for their
 * window, and this harness has no business leaving tabs behind in a real workspace.
 */
/**
 * Wait until the server-persisted workspace layout has landed in the panel store.
 *
 * Without this, cleanup can run against an empty store, report "nothing to close", and then
 * hydration restores the very tab it was supposed to remove — which is exactly how the
 * desktop scenarios started finding a stale settings tab.
 */
async function waitForWorkspace(cdp) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const tabs = await cdp.evaluate(`(async () => {
      const panels = (await import('/stores/panel-store.ts')).usePanelStore;
      return Object.values(panels.getState().panels).reduce((n, p) => n + p.tabs.length, 0);
    })()`).catch(() => 0);
    if (tabs > 0) return tabs;
    await Bun.sleep(400);
  }
  return 0; // an empty workspace is legitimate — nothing to wait for
}

async function closeSettingsTabs(cdp) {
  const closed = await cdp.evaluate(`(async () => {
    const panels = (await import('/stores/panel-store.ts')).usePanelStore;
    const ids = Object.values(panels.getState().panels)
      .flatMap((p) => p.tabs)
      .filter((t) => t.type === "settings")
      .map((t) => t.id);
    for (const id of ids) panels.getState().closeTab(id);
    return ids.length;
  })()`);
  if (closed) log(`  closed ${closed} leftover settings tab(s) so the workspace is left as found`);
  return closed;
}

async function bootstrap(cdp) {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.navigate(WEB);
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(TOKEN)})`);
  await cdp.navigate(WEB);
  await waitFor(cdp, `document.querySelector('button[aria-label="Settings"]') || ${q("settings-window")}`, "app shell");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!TOKEN) throw new Error(`No auth token in ${DB} (config key 'auth'). Set PPM_DB to the database the backend uses.`);
  await mkdir(SHOTS, { recursive: true });

  step("0. Servers");
  await ensureServers();

  step("1. Chrome");
  const cdp = await Cdp.connect(await launchChrome());

  step("2. Desktop (1280x900)");
  await cdp.setViewport(1280, 900);
  await bootstrap(cdp);
  // A settings tab persisted by an earlier mobile run would otherwise be mistaken for this
  // phase's window. Hydration first, or the cleanup races it and finds nothing.
  await waitForWorkspace(cdp);
  await closeSettingsTabs(cdp);
  await waitFor(cdp, `!${q("settings-window")}`, "no stale settings body before the desktop scenarios");

  await scenario("nav rail has exactly one Settings button", async () => {
    const count = await cdp.evaluate(`document.querySelectorAll('button[aria-label="Settings"]').length`);
    if (count !== 1) throw new Error(`expected 1 Settings button on the rail, found ${count}`);
  });

  await scenario("desktop: Settings opens a floating window with the split layout", async () => {
    await clickRailSettings(cdp);
    await waitFor(cdp, q("settings-window"), "settings body");
    if (!(await cdp.evaluate(IN_WINDOW))) {
      throw new Error("Settings rendered outside a floating window frame on desktop");
    }
    // The rail exists in the DOM at every width; on a wide container it must be laid out.
    const railVisible = await cdp.evaluate(`(() => {
      const rail = ${q("settings-rail")};
      return Boolean(rail && rail.getBoundingClientRect().width > 0);
    })()`);
    if (!railVisible) throw new Error("category rail is not laid out in the wide window (split layout did not engage)");
    // The default pane must actually render, not just be selected.
    await waitFor(cdp, paneHasText("Device Name"), "General pane content");
  });
  await cdp.screenshot(join(SHOTS, "settings-01-desktop-window.png"));

  await scenario("desktop: rail switches the pane and the section renders", async () => {
    await clickTestId(cdp, "settings-rail-appearance");
    await waitFor(cdp, `${q("settings-window")}.dataset.category === "appearance"`, "appearance selected");
    await waitFor(cdp, paneHasText("Tab Style"), "Appearance pane content");
  });
  await cdp.screenshot(join(SHOTS, "settings-02-desktop-appearance.png"));

  await scenario("desktop: the open category survives a reload", async () => {
    await cdp.navigate(WEB);
    await waitFor(cdp, q("settings-window"), "settings body after reload");
    const category = await cdp.evaluate(`${q("settings-window")}.dataset.category`);
    if (category !== "appearance") throw new Error(`expected the reload to restore "appearance", got ${JSON.stringify(category)}`);
  });

  await scenario("desktop: opening again focuses the same window, never a duplicate", async () => {
    await clickRailSettings(cdp);
    await Bun.sleep(500);
    const count = await cdp.evaluate(SETTINGS_WINDOW_COUNT);
    if (count !== 1) throw new Error(`expected 1 settings window after a repeat open, found ${count}`);
  });

  step("3. Accounts pane (desktop)");
  // Strictly read-only against real accounts: it opens panes and dialogs and cancels out of
  // them. Nothing here adds, removes, enables or exports an account — this harness runs
  // against whatever backend it is pointed at, which may well be the user's own.
  await scenario("desktop: the Accounts pane lists accounts and offers management", async () => {
    await clickTestId(cdp, "settings-rail-accounts");
    await waitFor(cdp, `${q("settings-window")}.dataset.category === "accounts"`, "accounts selected");
    // Either real accounts or the empty state — both prove the pane rendered rather than threw.
    await waitFor(
      cdp,
      `Boolean(${q("account-card")}) || ${paneHasText("No accounts connected yet.")}`,
      "account list or empty state",
    );
    for (const label of ["Add account", "Export", "Import", "Rotation", "Token test"]) {
      const present = await cdp.evaluate(
        `[...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === ${JSON.stringify(label)} && ${VISIBLE}(b))`,
      );
      if (!present) throw new Error(`the Accounts pane is missing a reachable "${label}" button`);
    }
  });
  await cdp.screenshot(join(SHOTS, "settings-06-desktop-accounts.png"));

  await scenario("desktop: Accounts has a sub-tab per configured provider", async () => {
    // Claude always exists; Codex only when the user configured that provider, so the tab bar
    // is only asserted to be consistent with what the AI settings actually list.
    const codexConfigured = await cdp.evaluate(`(async () => {
      const r = await fetch("/api/settings/ai", { headers: { Authorization: "Bearer " + localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) } });
      if (!r.ok) return null;
      const body = await r.json();
      // The API wraps payloads as {ok,data}; api-client unwraps .data, a raw fetch must too.
      const providers = body?.data?.providers ?? body?.providers ?? {};
      return Object.keys(providers).includes("codex");
    })()`);
    if (codexConfigured === null) throw new Error("could not read /api/settings/ai to know which providers are configured");

    const hasCodexTab = await cdp.evaluate(`Boolean(${q("accounts-tab-codex")})`);
    if (codexConfigured !== hasCodexTab) {
      throw new Error(`codex configured=${codexConfigured} but a Codex sub-tab present=${hasCodexTab}`);
    }
    // Claude content is what the pane opens on either way.
    await waitFor(cdp, `Boolean(${q("account-card")}) || ${paneHasText("No accounts connected yet.")}`, "Claude accounts");

    if (!hasCodexTab) {
      log("  codex is not a configured provider here — sub-tab correctly absent");
      return;
    }
    await clickTestId(cdp, "accounts-tab-codex");
    await waitFor(cdp, `${q("accounts-pane")}.dataset.provider === "codex"`, "codex sub-tab active");
    await waitFor(cdp, paneHasText("Codex Accounts"), "codex pane content");
    await cdp.screenshot(join(SHOTS, "settings-09-desktop-accounts-codex.png"));
    // Back to Claude, so later scenarios start where they expect.
    await clickTestId(cdp, "accounts-tab-claude");
    await waitFor(cdp, `${q("accounts-pane")}.dataset.provider === "claude"`, "claude sub-tab active");
  });

  await scenario("both account sub-tabs are built the same way", async () => {
    // The two panes were two different designs — one on shadcn buttons with dialogs, the
    // other on raw buttons with forms inline down the page. This is the guard against them
    // drifting apart again, asserted on structure rather than on pixels.
    if (!(await cdp.evaluate(`Boolean(${q("accounts-tab-codex")})`))) {
      log("  only one provider configured — nothing to compare");
      return;
    }

    /** What a pane offers, from the user's point of view. */
    const shapeOf = () => cdp.evaluate(`(() => {
      const pane = ${q("accounts-pane")};
      const visible = (el) => Boolean(el && el.offsetParent !== null);
      const labels = [...pane.querySelectorAll("button")]
        .filter(visible)
        .map((b) => b.textContent?.trim())
        .filter(Boolean);
      return {
        actions: ["Add account", "Export", "Import", "Rotation"].filter((l) => labels.includes(l)),
        refresh: Boolean(pane.querySelector('[aria-label="Refresh accounts"]')),
        // Bars, not text percentages: the Codex pane used to print "5h 37% - weekly 9%".
        // Keyed on the bar's own testid - a Switch in the card is also rounded-full.
        usageBars: pane.querySelectorAll('[data-testid="account-usage-bar"]').length,
        cards: pane.querySelectorAll('[data-testid="account-card"]').length,
        // Inline inputs were the other half of the mismatch — every form is a dialog now.
        inlineInputs: [...pane.querySelectorAll("input")].filter(visible).length,
      };
    })()`);

    // Switching sub-tabs remounts the pane, so it refetches. Measuring before that settles
    // reported zero cards and quietly skipped the usage-bar comparison entirely.
    const settled = `Boolean(${q("account-card")}) || ${paneHasText("No accounts connected yet.")} || ${paneHasText("No Codex accounts yet.")}`;
    await waitFor(cdp, settled, "claude pane settled");
    const claude = await shapeOf();
    await clickTestId(cdp, "accounts-tab-codex");
    await waitFor(cdp, `${q("accounts-pane")}.dataset.provider === "codex"`, "codex sub-tab");
    await waitFor(cdp, paneHasText("Codex Accounts"), "codex pane content");
    await waitFor(cdp, settled, "codex pane settled");
    const codex = await shapeOf();
    await clickTestId(cdp, "accounts-tab-claude");
    await waitFor(cdp, `${q("accounts-pane")}.dataset.provider === "claude"`, "claude sub-tab");

    const want = ["Add account", "Export", "Import", "Rotation"];
    for (const [name, shape] of [["Claude", claude], ["Codex", codex]]) {
      const missing = want.filter((l) => !shape.actions.includes(l));
      if (missing.length) throw new Error(`${name} pane is missing action buttons: ${missing.join(", ")}`);
      if (!shape.refresh) throw new Error(`${name} pane has no Refresh control`);
      if (shape.inlineInputs > 0) throw new Error(`${name} pane still has ${shape.inlineInputs} inline input(s) instead of a dialog`);
      // Only meaningful where accounts exist; an empty pane has no cards to draw.
      if (shape.cards > 0 && shape.usageBars === 0) throw new Error(`${name} pane draws ${shape.cards} card(s) with no usage bar`);
    }
    log(`  Claude: ${claude.cards} card(s)/${claude.usageBars} bar(s), Codex: ${codex.cards} card(s)/${codex.usageBars} bar(s), same action set`);
  });

  await scenario("AI Provider no longer embeds the Codex account manager", async () => {
    // The whole point of merging: Codex sign-ins must not exist in two places again.
    // Whatever happens below, hand the pane back on Accounts. Leaving it elsewhere after a
    // failure made four later scenarios fail for a reason that had nothing to do with them.
    try {
    await clickTestId(cdp, "settings-rail-ai-provider");
    await waitFor(cdp, `${q("settings-window")}.dataset.category === "ai-provider"`, "AI Provider pane");
    const CODEX_TAB = `[...document.querySelectorAll('[data-testid="settings-window"] button')]
      .find((b) => /codex$/i.test(b.textContent?.trim() ?? ""))`;
    // The pane fetches its settings before it can render provider tabs, so waiting on the
    // shell category is not enough - wait for the tab itself to be laid out.
    let hasProviderTab = false;
    try {
      await waitFor(cdp, `${VISIBLE}(${CODEX_TAB})`, "AI Provider Codex tab", 10_000);
      hasProviderTab = true;
    } catch { /* single-provider install: nothing to check */ }
    if (!hasProviderTab) {
      log("  codex provider tab not shown in AI Provider (single provider) — nothing to check");
    } else {
      await clickVisible(cdp, CODEX_TAB, "AI Provider Codex tab");
      const embedded = await cdp.evaluate(paneHasText("Codex Accounts"));
      if (embedded) throw new Error("AI Provider still renders the Codex account manager inline");
      const hasLink = await cdp.evaluate(
        `[...document.querySelectorAll('[data-testid="settings-window"] button')].some((b) => b.textContent?.includes("Codex accounts"))`,
      );
      if (!hasLink) throw new Error("AI Provider's Codex tab offers no way to reach the accounts pane");
    }
    } finally {
      await clickTestId(cdp, "settings-rail-accounts").catch(() => {});
      await waitFor(cdp, `${q("settings-window")}.dataset.category === "accounts"`, "back on accounts").catch(() => {});
    }
  });

  await scenario("desktop: the Add account dialog opens and cancels without touching anything", async () => {
    await clickVisible(
      cdp,
      `[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === "Add account" && ${VISIBLE}(b))`,
      '"Add account" button',
    );
    // `[data-slot="dialog-content"]` is this repo's dialog marker (see the other harnesses);
    // a bottom sheet is a plain layer with no dialog role, so the role selector misses it.
    const DIALOG = `document.querySelector('[data-slot="dialog-content"]')`;
    await waitFor(cdp, DIALOG, "add-account dialog");
    const hasOAuth = await cdp.evaluate(
      `[...document.querySelectorAll('[data-slot="dialog-content"] button')].some((b) => b.textContent?.includes("Login with Claude"))`,
    );
    if (!hasOAuth) throw new Error("the add-account dialog has no OAuth path");
    await clickVisible(
      cdp,
      `[...document.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent?.trim() === "Cancel")`,
      "dialog Cancel",
    );
    await waitFor(cdp, `!${DIALOG}`, "dialog dismissed");
  });

  step("4. Chat usage chip (desktop)");
  // Also read-only. It opens a chat tab to reach the chip and closes it again in teardown.
  await scenario("chat: the usage panel shows usage and NO account management", async () => {
    // A fresh tab, never a reused one: `openTab` puts it in the focused panel and activates
    // it, whereas an existing chat tab can sit in a panel that is not currently showing —
    // its chip is then in the DOM but display:none, which says nothing about the chip.
    harnessChatTabId = await cdp.evaluate(`(async () => {
      const tabs = (await import('/stores/tab-store.ts')).useTabStore;
      const projects = (await import('/stores/project-store.ts')).useProjectStore;
      // A chat tab with no projectId renders the select-a-project placeholder instead of a
      // chat, so the usage chip never exists. The app always binds chat tabs to a project.
      const name = projects.getState().activeProject?.name ?? null;
      if (!name) return null;
      return tabs.getState().openTab({
        type: "chat", title: "Usage check", projectId: name, closable: true,
        metadata: { projectName: name },
      });
    })()`);
    if (!harnessChatTabId) throw new Error("no active project, so no chat tab could be opened");

    // Wait for it to be VISIBLE, not merely present: activating the tab does not lay the
    // chat history bar out in the same frame, and asserting on presence alone made this
    // scenario pass or fail on timing.
    try {
      await waitFor(cdp, `Boolean(${visibleOne('button[title="Usage limits"]')})`, "usage chip laid out", 15_000);
    } catch {
      // Name the ancestor that is hiding it — "not visible" alone is not a diagnosis.
      const why = await cdp.evaluate(`(() => {
        const el = document.querySelector('button[title="Usage limits"]');
        if (!el) return "the chip is not in the DOM at all";
        let node = el, chain = [];
        while (node && node !== document.body) {
          const cs = getComputedStyle(node);
          if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
            chain.push(\`\${node.tagName.toLowerCase()}\${node.className ? "." + String(node.className).split(/\\s+/).slice(0, 3).join(".") : ""} {display:\${cs.display};visibility:\${cs.visibility};opacity:\${cs.opacity}}\`);
          }
          node = node.parentElement;
        }
        return chain.length ? chain.join(" <- ") : "no hidden ancestor — zero-size layout";
      })()`);
      // Which panel the tab landed in, and which tab that panel is showing: a hidden slot
      // almost always means the tab is mounted but not the active one.
      const layout = await cdp.evaluate(`(async () => {
        const panels = (await import('/stores/panel-store.ts')).usePanelStore.getState();
        return JSON.stringify({
          mine: ${JSON.stringify(harnessChatTabId)},
          focused: panels.focusedPanelId,
          grid: panels.grid,
          panels: Object.fromEntries(Object.entries(panels.panels).map(([id, p]) => [id, { active: p.activeTabId, tabs: p.tabs.map((t) => t.id) }])),
        });
      })()`).catch((e) => `probe failed: ${e.message}`);
      throw new Error(`the usage chip never laid out: ${why} | layout=${layout}`);
    }

    chatChipText = await cdp.evaluate(`${visibleOne('button[title="Usage limits"]')}.textContent.trim()`);
    if (!/5h:/.test(chatChipText)) throw new Error(`the chip is not showing usage: ${JSON.stringify(chatChipText)}`);

    await clickVisible(cdp, visibleOne('button[title="Usage limits"]'), "usage chip");
    await waitFor(cdp, `Boolean(${visibleOne('button[title="Add, remove or rotate accounts"]')})`, "usage panel");

    // The point of the split: management must not exist here any more, or the two copies can
    // drift again. Scoped to the panel, since the Settings window may also be open.
    const stray = await cdp.evaluate(`(() => {
      const link = ${visibleOne('button[title="Add, remove or rotate accounts"]')};
      const panel = link?.closest('div.relative');
      if (!panel) return "no panel";
      const labels = ["Add", "Export", "Import", "Add account"];
      const found = [...panel.querySelectorAll('button')]
        .map((b) => b.textContent?.trim())
        .filter((t) => labels.includes(t));
      return found.length ? found.join(", ") : "";
    })()`);
    if (stray) throw new Error(`the chat usage panel still offers account management: ${stray}`);
  });
  await cdp.screenshot(join(SHOTS, "settings-07-chat-usage-panel.png"));

  await scenario("chat: \"Manage accounts\" opens Settings on the Accounts pane", async () => {
    await clickVisible(cdp, visibleOne('button[title="Add, remove or rotate accounts"]'), '"Manage accounts"');
    await waitFor(cdp, `${q("settings-window")}.dataset.category === "accounts"`, "settings on accounts");
    if (!(await cdp.evaluate(IN_WINDOW))) throw new Error("the link produced a tab, not a window, on desktop");
  });

  await scenario("chat and Settings report the same usage for the same account", async () => {
    // Both render the same card component off the same hook; identical text is the evidence
    // that the chat side is a read-only view of the same data, not a second implementation.
    const cmp = await cdp.evaluate(`(() => {
      const pct = (card) => [...card.querySelectorAll('span')]
        .map((s) => s.textContent?.trim())
        .filter((t) => /^\\d+%$/.test(t ?? "")).join(",");
      const settings = {}, chat = {};
      for (const card of document.querySelectorAll('[data-testid="account-card"]')) {
        // Hidden tabs keep their cards mounted; only what the user can see is comparable.
        if (!${VISIBLE}(card)) continue;
        const bucket = card.closest('[data-testid="settings-window"]') ? settings : chat;
        bucket[card.dataset.accountId] = pct(card);
      }
      const shared = Object.keys(settings).filter((id) => id in chat);
      return {
        settingsCount: Object.keys(settings).length,
        chatCount: Object.keys(chat).length,
        shared: shared.length,
        mismatched: shared.filter((id) => settings[id] !== chat[id]).map((id) => ({ id, settings: settings[id], chat: chat[id] })),
      };
    })()`);
    // Requires cards on BOTH sides — otherwise this scenario could only ever pass.
    if (cmp.chatCount === 0) throw new Error("the chat panel rendered no account cards, so nothing was compared");
    if (cmp.settingsCount === 0) throw new Error("the Settings pane rendered no account cards, so nothing was compared");
    if (cmp.shared === 0) throw new Error(`no account appears in both (settings=${cmp.settingsCount}, chat=${cmp.chatCount})`);
    if (cmp.mismatched.length) {
      throw new Error(`same account shows different usage in chat vs Settings: ${JSON.stringify(cmp.mismatched)}`);
    }
    log(`  compared ${cmp.shared} account(s) across both views`);
  });

  step("5. URL route (desktop, hard load)");
  await scenario("desktop: a settings URL opens the window, not a tab", async () => {
    // The route is /project/{name}/{tabType} (see parseUrlState), so the project name has to
    // be real. The app writes it into the location itself once a project is active, which is
    // a more honest source than guessing or reading the database.
    const project = await cdp.evaluate(`(location.pathname.match(/^\\/project\\/([^/]+)/) || [])[1] ?? null`);
    if (!project) throw new Error("no active project in the URL — cannot build a /project/{name}/settings route");
    // Hard load, so the open races the window layer's restore — the case where restoreAll
    // replaces the window map and would silently discard an eagerly-opened window.
    await cdp.navigate(`${WEB}/project/${project}/settings`);
    await waitFor(cdp, q("settings-window"), "settings body from URL");
    if (!(await cdp.evaluate(IN_WINDOW))) {
      throw new Error("a settings URL produced a tab on desktop, or the window was wiped by restoreAll");
    }
  });
  await cdp.screenshot(join(SHOTS, "settings-03-desktop-url.png"));

  step("6. Mobile (390x844)");
  await cdp.setViewport(390, 844, true);
  await bootstrap(cdp);

  await scenario("mobile: the rail's Settings button is not reachable", async () => {
    // Guards the trap this harness fell into once: the desktop rail still exists in the DOM
    // on a phone, so a scenario clicking it would pass while proving nothing.
    const reachable = await cdp.evaluate(
      `${VISIBLE}(document.querySelector('button[aria-label="Settings"]'))`,
    );
    if (reachable) throw new Error("the desktop nav rail is visible at 390px — it should be hidden");
  });

  await scenario("mobile: Settings opens a TAB, and no floating window", async () => {
    // Settings is a singleton tab type, so `openTab` reuses an existing one — including a
    // leftover carrying a category, which would open straight on a pane and never show the
    // index this scenario is about. Start from none.
    await closeSettingsTabs(cdp);
    await waitFor(cdp, `!${q("settings-window")}`, "no settings tab before opening one");
    await clickMobileDrawerSettings(cdp);
    await waitFor(cdp, q("settings-window"), "settings body (mobile tab)", 15_000);
    if (await cdp.evaluate(IN_WINDOW)) {
      throw new Error("Settings rendered as a floating window on mobile — should be a tab");
    }
    // Wait for the index to actually paint before the screenshot, or the shot catches Suspense.
    await waitFor(cdp, `${VISIBLE}(${q("settings-index")})`, "category index visible");
  });
  await cdp.screenshot(join(SHOTS, "settings-04-mobile-index.png"));

  await scenario("mobile: \"Manage accounts\" opens the settings TAB already on Accounts", async () => {
    // The deep link has to work on the tab route too, or a phone user lands on the index and
    // has to find Accounts by hand. Category travels as tab metadata.
    await closeSettingsTabs(cdp);
    await waitFor(cdp, `!${q("settings-window")}`, "settings closed before the mobile deep link");
    await waitFor(cdp, `Boolean(${visibleOne('button[title="Usage limits"]')})`, "usage chip on mobile", 15_000);
    await clickVisible(cdp, visibleOne('button[title="Usage limits"]'), "usage chip");
    await clickVisible(cdp, visibleOne('button[title="Add, remove or rotate accounts"]'), '"Manage accounts"');
    await waitFor(cdp, q("settings-window"), "settings body on mobile");
    if (await cdp.evaluate(IN_WINDOW)) throw new Error("a floating window opened on mobile");
    const category = await cdp.evaluate(`${q("settings-window")}.dataset.category`);
    if (category !== "accounts") throw new Error(`expected the Accounts pane, got ${JSON.stringify(category)}`);
    // Landing on the pane, not the index, is the whole point of carrying the category.
    if (await cdp.evaluate(`Boolean(${q("settings-index")})`)) {
      throw new Error("the deep link left the category index covering the pane");
    }
  });
  await cdp.screenshot(join(SHOTS, "settings-08-mobile-accounts-deeplink.png"));

  await scenario("mobile: index -> pane -> back", async () => {
    // Establish its own starting point instead of inheriting one: the deep-link scenario
    // above deliberately lands on a pane, so a drill-down test that assumed "the index is
    // showing" would only pass depending on the order it happened to run in.
    await closeSettingsTabs(cdp);
    await waitFor(cdp, `!${q("settings-window")}`, "settings closed");
    await clickMobileDrawerSettings(cdp);
    await waitFor(cdp, q("settings-index"), "category index");
    await clickTestId(cdp, "settings-index-appearance");
    await waitFor(cdp, `!${q("settings-index")}`, "index dismissed");
    const title = await cdp.evaluate(`${q("settings-pane-title")}?.textContent?.trim()`);
    if (title !== "Appearance") throw new Error(`expected the Appearance pane, got ${JSON.stringify(title)}`);
    await waitFor(cdp, paneHasText("Tab Style"), "Appearance pane content on mobile");
    // Shot while the pane is on screen — after Back it would be the index again, which the
    // previous screenshot already covers.
    await cdp.screenshot(join(SHOTS, "settings-05-mobile-pane.png"));
    await clickVisible(
      cdp,
      `document.querySelector('button[aria-label="Back to settings list"]')`,
      'Back button',
    );
    await waitFor(cdp, q("settings-index"), "index restored by Back");
  });

  step("7. Teardown of workspace state");
  // The mobile scenario opened a real tab, and the layout is server-persisted — leave the
  // user's workspace the way it was found.
  await waitForWorkspace(cdp);
  await closeSettingsTabs(cdp);
  if (harnessChatTabId) {
    // Only the tab this run created — the user's own chat tabs are left alone.
    await cdp.evaluate(`(async () => {
      const tabs = (await import('/stores/tab-store.ts')).useTabStore;
      tabs.getState().closeTab(${JSON.stringify(harnessChatTabId)});
      return true;
    })()`).catch(() => {});
    log("  closed the chat tab this harness opened");
  }
  await Bun.sleep(500); // let the layout write land before Chrome goes away

  step("Results");
  for (const r of results) log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}${r.detail ? " — " + r.detail : ""}`);
  const failed = results.filter((r) => !r.pass);
  log(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  log("\nFATAL: " + (e?.message || String(e)));
  process.exitCode = 1;
} finally {
  await cleanup();
}
