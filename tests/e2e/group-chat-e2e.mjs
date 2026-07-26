// Group-chat feature — real browser end-to-end harness (headless Chrome via raw CDP).
//
// What it does (repeatable):
//   1. Starts `bun dev:server` (8081) + `bun dev:web` (5173) if not already up, waits for both.
//   2. Launches headless Chrome, sets the auth token in localStorage, drives the real app.
//   3. Selects the `ppm` project, opens the Teams sidebar, creates a group via the UI dialog.
//   4. SEEDS the durable bus (chat_group_messages) directly — NO live Claude turns (cost guard).
//      Seeding uses the exact store the feed reads, so the RENDER is 100% real.
//   5. Captures the required screenshots (desktop + mobile) into the plan visuals dir.
//   6. Optionally records a video (PPM_E2E_VIDEO=1) via CDP Page.startScreencast → MP4.
//   7. Optionally runs a LIVE mode (PPM_E2E_LIVE=1): real LLM agents, real cost, real MP4.
//   8. Stops ONLY the servers it started, by exact PID.
//
// Run:
//   bun tests/e2e/group-chat-e2e.mjs               # screenshots only (default)
//   PPM_E2E_VIDEO=1 bun tests/e2e/group-chat-e2e.mjs  # screenshots + MP4 video
//   PPM_E2E_LIVE=1 bun tests/e2e/group-chat-e2e.mjs   # REAL agents, real cost, live MP4
//
// Env overrides:
//   PPM_E2E_VIDEO=1       record a video (CDP screencast → ffmpeg MP4 concat)
//   PPM_E2E_LIVE=1        REAL LLM agents (maxTurns=6, maxCostUsd=1.0); outputs live MP4
//   PPM_E2E_KEEP=1        keep servers + group running after the run (debugging)
//   PPM_E2E_NO_SERVERS=1  assume servers already running; don't spawn/kill them
//   CHROME_PATH=...       override Chrome executable path
//
// Notes:
//   - Host Bun is fine for servers/scripts here; the known segfault only affects `bun test`/`tsc`.
//   - Seeded content is clearly labelled "[SEED]" in log output (no live Claude turns).
//   - Video pacing: deliberate 600-1000ms pauses make each story beat legible on screen.
//   - LIVE mode: no seeding fallback; if the engine errors the raw error is reported plainly.

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const REPO = process.cwd();
const AUTH_TOKEN = "123123";
const TOKEN_KEY = "ppm-auth-token"; // src/web/lib/api-client.ts
const API = "http://localhost:8081";
const WEB = "http://localhost:5173";
// Deep-link that auto-activates the ppm project on load (use-url-sync parses
// /project/:name → urlState.projectName → app.tsx setActiveProject).
const WEB_PROJECT = `${WEB}/project/${encodeURIComponent("ppm")}`;
const CDP_PORT = 9222;
const DEV_DB = join(homedir(), ".ppm", "ppm.dev.db");
const PROJECT_NAME = "ppm";
const VISUALS = join(REPO, "plans", "260724-1931-group-chat-native-engine", "visuals");
const MP4_OUT = join(VISUALS, "group-chat-e2e.mp4");
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const KEEP = !!process.env.PPM_E2E_KEEP;
const NO_SERVERS = !!process.env.PPM_E2E_NO_SERVERS;
const VIDEO = !!process.env.PPM_E2E_VIDEO;
const LIVE = !!process.env.PPM_E2E_LIVE;
const MP4_OUT_LIVE = join(VISUALS, "group-chat-e2e-live.mp4");

// Live group name — different from seeded group to avoid reset collision.
const LIVE_GROUP_NAME = "E2E Live Chat";

const started = { server: null, web: null, chrome: null, chromeProfile: null };
const log = (...a) => console.log(...a);
const step = (t) => log("\n=== " + t + " ===");

// ---------------------------------------------------------------------------
// Server lifecycle
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
      return true;
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
  // Backend
  if (await isUp(`${API}/api/health`)) {
    log("  backend already up — reusing");
  } else {
    log("  starting backend: bun dev:server");
    started.server = spawnBg("bun", ["run", "dev:server"], "server");
    await waitUp(`${API}/api/health`, "backend");
  }
  // Web
  if (await isUp(WEB)) {
    log("  web already up — reusing");
  } else {
    log("  starting web: bun dev:web");
    started.web = spawnBg("bun", ["run", "dev:web"], "web");
    await waitUp(WEB, "web");
  }
}

// ---------------------------------------------------------------------------
// Raw CDP driver — handles both request/reply and push events (screencast)
// ---------------------------------------------------------------------------
async function launchChrome() {
  const profile = join(tmpdir(), `ppm-e2e-chrome-${Date.now()}`);
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
      const r = await fetch(`http://localhost:${CDP_PORT}/json`, {
        signal: AbortSignal.timeout(1500),
      });
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
    // Push-event listeners: method → [callback, ...]
    this.eventListeners = new Map();

    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        // Reply to a send() call
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        // CDP push event (e.g. Page.screencastFrame, Page.loadEventFired)
        const cbs = this.eventListeners.get(msg.method);
        if (cbs) {
          for (const cb of cbs) {
            try { cb(msg.params); } catch { /* swallow handler errors */ }
          }
        }
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

  /** Subscribe to a CDP push event by method name. Returns an unsubscribe fn. */
  on(method, callback) {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, []);
    this.eventListeners.get(method).push(callback);
    return () => {
      const arr = this.eventListeners.get(method) ?? [];
      const idx = arr.indexOf(callback);
      if (idx !== -1) arr.splice(idx, 1);
    };
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
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        "evaluate threw: " +
          (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
      );
    }
    return r.result?.value;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await Bun.sleep(300);
  }

  async setViewport(width, height, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: mobile ? 3 : 1,
      mobile,
    });
  }

  async screenshot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(r.data, "base64"));
    log(`  screenshot -> ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Screencast recorder — collects JPEG frames via CDP Page.startScreencast
// ---------------------------------------------------------------------------
class Screencast {
  constructor(cdp, framesDir) {
    this.cdp = cdp;
    this.framesDir = framesDir;
    this.frames = []; // [{path, tsMs}]
    this._frameIdx = 0;
    this._unsub = null;
  }

  async start() {
    await mkdir(this.framesDir, { recursive: true });
    this._unsub = this.cdp.on("Page.screencastFrame", async (params) => {
      const idx = String(++this._frameIdx).padStart(6, "0");
      const path = join(this.framesDir, `frame-${idx}.jpg`);
      const tsMs = Date.now();
      try {
        await writeFile(path, Buffer.from(params.data, "base64"));
        this.frames.push({ path, tsMs });
      } catch { /* disk write error — skip frame */ }
      // Must ack each frame or Chrome stops sending.
      this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });

    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      // everyNthFrame: 1 → capture as many frames as Chrome's renderer offers.
      // In headless mode this is ~5-15 fps depending on page activity.
      everyNthFrame: 1,
    });
    log("  screencast started");
  }

  async stop() {
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    if (this._unsub) { this._unsub(); this._unsub = null; }
    log(`  screencast stopped — ${this.frames.length} frames collected`);
  }

  /**
   * Assemble frames → MP4 using ffmpeg concat demuxer so each frame's wall-clock
   * duration is honoured (correct real-time pacing even with variable frame rate).
   * Falls back to glob glob-pattern at 10 fps if fewer than 2 frames collected.
   */
  async assemble(outPath) {
    if (this.frames.length === 0) throw new Error("No screencast frames captured");
    log(`  assembling ${this.frames.length} frames → ${outPath}`);

    let ffmpegArgs;

    if (this.frames.length < 2) {
      // Edge case: single frame — fixed 1 fps
      ffmpegArgs = [
        "-y",
        "-framerate", "1",
        "-i", this.frames[0].path,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-vf", "scale=1280:-2",
        "-t", "2",
        outPath,
      ];
    } else {
      // Build a concat demuxer file: each entry = "file '<path>'\nduration <sec>"
      // The last entry must repeat without a duration (ffmpeg requirement).
      const lines = [];
      for (let i = 0; i < this.frames.length; i++) {
        // Normalise Windows backslashes for ffmpeg (forward slashes work on Windows too)
        const p = this.frames[i].path.replace(/\\/g, "/");
        lines.push(`file '${p}'`);
        if (i < this.frames.length - 1) {
          const durationSec = (this.frames[i + 1].tsMs - this.frames[i].tsMs) / 1000;
          // Clamp: never less than 0.05s (20 fps cap) or more than 3s per frame.
          const clamped = Math.max(0.05, Math.min(3.0, durationSec));
          lines.push(`duration ${clamped.toFixed(4)}`);
        }
      }
      // Repeat last frame without duration (required by concat demuxer)
      const lastP = this.frames[this.frames.length - 1].path.replace(/\\/g, "/");
      lines.push(`file '${lastP}'`);

      const concatFile = join(this.framesDir, "concat.txt");
      await writeFile(concatFile, lines.join("\n") + "\n");

      ffmpegArgs = [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFile,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        // Scale to 1280 wide, height divisible by 2 (libx264 requirement)
        "-vf", "scale=1280:-2",
        // vsync cfr normalises to a constant 15 fps for smooth playback
        "-r", "15",
        outPath,
      ];
    }

    await new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
      proc.stderr.on("data", (d) => process.stderr.write(`[ffmpeg] ${d}`));
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
    });
    log(`  MP4 written → ${outPath}`);
  }

  async cleanup() {
    await rm(this.framesDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Navigation / interaction helpers
// ---------------------------------------------------------------------------

// Open Teams sidebar panel by clicking the rail/nav button.
const OPEN_TEAMS_JS = `(() => {
  const nodes = Array.from(document.querySelectorAll('button,[role="button"],a'));
  const teams = nodes.find((n) => {
    const t = (n.getAttribute('aria-label')||'') + ' ' + (n.getAttribute('title')||'') + ' ' + (n.textContent||'');
    return /\\bTeams\\b/i.test(t);
  });
  if (teams) teams.click();
  return !!teams;
})()`;

// Expand the sidebar if it's in collapsed (rail-only) state.
const EXPAND_SIDEBAR_JS = `(() => {
  const btns = Array.from(document.querySelectorAll('button,[role="button"]'));
  const expand = btns.find((b) => /Expand sidebar/i.test(b.getAttribute('title')||''));
  if (expand) { expand.click(); return true; }
  return false;
})()`;

// Navigate to /project/ppm (auto-activates project), expand sidebar, open Teams.
async function gotoTeams(cdp) {
  await cdp.navigate(WEB_PROJECT);
  await waitFor(cdp, `document.body && document.body.innerText.length > 0`, "app body");
  await Bun.sleep(1500);
  await cdp.evaluate(EXPAND_SIDEBAR_JS);
  await Bun.sleep(400);
  await cdp.evaluate(OPEN_TEAMS_JS);
  await Bun.sleep(400);
  // Re-expand in case opening the panel didn't widen a collapsed rail.
  await cdp.evaluate(EXPAND_SIDEBAR_JS);
  await Bun.sleep(600);
}

// Poll a JS boolean expression until true (or timeout).
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

// Click an element found by a JS expression returning an Element.
async function clickEl(cdp, findExpr) {
  const ok = await cdp.evaluate(`(() => {
    const el = ${findExpr};
    if (!el) return false;
    el.scrollIntoView({block:'center'});
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`click target not found: ${findExpr}`);
}

// Set a controlled React input's value via the native setter + input event.
function setReactInputExpr(selectorExpr, value) {
  const v = JSON.stringify(value);
  return `(() => {
    const el = ${selectorExpr};
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${v});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
}

// Type text into an input character-by-character so it looks natural on video.
// Falls back to instant-set for long strings.
async function typeInto(cdp, selectorExpr, text, delayMs = 60) {
  if (text.length > 60 || !VIDEO) {
    // Not in video mode or too long — use instant set
    await cdp.evaluate(setReactInputExpr(selectorExpr, text));
    return;
  }
  // Type char by char using React native setter so each character triggers
  // a React onChange (native input event with bubbles).
  for (let i = 1; i <= text.length; i++) {
    const partial = text.slice(0, i);
    await cdp.evaluate(setReactInputExpr(selectorExpr, partial));
    await Bun.sleep(delayMs);
  }
}

// ---------------------------------------------------------------------------
// Bus seeding
// ---------------------------------------------------------------------------
async function seedBus(groupId, memberNames) {
  // Writes through the exact same INSERT shape as group-chat.store.appendMessage.
  // Uses bun:sqlite directly (own process) to avoid a second migrating DB handle
  // racing the dev server's open connection.
  const leader = memberNames.leader;
  const [m1, m2] = memberNames.members;
  // fakeSessionRef triggers the "view full transcript" button; archive is absent → 404 fallback
  const fakeSessionRef = "00000000-0000-4000-8000-000000000abc";

  const msgs = [
    { from: "You", to: "all", kind: "task", turn: 0, ref: null,
      summary: "Design the group-chat feed layout — Slack-style roster + composer. Keep it mobile-first." },
    { from: leader, to: "all", kind: "chat", turn: 1, ref: null,
      summary: `Kicking off. @${m1} take the feed rendering, @${m2} own the composer + thumb-zone layout. Report back with a plan.` },
    { from: m1, to: leader, kind: "chat", turn: 2, ref: fakeSessionRef,
      summary: `@${leader} feed will use a virtualized-free plain DOM list (stick-to-bottom). Sender avatar + name + relative time per row. Drafted the message-item component.` },
    { from: m2, to: leader, kind: "chat", turn: 3, ref: null,
      summary: `@${leader} composer pinned to bottom, 44px send target, textarea auto-grows to 32rem cap. Enter-to-send on desktop only; mobile keeps newline.` },
    { from: leader, to: "all", kind: "final", turn: 4, ref: null,
      summary: "Converged: plain-DOM feed + bottom composer, roster drawer on mobile. Shipping. DONE." },
  ];

  const db = new Database(DEV_DB);
  const insert = db.query(
    `INSERT INTO chat_group_messages
       (id, group_id, from_member, to_member, kind, summary, full_session_ref, data, turn_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of msgs) {
    insert.run(crypto.randomUUID(), groupId, m.from, m.to, m.kind, m.summary, m.ref, null, m.turn);
  }
  db.close();
  return msgs.length;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
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

// Kill the process listening on a given port (reaps --hot children).
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

let screencast = null;

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
  if (screencast) {
    await screencast.cleanup();
    screencast = null;
  }
}

// ---------------------------------------------------------------------------
// Core browser flow (shared by screenshot + video paths)
// Returns the groupId that was created so callers can use it.
// ---------------------------------------------------------------------------
async function runBrowserFlow(cdp) {
  step("4. Set auth token (web origin, before app boots)");
  await cdp.navigate(WEB);
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(AUTH_TOKEN)})`);

  step("5+6. Deep-link to /project/ppm (auto-activates project) + open Teams");
  await gotoTeams(cdp);

  const needsProject = await cdp.evaluate(
    `document.body.innerText.includes('Select a project to view groups')`,
  );
  if (needsProject) {
    throw new Error("project did not auto-activate — GroupList shows 'Select a project'");
  }

  step("7. Open create-group dialog");
  await clickEl(cdp, `document.querySelector('[aria-label="New group"]')`);
  await waitFor(
    cdp,
    `document.querySelector('input[placeholder="e.g. Design Review"]')`,
    "create dialog open",
  );
  await Bun.sleep(VIDEO ? 800 : 400);

  step("8. Fill roster");
  await typeInto(cdp, `document.querySelector('input[placeholder="e.g. Design Review"]')`, "E2E Design Review");
  await Bun.sleep(VIDEO ? 400 : 100);
  await typeInto(cdp, `document.querySelector('input[placeholder="Leader name"]')`, "Nova");
  await Bun.sleep(VIDEO ? 400 : 100);
  await typeInto(cdp, `document.querySelector('input[placeholder="Persona (optional)"]')`, "Lead engineer, keeps scope tight");
  await Bun.sleep(VIDEO ? 400 : 100);
  await typeInto(cdp, `document.querySelector('input[placeholder="Member name"]')`, "Ivy");
  // Add second member
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim() === 'Add');
  })()`);
  await Bun.sleep(VIDEO ? 400 : 300);
  await cdp.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('input[placeholder="Member name"]'));
    const el = inputs[inputs.length - 1];
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'Rhea');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await Bun.sleep(VIDEO ? 600 : 400);

  return null; // signals: caller handles screenshot here if needed
}

// ---------------------------------------------------------------------------
// Screenshots-only flow
// ---------------------------------------------------------------------------
async function runScreenshots(cdp) {
  await runBrowserFlow(cdp);

  step("SS-A. Screenshot 02-create-dialog");
  await cdp.screenshot(join(VISUALS, "02-create-dialog.png"));

  step("SS-B. Submit create group");
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim().replace(/\\s+/g,' ') === 'Create group');
  })()`);
  await waitFor(
    cdp,
    `document.querySelector('textarea[placeholder="Message the group…"]')`,
    "group tab opened",
    20_000,
  );
  await Bun.sleep(800);

  const groupId = await lookupGroupId();

  step("SS-C. [SEED] bus messages");
  const memberNames = await lookupMembers(groupId);
  const seeded = await seedBus(groupId, memberNames);
  log(`  seeded ${seeded} bus messages`);

  step("SS-D. Screenshot 01-teams-sidebar");
  await gotoTeams(cdp);
  await waitFor(cdp, `document.body.innerText.includes('E2E Design Review')`, "group in list", 10_000);
  await Bun.sleep(400);
  await cdp.screenshot(join(VISUALS, "01-teams-sidebar.png"));

  step("SS-E. Open group tab + roster → screenshot 03-feed-desktop");
  await cdp.setViewport(1280, 900, false);
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim() === 'E2E Design Review')
        || btns.find((b) => b.textContent && b.textContent.includes('E2E Design Review'));
  })()`);
  await waitFor(cdp, `document.body.innerText.includes('DONE') || document.querySelector('textarea[placeholder="Message the group…"]')`, "feed loaded");
  await Bun.sleep(600);
  for (let i = 0; i < 3; i++) {
    const rosterOpen = await cdp.evaluate(
      `Array.from(document.querySelectorAll('div')).some((d) => d.textContent && d.textContent.trim() === 'Members')`,
    );
    if (rosterOpen) break;
    await clickEl(cdp, `document.querySelector('[aria-label="Toggle roster"]')`);
    await Bun.sleep(700);
  }
  await Bun.sleep(400);
  await cdp.screenshot(join(VISUALS, "03-feed-desktop.png"));

  step("SS-F. Screenshot 06-view-full");
  const hasViewFull = await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return !!btns.find((b) => b.textContent && b.textContent.trim() === 'View full transcript');
  })()`);
  if (hasViewFull) {
    await clickEl(cdp, `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find((b) => b.textContent && b.textContent.trim() === 'View full transcript');
    })()`);
    await waitFor(
      cdp,
      `document.body.innerText.includes('Full transcript unavailable') || document.body.innerText.includes('full transcript')`,
      "transcript view", 8000,
    );
    await Bun.sleep(600);
    await cdp.screenshot(join(VISUALS, "06-view-full.png"));
    await cdp.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await Bun.sleep(500);
  } else {
    log("  WARN: no 'View full transcript' button — skipping 06");
  }

  step("SS-G. Screenshot 05-stop-or-resume (paused → Resume)");
  {
    const db = new Database(DEV_DB);
    db.query("UPDATE chat_groups SET status = 'paused' WHERE id = ?").run(groupId);
    db.close();
  }
  await gotoTeams(cdp);
  await waitFor(cdp, `document.body.innerText.includes('E2E Design Review')`, "group (paused)", 10_000);
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.includes('E2E Design Review'));
  })()`);
  await waitFor(
    cdp,
    `Array.from(document.querySelectorAll('button')).some((b)=>/Resume|Stop/.test(b.textContent||'')) || document.body.innerText.toLowerCase().includes('paused')`,
    "stop/resume control", 10_000,
  );
  await Bun.sleep(800);
  await cdp.screenshot(join(VISUALS, "05-stop-or-resume.png"));

  step("SS-H. Screenshot 04-feed-mobile (390x844)");
  {
    const db = new Database(DEV_DB);
    db.query("UPDATE chat_groups SET status = 'active' WHERE id = ?").run(groupId);
    db.close();
  }
  await cdp.setViewport(390, 844, true);
  await Bun.sleep(400);
  await cdp.navigate(`${WEB_PROJECT}/group/${encodeURIComponent(groupId)}`);
  await waitFor(
    cdp,
    `document.querySelector('textarea[placeholder="Message the group…"]') || document.body.innerText.includes('DONE')`,
    "mobile group tab", 20_000,
  );
  await Bun.sleep(1200);
  await cdp.screenshot(join(VISUALS, "04-feed-mobile.png"));

  return groupId;
}

// ---------------------------------------------------------------------------
// Video recording flow — paced for watchability
// Story: Teams sidebar → open dialog (type visibly) → create → feed → seed
//        → Stop → Paused → Resume → Active → view-full → 404 fallback
// ---------------------------------------------------------------------------
async function runVideo(cdp) {
  const framesDir = join(tmpdir(), `ppm-e2e-frames-${Date.now()}`);
  screencast = new Screencast(cdp, framesDir);

  // ---- 1. Start recording then boot the app ----
  step("V-1. Start screencast");
  await screencast.start();
  await Bun.sleep(400);

  step("V-2. Set auth token + load app");
  await cdp.navigate(WEB);
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(AUTH_TOKEN)})`);
  await Bun.sleep(300);

  step("V-3. Navigate to Teams sidebar (project auto-selected)");
  await gotoTeams(cdp);
  // Let viewer see the Teams panel
  await Bun.sleep(1000);

  const needsProject = await cdp.evaluate(
    `document.body.innerText.includes('Select a project to view groups')`,
  );
  if (needsProject) throw new Error("project did not auto-activate");

  step("V-4. Open create-group dialog");
  await clickEl(cdp, `document.querySelector('[aria-label="New group"]')`);
  await waitFor(cdp, `document.querySelector('input[placeholder="e.g. Design Review"]')`, "create dialog open");
  await Bun.sleep(800);

  step("V-5. Type group name character-by-character");
  await typeInto(cdp, `document.querySelector('input[placeholder="e.g. Design Review"]')`, "E2E Design Review");
  await Bun.sleep(600);

  step("V-6. Fill leader fields");
  await typeInto(cdp, `document.querySelector('input[placeholder="Leader name"]')`, "Nova");
  await Bun.sleep(400);
  await typeInto(cdp, `document.querySelector('input[placeholder="Persona (optional)"]')`, "Lead engineer, keeps scope tight");
  await Bun.sleep(500);

  step("V-7. Fill first member");
  await typeInto(cdp, `document.querySelector('input[placeholder="Member name"]')`, "Ivy");
  await Bun.sleep(500);

  step("V-8. Add second member");
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim() === 'Add');
  })()`);
  await Bun.sleep(400);
  await cdp.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('input[placeholder="Member name"]'));
    const el = inputs[inputs.length - 1];
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'Rhea');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await Bun.sleep(800);

  step("V-9. Submit → group created → group tab opens");
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim().replace(/\\s+/g,' ') === 'Create group');
  })()`);
  await waitFor(
    cdp,
    `document.querySelector('textarea[placeholder="Message the group…"]')`,
    "group tab opened", 20_000,
  );
  await Bun.sleep(1000);

  step("V-10. Look up group + seed the bus");
  const groupId = await lookupGroupId();
  const memberNames = await lookupMembers(groupId);
  const seeded = await seedBus(groupId, memberNames);
  log(`  seeded ${seeded} messages`);

  step("V-11. Reload → feed appears with seeded messages");
  await gotoTeams(cdp);
  await waitFor(cdp, `document.body.innerText.includes('E2E Design Review')`, "group in list", 10_000);
  await Bun.sleep(800);

  // Open the group tab (click the sidebar list item)
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim() === 'E2E Design Review')
        || btns.find((b) => b.textContent && b.textContent.includes('E2E Design Review'));
  })()`);
  await waitFor(cdp, `document.body.innerText.includes('DONE') || document.querySelector('textarea[placeholder="Message the group…"]')`, "feed loaded");
  await Bun.sleep(1000);

  step("V-12. Open roster panel — viewer sees feed + roster + composer");
  for (let i = 0; i < 3; i++) {
    const open = await cdp.evaluate(
      `Array.from(document.querySelectorAll('div')).some((d) => d.textContent && d.textContent.trim() === 'Members')`,
    );
    if (open) break;
    await clickEl(cdp, `document.querySelector('[aria-label="Toggle roster"]')`);
    await Bun.sleep(700);
  }
  await Bun.sleep(1000);

  step("V-13. Drive Stop → status flips to Paused");
  // Ensure group is active so the Stop button shows. Force via DB then reconnect.
  {
    const db = new Database(DEV_DB);
    db.query("UPDATE chat_groups SET status = 'active' WHERE id = ?").run(groupId);
    db.close();
  }
  // Reload to pick up WS group_state with status=active (shows Stop button)
  await gotoTeams(cdp);
  await waitFor(cdp, `document.body.innerText.includes('E2E Design Review')`, "group in list after reload", 10_000);
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim() === 'E2E Design Review')
        || btns.find((b) => b.textContent && b.textContent.includes('E2E Design Review'));
  })()`);
  // Re-open roster for consistent view
  for (let i = 0; i < 3; i++) {
    const open = await cdp.evaluate(
      `Array.from(document.querySelectorAll('div')).some((d) => d.textContent && d.textContent.trim() === 'Members')`,
    );
    if (open) break;
    await clickEl(cdp, `document.querySelector('[aria-label="Toggle roster"]')`);
    await Bun.sleep(700);
  }
  await waitFor(
    cdp,
    `Array.from(document.querySelectorAll('button')).some((b)=>b.textContent && b.textContent.includes('Stop'))`,
    "Stop button visible", 8000,
  );
  await Bun.sleep(800);
  // Click Stop
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim().includes('Stop'));
  })()`);
  // Wait for "Paused" to appear
  await waitFor(
    cdp,
    `document.body.innerText.toLowerCase().includes('paused') || Array.from(document.querySelectorAll('button')).some((b)=>b.textContent&&b.textContent.includes('Resume'))`,
    "paused state", 8000,
  );
  await Bun.sleep(1000);

  step("V-14. Drive Resume → back to Active");
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim().includes('Resume'));
  })()`);
  // Wait for active/idle status (resume starts the engine — but since bus has
  // no pending task it may go back to idle quickly; show the transition)
  await Bun.sleep(1200);

  step("V-15. Click 'View full transcript' → 404 fallback modal");
  const hasViewFull = await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return !!btns.find((b) => b.textContent && b.textContent.trim() === 'View full transcript');
  })()`);
  if (hasViewFull) {
    await clickEl(cdp, `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find((b) => b.textContent && b.textContent.trim() === 'View full transcript');
    })()`);
    await waitFor(
      cdp,
      `document.body.innerText.includes('Full transcript unavailable') || document.body.innerText.includes('full transcript')`,
      "transcript view", 8000,
    );
    await Bun.sleep(1200);
    // Close dialog
    await cdp.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await Bun.sleep(800);
  } else {
    log("  WARN: no 'View full transcript' button found — skipping modal");
  }

  step("V-16. Stop screencast + assemble MP4");
  await screencast.stop();
  await screencast.assemble(MP4_OUT);
  await screencast.cleanup();
  screencast = null;

  return groupId;
}

// ---------------------------------------------------------------------------
// DB helpers shared by both flows
// ---------------------------------------------------------------------------
async function lookupGroupId() {
  let g = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !g) {
    const db = new Database(DEV_DB);
    g = db
      .query("SELECT id FROM chat_groups WHERE name = ? ORDER BY created_at DESC LIMIT 1")
      .get("E2E Design Review");
    db.close();
    if (!g) await Bun.sleep(500);
  }
  if (!g) throw new Error("created group not found in dev DB (create POST did not persist)");
  log(`  group id: ${g.id}`);
  return g.id;
}

async function lookupMembers(groupId) {
  const db = new Database(DEV_DB);
  const mem = db
    .query("SELECT name, role FROM chat_group_members WHERE group_id = ? ORDER BY joined_at, id")
    .all(groupId);
  db.close();
  const leader = mem.find((m) => m.role === "leader")?.name ?? "Nova";
  const members = mem.filter((m) => m.role === "member").map((m) => m.name);
  log(`  leader: ${leader} | members: ${members.join(", ")}`);
  return { leader, members: members.length ? members : ["Ivy", "Rhea"] };
}

// ---------------------------------------------------------------------------
// Live LLM recording flow — real agents, real cost, real video.
//
// Flow:
//   1. Create group via REST API with maxTurns=6, maxCostUsd=1.0 (cost-bounded).
//   2. Navigate browser to the group tab via deep-link.
//   3. Start CDP screencast BEFORE sending the task (capture every frame of agent activity).
//   4. POST the task to /api/group-chat/:id/message (the engine runs server-side).
//   5. Poll DB every 5s for status transition active→idle/paused (cap 4 min).
//   6. Stop screencast, assemble group-chat-e2e-live.mp4.
//   7. Screenshot 07-live-feed.png.
//   8. Read messages from DB and log real quotes.
//
// HONESTY: if the engine errors (API key, network, etc.) the raw error is reported.
// There is NO seeding fallback. The MP4 will contain whatever actually rendered.
// ---------------------------------------------------------------------------
async function runLive(cdp) {
  // --- L-1. Create group via REST (not UI dialog — maxTurns/maxCostUsd not exposed there) ---
  step("L-1. Create live group via REST API");
  const createRes = await fetch(`${API}/api/group-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      projectName: PROJECT_NAME,
      projectPath: "c:/Users/PC/ppm",
      name: LIVE_GROUP_NAME,
      maxTurns: 6,
      maxCostUsd: 1.0,
      members: [
        {
          role: "leader",
          name: "Nova",
          persona:
            "Lead engineer. Keeps scope tight. Assigns sub-tasks to members, " +
            "collects results, and closes with a DONE: line when consensus is reached.",
        },
        {
          role: "member",
          name: "Ivy",
          persona: "Favours simplicity. Proposes the smallest solution that works.",
        },
        {
          role: "member",
          name: "Rhea",
          persona:
            "Raises edge cases. Points out one important edge case per proposal " +
            "and suggests a guard for it.",
        },
      ],
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Group create failed: HTTP ${createRes.status} — ${await createRes.text()}`);
  }
  const createJson = await createRes.json();
  if (!createJson.ok) {
    throw new Error(`Group create API error: ${JSON.stringify(createJson)}`);
  }
  const liveGroupId = createJson.data.id;
  log(`  created live group: ${liveGroupId} (maxTurns=6, maxCostUsd=$1.00)`);

  // --- L-2. Set auth + deep-link directly to the group tab ---
  step("L-2. Set auth + navigate to live group tab");
  await cdp.navigate(WEB);
  await cdp.evaluate(
    `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(AUTH_TOKEN)})`,
  );
  await Bun.sleep(300);
  // Deep-link opens the project AND the specific group tab in one navigation.
  await cdp.navigate(`${WEB_PROJECT}/group/${encodeURIComponent(liveGroupId)}`);
  await waitFor(
    cdp,
    `document.querySelector('textarea[placeholder="Message the group…"]') ` +
      `|| document.body.innerText.includes('${LIVE_GROUP_NAME}')`,
    "live group tab opened",
    25_000,
  );
  await cdp.evaluate(EXPAND_SIDEBAR_JS);
  await Bun.sleep(1000);

  // --- L-3. Start screencast BEFORE sending the task ---
  step("L-3. Start screencast (capturing full agent activity)");
  const framesDir = join(tmpdir(), `ppm-e2e-live-frames-${Date.now()}`);
  screencast = new Screencast(cdp, framesDir);
  await screencast.start();
  await Bun.sleep(500);

  // --- L-4. Submit the task (small, fast-converging: debounce helper) ---
  // Posting via REST /message is equivalent to typing in the UI composer and
  // pressing Send — it calls the same groupChatService.start() path.
  step("L-4. POST task to engine");
  const TASK =
    "Design a debounce(fn, delayMs) helper: agree on the exact function " +
    "signature, handle the leading-edge vs trailing-edge question, and name it. " +
    "Keep it under 10 lines. Close with DONE: <final signature>.";
  log(`  task: "${TASK}"`);

  const msgRes = await fetch(`${API}/api/group-chat/${liveGroupId}/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ content: TASK }),
  });
  if (!msgRes.ok) {
    // Capture screenshot of whatever loaded, then throw.
    await cdp.screenshot(join(VISUALS, "07-live-feed.png"));
    throw new Error(`Engine start failed: HTTP ${msgRes.status} — ${await msgRes.text()}`);
  }
  const msgJson = await msgRes.json();
  if (!msgJson.ok) {
    await cdp.screenshot(join(VISUALS, "07-live-feed.png"));
    throw new Error(`Engine start API error: ${JSON.stringify(msgJson)}`);
  }
  log("  engine started — agents are running...");

  // --- L-5. Poll for completion (cap 4 minutes) ---
  // Natural termination: status = "idle" (leader_done / max_turns / budget).
  // User-stop: status = "paused" (shouldn't happen here but handle it gracefully).
  step("L-5. Polling DB for engine completion (max 4 min)");
  const POLL_CAP_MS = 4 * 60 * 1000;
  const pollDeadline = Date.now() + POLL_CAP_MS;
  let finalStatus = "active";
  let polledTurns = 0;
  while (Date.now() < pollDeadline) {
    await Bun.sleep(5_000);
    const db = new Database(DEV_DB);
    const row = db
      .query("SELECT status FROM chat_groups WHERE id = ?")
      .get(liveGroupId);
    const msgCount = db
      .query("SELECT COUNT(*) as n FROM chat_group_messages WHERE group_id = ?")
      .get(liveGroupId);
    db.close();
    finalStatus = row?.status ?? "unknown";
    polledTurns = msgCount?.n ?? 0;
    log(`  poll: status=${finalStatus} messages=${polledTurns}`);
    if (finalStatus === "idle" || finalStatus === "paused") break;
  }

  const timedOut = finalStatus === "active";
  if (timedOut) {
    log("  WARN: engine still active after 4-minute cap — stopping via API");
    // Force-stop so we can still capture the partial feed.
    await fetch(`${API}/api/group-chat/${liveGroupId}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }).catch(() => {});
    await Bun.sleep(2000);
    finalStatus = "paused (timeout)";
  }

  // Let the browser's WS catch up and render the latest feed state.
  await Bun.sleep(2000);

  // --- L-6. Stop screencast + assemble MP4 ---
  step("L-6. Stop screencast + assemble live MP4");
  await screencast.stop();
  await screencast.assemble(MP4_OUT_LIVE);
  await screencast.cleanup();
  screencast = null;

  // --- L-7. Final screenshot ---
  step("L-7. Screenshot 07-live-feed.png");
  await cdp.screenshot(join(VISUALS, "07-live-feed.png"));

  // --- L-8. Read real messages from DB and report ---
  step("L-8. Reading messages from DB");
  const db = new Database(DEV_DB);
  const rows = db
    .query(
      `SELECT from_member, kind, summary, turn_index
       FROM chat_group_messages
       WHERE group_id = ?
       ORDER BY turn_index, rowid`,
    )
    .all(liveGroupId);
  const groupRow = db.query("SELECT max_turns, max_cost_usd FROM chat_groups WHERE id = ?").get(liveGroupId);
  db.close();

  log(`\n--- LIVE RUN RESULTS ---`);
  log(`  final status : ${finalStatus}`);
  log(`  total messages : ${rows.length}`);
  log(`  db maxTurns : ${groupRow?.max_turns ?? "?"}, maxCostUsd : $${groupRow?.max_cost_usd ?? "?"}`);
  if (rows.length > 0) {
    log("  messages (all):");
    for (const r of rows) {
      const preview = (r.summary ?? "").slice(0, 120).replace(/\n/g, " ");
      log(`    [turn ${r.turn_index}] <${r.from_member}> [${r.kind}] ${preview}`);
    }
  } else {
    log("  WARN: no messages found in DB — engine may have errored before producing any turns");
  }
  log(`  screenshots : ${join(VISUALS, "07-live-feed.png")}`);
  log(`  MP4         : ${MP4_OUT_LIVE}`);
  log(`------------------------\n`);

  return { liveGroupId, finalStatus, rows };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(VISUALS, { recursive: true });

  step("1. Ensure servers");
  await ensureServers();

  step("2. Reset prior e2e groups (dev DB)");
  {
    const db = new Database(DEV_DB);
    // Remove seeded group (used by screenshot + video modes)
    const prior = db.query("SELECT id FROM chat_groups WHERE name = ?").all("E2E Design Review");
    for (const row of prior) {
      db.query("DELETE FROM chat_group_messages WHERE group_id = ?").run(row.id);
      db.query("DELETE FROM chat_group_members WHERE group_id = ?").run(row.id);
      db.query("DELETE FROM chat_groups WHERE id = ?").run(row.id);
    }
    // Remove live group (used by LIVE mode) so the run always starts fresh
    const priorLive = db.query("SELECT id FROM chat_groups WHERE name = ?").all(LIVE_GROUP_NAME);
    for (const row of priorLive) {
      db.query("DELETE FROM chat_group_messages WHERE group_id = ?").run(row.id);
      db.query("DELETE FROM chat_group_members WHERE group_id = ?").run(row.id);
      db.query("DELETE FROM chat_groups WHERE id = ?").run(row.id);
    }
    log(`  removed ${prior.length} seeded + ${priorLive.length} live prior e2e group(s)`);
    db.close();
  }

  step("3. Launch Chrome + connect CDP");
  const wsUrl = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.setViewport(1280, 900, false);

  if (LIVE) {
    log("  PPM_E2E_LIVE=1 — REAL agents, REAL cost, live MP4");
    await runLive(cdp);
    step("DONE — live MP4 written");
  } else if (VIDEO) {
    log("  PPM_E2E_VIDEO=1 — recording MP4");
    await runVideo(cdp);
    step("DONE — MP4 written");
  } else {
    await runScreenshots(cdp);
    step("DONE — screenshots written");
  }
}

// ---------------------------------------------------------------------------
let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = 1;
  console.error("\n[E2E FAILED]", e?.stack || e?.message || e);
} finally {
  await cleanup();
}
process.exit(exitCode);
