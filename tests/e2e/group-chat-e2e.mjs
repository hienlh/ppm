// Group-chat feature — real browser end-to-end harness (headless Chrome via raw CDP).
//
// What it does (repeatable):
//   1. Starts `bun dev:server` (8081) + `bun dev:web` (5173) if not already up, waits for both.
//   2. Launches headless Chrome, sets the auth token in localStorage, drives the real app.
//   3. Selects the `ppm` project, opens the Teams sidebar, creates a group via the UI dialog.
//   4. SEEDS the durable bus (chat_group_messages) directly — NO live Claude turns (cost guard).
//      Seeding uses the exact store the feed reads, so the RENDER is 100% real.
//   5. Captures the required screenshots (desktop + mobile) into the plan visuals dir.
//   6. Stops ONLY the servers it started, by exact PID.
//
// Run:
//   bun tests/e2e/group-chat-e2e.mjs
//
// Env overrides:
//   PPM_E2E_KEEP=1        keep servers + group running after the run (debugging)
//   PPM_E2E_NO_SERVERS=1  assume servers already running; don't spawn/kill them
//   CHROME_PATH=...       override Chrome executable path
//
// Notes:
//   - Host Bun is fine for servers/scripts here; the known segfault only affects `bun test`/`tsc`.
//   - Seeded content is clearly labelled "[SEED]" in the report output below.

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
// /project/:name → urlState.projectName → app.tsx setActiveProject). This is
// far more reliable than DOM-clicking a project switcher.
const WEB_PROJECT = `${WEB}/project/${encodeURIComponent("ppm")}`;
const CDP_PORT = 9222;
const DEV_DB = join(homedir(), ".ppm", "ppm.dev.db");
const PROJECT_NAME = "ppm";
const PROJECT_PATH = "c:/Users/PC/ppm"; // exact path stored in dev DB (GroupList scopes by path)
const VISUALS = join(REPO, "plans", "260724-1931-group-chat-native-engine", "visuals");
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const KEEP = !!process.env.PPM_E2E_KEEP;
const NO_SERVERS = !!process.env.PPM_E2E_NO_SERVERS;

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
// Raw CDP driver (single-target, over the page WebSocket)
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

  // Wait for the DevTools HTTP endpoint, then grab the page target ws URL.
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

// Open the Teams sidebar panel by clicking the rail/nav button that carries a
// "Teams" aria-label / title / text.
const OPEN_TEAMS_JS = `(() => {
  const nodes = Array.from(document.querySelectorAll('button,[role="button"],a'));
  const teams = nodes.find((n) => {
    const t = (n.getAttribute('aria-label')||'') + ' ' + (n.getAttribute('title')||'') + ' ' + (n.textContent||'');
    return /\\bTeams\\b/i.test(t);
  });
  if (teams) teams.click();
  return !!teams;
})()`;

// The sidebar collapse state is a server-persisted UI pref, so a machine that
// last used it collapsed will boot collapsed (rail only). Click the "Expand
// sidebar" affordance if present so the Teams panel is actually readable.
const EXPAND_SIDEBAR_JS = `(() => {
  const btns = Array.from(document.querySelectorAll('button,[role="button"]'));
  const expand = btns.find((b) => /Expand sidebar/i.test(b.getAttribute('title')||''));
  if (expand) { expand.click(); return true; }
  return false;
})()`;

// Navigate to the project deep-link (auto-activates ppm), wait for the app,
// then ensure the sidebar is expanded and the Teams panel is open. Used before
// every group-list screenshot so the run survives full reloads.
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

// ---------------------------------------------------------------------------
// Bus seeding — writes directly through the same store the feed reads.
// Labelled [SEED] in the report; no live Claude turns are triggered.
// ---------------------------------------------------------------------------
async function seedBus(groupId, memberNames) {
  // Writes through the exact same INSERT shape as group-chat.store.appendMessage
  // (id, group_id, from_member, to_member, kind, summary, full_session_ref,
  //  data, turn_index) — this is the precise data path the feed reads, so the
  //  RENDER is 100% real. Uses bun:sqlite directly (own process) to avoid a
  //  second migrating DB handle racing the dev server's open connection.
  const leader = memberNames.leader;
  const [m1, m2] = memberNames.members;
  const fakeSessionRef = "00000000-0000-4000-8000-000000000abc"; // valid UUID shape; archive absent → 404 fallback

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
      // Scoped to the exact PID tree — never a blanket image-name kill.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
    log(`  killed ${name} (pid ${child.pid})`);
  } catch (e) {
    log(`  failed to kill ${name}: ${e.message}`);
  }
}

// Kill whatever process is listening on a TCP port (Windows). Used to reap the
// `bun --hot` child that survives a parent-PID taskkill. Scoped to the exact
// PID on the port — never a blanket image-name kill.
async function killPort(port) {
  if (process.platform !== "win32") return;
  try {
    const proc = Bun.spawnSync([
      "powershell",
      "-Command",
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
    // Reap any --hot children that outlived the parent PID.
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
// Main flow
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(VISUALS, { recursive: true });

  step("1. Ensure servers");
  await ensureServers();

  // Clean any prior e2e group so the run is idempotent.
  step("2. Reset prior e2e groups (dev DB)");
  {
    const db = new Database(DEV_DB);
    const prior = db
      .query("SELECT id FROM chat_groups WHERE name = ?")
      .all("E2E Design Review");
    for (const row of prior) {
      db.query("DELETE FROM chat_group_messages WHERE group_id = ?").run(row.id);
      db.query("DELETE FROM chat_group_members WHERE group_id = ?").run(row.id);
      db.query("DELETE FROM chat_groups WHERE id = ?").run(row.id);
    }
    log(`  removed ${prior.length} prior e2e group(s)`);
    db.close();
  }

  step("3. Launch Chrome + connect CDP");
  const wsUrl = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.setViewport(1280, 900, false);

  step("4. Set auth token (web origin, before app boots)");
  await cdp.navigate(WEB);
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(AUTH_TOKEN)})`);

  step("5+6. Deep-link to /project/ppm (auto-activates project) + open Teams");
  await gotoTeams(cdp);

  // Sanity: GroupList must NOT show the empty-state placeholder.
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
  await Bun.sleep(400);

  step("8. Fill roster + screenshot 02-create-dialog");
  await cdp.evaluate(
    setReactInputExpr(`document.querySelector('input[placeholder="e.g. Design Review"]')`, "E2E Design Review"),
  );
  await cdp.evaluate(
    setReactInputExpr(`document.querySelector('input[placeholder="Leader name"]')`, "Nova"),
  );
  await cdp.evaluate(
    setReactInputExpr(`document.querySelector('input[placeholder="Persona (optional)"]')`, "Lead engineer, keeps scope tight"),
  );
  // First "Member name" field.
  await cdp.evaluate(
    setReactInputExpr(`document.querySelector('input[placeholder="Member name"]')`, "Ivy"),
  );
  // Add a second member so the roster has 2.
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim() === 'Add');
  })()`);
  await Bun.sleep(300);
  await cdp.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('input[placeholder="Member name"]'));
    const el = inputs[inputs.length - 1];
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'Rhea');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await Bun.sleep(400);
  await cdp.screenshot(join(VISUALS, "02-create-dialog.png"));

  step("9. Submit create group");
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim().replace(/\\s+/g,' ') === 'Create group');
  })()`);
  // Group creation opens the group tab. Wait for the composer to appear.
  await waitFor(
    cdp,
    `document.querySelector('textarea[placeholder="Message the group…"]')`,
    "group tab opened",
    20_000,
  );
  await Bun.sleep(800);

  step("10. Look up the created group id from dev DB");
  let groupId, memberNames;
  {
    // Poll: the POST /api/group-chat write may lag the UI's tab-open slightly.
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
    groupId = g.id;
    const db = new Database(DEV_DB);
    const mem = db
      .query("SELECT name, role FROM chat_group_members WHERE group_id = ? ORDER BY joined_at, id")
      .all(groupId);
    db.close();
    const leader = mem.find((m) => m.role === "leader")?.name ?? "Nova";
    const members = mem.filter((m) => m.role === "member").map((m) => m.name);
    memberNames = { leader, members: members.length ? members : ["Ivy", "Rhea"] };
    log(`  group id: ${groupId} | leader: ${leader} | members: ${members.join(", ")}`);
  }

  step("11. [SEED] append realistic bus messages (NO live Claude turns)");
  const seeded = await seedBus(groupId, memberNames);
  log(`  seeded ${seeded} bus messages (exact appendMessage INSERT shape into chat_group_messages)`);

  step("12. Screenshot 01-teams-sidebar (group listed)");
  // Reload via deep-link so the newly seeded group appears in the Teams list.
  await gotoTeams(cdp);
  await waitFor(cdp, `document.body.innerText.includes('E2E Design Review')`, "group in Teams list", 10_000);
  await Bun.sleep(400);
  await cdp.screenshot(join(VISUALS, "01-teams-sidebar.png"));

  step("13. Open the group tab + roster + screenshot 03-feed-desktop");
  await cdp.setViewport(1280, 900, false);
  // Open the group from the Teams sidebar list (real UX). Match the list button
  // (has the Users icon) rather than an already-open tab title.
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.trim() === 'E2E Design Review')
        || btns.find((b) => b.textContent && b.textContent.includes('E2E Design Review'));
  })()`);
  await waitFor(cdp, `document.body.innerText.includes('DONE') || document.querySelector('textarea[placeholder="Message the group…"]')`, "feed loaded");
  await Bun.sleep(600);
  // Open the roster panel; retry until the "Members" header renders so the
  // screenshot reliably shows feed + roster + composer + status dot.
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

  step("14. Screenshot 06-view-full (transcript 404 graceful fallback)");
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
      "transcript view",
      8000,
    );
    await Bun.sleep(600);
    await cdp.screenshot(join(VISUALS, "06-view-full.png"));
    // Close the dialog.
    await cdp.evaluate(`(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const overlay = document.querySelector('[data-state="open"]');
      return true;
    })()`);
    await Bun.sleep(500);
  } else {
    log("  WARN: no 'View full transcript' button found — skipping 06");
  }

  step("15. Screenshot 05-stop-or-resume (set status=paused → Resume control)");
  {
    const db = new Database(DEV_DB);
    db.query("UPDATE chat_groups SET status = 'paused' WHERE id = ?").run(groupId);
    db.close();
  }
  // Reload so WS group_state re-broadcasts the paused status → Resume button.
  await gotoTeams(cdp);
  await waitFor(cdp, `document.body.innerText.includes('E2E Design Review')`, "group in Teams (paused)", 10_000);
  await clickEl(cdp, `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent && b.textContent.includes('E2E Design Review'));
  })()`);
  await waitFor(
    cdp,
    `Array.from(document.querySelectorAll('button')).some((b)=>/Resume|Stop/.test(b.textContent||'')) || document.body.innerText.toLowerCase().includes('paused')`,
    "stop/resume control",
    10_000,
  );
  await Bun.sleep(800);
  await cdp.screenshot(join(VISUALS, "05-stop-or-resume.png"));

  step("16. Screenshot 04-feed-mobile (390x844)");
  // Reset status to active so the mobile feed shows the live status dot, then
  // deep-link straight to the group tab (/project/ppm/group/:id) — reliable on
  // mobile where the roster/panel lives behind a drawer.
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
    "mobile group tab",
    20_000,
  );
  await Bun.sleep(1200);
  await cdp.screenshot(join(VISUALS, "04-feed-mobile.png"));

  step("DONE — screenshots written to plan visuals dir");
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
