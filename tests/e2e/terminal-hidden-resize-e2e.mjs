import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.env.PPM_PLAYWRIGHT_MODULE || "playwright");
// A terminal with no layout must not resize its shell. The dock's active tab is mounted even
// while the dock is hidden, and a phone always restores the dock collapsed; xterm's FitAddon
// proposes its 2x1 floor for that 0x0 box, and 2x1 sent to the PTY makes zsh corrupt its heap
// and abort on the first keystroke once the dock is opened. The size asserted here is the one
// the server really gave the PTY, read from the shell's own tty, not what xterm believes.
// Build into a scratch directory first; this runner never writes live dist or PPM data.
// PPM_E2E_DIST=/path/to/scratch/dist node tests/e2e/terminal-hidden-resize-e2e.mjs
const dist = process.env.PPM_E2E_DIST;
assert(dist, "Set PPM_E2E_DIST to an isolated compiled build's dist directory");
const root = await mkdtemp(join(tmpdir(), "ppm-terminal-hidden-resize-e2e-"));
const configModule = pathToFileURL(resolve(import.meta.dirname, "../../src/services/config.service.ts")).href;
const home = root + "/test-home", ppm = root + "/ppm", artifacts = process.env.PPM_TERMINAL_ARTIFACTS || root + "/artifacts";
await Promise.all([home, ppm, artifacts].map((p) => mkdir(p, { recursive: true })));
const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home + "/.claude", CODEX_HOME: home + "/.codex" };
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY", "PPM_ALLOW_PROD_DB"]) delete env[key];
async function cmd(exe, args) {
  const child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"] }); let output = "";
  child.stdout.on("data", (d) => output += d); child.stderr.on("data", (d) => output += d);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, 0, output); return output;
}
await writeFile(root + "/setup-test.ts", `import { configService } from ${JSON.stringify(configModule)};
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("ai", { ...configService.get("ai"), default_provider: "mock", share_provider_context: false,
providers: { mock: { type: "mock", permission_mode: "bypassPermissions" } } });`);
await cmd("bun", [root + "/setup-test.ts"]);
const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r)); const port = listener.address().port; await new Promise((r) => listener.close(r));
const origin = `http://127.0.0.1:${port}`; console.log("Isolated binary browser test", origin);
// bash with an empty HOME: a zsh there would stop at its new-user wizard.
const child = spawn(resolve(dist, "ppm"), ["__serve__", String(port), "127.0.0.1"], { env: { ...env, PATH: "/usr/bin:/bin", SHELL: "/bin/bash" }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; child.stdout.on("data", (d) => serverLog += d); child.stderr.on("data", (d) => serverLog += d);
async function until(label, fn, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw Error("Timeout: " + label); }
async function api(path, opts = {}) { const r = await fetch(origin + path, { ...opts, headers: { "Content-Type": "application/json" } }); const j = await r.json(); assert(r.ok && j.ok, JSON.stringify(j)); return j.data; }
/** The size of the PTY the server gave the shell it started in `dir`, from that shell's tty. */
function ptySize(dir) {
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) !== dir) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) !== child.pid) continue;
      const [rows, cols] = execFileSync("stty", ["-F", readlinkSync(`/proc/${pid}/fd/1`), "size"], { encoding: "utf8" }).trim().split(" ").map(Number);
      return { cols, rows };
    } catch {}
  }
  return null;
}
let browser; const results = [];
try {
  await until("binary healthy", async () => { const r = await fetch(origin + "/api/health"); return (await r.json()).ok; }, 60000);
  browser = await chromium.launch({ headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });
  for (const [device, options] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["mobile", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]]) {
    const name = "hidden-terminal-" + device, project = root + "/project-" + device, main = "main-" + device;
    await mkdir(project, { recursive: true });
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name, path: project }) });
    const terminalTab = { id: "dock-terminal-" + device, type: "terminal", title: "Terminal", projectId: name, closable: true, metadata: { projectName: name } };
    // The terminal is the dock's active tab and the dock is closed: hidden on the desktop, and
    // saved open on the phone, which collapses it on restore anyway.
    await api(`/api/project/${name}/workspace`, { method: "PUT", body: JSON.stringify({ layout: {
      panels: { [main]: { id: main, tabs: [], activeTabId: null, tabHistory: [] } }, grid: [[main]], focusedPanelId: main,
      dock: { visible: device === "mobile", height: 30 },
      dockPanel: { id: "__dock__", tabs: [terminalTab], activeTabId: terminalTab.id, tabHistory: [terminalTab.id] },
    } }) });
    const context = await browser.newContext({ ...options, serviceWorkers: "block" });
    await context.addInitScript(() => localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null })));
    const page = await context.newPage(), errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${origin}/project/${name}`);

    // The hidden terminal still connects, so its shell exists; the size its socket sends on
    // open lands just after, hence the second read.
    await until("a shell for the hidden terminal", () => ptySize(project), 30000);
    await page.waitForTimeout(1500);
    const hidden = ptySize(project);
    results.push({ device, step: "dock hidden", pty: hidden });
    assert(hidden.cols >= 20 && hidden.rows >= 2, `${device}: the hidden terminal resized its shell to ${hidden.cols}x${hidden.rows}`);

    if (device === "desktop") {
      // Shown, it is fitted to the dock: the guard must not stop a terminal that has a size.
      await page.getByRole("button", { name: "Show panel" }).click();
      const shown = await until("the shell sized to the open dock", () => { const s = ptySize(project); return s && s.cols > 80 && s; }, 15000);
      results.push({ device, step: "dock shown", pty: shown });
      await page.screenshot({ path: `${artifacts}/${device}-dock-shown.png` });
    }
    assert.deepEqual(errors, [], `${device}: page errors`);
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, origin, artifacts, results }, null, 2));
} catch (error) {
  process.exitCode = 1; console.error(error);
  console.error(JSON.stringify({ results }, null, 2));
} finally {
  await writeFile(artifacts + "/results.json", JSON.stringify({ origin, artifacts, results, passed: !process.exitCode }, null, 2));
  await writeFile(artifacts + "/server.log", serverLog); await browser?.close(); child.kill("SIGTERM");
}
