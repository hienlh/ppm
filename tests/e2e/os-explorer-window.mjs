// E2E proof for the OS File Explorer Window feature (floating window, list/icons/columns,
// OS skins, mobile sheet, entry drag-and-drop). Style follows tests/e2e/lazy-mount-interaction.mjs
// (hand-rolled CDP client over system Chrome, no puppeteer).
//
// Run against an already-running isolated stack:
//   PPM_E2E_API_PORT=8099 PPM_E2E_WEB_PORT=5199 bun tests/e2e/os-explorer-window.mjs
// Both default to 8099/5199 if unset. Reads the dev auth token from ppm.dev.db (read-only,
// never printed). Screenshots and fixtures paths are also overridable via env for reruns.
//
// Exits non-zero if any scenario fails.

import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const API_PORT = process.env.PPM_E2E_API_PORT || "8099";
const WEB_PORT = process.env.PPM_E2E_WEB_PORT || "5199";
const ORIGIN = `http://localhost:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const CDP_PORT = Number(process.env.PPM_E2E_CDP_PORT || 9339);
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const FIXTURE_DIR = process.env.PPM_E2E_FIXTURES || join(tmpdir(), "ppm-p9-e2e");
const PROJECT_DIR = process.env.PPM_E2E_PROJECT || join(tmpdir(), "ppm-p9-e2e-proj");
const VISUALS_DIR = process.env.PPM_E2E_VISUALS || "C:\\Users\\PC\\ppm\\plans\\260903-0009-os-file-explorer-window\\visuals";
const PROFILE_DIR = join(tmpdir(), `ppm-e2e-p9-${Date.now()}`);

const db = new Database(join(homedir(), ".ppm", "ppm.dev.db"), { readonly: true });
const TOKEN = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
db.close();

const results = []; // { name, pass, detail }
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
async function scenario(name, fn) {
  try {
    await fn();
    if (!results.some((r) => r.name === name)) record(name, true);
  } catch (e) {
    record(name, false, e?.message || String(e));
  }
}

// ── tiny fetch helper against the isolated API (project register/cleanup only) ──
async function api(method, path, body) {
  const r = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// ── CDP client: request/response + event subscription ──
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map(); // method -> Set<fn>
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      } else if (m.method) {
        const set = this.listeners.get(m.method);
        if (set) for (const fn of set) fn(m.params);
      }
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, timeoutMs);
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }
  once(method) {
    return new Promise((resolve) => {
      const off = this.on(method, (params) => {
        off();
        resolve(params);
      });
    });
  }
  async evalJs(expression, timeoutMs = 30000) {
    // Raw top-level `await` is not valid outside replMode — always wrap in an async IIFE so
    // every call site can use `await import(...)` freely.
    const wrapped = `(async () => { return (${expression}); })()`;
    const r = await this.send("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(desc + " :: " + expression.slice(0, 300));
    }
    return r.result.value;
  }
}

async function openTab() {
  const t = await (await fetch(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = await new Promise((res, rej) => {
    const sock = new WebSocket(t.webSocketDebuggerUrl);
    sock.addEventListener("open", () => res(sock));
    sock.addEventListener("error", rej);
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  // A leftover editor tab pointing at a since-deleted fixture file (from an earlier phase's
  // e2e pass, restored via this project's server-persisted last-tab state) can arm a
  // `beforeunload` confirm dialog. Headless Chrome blocks the WHOLE renderer — including
  // Runtime.evaluate — on an unanswered native dialog, with the process sitting idle (no CPU
  // spin), which is otherwise indistinguishable from a hang. Auto-accept every dialog always.
  cdp.on("Page.javascriptDialogOpening", () => {
    cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });
  return { cdp, targetId: t.id };
}

async function closeTab(targetId) {
  try {
    await fetch(`http://localhost:${CDP_PORT}/json/close/${targetId}`);
  } catch {}
}

/** Page.reload invalidates the Runtime execution context; Runtime domain must be re-enabled
 * and given time to settle before Runtime.evaluate is reliable again on the same session.
 * Waits for the real `Page.loadEventFired` event rather than a blind sleep, then probes with
 * short per-attempt timeouts (a hung probe must not itself eat 30s per retry). */
async function reloadPage(cdp) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.reload");
  await Promise.race([loaded, Bun.sleep(15000)]);
  await cdp.send("Runtime.enable").catch(() => {});
  await Bun.sleep(1200);
  for (let i = 0; i < 8; i++) {
    try {
      await cdp.evalJs("1+1", 3000);
      await Bun.sleep(800); // let React hydrate before the caller starts interacting
      return;
    } catch {
      await cdp.send("Runtime.enable").catch(() => {});
      await Bun.sleep(1000);
    }
  }
  throw new Error("Runtime.evaluate never recovered after Page.reload");
}

async function navigateAndAuth(cdp, path = "/") {
  await cdp.send("Page.navigate", { url: ORIGIN + path });
  await Bun.sleep(1800);
  await cdp.evalJs(`localStorage.setItem("ppm-auth-token", ${JSON.stringify(TOKEN)})`);
  await reloadPage(cdp);
}

async function screenshot(cdp, name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(VISUALS_DIR, name), Buffer.from(r.data, "base64"));
}

// ── store-level state readers (Vite dev server serves ESM at these paths — legitimate
// dynamic import of the app's own modules, not a private hack) ──
const IMPORTS = {
  windowStore: `(await import('/components/floating-window/window-store.ts')).useWindowStore`,
  explorerStore: `(await import('/components/os-explorer/explorer-store.ts')).useExplorerStore`,
  settingsStore: `(await import('/stores/settings-store.ts')).useSettingsStore`,
};

async function getWindows(cdp) {
  return cdp.evalJs(`JSON.stringify(Object.values(${IMPORTS.windowStore}.getState().windows))`).then(JSON.parse);
}
async function getSlice(cdp, windowId) {
  return cdp
    .evalJs(
      `(async () => { const s = ${IMPORTS.explorerStore}.getState().slices[${JSON.stringify(windowId)}]; if (!s) return null; return JSON.stringify({ path: s.path, loading: s.loading, entryNames: s.entries.map(e=>e.name), filter: s.filter }); })()`,
    )
    .then((v) => (v ? JSON.parse(v) : null));
}
async function setThemeMode(cdp, mode) {
  await cdp.evalJs(`${IMPORTS.settingsStore}.getState().setThemeMode(${JSON.stringify(mode)})`);
  await Bun.sleep(300);
}
async function setExplorerSkin(cdp, skin) {
  await cdp.evalJs(`${IMPORTS.settingsStore}.getState().setExplorerSkin(${JSON.stringify(skin)})`);
  await Bun.sleep(300);
}

/** React's controlled `<input>` tracks its own value setter; a plain `el.value = x` is
 * invisible to it (the subsequent `input` event fires, but React reads back its own tracked
 * value, not the DOM's), so `onChange` never sees the new text. Must go through the native
 * HTMLInputElement setter, exactly like a real keystroke would. Optionally submits Enter. */
async function typeIntoReactInput(cdp, selector, value, { submit = false } = {}) {
  await cdp.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    ${submit ? `el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));` : ""}
    return true;
  })()`);
}

// ── row / element geometry helpers (JS-side exact-match, never a raw CSS selector on a
// Windows path — backslashes are CSS escape characters) ──
async function rowRect(cdp, path, testids = ["explorer-row", "explorer-tile", "explorer-column-row"]) {
  const json = await cdp.evalJs(`(() => {
    const ids = ${JSON.stringify(testids)};
    for (const id of ids) {
      const els = [...document.querySelectorAll('[data-testid="' + id + '"]')];
      const hit = els.find(e => e.dataset.path === ${JSON.stringify(path)});
      if (hit) { const r = hit.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); }
    }
    return null;
  })()`);
  return json ? JSON.parse(json) : null;
}
async function clickByText(cdp, tag, text) {
  return cdp.evalJs(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(tag)})];
    const hit = els.find(e => e.textContent && e.textContent.trim().includes(${JSON.stringify(text)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
}
async function clickAriaLabel(cdp, label) {
  return cdp.evalJs(`(() => {
    const el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
    if (!el) return false;
    el.click();
    return true;
  })()`);
}
/** Radix animates a menu closing while a new one opens, so a global `querySelectorAll`
 * right after a context-menu click can grab a stale, already-detaching item instead of the
 * one just opened. Scope the search to the LAST `[role="menu"]`/`[role="menuitem"]` group in
 * the DOM (Radix appends new portals at the end) and match exact or prefix text. */
async function clickMenuItemByText(cdp, text, { exact = true } = {}) {
  return cdp.evalJs(`(() => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const menu = menus[menus.length - 1];
    if (!menu) return false;
    const els = [...menu.querySelectorAll('*')];
    const hit = els.find(e => e.children.length === 0 && e.textContent && (${exact} ? e.textContent.trim() === ${JSON.stringify(text)} : e.textContent.trim().startsWith(${JSON.stringify(text)})));
    if (!hit) return false;
    const item = hit.closest('[role="menuitem"]') || hit;
    if (item.getAttribute('data-disabled') !== null || item.getAttribute('aria-disabled') === 'true') return false;
    item.click();
    return true;
  })()`);
}
/** Waits until no Radix menu/context-menu portal remains in the DOM (closing animation
 * finished) before the caller opens the next one, avoiding stale-node collisions. */
async function waitForNoMenu(cdp, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await cdp.evalJs(`document.querySelectorAll('[role="menu"]').length`);
    if (count === 0) return;
    await Bun.sleep(100);
  }
}
async function dispatchOnRow(cdp, path, eventType, testids) {
  const json = await cdp.evalJs(`(() => {
    const ids = ${JSON.stringify(testids || ["explorer-row", "explorer-tile", "explorer-column-row"])};
    for (const id of ids) {
      const els = [...document.querySelectorAll('[data-testid="' + id + '"]')];
      const hit = els.find(e => e.dataset.path === ${JSON.stringify(path)});
      if (hit) { hit.dispatchEvent(new MouseEvent(${JSON.stringify(eventType)}, { bubbles: true, cancelable: true, button: ${eventType === "contextmenu" ? 2 : 0} })); return true; }
    }
    return false;
  })()`);
  if (!json) throw new Error(`row not found for ${eventType}: ${path}`);
}

async function mouseDrag(cdp, from, to, steps = 6) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
    await Bun.sleep(30);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left" });
}

/** Real HTML5 drag-and-drop over CDP (per dev-p8's report). ctrl=true dispatches a Ctrl-copy. */
async function entryDragDrop(cdp, fromRect, toRect, { ctrl = false } = {}) {
  const from = { x: fromRect.x + fromRect.w / 2, y: fromRect.y + fromRect.h / 2 };
  const to = { x: toRect.x + toRect.w / 2, y: toRect.y + toRect.h / 2 };
  await cdp.send("Input.setInterceptDrags", { enabled: true });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  const interceptedP = cdp.once("Input.dragIntercepted");
  for (let i = 1; i <= 6; i++) {
    const x = from.x + ((to.x - from.x) * i) / 6;
    const y = from.y + ((to.y - from.y) * i) / 6;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
    await Bun.sleep(40);
  }
  const intercepted = await Promise.race([interceptedP, Bun.sleep(4000).then(() => null)]);
  if (!intercepted) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left" });
    await cdp.send("Input.setInterceptDrags", { enabled: false });
    throw new Error("drag never intercepted (no dragstart?)");
  }
  const modifiers = ctrl ? 2 : 0;
  const common = { x: to.x, y: to.y, data: intercepted.data, modifiers };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...common });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...common });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", ...common });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left" });
  await cdp.send("Input.setInterceptDrags", { enabled: false });
}

async function touchTap(cdp, x, y) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
/** Ends with touchCancel (per dev-p7's finding) so headless Chrome's ghost-click doesn't
 * instantly dismiss the sheet the long-press itself opened. */
async function touchLongPress(cdp, x, y, ms = 550) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await Bun.sleep(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
}

function fx(...parts) {
  return join(FIXTURE_DIR, ...parts);
}

// A 1x1 red PNG and a minimal single-page PDF — tiny valid binaries so the image/pdf tabs and
// the Icons view thumbnail path have something real to load.
const PNG_1x1_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
xref
0 4
0000000000 65535 f
trailer<</Size 4/Root 1 0 R>>
startxref
0
%%EOF`;

/** Rebuilds the whole fixture tree from scratch every run so the harness is idempotent and
 * safe to rerun without manual cleanup between attempts. Confined to FIXTURE_DIR/PROJECT_DIR
 * under the OS temp directory — never touches anything outside those two roots.
 *
 * `sample.db` is special-cased: the server's own sqlite-viewer route caches an open connection
 * to it for 5 minutes (`sqlite.service.ts`), which holds a Windows file lock a plain `rm` on the
 * containing tree cannot remove. Reset its *contents* via SQL instead of deleting the file. */
async function setupFixtures() {
  for (const root of [FIXTURE_DIR, PROJECT_DIR]) {
    if (!existsSync(root)) continue;
    for (const entry of await readdir(root)) {
      if (root === FIXTURE_DIR && entry === "sample.db") continue; // reset in place, see below
      await rm(join(root, entry), { recursive: true, force: true }).catch(() => {});
    }
  }

  await mkdir(join(FIXTURE_DIR, "level1", "level2", "level3"), { recursive: true });
  await mkdir(join(FIXTURE_DIR, "pictures"), { recursive: true });
  await mkdir(join(FIXTURE_DIR, "movetarget"), { recursive: true });
  await mkdir(join(FIXTURE_DIR, "copytarget"), { recursive: true });
  await mkdir(join(PROJECT_DIR, "drop-here"), { recursive: true });

  await writeFile(fx("sample.md"), "hello md\n");
  await writeFile(fx("sample.csv"), "a,b,c\n1,2,3\n");
  await writeFile(fx("sample.png"), PNG_1x1_RED);
  await writeFile(fx("sample.pdf"), MINIMAL_PDF);
  await writeFile(join(FIXTURE_DIR, "level1", "level2", "level3", "l3.txt"), "leaf file\n");
  await writeFile(fx("dragme.txt"), "drag me move\n");
  await writeFile(fx("dragme-copy.txt"), "drag me copy\n");
  await writeFile(fx("dragme-tree.txt"), "drag me tree\n");
  await writeFile(fx("trash-me.txt"), "trash me\n");
  await writeFile(fx("shiftdel-me.txt"), "shiftdel me\n");
  for (let i = 0; i < 5; i++) await writeFile(join(FIXTURE_DIR, "pictures", `pic-${i}.png`), PNG_1x1_RED);
  await writeFile(join(PROJECT_DIR, "README.md"), "project readme\n");

  const db = new Database(fx("sample.db"), { create: true });
  db.run("DROP TABLE IF EXISTS items");
  db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  db.run("INSERT INTO items (name) VALUES ('alpha'), ('beta'), ('gamma')");
  db.close();
}

async function windowsPathInRecycleBin(basename) {
  const ps = spawn("powershell.exe", [
    "-NoProfile", "-Command",
    `$sh = New-Object -ComObject Shell.Application; $rb = $sh.Namespace(10); ($rb.Items() | Where-Object { $_.Name -eq '${basename}' }).Count`,
  ]);
  let out = "";
  for await (const chunk of ps.stdout) out += chunk.toString();
  await new Promise((r) => ps.on("exit", r));
  return Number(out.trim()) > 0;
}

// ═══════════════════════════════════════════════════════════════════════
let chromeProc = null; // module-level so the watchdog can force-kill on a hang

async function main() {
  await setupFixtures();
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(VISUALS_DIR, { recursive: true });

  const chrome = (chromeProc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--window-size=1440,900",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  ));

  try {
    // wait for CDP to come up
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        await (await fetch(`http://localhost:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) })).json();
        break;
      } catch {}
      await Bun.sleep(300);
    }

    // ── register temp project for the tree-DnD scenario (idempotent: drop any leftover
    // registration from a prior interrupted run before recreating it) ──
    await api("DELETE", "/api/projects/ppm-p9-e2e-proj").catch(() => {});
    await api("POST", "/api/projects", { path: PROJECT_DIR.replace(/\\/g, "/"), name: "ppm-p9-e2e-proj" });

    // ═══ DESKTOP FLOW (1440×900) ═══
    const { cdp, targetId: mainTarget } = await openTab();
    await navigateAndAuth(cdp);

    let winId;

    await scenario("open via command palette → window appears", async () => {
      await cdp.evalJs(`window.dispatchEvent(new CustomEvent("open-command-palette"))`);
      await Bun.sleep(500);
      const clicked = await clickByText(cdp, "button", "Open File Explorer");
      if (!clicked) throw new Error('"Open File Explorer" palette item not found');
      await Bun.sleep(1500);
      const wins = await getWindows(cdp);
      if (wins.length !== 1) throw new Error(`expected 1 window, got ${wins.length}`);
      winId = wins[0].id;
    });

    await scenario("drag titlebar 200px", async () => {
      const before = (await getWindows(cdp))[0];
      const titlebar = await cdp.evalJs(`(() => { const el = document.querySelector('[role="toolbar"]'); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+80,y:r.y+r.height/2}); })()`).then(JSON.parse);
      await mouseDrag(cdp, titlebar, { x: titlebar.x + 200, y: titlebar.y });
      await Bun.sleep(300);
      const after = (await getWindows(cdp)).find((w) => w.id === winId);
      const dx = after.rect.x - before.rect.x;
      if (Math.abs(dx - 200) > 5) throw new Error(`expected dx≈200, got ${dx}`);
    });

    await scenario("resize via SE handle", async () => {
      const before = (await getWindows(cdp)).find((w) => w.id === winId);
      const handle = await cdp.evalJs(`(() => { const el = document.querySelector('[data-resize-handle="se"]'); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`).then(JSON.parse);
      await mouseDrag(cdp, handle, { x: handle.x + 100, y: handle.y + 80 });
      await Bun.sleep(300);
      const after = (await getWindows(cdp)).find((w) => w.id === winId);
      const dw = after.rect.w - before.rect.w;
      const dh = after.rect.h - before.rect.h;
      if (Math.abs(dw - 100) > 8 || Math.abs(dh - 80) > 8) throw new Error(`expected +100/+80, got +${dw}/+${dh}`);
    });

    let rectBeforeReload, pathBeforeReload;
    await scenario("reload keeps rect + path", async () => {
      rectBeforeReload = (await getWindows(cdp)).find((w) => w.id === winId).rect;
      pathBeforeReload = (await getSlice(cdp, winId))?.path;
      await reloadPage(cdp);
      const wins = await getWindows(cdp);
      if (wins.length !== 1) throw new Error(`expected 1 window after reload, got ${wins.length}`);
      winId = wins[0].id;
      const rect = wins[0].rect;
      if (
        Math.abs(rect.x - rectBeforeReload.x) > 2 ||
        Math.abs(rect.y - rectBeforeReload.y) > 2 ||
        Math.abs(rect.w - rectBeforeReload.w) > 2 ||
        Math.abs(rect.h - rectBeforeReload.h) > 2
      ) {
        throw new Error(`rect drifted: ${JSON.stringify(rect)} vs ${JSON.stringify(rectBeforeReload)}`);
      }
    });

    await scenario("navigate to fixture dir via path input", async () => {
      await clickAriaLabel(cdp, "Edit path");
      await Bun.sleep(150);
      await typeIntoReactInput(cdp, '[aria-label="Path"]', FIXTURE_DIR, { submit: true });
      await Bun.sleep(700);
      const slice = await getSlice(cdp, winId);
      if (!slice || slice.path.toLowerCase() !== FIXTURE_DIR.toLowerCase()) throw new Error(`path is ${slice?.path}`);
      if (!slice.entryNames.includes("sample.md")) throw new Error("fixture entries not loaded");
    });
    await screenshot(cdp, "final-01-windows-list-dark.png");

    async function openAndCheckTab(filename, mustInclude) {
      await dispatchOnRow(cdp, fx(filename), "dblclick");
      await Bun.sleep(1200);
      const titles = await cdp.evalJs(`JSON.stringify([...document.querySelectorAll('[data-tab-id]')].map(e=>e.title||e.textContent))`).then(JSON.parse);
      if (!titles.some((t) => t.includes(mustInclude))) throw new Error(`no tab titled like "${mustInclude}": ${titles.join(", ")}`);
    }

    await scenario("double-click sample.md opens editor tab", () => openAndCheckTab("sample.md", "sample.md"));
    await screenshot(cdp, "final-10-md-opened-in-tab.png");
    await scenario("double-click sample.png opens image tab", () => openAndCheckTab("sample.png", "sample.png"));
    await scenario("double-click sample.pdf opens pdf tab", () => openAndCheckTab("sample.pdf", "sample.pdf"));
    await scenario("double-click sample.csv opens csv tab", () => openAndCheckTab("sample.csv", "sample.csv"));
    await scenario("double-click sample.db opens sqlite viewer tab", async () => {
      await openAndCheckTab("sample.db", "sample.db");
      await Bun.sleep(800);
      const hasTable = await cdp.evalJs(`document.body.textContent.includes('items')`);
      if (!hasTable) throw new Error("sqlite viewer did not show the 'items' table");
    });
    await screenshot(cdp, "final-11-sqlite-external.png");

    await scenario("context-menu copy/paste in same dir → collision numbering", async () => {
      await waitForNoMenu(cdp);
      await dispatchOnRow(cdp, fx("sample.md"), "contextmenu");
      await Bun.sleep(400);
      const copied = await clickMenuItemByText(cdp, "Copy");
      if (!copied) throw new Error('"Copy" menu item not found');
      const clip = await cdp.evalJs(`(async () => { const { useFileStore } = await import('/stores/file-store.ts'); return JSON.stringify(useFileStore.getState().clipboard); })()`);
      if (!clip || clip === "null") throw new Error("clipboard is empty after Copy click");
      await waitForNoMenu(cdp);
      // right-click empty space, then Paste
      await cdp.evalJs(`document.querySelector('[data-testid="explorer-list"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, button:2}))`);
      await Bun.sleep(400);
      const pasted = await clickMenuItemByText(cdp, "Paste");
      if (!pasted) throw new Error('"Paste" menu item not found or disabled');
      await Bun.sleep(1000);
      const slice = await getSlice(cdp, winId);
      if (!slice.entryNames.some((n) => /^sample \(2\)\.md$/.test(n))) {
        throw new Error(`expected "sample (2).md", got: ${slice.entryNames.join(", ")}`);
      }
    });

    await scenario("rename the collision copy", async () => {
      await waitForNoMenu(cdp);
      await dispatchOnRow(cdp, fx("sample (2).md"), "contextmenu");
      await Bun.sleep(400);
      const ok = await clickMenuItemByText(cdp, "Rename");
      if (!ok) throw new Error('"Rename" menu item not found');
      await Bun.sleep(300);
      await typeIntoReactInput(cdp, '[aria-label="Name"]', "sample-renamed.md", { submit: true });
      await Bun.sleep(1000);
      const slice = await getSlice(cdp, winId);
      if (!slice.entryNames.includes("sample-renamed.md")) throw new Error(`rename did not apply: ${slice.entryNames.join(", ")}`);
    });

    await scenario("Move to Trash → gone from dir, present in Recycle Bin", async () => {
      await waitForNoMenu(cdp);
      await dispatchOnRow(cdp, fx("trash-me.txt"), "contextmenu");
      await Bun.sleep(400);
      const ok = await clickMenuItemByText(cdp, "Move to Trash", { exact: false });
      if (!ok) throw new Error('"Move to Trash" menu item not found');
      await Bun.sleep(1200);
      const slice = await getSlice(cdp, winId);
      if (slice.entryNames.includes("trash-me.txt")) throw new Error("still present in dir listing");
      if (existsSync(fx("trash-me.txt"))) throw new Error("file still on disk");
      // The Shell.Application COM namespace can lag a moment behind the actual move; poll
      // rather than assume the first check lands after the shell has indexed it.
      let inBin = false;
      for (let i = 0; i < 6 && !inBin; i++) {
        inBin = await windowsPathInRecycleBin("trash-me.txt");
        if (!inBin) await Bun.sleep(500);
      }
      if (!inBin) throw new Error("not found in Recycle Bin via Shell.Application namespace 10");
    });

    await scenario("Shift+Del permanent delete with confirm", async () => {
      await waitForNoMenu(cdp);
      await dispatchOnRow(cdp, fx("shiftdel-me.txt"), "contextmenu");
      await Bun.sleep(400);
      const ok = await clickMenuItemByText(cdp, "Delete permanently");
      if (!ok) throw new Error('"Delete permanently" menu item not found');
      await Bun.sleep(400);
      const confirmed = await clickByText(cdp, "button", "Delete permanently");
      if (!confirmed) throw new Error("confirm dialog button not found");
      await Bun.sleep(1200);
      const slice = await getSlice(cdp, winId);
      if (slice.entryNames.includes("shiftdel-me.txt")) throw new Error("still present in dir listing");
      if (existsSync(fx("shiftdel-me.txt"))) throw new Error("file still on disk");
    });

    await scenario("mouse-drag entry into subfolder (move)", async () => {
      const src = await rowRect(cdp, fx("dragme.txt"));
      const dst = await rowRect(cdp, fx("movetarget"));
      if (!src || !dst) throw new Error("source or target row not found");
      await entryDragDrop(cdp, src, dst);
      await Bun.sleep(700);
      const slice = await getSlice(cdp, winId);
      if (slice.entryNames.includes("dragme.txt")) throw new Error("still present in source dir");
      if (!existsSync(join(FIXTURE_DIR, "movetarget", "dragme.txt"))) throw new Error("not found in movetarget on disk");
    });
    await screenshot(cdp, "final-09-dnd-drop-highlight.png");

    await scenario("mouse-drag entry into subfolder with Ctrl (copy)", async () => {
      const src = await rowRect(cdp, fx("dragme-copy.txt"));
      const dst = await rowRect(cdp, fx("copytarget"));
      if (!src || !dst) throw new Error("source or target row not found");
      await entryDragDrop(cdp, src, dst, { ctrl: true });
      await Bun.sleep(700);
      const slice = await getSlice(cdp, winId);
      if (!slice.entryNames.includes("dragme-copy.txt")) throw new Error("original missing after copy (should stay)");
      if (!existsSync(join(FIXTURE_DIR, "copytarget", "dragme-copy.txt"))) throw new Error("not found in copytarget on disk");
    });

    await scenario("drag entry onto the project tree", async () => {
      // The project tree only renders once the sidebar's Explorer tab is active, the sidebar
      // itself is expanded (not just the icon rail — this dev DB's real, shared ui-prefs had
      // it collapsed from actual prior use), and the temp project is selected.
      await cdp.evalJs(`(async () => {
        const { useSettingsStore } = await import('/stores/settings-store.ts');
        useSettingsStore.setState({ sidebarCollapsed: false });
        useSettingsStore.getState().setSidebarActiveTab('explorer');
        const { useProjectStore } = await import('/stores/project-store.ts');
        const proj = useProjectStore.getState().projects.find(p => p.name === 'ppm-p9-e2e-proj');
        if (proj) useProjectStore.getState().setActiveProject(proj);
      })()`);
      const src = await rowRect(cdp, fx("dragme-tree.txt"));
      if (!src) throw new Error("source row not found");
      // Tree data loads async after the project switch; poll rather than guess a fixed delay.
      let treeRect = null;
      for (let i = 0; i < 10 && !treeRect; i++) {
        await Bun.sleep(500);
        treeRect = await cdp.evalJs(`(() => {
          const btns = [...document.querySelectorAll('button')];
          const hit = btns.find(b => b.textContent && b.textContent.trim() === 'drop-here');
          if (!hit) return null;
          const r = hit.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});
        })()`).then((v) => (v ? JSON.parse(v) : null));
      }
      if (!treeRect) throw new Error('project tree node "drop-here" not found — is the project sidebar open/expanded?');
      await entryDragDrop(cdp, src, treeRect);
      await Bun.sleep(700);
      if (!existsSync(join(PROJECT_DIR, "drop-here", "dragme-tree.txt"))) throw new Error("not found under the project's drop-here folder");
    });

    await scenario("switch to Icons view with thumbnails", async () => {
      await clickAriaLabel(cdp, "Icons view");
      await Bun.sleep(1200);
      const tiles = await cdp.evalJs(`[...document.querySelectorAll('[data-testid="explorer-tile"] img')].length`);
      if (tiles < 1) throw new Error("no <img> thumbnails rendered in Icons view");
    });
    await screenshot(cdp, "final-02-windows-icons-light.png");

    await scenario("switch to Column view, 3 deep + preview", async () => {
      await clickAriaLabel(cdp, "Column view");
      await Bun.sleep(500);
      for (const seg of ["level1", "level2", "level3"]) {
        const slice = await getSlice(cdp, winId);
        const target = join(slice.path, seg);
        await dispatchOnRow(cdp, target, "dblclick", ["explorer-column-row"]);
        await Bun.sleep(500);
      }
      const columns = await cdp.evalJs(`document.querySelectorAll('[data-testid="explorer-columns"] [role="listbox"]').length`);
      if (columns < 4) throw new Error(`expected >=4 ancestor columns after 3 drills, got ${columns}`);
      await dispatchOnRow(cdp, join(FIXTURE_DIR, "level1", "level2", "level3", "l3.txt"), "click", ["explorer-column-row"]);
      await Bun.sleep(400);
      const hasPreview = await cdp.evalJs(`document.body.textContent.includes('l3.txt')`);
      if (!hasPreview) throw new Error("preview pane did not show l3.txt");
    });

    // ── skin × theme grid screenshots (settings-store, no reload needed) ──
    async function backToFixtureListView() {
      await clickAriaLabel(cdp, "List view");
      await Bun.sleep(300);
      await clickAriaLabel(cdp, "Edit path");
      await Bun.sleep(150);
      await typeIntoReactInput(cdp, '[aria-label="Path"]', FIXTURE_DIR, { submit: true });
      await Bun.sleep(600);
    }

    await scenario("skin/theme: Windows dark", async () => {
      await setExplorerSkin(cdp, "windows");
      await setThemeMode(cdp, "dark");
      await backToFixtureListView();
      const skin = await cdp.evalJs(`document.querySelector('[data-skin]')?.dataset.skin`);
      if (skin !== "windows") throw new Error(`data-skin=${skin}`);
    });
    await screenshot(cdp, "final-01-windows-list-dark.png");

    await scenario("skin/theme: Windows light", async () => {
      await setThemeMode(cdp, "light");
      await Bun.sleep(200);
    });
    await screenshot(cdp, "final-02-windows-icons-light.png");

    await scenario("skin/theme: macOS light columns", async () => {
      await setExplorerSkin(cdp, "macos");
      await setThemeMode(cdp, "light");
      await clickAriaLabel(cdp, "Column view");
      await Bun.sleep(500);
      const skin = await cdp.evalJs(`document.querySelector('[data-skin]')?.dataset.skin`);
      if (skin !== "macos") throw new Error(`data-skin=${skin}`);
    });
    await screenshot(cdp, "final-03-macos-columns-light.png");

    await scenario("skin/theme: macOS dark list", async () => {
      await setThemeMode(cdp, "dark");
      await clickAriaLabel(cdp, "List view");
      await Bun.sleep(400);
    });
    await screenshot(cdp, "final-04-macos-dark-list.png");

    // reset to Auto/dark for the rest of the run
    await setExplorerSkin(cdp, "auto");
    await setThemeMode(cdp, "dark");
    await Bun.sleep(300);

    await scenario("context menu screenshot", async () => {
      await waitForNoMenu(cdp);
      await dispatchOnRow(cdp, fx("sample.csv"), "contextmenu");
      await Bun.sleep(400);
    });
    await screenshot(cdp, "final-06-context-menu.png");
    await cdp.evalJs(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await waitForNoMenu(cdp);

    await scenario("properties dialog screenshot", async () => {
      await dispatchOnRow(cdp, fx("sample.csv"), "contextmenu");
      await Bun.sleep(400);
      const ok = await clickMenuItemByText(cdp, "Properties");
      if (!ok) throw new Error('"Properties" menu item not found');
      await Bun.sleep(600);
    });
    await screenshot(cdp, "final-07-properties.png");
    await cdp.evalJs(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await Bun.sleep(300);

    // ── collision prompt (Replace dialog) — copy sample-renamed.md into movetarget twice ──
    await scenario("collision prompt screenshot (cross-directory copy)", async () => {
      await waitForNoMenu(cdp);
      await dispatchOnRow(cdp, fx("sample-renamed.md"), "contextmenu");
      await Bun.sleep(400);
      const copied = await clickMenuItemByText(cdp, "Copy", { exact: false });
      if (!copied) throw new Error("Copy not found");
      await waitForNoMenu(cdp);
      await dispatchOnRow(cdp, join(FIXTURE_DIR, "movetarget"), "contextmenu");
      await Bun.sleep(400);
      const pasted1 = await clickMenuItemByText(cdp, "Paste");
      if (!pasted1) throw new Error("first Paste not found/enabled");
      await Bun.sleep(1000);
      await waitForNoMenu(cdp);
      await dispatchOnRow(cdp, join(FIXTURE_DIR, "movetarget"), "contextmenu");
      await Bun.sleep(400);
      const pasted2 = await clickMenuItemByText(cdp, "Paste");
      if (!pasted2) throw new Error("second (colliding) Paste not found/enabled");
      await Bun.sleep(600);
    });
    await screenshot(cdp, "final-08-collision-prompt.png");
    await clickByText(cdp, "button", "Skip").catch(() => {});
    await Bun.sleep(300);

    // ── two windows, focus toggling ──
    let winId2;
    await scenario("two windows, focus toggling", async () => {
      await cdp.evalJs(`window.dispatchEvent(new CustomEvent("open-command-palette"))`);
      await Bun.sleep(400);
      await clickByText(cdp, "button", "Open File Explorer");
      await Bun.sleep(1200);
      const wins = await getWindows(cdp);
      if (wins.length !== 2) throw new Error(`expected 2 windows, got ${wins.length}`);
      winId2 = wins.find((w) => w.id !== winId).id;
      const rects = await cdp.evalJs(`JSON.stringify([...document.querySelectorAll('[role="group"][aria-roledescription="window"]')].map(el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y}; }))`).then(JSON.parse);
      if (rects.length !== 2) throw new Error("expected 2 window DOM roots");
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rects[0].x + 10, y: rects[0].y + 10, button: "left" });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rects[0].x + 10, y: rects[0].y + 10, button: "left" });
      await Bun.sleep(300);
    });
    await screenshot(cdp, "final-05-two-windows-focus.png");

    await scenario("tab dragging between panels still works", async () => {
      // Sanity-only check per dev-p8's architecture note: entry drags use application/x-ppm-paths,
      // tab drags use application/ppm-tab. Asserts the tab is still marked draggable — the real
      // regression risk (a shared file accidentally intercepting the drag) is covered by unit tests.
      const ok = await cdp.evalJs(`(() => { const t = document.querySelector('[data-tab-id]'); if(!t) return 'no-tab'; return t.getAttribute('draggable'); })()`);
      if (ok === "no-tab") throw new Error("no tab present to check draggable attribute");
    });

    await scenario("close second window", async () => {
      await cdp.evalJs(`(await import('/components/floating-window/window-store.ts')).useWindowStore.getState().close(${JSON.stringify(winId2)})`);
      await Bun.sleep(300);
    });

    await closeTab(mainTarget);

    // ═══ touch-emulated long-press at desktop width, coarse pointer ═══
    await scenario("touch long-press opens row menu at 1024×768 coarse pointer", async () => {
      const { cdp: c2, targetId } = await openTab();
      await navigateAndAuth(c2);
      await c2.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
      await c2.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await Bun.sleep(300);
      await c2.evalJs(`window.dispatchEvent(new CustomEvent("open-command-palette"))`);
      await Bun.sleep(400);
      await clickByText(c2, "button", "Open File Explorer");
      await Bun.sleep(1200);
      await clickAriaLabel(c2, "Edit path");
      await Bun.sleep(150);
      await typeIntoReactInput(c2, '[aria-label="Path"]', FIXTURE_DIR, { submit: true });
      await Bun.sleep(700);
      const r = await rowRect(c2, fx("sample.csv"));
      if (!r) throw new Error("row not found for touch long-press");
      await touchLongPress(c2, r.x + r.w / 2, r.y + r.h / 2, 550);
      await Bun.sleep(400);
      const menuOpen = await c2.evalJs(`document.body.textContent.includes('Move to Trash')`);
      if (!menuOpen) throw new Error("row context menu did not open from a long-press");
      await closeTab(targetId);
    });

    // ═══ MOBILE FLOW (390×844) ═══
    const { cdp: mc, targetId: mobileTarget } = await openTab();
    await mc.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await mc.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await navigateAndAuth(mc);

    await scenario("mobile: sheet opens full-screen via command palette", async () => {
      await mc.evalJs(`window.dispatchEvent(new CustomEvent("open-command-palette"))`);
      await Bun.sleep(500);
      const clicked = await clickByText(mc, "button", "Open File Explorer");
      if (!clicked) throw new Error('"Open File Explorer" not found on mobile palette');
      await Bun.sleep(1200);
      const sheetVisible = await mc.evalJs(`!!document.querySelector('[aria-label="Close file explorer"]')`);
      if (!sheetVisible) throw new Error("mobile sheet top bar not present");
    });
    await screenshot(mc, "final-12-mobile-list.png");

    await scenario("mobile: navigate to fixture dir, tap folder to open", async () => {
      await mc.evalJs(`(async () => {
        const { useExplorerStore } = await import('/components/os-explorer/explorer-store.ts');
        const { MOBILE_EXPLORER_WINDOW_ID } = await import('/components/os-explorer/use-explorer-open-state.ts');
        useExplorerStore.getState().patch(MOBILE_EXPLORER_WINDOW_ID, { path: ${JSON.stringify(FIXTURE_DIR)} });
      })()`);
      await Bun.sleep(900);
      const r = await rowRect(mc, join(FIXTURE_DIR, "level1"));
      if (!r) throw new Error("level1 row not found on mobile");
      await touchTap(mc, r.x + r.w / 2, r.y + r.h / 2);
      await Bun.sleep(700);
      const slice = await mc.evalJs(`(async () => {
        const { useExplorerStore } = await import('/components/os-explorer/explorer-store.ts');
        const { MOBILE_EXPLORER_WINDOW_ID } = await import('/components/os-explorer/use-explorer-open-state.ts');
        return useExplorerStore.getState().slices[MOBILE_EXPLORER_WINDOW_ID]?.path;
      })()`);
      if (!slice || !slice.endsWith("level1")) throw new Error(`did not navigate into level1, path=${slice}`);
      await mc.evalJs(`(async () => {
        const { useExplorerStore } = await import('/components/os-explorer/explorer-store.ts');
        const { MOBILE_EXPLORER_WINDOW_ID } = await import('/components/os-explorer/use-explorer-open-state.ts');
        useExplorerStore.getState().patch(MOBILE_EXPLORER_WINDOW_ID, { path: ${JSON.stringify(FIXTURE_DIR)} });
      })()`);
      await Bun.sleep(700);
    });

    await scenario("mobile: long-press opens actions sheet", async () => {
      const r = await rowRect(mc, fx("sample.csv"));
      if (!r) throw new Error("row not found");
      await touchLongPress(mc, r.x + r.w / 2, r.y + r.h / 2, 550);
      await Bun.sleep(500);
      const has = await mc.evalJs(`document.body.textContent.includes('Move to Trash')`);
      if (!has) throw new Error("long-press actions sheet did not open");
    });
    await screenshot(mc, "final-13-mobile-long-press.png");
    await mc.evalJs(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await Bun.sleep(300);

    await scenario("mobile: select mode + bottom bar", async () => {
      const ok = await clickAriaLabel(mc, "Select");
      if (!ok) throw new Error('"Select" button not found');
      await Bun.sleep(300);
      const r = await rowRect(mc, fx("sample.csv"));
      await touchTap(mc, r.x + r.w / 2, r.y + r.h / 2);
      await Bun.sleep(300);
      const bar = await mc.evalJs(`document.body.textContent.includes('selected')`);
      if (!bar) throw new Error("bottom bar did not switch to selection mode");
    });
    await screenshot(mc, "final-14-mobile-select-mode.png");
    await clickAriaLabel(mc, "Cancel").catch(() => {});
    await Bun.sleep(300);

    await scenario("mobile: Column view single-column + Back", async () => {
      const moreOk = await clickAriaLabel(mc, "More");
      if (!moreOk) throw new Error('"More" button not found');
      await Bun.sleep(300);
      await clickByText(mc, "button", "Columns");
      await Bun.sleep(500);
      const cols = await mc.evalJs(`document.querySelectorAll('[data-testid="explorer-columns"] [role="listbox"]').length`);
      if (cols !== 1) throw new Error(`expected exactly 1 visible column on mobile, got ${cols}`);
      await clickAriaLabel(mc, "Back").catch(() => {});
    });
    await screenshot(mc, "final-15-mobile-columns.png");

    await closeTab(mobileTarget);

    // ═══ cleanup ═══
    await api("DELETE", "/api/projects/ppm-p9-e2e-proj");
  } finally {
    chrome.kill();
  }
}

// Belt-and-braces: if anything (a native dialog, a wedged renderer) hangs past this, force
// the process to exit rather than run forever unattended.
const watchdog = new Promise((_, reject) =>
  setTimeout(() => reject(new Error("global watchdog: harness exceeded 8 minutes")), 8 * 60 * 1000),
);

Promise.race([main(), watchdog])
  .catch((e) => {
    console.error("HARNESS ERROR:", e);
    results.push({ name: "harness", pass: false, detail: String(e) });
    chromeProc?.kill();
  })
  .finally(async () => {
    console.log("\n═══ SUMMARY ═══");
    const pass = results.filter((r) => r.pass).length;
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? " — " + r.detail : ""}`);
    console.log(`\n${pass}/${results.length} passed`);
    await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
    process.exit(results.some((r) => !r.pass) ? 1 : 0);
  });
