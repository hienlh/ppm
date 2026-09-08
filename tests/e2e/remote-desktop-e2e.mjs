// Remote Desktop window — real browser end-to-end harness (headless Chrome via raw CDP,
// same conventions as tests/e2e/system-monitor-e2e.mjs: no puppeteer, auth token read
// read-only from ppm.dev.db and never printed, PID-scoped server teardown).
//
// Runs its OWN dev stack on alternate ports (8082/5174) so it never touches a dev:server
// already running on 8081/5173 — the remote-desktop feature is env-gated
// (REMOTE_DESKTOP_ENABLED=1) and the frontend's dev-mode WS bypass otherwise hardcodes
// port 8081 (see src/web/components/remote-desktop/remote-desktop-ws-url.ts), so
// VITE_DEV_API_PORT is threaded through to keep the browser's WS connecting to 8082.
//
// What it does:
//   1. Starts the server (8082, REMOTE_DESKTOP_ENABLED=1) + vite (5174, PPM_DEV_API +
//      VITE_DEV_API_PORT pointed at 8082) if not already up (skip with
//      PPM_E2E_NO_SERVERS=1 to reuse a stack you started yourself).
//   2. Launches headless Chrome, injects the dev auth token into localStorage.
//   3. Waits for GET /api/remote-desktop/capabilities to report videoAvailable, opens the
//      Remote Desktop window from the status bar, waits for the WS to report
//      data-conn-state="streaming", then polls canvas pixels via CDP Runtime.evaluate
//      until a real (non-black, non-flat) frame is decoded.
//   4. Best-effort 1b: dispatches a synthetic pointer click on the canvas (real UI path:
//      pointerdown -> use-remote-input-capture -> WS -> SendInput) and — since this
//      harness runs ON the same host being captured — reads the actual OS cursor
//      position via a PowerShell one-liner before/after to confirm the round trip moved
//      the real host cursor, not just something inside the browser.
//   5. Screenshots to plans/reports/screenshots/remote-desktop-*.png.
//   6. Stops ONLY the servers this script itself started, by exact PID.
//
// Run:
//   PPM_E2E_NO_SERVERS=1 bun tests/e2e/remote-desktop-e2e.mjs   # reuse a stack you started
//   bun tests/e2e/remote-desktop-e2e.mjs                        # starts its own 8082/5174 stack
//   PPM_E2E_KEEP=1 bun tests/e2e/remote-desktop-e2e.mjs         # leave servers running after
//
// Exits non-zero if any scenario fails.

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Config — deliberately NOT 8081/5173 (that stack belongs to someone else).
// ---------------------------------------------------------------------------
const REPO = process.cwd();
const API_PORT = 8082;
const WEB_PORT = 5174;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const CDP_PORT = 9232;
const DEV_DB = join(homedir(), ".ppm", "ppm.dev.db");
const SHOTS = process.env.PPM_E2E_SHOTS || join(REPO, "plans", "reports", "screenshots");
const CHROME = process.env.CHROME_PATH || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
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
// Server lifecycle (mirrors tests/e2e/system-monitor-e2e.mjs)
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

function spawnBg(cmd, args, name, env = {}) {
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
  if (NO_SERVERS) {
    log("  PPM_E2E_NO_SERVERS set — assuming servers already running on 8082/5174");
    await waitUp(`${API}/api/health`, "backend");
    await waitUp(WEB, "web");
    return;
  }
  if (await isUp(`${API}/api/health`)) {
    log("  backend already up — reusing");
  } else {
    log(`  starting backend: __serve__ ${API_PORT} (REMOTE_DESKTOP_ENABLED=1)`);
    started.server = spawnBg(
      "bun",
      ["run", "--hot", "src/server/index.ts", "__serve__", String(API_PORT), "0.0.0.0", "dev"],
      "server",
      { REMOTE_DESKTOP_ENABLED: "1" },
    );
    await waitUp(`${API}/api/health`, "backend");
  }
  if (await isUp(WEB)) {
    log("  web already up — reusing");
  } else {
    log(`  starting web: vite --port ${WEB_PORT} (PPM_DEV_API -> ${API})`);
    started.web = spawnBg(
      "bun",
      ["run", "vite", "--config", "vite.config.ts", "--port", String(WEB_PORT)],
      "web",
      { PPM_DEV_API: API, VITE_DEV_API_PORT: String(API_PORT) },
    );
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
    if (started.server) await killPort(API_PORT);
    if (started.web) await killPort(WEB_PORT);
  } else {
    log("  PPM_E2E_KEEP set — leaving servers running");
  }
  if (started.chromeProfile) {
    await rm(started.chromeProfile, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Raw CDP driver (mirrors tests/e2e/system-monitor-e2e.mjs's Cdp class)
// ---------------------------------------------------------------------------
async function launchChrome() {
  const profile = join(tmpdir(), `ppm-e2e-remotedesktop-${Date.now()}`);
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
    // WebCodecs H.264 software decode does not need the GPU, but make sure no
    // feature flag disables the decoder outright in a headless build.
    "--enable-features=PlatformHEVCDecoderSupport",
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

  async setViewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
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

async function clickTestId(cdp, testId) {
  const ok = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`click target not found: [data-testid="${testId}"]`);
}

async function attr(cdp, testId, name) {
  return cdp.evaluate(`document.querySelector('[data-testid=${JSON.stringify(testId)}]')?.getAttribute(${JSON.stringify(name)})`);
}

/** Samples the canvas via `getImageData` (same-origin decoded VideoFrame pixels, never
 *  tainted) and returns mean luma + variance over a strided sample — cheap enough to poll
 *  every few hundred ms without materializing the full buffer's math on every byte. A
 *  black/blank canvas has mean ~0; a flat color has variance ~0; a real desktop frame has
 *  both a real mean AND non-trivial variance (UI has edges/text/contrast). */
async function canvasStats(cdp) {
  return cdp.evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="remote-desktop-canvas"]');
    if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    let sum = 0, sumSq = 0, n = 0;
    const stride = 4 * 37; // ~1/37th of pixels — plenty for mean/variance, cheap to compute
    for (let i = 0; i < data.length; i += stride) {
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += lum;
      sumSq += lum * lum;
      n++;
    }
    if (n === 0) return null;
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return { mean, variance, width: w, height: h, sampled: n };
  })()`);
}

async function waitForRealFrame(cdp, { meanThreshold = 5, varianceThreshold = 30, timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await canvasStats(cdp);
    if (last && last.mean > meanThreshold && last.variance > varianceThreshold) return last;
    await Bun.sleep(400);
  }
  throw new Error(`no real frame within ${timeoutMs}ms — last stats: ${JSON.stringify(last)}`);
}

/** Host cursor position — this harness runs ON the captured machine, so it can independently
 *  verify the injector actually moved the real OS cursor (not just something inside the browser
 *  sandbox) without any CDP mouse emulation being mistaken for the remote-desktop's own input
 *  path. PowerShell on Windows; on macOS a JXA one-liner, because `CGEventGetLocation` returns
 *  a struct by value that bun:ffi cannot express. */
function hostCursorPos() {
  if (process.platform === "darwin") {
    const proc = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e",
      'ObjC.import("CoreGraphics"); const p = $.CGEventGetLocation($.CGEventCreate(null)); `${Math.round(p.x)},${Math.round(p.y)}`']);
    const out = proc.stdout.toString().trim();
    const m = out.match(/(-?\d+),(-?\d+)/);
    if (!m) throw new Error(`could not parse host cursor position from: ${out}`);
    return { x: Number(m[1]), y: Number(m[2]) };
  }
  const proc = Bun.spawnSync([
    "powershell", "-NoProfile", "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.Cursor]::Position; Write-Output \"$($p.X),$($p.Y)\"",
  ]);
  const out = proc.stdout.toString().trim();
  const m = out.match(/(-?\d+),(-?\d+)/);
  if (!m) throw new Error(`could not parse host cursor position from: ${out}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Bounds the capture maps 0..1 onto: the whole virtual screen on Windows (gdigrab `desktop`),
 *  the main display in logical points on macOS (avfoundation "Capture screen 0" + CG points). */
function hostVirtualScreen() {
  if (process.platform === "darwin") {
    const proc = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e",
      'ObjC.import("CoreGraphics"); const d = $.CGMainDisplayID(); `0,0,${$.CGDisplayPixelsWide(d)},${$.CGDisplayPixelsHigh(d)}`']);
    const out = proc.stdout.toString().trim();
    const m = out.match(/(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
    if (!m) throw new Error(`could not parse main display bounds from: ${out}`);
    return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
  }
  const proc = Bun.spawnSync([
    "powershell", "-NoProfile", "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; Write-Output \"$($b.X),$($b.Y),$($b.Width),$($b.Height)\"",
  ]);
  const out = proc.stdout.toString().trim();
  const m = out.match(/(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
  if (!m) throw new Error(`could not parse virtual screen bounds from: ${out}`);
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS, { recursive: true });

  step("1. Ensure servers (8082/5174, REMOTE_DESKTOP_ENABLED=1)");
  await ensureServers();

  if (!TOKEN) {
    throw new Error("no auth token found in ppm.dev.db (config key 'auth') — remote desktop requires PPM auth enabled");
  }

  step("2. Launch Chrome + connect CDP");
  const wsUrl = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.setViewport(1280, 800);

  step("3. Load app + inject auth token");
  await cdp.navigate(WEB);
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(TOKEN)})`);
  await cdp.navigate(WEB);
  await waitFor(cdp, `document.querySelector('[data-testid="status-bar-resources"]')`, "status bar mounted", 30_000);
  await Bun.sleep(500);

  // The entry point lives in the nav rail footer (aria-label only, no testid) — it renders only
  // once /api/remote-desktop/capabilities reports videoAvailable.
  const RAIL_BUTTON = `document.querySelector('button[aria-label="Remote Desktop"]')`;
  await scenario("capabilities: videoAvailable is true, nav rail button renders", async () => {
    await waitFor(cdp, RAIL_BUTTON, "remote desktop nav rail button (requires capabilities.videoAvailable)", 15_000);
  });

  await scenario("open Remote Desktop window from the nav rail, past the warning gate", async () => {
    await cdp.evaluate(`${RAIL_BUTTON}.click()`);
    await waitFor(cdp, `document.querySelector('[data-testid="remote-desktop-warning-gate"]')`, "warning gate", 10_000);
    await cdp.screenshot(join(SHOTS, "remote-desktop-00-warning-gate.png"));
    await clickTestId(cdp, "remote-desktop-warning-continue");
    await waitFor(cdp, `document.querySelector('[data-testid="remote-desktop-window"]')`, "remote desktop window", 10_000);
    const isFloatingWindow = await cdp.evaluate(
      `!!document.querySelector('[role="group"][aria-roledescription="window"]')`,
    );
    if (!isFloatingWindow) throw new Error("Remote Desktop did not render inside a floating window");
  });
  await cdp.screenshot(join(SHOTS, "remote-desktop-01-initial-window.png"));

  await scenario("WS connects and reaches the streaming state", async () => {
    await waitFor(cdp, `document.querySelector('[data-testid="remote-desktop-window"]')?.dataset.connState === "streaming"`, "conn-state=streaming", 20_000);
  });

  let frameStats = null;
  await scenario("canvas renders a real (non-black, non-flat) host-desktop frame", async () => {
    frameStats = await waitForRealFrame(cdp);
    log(`  frame stats: mean=${frameStats.mean.toFixed(2)} variance=${frameStats.variance.toFixed(2)} size=${frameStats.width}x${frameStats.height}`);
  });
  await cdp.screenshot(join(SHOTS, "remote-desktop-02-live-frame.png"));

  step("4. Best-effort input round trip (1b)");
  let inputResult = "not attempted";
  const inputScenarioName = "synthetic pointer click round-trips to the real host cursor (SendInput / CGEvent)";
  if (!(await cdp.evaluate(`document.querySelector('[data-testid="remote-desktop-window"]')?.dataset.connState === "streaming"`))) {
    inputResult = "SKIP: not streaming (video pipe did not reach streaming state — see scenario above)";
    record(inputScenarioName, false, inputResult);
  } else {
  await scenario(inputScenarioName, async () => {
    const before = hostCursorPos();
    const vscreen = hostVirtualScreen();

    // Dispatch a real PointerEvent on the canvas (exercises the actual UI -> WS -> SendInput
    // path in use-remote-input-capture.ts, not CDP's own input-emulation layer) targeting a
    // known fraction of the canvas so the expected host coordinate is computable.
    const targetFrac = { x: 0.75, y: 0.25 };
    await cdp.evaluate(`(() => {
      const canvas = document.querySelector('[data-testid="remote-desktop-canvas"]');
      const r = canvas.getBoundingClientRect();
      const x = r.left + r.width * ${targetFrac.x};
      const y = r.top + r.height * ${targetFrac.y};
      const fire = (type, extra) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra,
      }));
      fire("pointerdown");
      fire("pointerup");
    })()`);
    await Bun.sleep(500); // WS round trip + SendInput

    const after = hostCursorPos();
    const expected = {
      x: Math.round(vscreen.x + vscreen.width * targetFrac.x),
      y: Math.round(vscreen.y + vscreen.height * targetFrac.y),
    };
    const movedFromBefore = Math.hypot(after.x - before.x, after.y - before.y) > 2;
    const distFromExpected = Math.hypot(after.x - expected.x, after.y - expected.y);
    log(`  host cursor before=${JSON.stringify(before)} after=${JSON.stringify(after)} expected=${JSON.stringify(expected)} distFromExpected=${distFromExpected.toFixed(1)}px`);
    if (!movedFromBefore) {
      inputResult = `FAIL: host cursor did not move (before=${JSON.stringify(before)} after=${JSON.stringify(after)})`;
      throw new Error(inputResult);
    }
    // Generous tolerance: DPI-per-monitor rounding + the 0..65535 SendInput quantization.
    if (distFromExpected > 50) {
      inputResult = `PARTIAL: cursor moved but ${distFromExpected.toFixed(1)}px from expected coordinate`;
    } else {
      inputResult = `PASS: host cursor moved to within ${distFromExpected.toFixed(1)}px of the expected coordinate`;
    }
  });
  }
  await cdp.screenshot(join(SHOTS, "remote-desktop-03-after-input.png"));
  log(`  1b input result: ${inputResult}`);

  step("DONE");
  return { frameStats, inputResult };
}

// ---------------------------------------------------------------------------
let exitCode = 0;
let outcome = null;
try {
  outcome = await main();
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
if (outcome?.frameStats) {
  console.log(`Frame stats: mean=${outcome.frameStats.mean.toFixed(2)} variance=${outcome.frameStats.variance.toFixed(2)}`);
}
if (outcome?.inputResult) {
  console.log(`1b input: ${outcome.inputResult}`);
}
if (results.some((r) => !r.pass)) exitCode = 1;
process.exit(exitCode);
