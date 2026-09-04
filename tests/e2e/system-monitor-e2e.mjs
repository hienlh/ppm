// System Monitor / Task Manager window — real browser end-to-end harness (headless
// Chrome via raw CDP, same conventions as tests/e2e/group-chat-e2e.mjs and
// tests/e2e/os-explorer-window.mjs: no puppeteer, auth token read read-only from
// ppm.dev.db and never printed, PID-scoped server teardown).
//
// What it does:
//   1. Starts `bun dev:server` (8081) + `bun dev:web` (5173) if not already up (skip
//      with PPM_E2E_NO_SERVERS=1 to reuse a stack you started yourself).
//   2. Launches headless Chrome, injects the dev auth token into localStorage.
//   3. Desktop (1280x800): status bar -> floating window -> Overview charts ->
//      Processes tab -> expand a group -> search filter -> PPM-only filter ->
//      sort by Disk column -> sort by GPU column -> flat mode -> open the
//      kill-confirm dialog on a harmless row and CANCEL (never actually kills a
//      process).
//   4. Mobile (390x844): status bar -> asserts a TAB opened, not a window.
//   5. Tablet (768x1024, touch emulation -> hover:none): asserts the process
//      row's kill button is visible without hovering (no hover-only controls).
//   6. Screenshots at each major step, written under PPM_E2E_SHOTS
//      (default: plans/reports/screenshots/) — the Overview/Processes shots wait for
//      >=2 snapshot ticks first, since CPU%/disk/net are always 0.0%/"n/a" on the very
//      first frame by design (a rate needs two samples).
//   7. Stops ONLY the servers this script itself started, by exact PID.
//
// Run:
//   bun tests/e2e/system-monitor-e2e.mjs
//   PPM_E2E_NO_SERVERS=1 bun tests/e2e/system-monitor-e2e.mjs   # reuse running dev:server/dev:web
//   PPM_E2E_KEEP=1 bun tests/e2e/system-monitor-e2e.mjs         # leave servers running after
//   CHROME_PATH=... PPM_E2E_SHOTS=... bun tests/e2e/system-monitor-e2e.mjs
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
const API = "http://localhost:8081";
const WEB = "http://localhost:5173";
const CDP_PORT = 9231;
const DEV_DB = join(homedir(), ".ppm", "ppm.dev.db");
const SHOTS = process.env.PPM_E2E_SHOTS || join(REPO, "plans", "reports", "screenshots");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const KEEP = !!process.env.PPM_E2E_KEEP;
const NO_SERVERS = !!process.env.PPM_E2E_NO_SERVERS;
const TOKEN_KEY = "ppm-auth-token"; // src/web/lib/api-client.ts

// Never log TOKEN's value anywhere below.
const TOKEN = (() => {
  const db = new Database(DEV_DB, { readonly: true });
  try {
    const row = db.query("SELECT value FROM config WHERE key='auth'").get();
    if (!row) return null;
    return JSON.parse(row.value)?.token ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
})();

const started = { server: null, web: null, chrome: null, chromeProfile: null };
const results = []; // { name, pass, detail }
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
// Server lifecycle (mirrors tests/e2e/group-chat-e2e.mjs)
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

function spawnBg(cmd, args, name) {
  const child = spawn(cmd, args, {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

async function ensureServers() {
  if (NO_SERVERS) {
    log("  PPM_E2E_NO_SERVERS set — assuming servers already running");
    await waitUp(`${API}/api/health`, "backend");
    await waitUp(WEB, "web");
    return;
  }
  if (await isUp(`${API}/api/health`)) {
    log("  backend already up — reusing");
  } else {
    log("  starting backend: bun dev:server");
    started.server = spawnBg("bun", ["run", "dev:server"], "server");
    await waitUp(`${API}/api/health`, "backend");
  }
  if (await isUp(WEB)) {
    log("  web already up — reusing");
  } else {
    log("  starting web: bun dev:web");
    started.web = spawnBg("bun", ["run", "dev:web"], "web");
    await waitUp(WEB, "web");
  }
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

async function killPort(port) {
  if (process.platform !== "win32") return;
  try {
    const proc = Bun.spawnSync([
      "powershell", "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
    ]);
    const pids = proc.stdout.toString().split(/\s+/).map((s) => s.trim()).filter(Boolean);
    for (const pid of pids) {
      if (!/^\d+$/.test(pid)) continue;
      Bun.spawnSync(["taskkill", "/pid", pid, "/T", "/F"]);
      log(`  killed listener on :${port} (pid ${pid})`);
    }
  } catch (e) {
    log(`  killPort ${port} failed: ${e.message}`);
  }
}

async function cleanup() {
  step("Cleanup");
  killPid(started.chrome, "chrome");
  if (!KEEP) {
    killPid(started.web, "web");
    killPid(started.server, "server");
    if (started.server) await killPort(8081);
    if (started.web) await killPort(5173);
  } else {
    log("  PPM_E2E_KEEP set — leaving servers running");
  }
  if (started.chromeProfile) {
    await rm(started.chromeProfile, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Raw CDP driver (mirrors tests/e2e/group-chat-e2e.mjs's Cdp class)
// ---------------------------------------------------------------------------
async function launchChrome() {
  const profile = join(tmpdir(), `ppm-e2e-sysmon-${Date.now()}`);
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
      const targets = await r.json();
      const page = targets.find((t) => t.type === "page");
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

  /** Neither `setDeviceMetricsOverride`'s `mobile` flag nor
   *  `Emulation.setEmulatedMedia({features:[...]})` actually flip the
   *  `(hover)`/`(pointer)` media features in this headless Chrome build
   *  (verified empirically — both report success but matchMedia never
   *  changes). The legacy `Emulation.setTouchEmulationEnabled` does, but
   *  only if called BEFORE `setDeviceMetricsOverride` and before navigation
   *  — call this first, then `setViewport`, then `navigate`. */
  async setTouchMedia(touch) {
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
  }

  async screenshot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(r.data, "base64"));
    log(`  screenshot -> ${path}`);
  }
}

async function waitFor(cdp, expr, label, timeoutMs = 15_000) {
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

/** CPU%/disk/net are all 0.0%/"n/a" on the very first SSE frame by design — a rate
 *  needs two samples. `[data-testid="sysmon-connection"]` carries `data-tick-count`
 *  (the number of `snapshot` frames the shared hook has received on the current
 *  connection) precisely so a caller can wait past that frame before a screenshot is
 *  meant to show real values. Soft wait, capped at 6s: a screenshot is cosmetic, not
 *  worth failing the whole run over if the stream is unusually slow to tick twice. */
async function waitForTicks(cdp, min, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ticks = Number(await attr(cdp, "sysmon-connection", "data-tick-count")) || 0;
    if (ticks >= min) return true;
    await Bun.sleep(300);
  }
  log(`  WARN: fewer than ${min} snapshot ticks after ${timeoutMs}ms — screenshot may show first-tick placeholders`);
  return false;
}

async function clickTestId(cdp, testId, { nth = 0 } = {}) {
  const ok = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('[data-testid=${JSON.stringify(testId)}]')];
    const el = els[${nth}];
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`click target not found: [data-testid="${testId}"] (nth=${nth})`);
}

/** The sort button carries the test id; `aria-sort` lives on its `columnheader`
 *  wrapper. Proves the click actually toggled the sort instead of relying on a
 *  row order that might already hold by coincidence. */
async function expectAriaSort(cdp, testId, expected) {
  const actual = await cdp.evaluate(`document.querySelector('[data-testid=${JSON.stringify(testId)}]')?.closest('[role="columnheader"]')?.getAttribute("aria-sort")`);
  if (actual !== expected) throw new Error(`expected aria-sort=${expected} on ${testId}, got ${actual}`);
}

async function attr(cdp, testId, name) {
  return cdp.evaluate(`document.querySelector('[data-testid=${JSON.stringify(testId)}]')?.getAttribute(${JSON.stringify(name)})`);
}

async function typeIntoReactInput(cdp, testId, value) {
  await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS, { recursive: true });

  step("1. Ensure servers");
  await ensureServers();

  if (!TOKEN) {
    log("  WARN: no auth token found in ppm.dev.db (config key 'auth') — assuming auth is disabled");
  }

  step("2. Launch Chrome + connect CDP");
  const wsUrl = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.setViewport(1280, 800, false);

  step("3. Load app + inject auth token");
  await cdp.navigate(WEB);
  if (TOKEN) {
    await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(TOKEN)})`);
    await cdp.navigate(WEB);
  }
  await waitFor(cdp, `document.querySelector('[data-testid="status-bar-resources"]')`, "status bar mounted", 30_000);
  await Bun.sleep(500);

  await scenario("desktop: status bar click opens the System Monitor floating window", async () => {
    await clickTestId(cdp, "status-bar-resources");
    await waitFor(cdp, `document.querySelector('[data-testid="system-monitor-window"]')`, "system monitor window", 10_000);
    const isFloatingWindow = await cdp.evaluate(
      `!!document.querySelector('[role="group"][aria-roledescription="window"]')`,
    );
    if (!isFloatingWindow) throw new Error("System Monitor did not render inside a floating window on desktop");
  });

  await scenario("desktop: Overview tab is the default and renders", async () => {
    const selected = await attr(cdp, "sysmon-tab-overview", "aria-selected");
    if (selected !== "true") throw new Error(`Overview tab aria-selected=${selected}`);
    await waitFor(cdp, `document.querySelector('[data-testid="sysmon-overview"]')`, "overview panel", 10_000);
  });
  // Wait past the always-0.0%/"measuring…" first frame so the screenshot shows a real
  // CPU reading and real disk/net rates, not the two-sample warm-up placeholder.
  await waitForTicks(cdp, 2);
  await cdp.screenshot(join(SHOTS, "01-overview.png"));

  let totalBeforeFilter = 0;
  await scenario("desktop: Processes tab shows the whole-machine process count", async () => {
    await clickTestId(cdp, "sysmon-tab-processes");
    await waitFor(cdp, `document.querySelector('[data-testid="sysmon-processes"]')`, "processes panel", 10_000);
    // The footer renders with data-process-count="0" before the first full-tier
    // SSE snapshot arrives — "0" is a non-empty string so a bare Boolean(...)
    // check resolves immediately on that placeholder. Wait for a positive count.
    await waitFor(cdp, `Number(document.querySelector('[data-testid="sysmon-total"]')?.dataset.processCount) > 0`, "footer total > 0", 15_000);
    totalBeforeFilter = Number(await attr(cdp, "sysmon-total", "data-process-count")) || 0;
    log(`  total process count reported: ${totalBeforeFilter}`);
    if (totalBeforeFilter < 50) {
      throw new Error(`expected >= 50 processes on a real Windows host, got ${totalBeforeFilter}`);
    }
  });
  await waitForTicks(cdp, 2);
  await cdp.screenshot(join(SHOTS, "02-processes.png"));

  await scenario("desktop: expanding a group reveals its child process rows", async () => {
    const before = await cdp.evaluate(`document.querySelectorAll('[data-testid="sysmon-process-row"]').length`);
    // Rows re-sort by CPU% on every ~2s SSE tick. Re-querying "the nth=0
    // group-expand button" after a sleep can silently land on a *different*
    // group than the one just clicked once a tick reorders the list — pin the
    // clicked group's stable `data-group-key` and re-locate by that, not by
    // position, for the follow-up assertion.
    const groupKey = await cdp.evaluate(`(() => {
      const btn = document.querySelector('[data-testid="sysmon-group-expand"]');
      const row = btn?.closest('[data-testid="sysmon-group-row"]');
      const key = row?.dataset.groupKey;
      if (!btn || !key) return null;
      btn.click();
      return key;
    })()`);
    if (!groupKey) throw new Error("click target not found: [data-testid=\"sysmon-group-expand\"] (nth=0)");
    await Bun.sleep(400);
    const expandedAttr = await cdp.evaluate(
      `document.querySelector('[data-testid="sysmon-group-row"][data-group-key=${JSON.stringify(groupKey)}] [data-testid="sysmon-group-expand"]')?.getAttribute("aria-expanded")`,
    );
    if (expandedAttr !== "true") throw new Error(`expected aria-expanded=true, got ${expandedAttr}`);
    const after = await cdp.evaluate(`document.querySelectorAll('[data-testid="sysmon-process-row"]').length`);
    if (after <= before) throw new Error(`expected child rows after expand: before=${before} after=${after}`);
  });

  await scenario("desktop: search narrows the visible process count", async () => {
    await typeIntoReactInput(cdp, "sysmon-process-search", "svchost");
    await Bun.sleep(400); // debounce (150ms) + render
    const filtered = Number(await attr(cdp, "sysmon-total", "data-process-count")) || 0;
    log(`  filtered count for "svchost": ${filtered}`);
    if (filtered === 0) throw new Error('expected at least one match for "svchost" on a Windows host');
    if (filtered >= totalBeforeFilter) throw new Error(`expected search to narrow the count, got ${filtered} >= ${totalBeforeFilter}`);
    await typeIntoReactInput(cdp, "sysmon-process-search", "");
    await Bun.sleep(400);
  });

  await scenario("desktop: PPM-only filter narrows to PPM-owned rows", async () => {
    await clickTestId(cdp, "sysmon-filter-ppm");
    await Bun.sleep(300);
    const pressed = await attr(cdp, "sysmon-filter-ppm", "aria-pressed");
    if (pressed !== "true") throw new Error(`expected aria-pressed=true, got ${pressed}`);
    const ppmOnlyCount = Number(await attr(cdp, "sysmon-total", "data-process-count")) || 0;
    if (ppmOnlyCount === 0 || ppmOnlyCount >= totalBeforeFilter) {
      throw new Error(`expected PPM-only count between 1 and ${totalBeforeFilter}, got ${ppmOnlyCount}`);
    }
    await clickTestId(cdp, "sysmon-filter-ppm"); // toggle back off
    await Bun.sleep(300);
  });

  // Disk/GPU are per-process optional columns — only rendered when the
  // host actually reported them measurable (`processColumns`, expected
  // `{disk:true, gpu:true, net:false}` on this Win11 dev box). A group's rolled-up
  // value is the SUM of its measured members, so it can never be smaller than any
  // single member's value — the "first >= second" invariant below holds whether
  // the top two DOM rows are two groups, or a group followed by one of its own
  // (already-expanded, from the scenario above) children.
  async function firstTwoByAttr(attr) {
    return cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="sysmon-group-row"], [data-testid="sysmon-process-row"]')];
      return rows.slice(0, 2).map((r) => {
        const v = r.getAttribute(${JSON.stringify(attr)});
        return v === null ? null : Number(v);
      });
    })()`);
  }

  await scenario("desktop: sort by Disk column orders rows by read+write throughput", async () => {
    const hasDiskColumn = await cdp.evaluate(`!!document.querySelector('[data-testid="sysmon-col-disk"]')`);
    if (!hasDiskColumn) {
      log("  SKIP: this host reports processColumns.disk=false — no Disk column to sort");
      return;
    }
    await clickTestId(cdp, "sysmon-col-disk"); // 3-state toggle starts at desc
    await Bun.sleep(400);
    await expectAriaSort(cdp, "sysmon-col-disk", "descending");
    const [first, second] = await firstTwoByAttr("data-disk-bps");
    if (first === null) throw new Error("top row after sorting by Disk has no measurable disk value");
    if (second !== null && first < second) throw new Error(`expected disk-desc order: first=${first} < second=${second}`);
  });
  await cdp.screenshot(join(SHOTS, "06-processes-sorted-by-disk.png"));

  await scenario("desktop: sort by GPU column orders rows by utilization", async () => {
    const hasGpuColumn = await cdp.evaluate(`!!document.querySelector('[data-testid="sysmon-col-gpu"]')`);
    if (!hasGpuColumn) {
      log("  SKIP: this host reports processColumns.gpu=false — no GPU column to sort");
      return;
    }
    await clickTestId(cdp, "sysmon-col-gpu");
    await Bun.sleep(400);
    await expectAriaSort(cdp, "sysmon-col-gpu", "descending");
    const [first, second] = await firstTwoByAttr("data-gpu-pct");
    if (first === null) throw new Error("top row after sorting by GPU has no measurable gpu value");
    if (second !== null && first < second) throw new Error(`expected gpu-desc order: first=${first} < second=${second}`);
  });
  await cdp.screenshot(join(SHOTS, "07-processes-sorted-by-gpu.png"));

  await scenario("desktop: kill dialog opens on a harmless row and CANCEL never kills it", async () => {
    await clickTestId(cdp, "sysmon-toggle-flat");
    await Bun.sleep(400);
    // Pick the first non-protected row so the confirm flow is exercised without
    // ever risking a real kill — this scenario only clicks Cancel.
    const clicked = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="sysmon-process-row"]')];
      const row = rows.find((r) => r.dataset.protected !== "true");
      if (!row) return false;
      const btn = row.querySelector('[data-testid="sysmon-kill-btn"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!clicked) throw new Error("no harmless (non-protected) process row with a kill button found");
    await waitFor(cdp, `document.querySelector('[data-testid="sysmon-kill-confirm"]')`, "kill confirm dialog", 5_000);
    await cdp.screenshot(join(SHOTS, "03-kill-confirm.png"));
    await clickTestId(cdp, "sysmon-kill-confirm-cancel");
    await Bun.sleep(300);
    const stillOpen = await cdp.evaluate(`!!document.querySelector('[data-testid="sysmon-kill-confirm"]')`);
    if (stillOpen) throw new Error("kill confirm dialog did not close after Cancel");
  });

  await scenario("desktop: reload keeps System Monitor in a floating window", async () => {
    await cdp.navigate(WEB);
    await waitFor(cdp, `document.querySelector('[data-testid="status-bar-resources"]')`, "status bar after reload", 20_000);
    await waitFor(cdp, `document.querySelector('[data-testid="system-monitor-window"]')`, "window persisted", 10_000);
  });

  step("4. Mobile viewport (390x844)");
  await cdp.setViewport(390, 844, true);
  await cdp.navigate(WEB);
  if (TOKEN) await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(TOKEN)})`);
  await waitFor(cdp, `document.querySelector('[data-testid="status-bar-resources"]')`, "mobile status bar", 20_000);
  await Bun.sleep(500);

  await scenario("mobile: status bar click opens a TAB, not a floating window", async () => {
    await clickTestId(cdp, "status-bar-resources");
    await waitFor(cdp, `document.querySelector('[data-testid="system-monitor-window"]')`, "system monitor body (mobile tab)", 10_000);
    const isFloatingWindow = await cdp.evaluate(
      `!!document.querySelector('[role="group"][aria-roledescription="window"]')`,
    );
    if (isFloatingWindow) throw new Error("System Monitor rendered as a floating window on mobile — should be a tab");
  });
  await cdp.screenshot(join(SHOTS, "04-mobile-tab.png"));

  step("5. Tablet viewport (768x1024, touch — no hover)");
  // 768px is Tailwind's md breakpoint: useIsMobile() (width < 768) is false here,
  // so this is still "desktop" window mode, but setTouchMedia(true) forces
  // `(hover: none)`/`(pointer: coarse)`, same as a real iPad. The kill button
  // uses `can-hover:opacity-0 can-hover:group-hover/proc:opacity-100`
  // (process-row.tsx) so it must render fully visible here with no hover simulated.
  // Order matters: setTouchEmulationEnabled only sticks if it runs before the
  // device-metrics override and before the next navigation (verified empirically).
  await cdp.setTouchMedia(true);
  await cdp.setViewport(768, 1024, true);
  await cdp.navigate(WEB);
  // `useOpenSystemMonitor` -> `windowStore.open("system-monitor")` always spawns a
  // new window, it never checks for one already open of that kind (unlike, say,
  // team-member windows, which are legitimately keyed by a different payload per
  // teammate — system-monitor has no such key, there is only one machine). The
  // desktop scenarios above already left one persisted in localStorage; without
  // clearing it here, clicking the status bar below stacks a *second* window on
  // top and this scenario would be asserting against the wrong DOM instance. See
  // the tester report for the full writeup of that product bug.
  await cdp.evaluate(`localStorage.removeItem("ppm-windows")`);
  if (TOKEN) await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(TOKEN)})`);
  await cdp.navigate(WEB);
  await waitFor(cdp, `document.querySelector('[data-testid="status-bar-resources"]')`, "tablet status bar", 20_000);
  await Bun.sleep(500);

  // The mobile scenario's "system-monitor" tab is a *tab*, not a window, so
  // clearing "ppm-windows" above does not close it, and tabs persist
  // server-side via ppm.dev.db rather than localStorage (no client-side key
  // to clear). Both the tab and the floating window render the identical
  // `SystemMonitorBody` with identical data-testids, so leaving the tab open
  // makes every selector below ambiguous. Close it the same way a user would
  // — middle-click, which `draggable-tab.tsx`'s onAuxClick wires to onClose
  // regardless of hover state — before opening the window under test.
  await cdp.evaluate(`(() => {
    const span = [...document.querySelectorAll('span[title="System Monitor"]')].find((el) => !el.closest('[role="group"][aria-roledescription="window"]'));
    window.__leftoverTab = span?.closest("button") ?? null;
  })()`);
  const leftoverTabBox = await cdp.evaluate(`(() => {
    const el = window.__leftoverTab;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (leftoverTabBox) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: leftoverTabBox.x, y: leftoverTabBox.y, button: "middle", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: leftoverTabBox.x, y: leftoverTabBox.y, button: "middle", clickCount: 1 });
    await Bun.sleep(300);
    log("  closed a leftover \"System Monitor\" tab from an earlier mobile-viewport run");
  }

  await scenario("tablet (768px, no hover): kill button is visible without hovering", async () => {
    await clickTestId(cdp, "status-bar-resources");
    await waitFor(cdp, `document.querySelector('[data-testid="system-monitor-window"]')`, "system monitor window", 10_000);
    // The window content registry lazy-loads `system-monitor-window-content`; the
    // outer window chrome mounts (and gets its role/testid) before that resolves,
    // showing "Loading..." — wait for the real tab strip, not just the shell.
    await waitFor(cdp, `document.querySelector('[data-testid="sysmon-tab-processes"]')`, "processes tab (lazy content loaded)", 10_000);
    const hoverCapable = await cdp.evaluate(`window.matchMedia("(hover: hover)").matches`);
    if (hoverCapable) throw new Error("expected (hover: hover) to be false under touch emulation — the visibility assertion below would be meaningless otherwise");
    await clickTestId(cdp, "sysmon-tab-processes");
    await waitFor(cdp, `Number(document.querySelector('[data-testid="sysmon-total"]')?.dataset.processCount) > 0`, "footer total > 0", 15_000);
    // Default view is Grouped: top-level rows are `sysmon-group-row`, which has
    // no individual kill button. Switch to flat (same as the desktop kill-dialog
    // scenario) so real `sysmon-process-row` leaf rows with kill buttons render.
    await clickTestId(cdp, "sysmon-toggle-flat");
    await Bun.sleep(400);
    // No mouseover/hover dispatched anywhere above — if the button is visible now,
    // it is visible without hover, exactly as design-guidelines.md requires.
    // A *protected* row's kill button is intentionally dimmed (opacity-40,
    // cursor-not-allowed) — that is a disabled affordance, not the can-hover
    // invisibility this check targets, so pick a harmless row like the desktop
    // kill-dialog scenario does.
    const visible = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="sysmon-process-row"]')];
      const row = rows.find((r) => r.dataset.protected !== "true");
      const btn = row?.querySelector('[data-testid="sysmon-kill-btn"]');
      if (!btn) return false;
      return Number(getComputedStyle(btn).opacity) > 0.9;
    })()`);
    if (!visible) throw new Error("kill button is not visible without hover at 768px (touch)");
  });
  await cdp.screenshot(join(SHOTS, "05-tablet-768-kill-visible.png"));

  step("DONE");
}

// ---------------------------------------------------------------------------
let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = 1;
  console.error("\n[HARNESS ERROR]", e?.stack || e?.message || e);
} finally {
  await cleanup();
}

console.log("\n=== SUMMARY ===");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? " — " + r.detail : ""}`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} scenarios passed`);
if (results.some((r) => !r.pass)) exitCode = 1;
process.exit(exitCode);
