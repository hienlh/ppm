// E2E proof for tab pop-out → floating window → Document Picture-in-Picture.
//
//   bun tests/e2e/tab-popout-pip-e2e.mjs            # all scenarios
//   PPM_E2E_ONLY=1,4 bun tests/e2e/tab-popout-pip-e2e.mjs
//
// Requires a HEADED Chrome (Document PiP does not exist headless), Vite on 5173 and the
// dev API on 8081. Reads the dev auth token from ppm.dev.db read-only; never prints it.
// Exits non-zero with the failure count.
//
// Two rules this harness never breaks:
//  * Tabs are opened through the app's own store actions (what the palette/sidebar call),
//    never by navigating to a tab URL — `autoOpenFromUrl` matches an un-suffixed id against
//    stored ids and appends duplicates, which would corrupt every count below.
//  * Every click that must carry a user gesture (pop-out menu, PiP button) is a real
//    Input.dispatchMouseEvent; `el.click()` is untrusted and `requestWindow()` rejects it.

import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { Cdp, launchChrome, osScreenshot, cdpScreenshot, pageInitScript, sleep } from "./tab-popout-pip-helpers.mjs";

const WEB_PORT = process.env.PPM_E2E_WEB_PORT || "5173";
const API_PORT = process.env.PPM_E2E_API_PORT || "8081";
const ORIGIN = `http://localhost:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const CDP_PORT = Number(process.env.PPM_E2E_CDP_PORT || 9341);
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const VISUALS_DIR =
  process.env.PPM_E2E_VISUALS ||
  "C:\\Users\\PC\\ppm\\plans\\260905-0155-tab-popout-floating-window-and-document-pip\\visuals";
const RUN = Date.now().toString(36);
const PROFILE_DIR = join(tmpdir(), `ppm-e2e-pip-${RUN}`);
const PROJECT_DIR = join(tmpdir(), `ppm-e2e-pip-proj-${RUN}`);
const PROJECT_NAME = `e2e-pip-${RUN}`;
const ONLY = (process.env.PPM_E2E_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);

const db = new Database(join(homedir(), ".ppm", "ppm.dev.db"), { readonly: true });
const TOKEN = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
db.close();

// ---------------------------------------------------------------------------
// result bookkeeping
// ---------------------------------------------------------------------------
const results = [];
const shots = [];
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
function assert(cond, name, detail) {
  record(name, !!cond, detail);
  if (!cond) throw new Error(`assert failed: ${name} — ${detail}`);
}
async function scenario(id, name, fn) {
  if (ONLY.length && !ONLY.includes(id)) return;
  console.log(`\n=== [${id}] ${name} ===`);
  try {
    await fn();
  } catch (e) {
    record(`[${id}] ${name} — aborted`, false, e?.message || String(e));
  }
}

// ---------------------------------------------------------------------------
// app-module handles (Vite dev serves the app's own ESM; same module instance)
// ---------------------------------------------------------------------------
const PANELS = `(await import('/stores/panel-store.ts')).usePanelStore`;
const WINDOWS = `(await import('/components/floating-window/window-store.ts')).useWindowStore`;
const PROJECTS = `(await import('/stores/project-store.ts')).useProjectStore`;
const PIPREG = `(await import('/components/floating-window/tab-host-pip-registry.ts'))`;

let cdp;
let main; // sessionId of the app page
let mainTargetId;
let chrome;

const ev = (expr, ms) => cdp.evalJs(main, expr, ms);

async function waitFor(expr, timeoutMs = 20000, label = expr) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await ev(`!!(${expr})`, 8000);
      if (last) return true;
    } catch (e) {
      last = e.message;
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label} (last=${last})`);
}

async function api(method, path, body) {
  const r = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// ---------------------------------------------------------------------------
// page-side helpers that need the app's modules (re-installed after every load)
// ---------------------------------------------------------------------------
async function installAppHelpers() {
  await ev(`(async () => {
    const reg = await import('/components/floating-window/tab-host-pip-registry.ts');
    const E = window.__e2e;
    E.pipDoc = (wid) => reg.tabHostPip(wid)?.pipWindow.document ?? null;
    E.wrapper = (tabId, wid) => {
      const sel = '[data-tab-pool-id=' + JSON.stringify(tabId) + ']';
      const pip = wid ? E.pipDoc(wid) : null;
      return document.querySelector(sel) || (pip ? pip.querySelector(sel) : null);
    };
    E.where = (tabId, wid) => {
      const el = E.wrapper(tabId, wid);
      if (!el) return 'missing';
      const inPip = !!(wid && E.pipDoc(wid) && el.ownerDocument === E.pipDoc(wid));
      const winEl = el.closest('[role="group"]');
      return JSON.stringify({
        doc: inPip ? 'pip' : 'main',
        node: el.dataset.e2eNode ?? null,
        inWindow: !!winEl,
        windowLabel: winEl?.getAttribute('aria-label') ?? null,
        parentClass: el.parentElement?.className ?? null,
      });
    };
    return 'ok';
  })()`);
}

/** Full store snapshot: which panel holds what, plus the live windows. */
async function snapshot() {
  return JSON.parse(
    await ev(`(async () => {
      const p = ${PANELS}.getState();
      const w = ${WINDOWS}.getState();
      const panels = {};
      for (const [id, panel] of Object.entries(p.panels)) panels[id] = panel.tabs.map(t => t.id);
      return JSON.stringify({
        panels,
        grid: p.grid,
        focused: p.focusedPanelId,
        windows: Object.values(w.windows).map(x => ({ id: x.id, kind: x.kind, rect: x.rect, payload: x.payload })),
        chips: document.querySelectorAll('[data-tab-item]').length,
        wrappers: document.querySelectorAll('[data-tab-pool-id]').length,
        terminalWs: window.__e2e.terminalWsCount,
      });
    })()`),
  );
}
const totalTabs = (s) => Object.values(s.panels).reduce((n, ids) => n + ids.length, 0);
const panelOf = (s, tabId) => Object.entries(s.panels).find(([, ids]) => ids.includes(tabId))?.[0] ?? null;

// ---------------------------------------------------------------------------
// interaction helpers
// ---------------------------------------------------------------------------
/** Click the centre of whatever `selectorExpr` returns, in the given target's document. */
async function trustedClickSelector(selectorExpr, label, sessionId = main, button = "left") {
  const useSession = sessionId;
  const json = await cdp.evalJs(
    useSession,
    `(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
  );
  if (!json) throw new Error(`not found for click: ${label}`);
  const { x, y } = JSON.parse(json);
  await cdp.click(useSession, x, y, button);
  return { x, y };
}

/** Right-click a tab chip and click "Open in window" — the shipped UI path. */
async function popOutViaMenu(tabId) {
  const before = await snapshot();
  await trustedClickSelector(
    `document.querySelector('[data-tab-id=' + JSON.stringify(${JSON.stringify(tabId)}) + ']')`,
    `tab chip ${tabId}`,
    main,
    "right",
  );
  await sleep(400);
  const clicked = await ev(`(() => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const menu = menus[menus.length - 1];
    if (!menu) return 'no-menu';
    const item = [...menu.querySelectorAll('[role="menuitem"]')]
      .find(e => (e.textContent || '').trim() === 'Open in window');
    if (!item) return 'no-item';
    item.click();
    return 'ok';
  })()`);
  if (clicked !== "ok") throw new Error(`pop-out menu: ${clicked}`);
  await sleep(800);
  const after = await snapshot();
  const winId = after.windows.map((w) => w.id).find((id) => !before.windows.some((b) => b.id === id));
  if (!winId) throw new Error("pop-out produced no window");
  return { winId, before, after };
}

const PIP_OPEN_LABEL = "Open in picture-in-picture";
const PIP_BACK_LABEL = "Bring back from picture-in-picture";

const captionButton = (label) =>
  `document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']')`;

/** Attach to the PiP page target (its opener is the app page). */
async function findPipTarget() {
  const targets = await cdp.targets();
  return targets.find((t) => t.type === "page" && t.openerId === mainTargetId && t.targetId !== mainTargetId) ?? null;
}

async function enterPip(winId) {
  await trustedClickSelector(captionButton(PIP_OPEN_LABEL), "pip button");
  const deadline = Date.now() + 15000;
  let target = null;
  while (Date.now() < deadline && !target) {
    await sleep(300);
    target = await findPipTarget();
  }
  if (!target) throw new Error("PiP window never opened (gesture rejected?)");
  const sid = await cdp.attach(target.targetId);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid).catch(() => {});
  await sleep(800);
  const inPip = await ev(`!!(${PIPREG}.tabHostPip(${JSON.stringify(winId)}))`);
  if (!inPip) throw new Error("registry has no PiP handle after requestWindow");
  return { sid, targetId: target.targetId };
}

async function leavePip({ viaPlaceholder = false } = {}) {
  if (viaPlaceholder) {
    await trustedClickSelector(
      `[...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === 'Bring back')`,
      "Bring back placeholder button",
    );
  } else {
    await trustedClickSelector(captionButton(PIP_BACK_LABEL), "pip back button");
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (!(await findPipTarget())) return true;
  }
  throw new Error("PiP window never closed");
}

async function closeWindowChrome() {
  await trustedClickSelector(captionButton("Close window"), "window close button");
  await sleep(900);
}

// ---------------------------------------------------------------------------
// screenshots — OS-level first, CDP per-target fallback (recorded per file)
// ---------------------------------------------------------------------------
async function screenshot(name, { pipSid = null, scenarioId = "", step = "", pass = true } = {}) {
  const target = join(VISUALS_DIR, name);
  let method = await osScreenshot(target);
  if (!method) {
    // GDI capture is impossible on a disconnected session — fall back to CDP, which
    // sees the PiP target and the app page separately.
    if (pipSid) {
      await cdpScreenshot(cdp, pipSid, target);
      method = "cdp-pip";
      const mainName = name.replace(/\.png$/, "-main.png");
      await cdpScreenshot(cdp, main, join(VISUALS_DIR, mainName));
      shots.push({ name: mainName, scenarioId, step: `${step} (main window)`, pass, method: "cdp-main" });
    } else {
      await cdpScreenshot(cdp, main, target);
      method = "cdp-main";
    }
  }
  shots.push({ name, scenarioId, step, pass, method });
  console.log(`  shot ${name} (${method})`);
  return method;
}

// ---------------------------------------------------------------------------
// boot / teardown
// ---------------------------------------------------------------------------
async function bootBrowser({ deletePipApi = false } = {}) {
  chrome = await launchChrome({ chromePath: CHROME, cdpPort: CDP_PORT, profileDir: PROFILE_DIR, url: "about:blank" });
  cdp = await Cdp.connect(CDP_PORT);
  const deadline = Date.now() + 20000;
  let page = null;
  while (Date.now() < deadline && !page) {
    page = (await cdp.targets()).find((t) => t.type === "page");
    if (!page) await sleep(300);
  }
  if (!page) throw new Error("no page target");
  mainTargetId = page.targetId;
  main = await cdp.attach(mainTargetId);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, main).catch(() => {});
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: pageInitScript(TOKEN, { deletePipApi }) }, main);
  if (await retargetTerminalWs(main)) console.log(`terminal WebSocket retargeted to :${API_PORT}`);
}

/**
 * Serve `main.tsx` with `<StrictMode>` replaced by a pass-through component.
 *
 * Not a product change and not a mask: a production build has no StrictMode, so this is
 * the tree a user actually runs. Scenario 0 measures the StrictMode behaviour on purpose,
 * before this is switched on; without it every later scenario would only ever re-measure
 * that one bug. Set PPM_E2E_STRICTMODE=keep to run everything with StrictMode on.
 */
async function neutralizeStrictMode(sessionId) {
  if (process.env.PPM_E2E_STRICTMODE === "keep") return false;
  await cdp.send("Network.enable", {}, sessionId).catch(() => {});
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId).catch(() => {});
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/main.tsx*", requestStage: "Response" }] }, sessionId);
  cdp.on(async (m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== sessionId) return;
    const { requestId } = m.params;
    try {
      const r = await cdp.send("Fetch.getResponseBody", { requestId }, sessionId);
      const text = (r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body).replace(
        /_jsxDEV\(StrictMode,/g,
        "_jsxDEV(((props) => props.children),",
      );
      await cdp.send(
        "Fetch.fulfillRequest",
        {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "content-type", value: "application/javascript" },
            { name: "cache-control", value: "no-store" },
          ],
          body: Buffer.from(text, "utf8").toString("base64"),
        },
        sessionId,
      );
    } catch {
      await cdp.send("Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
    }
  });
  return true;
}

/**
 * Point the dev-only terminal WebSocket at an isolated backend port.
 *
 * `use-terminal.ts` hard-codes `ws://<host>:8081` for http dev (Vite's proxy is unreliable
 * for upgrades), and a WebSocket handshake cannot be rewritten by the Fetch domain — so the
 * module itself is rewritten as it is served. Only needed when the run is NOT on 8081, e.g.
 * after Windows wedges that port behind a dead PID. No app behaviour changes.
 */
async function retargetTerminalWs(sessionId) {
  if (API_PORT === "8081") return false;
  await cdp.send("Network.enable", {}, sessionId).catch(() => {});
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId).catch(() => {});
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/hooks/use-terminal.ts*", requestStage: "Response" }] }, sessionId);
  cdp.on(async (m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== sessionId) return;
    const { requestId } = m.params;
    try {
      const r = await cdp.send("Fetch.getResponseBody", { requestId }, sessionId);
      const text = (r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body).replace(
        /hostname\}:8081/g,
        `hostname}:${API_PORT}`,
      );
      await cdp.send(
        "Fetch.fulfillRequest",
        {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "content-type", value: "application/javascript" },
            { name: "cache-control", value: "no-store" },
          ],
          body: Buffer.from(text, "utf8").toString("base64"),
        },
        sessionId,
      );
    } catch {
      await cdp.send("Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
    }
  });
  return true;
}

async function openApp(path = `/project/${PROJECT_NAME}`) {
  await cdp.send("Page.navigate", { url: ORIGIN + path }, main);
  await sleep(2500);
  await waitFor(`${PROJECTS}.getState().activeProject?.name === ${JSON.stringify(PROJECT_NAME)}`, 30000, "project active");
  await waitFor(`${PANELS}.getState().grid.flat().length > 0`, 20000, "grid ready");
  await installAppHelpers();
}

/** Open a tab the way the command palette does — never through the URL. */
async function openTab(def, panelId) {
  const id = await ev(
    `${PANELS}.getState().openTab(${JSON.stringify(def)}${panelId ? `, ${JSON.stringify(panelId)}` : ""})`,
  );
  await sleep(700);
  return id;
}

async function resetWorkspace() {
  await ev(`(async () => {
    const w = ${WINDOWS}.getState();
    for (const id of Object.keys(w.windows)) w.close(id);
    return 'ok';
  })()`);
  await sleep(700);
  await ev(`(async () => {
    const p = ${PANELS}.getState();
    for (const [pid, panel] of Object.entries(p.panels)) {
      for (const t of [...panel.tabs]) p.closeTab(t.id, pid);
    }
    return 'ok';
  })()`);
  await sleep(700);
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------
const TERMINAL_ID = "terminal:1";

async function terminalText(winId) {
  return ev(`window.__e2e.termText(window.__e2e.wrapper(${JSON.stringify(TERMINAL_ID)}, ${JSON.stringify(winId ?? null)}))`);
}
async function where(tabId, winId) {
  const raw = await ev(`window.__e2e.where(${JSON.stringify(tabId)}, ${JSON.stringify(winId ?? null)})`);
  return raw === "missing" ? { doc: "missing" } : JSON.parse(raw);
}

async function scenario1() {
  await resetWorkspace();
  const marks = [];
  const mark = (n) => `PPM-E2E-${RUN}-${n}`;

  await openTab({
    type: "terminal",
    title: "Terminal 1",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { terminalIndex: 1, projectName: PROJECT_NAME },
  });
  await waitFor(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm')`, 30000, "xterm mounted");
  await sleep(2500); // shell prompt

  // Tag the wrapper node: a remount would create a fresh element without this.
  await ev(`(window.__e2e.wrapper('terminal:1', null).dataset.e2eNode = 'n1')`);

  async function typeMarker(n, sid = main) {
    const m = mark(n);
    marks.push(m);
    await cdp.typeText(sid, `echo ${m}`);
    await cdp.enter(sid);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(400);
      const txt = await terminalText(currentWin);
      if (txt && txt.includes(m)) return m;
    }
    throw new Error(`marker ${m} never appeared in the terminal buffer`);
  }

  let currentWin = null;
  // Focus the terminal with a real click, then type the first marker in the grid.
  await trustedClickSelector(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm-screen')`, "xterm");
  await typeMarker("A");
  const beforeSnap = await snapshot();
  // Baseline, not an absolute: the app may open the socket more than once while the tab
  // first mounts. What matters is that the trip itself opens no new one.
  const wsBaseline = beforeSnap.terminalWs;
  record("[1] marker A echoed in grid panel", true, `terminal WebSocket baseline=${wsBaseline}`);

  // ── pop out ──
  const { winId, before, after } = await popOutViaMenu(TERMINAL_ID);
  currentWin = winId;
  const w1 = await where(TERMINAL_ID, winId);
  assert(
    panelOf(after, TERMINAL_ID) === `__win__:${winId}`,
    "[1] tab moved to the window panel",
    `panel=${panelOf(after, TERMINAL_ID)} panels=${JSON.stringify(after.panels)}`,
  );
  assert(w1.inWindow && w1.node === "n1", "[1] same DOM node now inside the floating window", JSON.stringify(w1));
  assert(
    totalTabs(after) === totalTabs(before) && after.wrappers === before.wrappers,
    "[1] tab count unchanged by pop-out",
    `tabs ${totalTabs(before)}→${totalTabs(after)}, wrappers ${before.wrappers}→${after.wrappers}`,
  );
  let txt = await terminalText(winId);
  assert(txt?.includes(marks[0]), "[1] scrollback survives pop-out", `marker A present=${!!txt?.includes(marks[0])}`);
  await screenshot("01-terminal-in-window.png", { scenarioId: "1", step: "terminal detached into floating window" });

  // ── two consecutive PiP round trips ──
  for (const [i, letter] of [["1", "B"], ["2", "C"]]) {
    const pip = await enterPip(winId);
    const inPip = await where(TERMINAL_ID, winId);
    assert(inPip.doc === "pip" && inPip.node === "n1", `[1] round trip ${i}: wrapper adopted into the PiP document`, JSON.stringify(inPip));
    const placeholder = await ev(`document.body.innerText.includes('Playing in picture-in-picture')`);
    assert(placeholder, `[1] round trip ${i}: window shows the PiP placeholder`, `placeholder=${placeholder}`);
    await typeMarker(letter, pip.sid);
    record(`[1] round trip ${i}: typing inside PiP reaches the PTY`, true, `marker ${mark(letter)} echoed`);
    await screenshot(`0${i === "1" ? "1b" : "1c"}-terminal-in-pip${i === "2" ? "-second" : ""}.png`, {
      pipSid: pip.sid,
      scenarioId: "1",
      step: `terminal live in PiP (round trip ${i})`,
    });
    await leavePip();
    const back = await where(TERMINAL_ID, winId);
    assert(back.doc === "main" && back.inWindow && back.node === "n1", `[1] round trip ${i}: wrapper returned to the window`, JSON.stringify(back));
    txt = await terminalText(winId);
    assert(marks.every((m) => txt?.includes(m)), `[1] round trip ${i}: every marker still in the buffer`, `marks=${marks.length}`);
  }

  // ── close the window ──
  const originPanel = panelOf(before, TERMINAL_ID);
  await closeWindowChrome();
  const end = await snapshot();
  assert(panelOf(end, TERMINAL_ID) === originPanel, "[1] tab re-docked into its origin panel", `panel=${panelOf(end, TERMINAL_ID)} origin=${originPanel}`);
  const endWhere = await where(TERMINAL_ID, null);
  assert(endWhere.node === "n1", "[1] still the same DOM node after the whole trip", JSON.stringify(endWhere));
  txt = await terminalText(null);
  assert(marks.every((m) => txt?.includes(m)), "[1] all three markers survive the whole trip", `markers=${marks.join(",")}`);
  assert(
    end.terminalWs === wsBaseline,
    "[1] PTY never reconnected across pop-out, 2 PiP round trips and re-dock",
    `terminal WebSocket count ${wsBaseline}→${end.terminalWs}`,
  );
  assert(totalTabs(end) === totalTabs(before) && end.chips === before.chips, "[1] tab-chip count unchanged after re-dock", `chips ${before.chips}→${end.chips}`);
  await screenshot("01d-terminal-after-window-close.png", { scenarioId: "1", step: "terminal re-docked in the grid" });
}

/**
 * Regression probe, and the reason every other scenario runs with StrictMode disabled.
 *
 * `TabHostWindowContent` re-docks the tab from a LAYOUT-effect cleanup. React runs that
 * cleanup for more than a real unmount: StrictMode's simulated remount hides the subtree
 * (`disappearLayoutEffects`) and runs it, and the matching `reappearLayoutEffects` has
 * nothing that puts the tab back. So in dev the tab is yanked out of the window ~1s after
 * it lands there, leaving an empty window behind.
 */
async function scenario0() {
  await resetWorkspace();
  await openTab({
    type: "terminal",
    title: "Terminal 1",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { terminalIndex: 1, projectName: PROJECT_NAME },
  });
  await waitFor(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm')`, 30000, "xterm mounted");
  await ev(`(async () => {
    const store = ${PANELS};
    const orig = store.getState().redockFromWindow;
    window.__e2eRedock = [];
    store.setState({ redockFromWindow: (wid, origin) => {
      window.__e2eRedock.push(String(new Error('redock').stack).split('\\n').slice(0, 8).join(' | '));
      return orig(wid, origin);
    } });
    return 'ok';
  })()`);
  const out = await ev(`(async () => {
    const store = ${PANELS};
    const p = store.getState();
    const pid = Object.keys(p.panels).find(id => p.panels[id].tabs.some(t => t.id === 'terminal:1'));
    const wid = p.popOutTab('terminal:1', pid);
    const at = (label) => {
      const s = store.getState();
      const holder = Object.keys(s.panels).find(id => s.panels[id].tabs.some(t => t.id === 'terminal:1'));
      return label + '=' + holder + ' winPanel=' + !!s.panels['__win__:' + wid];
    };
    const t0 = at('sync');
    await new Promise(r => setTimeout(r, 300));
    const t05 = at('after300ms');
    await new Promise(r => setTimeout(r, 1500));
    const t1 = at('after1800ms');
    const w = ${WINDOWS}.getState();
    return JSON.stringify({ wid, t0, t05, t1, windows: Object.keys(w.windows) });
  })()`);
  const timeline = JSON.parse(out);
  const stacks = JSON.parse(await ev(`JSON.stringify(window.__e2eRedock)`));
  const stuck = timeline.t1.startsWith(`after1800ms=__win__:${timeline.wid}`);
  record(
    "[0] a popped-out tab stays in its window under React StrictMode",
    stuck,
    `${out}${stuck ? "" : ` | redock stack: ${(stacks[0] || "none").slice(0, 320)}`}`,
  );
  await screenshot("00-strictmode-popout.png", {
    scenarioId: "0",
    step: "1.8 s after pop-out under real StrictMode",
    pass: stuck,
  });
  await ev(`(async () => { ${WINDOWS}.getState().close(${JSON.stringify(timeline.wid)}); return 'ok'; })()`);
  await sleep(600);
}

async function scenario2() {
  await resetWorkspace();
  const chatId = await openTab({
    type: "chat",
    title: "Chat",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { projectName: PROJECT_NAME },
  });
  await waitFor(
    `[...document.querySelectorAll('textarea')].some(t => /ask anything|follow-up/i.test(t.placeholder||''))`,
    30000,
    "composer",
  );
  // The composer is rendered twice (mobile + desktop layouts); only the visible, enabled
  // one can take focus, and `find()` would otherwise return the hidden mobile copy.
  const composerExpr = `[...document.querySelectorAll('textarea')]
    .filter(t => /ask anything|follow-up/i.test(t.placeholder||'') && !t.disabled && t.offsetParent !== null)[0]`;
  const assistantLenExpr = `(() => {
    const el = window.__e2e.wrapper(${JSON.stringify(chatId)}, window.__e2eWin ?? null);
    return el ? el.innerText.length : -1;
  })()`;

  /** Type into whichever document currently holds the composer, then submit. */
  async function send(text, sid = main) {
    const focused = await cdp.evalJs(
      sid,
      `(() => { const ta = ${composerExpr}; if (!ta) return false; ta.focus(); return document.activeElement === ta; })()`,
    );
    if (!focused) throw new Error("composer not focusable in this document");
    await cdp.typeText(sid, text);
    await sleep(400);
    const typed = await cdp.evalJs(sid, `(${composerExpr})?.value ?? ''`);
    if (!typed.includes(text.slice(0, 12))) throw new Error(`composer did not take the text (value=${JSON.stringify(typed)})`);
    await cdp.enter(sid);
    await sleep(600);
    return typed;
  }

  // The trailing marker is the assertion: a length delta is unreliable because the
  // thinking block is replaced by the answer and can happen to be the same size.
  await send("Count slowly from 1 to 40, one number per line, then on the last line write PPM-STREAM-DONE.");
  let streaming = false;
  const deadline = Date.now() + 60000;
  let baseLen = 0;
  while (Date.now() < deadline) {
    await sleep(700);
    const len = await ev(assistantLenExpr);
    if (len > 200) {
      baseLen = len;
      streaming = await ev(
        `(await import('/stores/streaming-store.ts')).useStreamingStore.getState().sessions.size > 0`,
      ).catch(() => false);
      if (streaming) break;
    }
  }
  const diag = await ev(`(async () => {
    const el = window.__e2e.wrapper(${JSON.stringify(chatId)}, null);
    const ta = [...document.querySelectorAll('textarea')].find(t => /ask anything|follow-up/i.test(t.placeholder||''));
    const store = (await import('/stores/streaming-store.ts')).useStreamingStore.getState();
    return JSON.stringify({
      wrapper: !!el,
      innerTextLen: el ? el.innerText.length : -1,
      text: el ? el.innerText.slice(0, 200) : null,
      composerValue: ta ? ta.value : null,
      streamingSessions: store.sessions.size,
      toasts: [...document.querySelectorAll('[data-sonner-toast]')].map(t => t.textContent).join(' | '),
    });
  })()`);
  assert(streaming, "[2] chat turn started streaming", `streaming=${streaming}, len=${baseLen}, diag=${diag}`);

  // Pop out mid-stream and prove tokens keep arriving.
  const { winId } = await popOutViaMenu(chatId);
  await ev(`window.__e2eWin = ${JSON.stringify(winId)}`);
  const atPopOut = await ev(assistantLenExpr);
  // The prompt echo already contains the marker, so count occurrences: the answer's copy
  // is the second one, and it can only appear after the tab was detached.
  const doneMarkerExpr = `(() => {
    const el = window.__e2e.wrapper(${JSON.stringify(chatId)}, ${JSON.stringify(winId)});
    return el ? (el.innerText.match(/PPM-STREAM-DONE/g) || []).length : 0;
  })()`;
  const markersAtPopOut = await ev(doneMarkerExpr);
  const streamingSize = `(await import('/stores/streaming-store.ts')).useStreamingStore.getState().sessions.size`;
  let grew = false;
  let len = atPopOut;
  let stillStreaming = true;
  const growDeadline = Date.now() + 120000;
  while (Date.now() < growDeadline && !grew) {
    await sleep(600);
    len = await ev(assistantLenExpr);
    stillStreaming = await ev(streamingSize).then((n) => n > 0);
    grew = (await ev(doneMarkerExpr)) > markersAtPopOut;
    if (!stillStreaming && !grew) break; // turn ended without ever delivering the marker
  }
  const afterDiag = await ev(`(() => {
    const el = window.__e2e.wrapper(${JSON.stringify(chatId)}, ${JSON.stringify(winId)});
    return JSON.stringify({ inWindow: !!el?.closest('[role="group"]'), text: el ? el.innerText.slice(0, 400) : null });
  })()`);
  assert(
    grew,
    "[2] tokens keep arriving while detached (end-of-answer marker lands in the window)",
    `marker occurrences at pop-out=${markersAtPopOut}, text length ${atPopOut}→${len}, streaming=${stillStreaming}, ${afterDiag}`,
  );
  await screenshot("02-chat-streaming-in-window.png", { scenarioId: "2", step: "chat streaming in the floating window" });

  // Let the turn finish: the model selector is deliberately disabled while running.
  for (let i = 0; i < 60 && (await ev(streamingSize)) > 0; i++) await sleep(1000);

  // PiP: model selector must render in the PiP document and close on click-outside.
  const pip = await enterPip(winId);
  const inPip = await where(chatId, winId);
  assert(inPip.doc === "pip", "[2] chat adopted into the PiP document", JSON.stringify(inPip));
  await trustedClickSelector(
    `[...document.querySelectorAll('[aria-label^="Model "]')].filter(e => e.offsetParent !== null)[0]`,
    "model selector",
    pip.sid,
  );
  await sleep(900);
  const menuDoc = await ev(`(() => {
    const pipDoc = window.__e2e.pipDoc(${JSON.stringify(winId)});
    const sel = '[aria-label="Model and thinking"]';
    return JSON.stringify({
      inMain: !!document.querySelector(sel),
      inPipDoc: !!(pipDoc && pipDoc.querySelector(sel)),
    });
  })()`);
  const menu = JSON.parse(menuDoc);
  assert(menu.inPipDoc && !menu.inMain, "[2] model selector renders inside the PiP document", menuDoc);
  await screenshot("02b-chat-model-selector-in-pip.png", { pipSid: pip.sid, scenarioId: "2", step: "model selector open inside PiP" });
  await cdp.click(pip.sid, 8, 8); // click-outside
  await sleep(600);
  const closed = await ev(`(() => {
    const pipDoc = window.__e2e.pipDoc(${JSON.stringify(winId)});
    return !(pipDoc && pipDoc.querySelector('[aria-label="Model and thinking"]'));
  })()`);
  assert(closed, "[2] model selector closes on click-outside inside PiP", `closed=${closed}`);

  // Composer must send from inside the PiP window.
  const beforeSend = await ev(assistantLenExpr);
  await send("Reply with exactly: PPM-PIP-OK", pip.sid);
  let sent = false;
  const sendDeadline = Date.now() + 45000;
  while (Date.now() < sendDeadline && !sent) {
    await sleep(800);
    sent = await ev(`(() => {
      const el = window.__e2e.wrapper(${JSON.stringify(chatId)}, ${JSON.stringify(winId)});
      return !!el && el.innerText.includes('PPM-PIP-OK');
    })()`);
  }
  assert(sent, "[2] composer sends from inside the PiP window", `text len before=${beforeSend}`);
  await screenshot("02c-chat-sent-from-pip.png", { pipSid: pip.sid, scenarioId: "2", step: "message sent from the PiP composer" });
  await leavePip();
  await closeWindowChrome();
}

const EDITOR_ID = "editor:scratch.ts";

async function scenario3() {
  await resetWorkspace();
  await openTab({
    type: "editor",
    title: "scratch.ts",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { filePath: "scratch.ts", projectName: PROJECT_NAME },
  });
  await waitFor(`window.monaco && window.monaco.editor.getEditors().length > 0`, 40000, "monaco");
  await sleep(1200);
  const editorExpr = (wid) => `window.__e2e.findEditor(window.__e2e.wrapper(${JSON.stringify(EDITOR_ID)}, ${JSON.stringify(wid ?? null)}))`;
  const value = (wid) => ev(`${editorExpr(wid)}.getValue()`);

  const original = await value(null);
  await ev(`(() => { const e = ${editorExpr(null)}; e.focus(); e.setPosition({ lineNumber: 1, column: 1 }); return 'ok'; })()`);
  await cdp.typeText(main, "E2E-EDIT-ONE");
  await sleep(800);
  const afterType = await value(null);
  assert(
    afterType.includes("E2E-EDIT-ONE"),
    "[3] typed into the docked editor",
    `len ${original.length}→${afterType.length} value=${JSON.stringify(afterType.slice(0, 90))}`,
  );

  const { winId, before } = await popOutViaMenu(EDITOR_ID);
  const pip = await enterPip(winId);
  const inPip = await where(EDITOR_ID, winId);
  assert(inPip.doc === "pip", "[3] editor adopted into the PiP document", JSON.stringify(inPip));
  const keptBuffer = await value(winId);
  assert(keptBuffer.includes("E2E-EDIT-ONE"), "[3] unsaved buffer survives pop-out + PiP", `len=${keptBuffer.length}`);
  await screenshot("03-editor-in-pip.png", { pipSid: pip.sid, scenarioId: "3", step: "editor live in PiP with unsaved edit" });

  // Resize the PiP window at the OS level and prove Monaco relayouts.
  const layoutBefore = JSON.parse(await ev(`JSON.stringify(${editorExpr(winId)}.getLayoutInfo())`));
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: pip.targetId });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: 680, height: 420 } });
  await sleep(2000);
  const layoutAfter = JSON.parse(await ev(`JSON.stringify(${editorExpr(winId)}.getLayoutInfo())`));
  assert(
    layoutAfter.width !== layoutBefore.width && layoutAfter.contentLeft > 0,
    "[3] Monaco relayouts on PiP resize (gutter intact)",
    `width ${layoutBefore.width}→${layoutAfter.width}, contentLeft=${layoutAfter.contentLeft}`,
  );
  await screenshot("03b-editor-in-pip-resized.png", { pipSid: pip.sid, scenarioId: "3", step: "PiP window resized, Monaco relaid out" });

  // Typing must reach the buffer from inside the PiP window — and it is also the
  // control for the Ctrl+Z check below: same focus, same key transport.
  await trustedClickSelector(`document.querySelector('.monaco-editor .view-lines')`, "monaco view lines", pip.sid).catch(
    () => {},
  );
  await ev(`${editorExpr(winId)}.focus()`);
  await sleep(400);
  await cdp.typeText(pip.sid, "E2E-EDIT-PIP");
  await sleep(800);
  const pipTyped = (await value(winId)).includes("E2E-EDIT-PIP");
  assert(pipTyped, "[3] typing inside the PiP window reaches the editor buffer", `typed=${pipTyped}`);
  const focusInfo = await cdp.evalJs(
    pip.sid,
    `(() => { const a = document.activeElement; return JSON.stringify({ tag: a?.tagName, cls: String(a?.className).slice(0, 60), hasFocus: document.hasFocus() }); })()`,
  );
  await cdp.pressKey(pip.sid, { key: "z", code: "KeyZ", vk: 90, modifiers: 2 });
  await sleep(1000);
  const undoneInPip = !(await value(winId)).includes("E2E-EDIT-PIP");
  record(
    "[3] Ctrl+Z works while the editor is inside the PiP window",
    undoneInPip,
    `undone=${undoneInPip}, pip focus=${focusInfo}; typing with the same focus DID reach the buffer`,
  );

  // Same key, same transport, editor back in the main document: the control that separates
  // "the harness cannot press Ctrl+Z" from "Monaco keybindings are dead in the PiP document".
  await leavePip();
  await sleep(1200);
  let valueAfter = "";
  let undone = false;
  for (let i = 0; i < 6 && !undone; i++) {
    await ev(`${editorExpr(winId)}.focus()`);
    await cdp.pressKey(main, { key: "z", code: "KeyZ", vk: 90, modifiers: 2 });
    await sleep(700);
    valueAfter = await value(winId);
    undone = valueAfter === original;
  }
  assert(
    undone,
    "[3] Ctrl+Z after the PiP round trip walks the undo stack back to the original buffer",
    `value=${JSON.stringify(valueAfter.slice(0, 60))} original=${JSON.stringify(original.slice(0, 60))}`,
  );
  const winRect = (await snapshot()).windows.find((w) => w.id === winId)?.rect;
  const layoutBack = JSON.parse(await ev(`JSON.stringify(${editorExpr(winId)}.getLayoutInfo())`));
  assert(
    winRect && Math.abs(layoutBack.width - winRect.w) <= 24,
    "[3] editor fills the floating window after return",
    `layout=${layoutBack.width} window=${winRect?.w}`,
  );
  await screenshot("03c-editor-back-in-window.png", { scenarioId: "3", step: "editor refilled the floating window" });
  await closeWindowChrome();
  const end = await snapshot();
  assert(totalTabs(end) === totalTabs(before), "[3] tab count unchanged across the editor trip", `${totalTabs(before)}→${totalTabs(end)}`);
}

async function scenario4() {
  await resetWorkspace();
  await openTab({
    type: "terminal",
    title: "Terminal 1",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { terminalIndex: 1, projectName: PROJECT_NAME },
  });
  await waitFor(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm')`, 30000, "xterm mounted");
  const start = await snapshot();
  const originPanel = panelOf(start, TERMINAL_ID);

  // (a) close PiP → tab is in the floating window
  const { winId } = await popOutViaMenu(TERMINAL_ID);
  const pip = await enterPip(winId);
  await screenshot("04-terminal-in-pip.png", { pipSid: pip.sid, scenarioId: "4", step: "before closing PiP" });
  await leavePip({ viaPlaceholder: true });
  const afterPip = await where(TERMINAL_ID, winId);
  assert(afterPip.doc === "main" && afterPip.inWindow, "[4a] closing PiP leaves the tab in the floating window", JSON.stringify(afterPip));

  // (b) close the window → tab is back in its origin panel
  await closeWindowChrome();
  const afterClose = await snapshot();
  assert(panelOf(afterClose, TERMINAL_ID) === originPanel, "[4b] closing the window re-docks into the origin panel", `panel=${panelOf(afterClose, TERMINAL_ID)}`);
  assert(totalTabs(afterClose) === totalTabs(start), "[4b] tab count unchanged", `${totalTabs(start)}→${totalTabs(afterClose)}`);
  await screenshot("04-after-redock.png", { scenarioId: "4", step: "tab re-docked after window close" });

  // (c) origin panel closed first → the tab lands in the focused grid panel
  const split = await ev(`${PANELS}.getState().splitPanel('right', ${JSON.stringify(TERMINAL_ID)}, ${JSON.stringify(originPanel)})`);
  await sleep(900);
  const afterSplit = await snapshot();
  const newPanel = panelOf(afterSplit, TERMINAL_ID);
  assert(split && newPanel && newPanel !== originPanel, "[4c] terminal moved to a second grid panel", `split=${split} panel=${newPanel}`);

  const { winId: win2 } = await popOutViaMenu(TERMINAL_ID);
  // Empty the origin panel so it disappears while the tab is detached.
  await ev(`(async () => {
    const p = ${PANELS}.getState();
    const panel = p.panels[${JSON.stringify(newPanel)}];
    if (panel) for (const t of [...panel.tabs]) p.closeTab(t.id, ${JSON.stringify(newPanel)});
    return 'ok';
  })()`);
  await sleep(800);
  const gone = await snapshot();
  assert(!gone.grid.flat().includes(newPanel), "[4c] origin panel closed while the tab is detached", `grid=${JSON.stringify(gone.grid)}`);
  await closeWindowChrome();
  const landed = await snapshot();
  const landedPanel = panelOf(landed, TERMINAL_ID);
  assert(
    landedPanel && landed.grid.flat().includes(landedPanel),
    "[4c] tab lands in a live grid panel when its origin is gone",
    `panel=${landedPanel} focused=${landed.focused} grid=${JSON.stringify(landed.grid)}`,
  );
  assert(landedPanel === landed.focused, "[4c] the landing panel is the focused one", `landed=${landedPanel} focused=${landed.focused}`);
}

async function scenario5() {
  await resetWorkspace();
  await openTab({
    type: "terminal",
    title: "Terminal 1",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { terminalIndex: 1, projectName: PROJECT_NAME },
  });
  await waitFor(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm')`, 30000, "xterm mounted");
  const { winId } = await popOutViaMenu(TERMINAL_ID);
  const beforeReload = await snapshot();
  const rect = beforeReload.windows.find((w) => w.id === winId).rect;
  await sleep(2200); // let the debounced workspace sync land

  const loaded = cdp.once("Page.loadEventFired", main, 25000);
  await cdp.send("Page.reload", {}, main);
  await loaded;
  await sleep(3500);
  await cdp.send("Runtime.enable", {}, main).catch(() => {});
  await waitFor(`${PROJECTS}.getState().activeProject?.name === ${JSON.stringify(PROJECT_NAME)}`, 40000, "project active after reload");
  await sleep(2500);
  await installAppHelpers();

  const after = await snapshot();
  const restored = after.windows.find((w) => w.id === winId);
  assert(!!restored, "[5] the floating window is restored after reload", `windows=${JSON.stringify(after.windows.map((w) => w.id))}`);
  assert(
    restored && ["x", "y", "w", "h"].every((k) => restored.rect[k] === rect[k]),
    "[5] restored at the persisted rect",
    `before=${JSON.stringify(rect)} after=${JSON.stringify(restored?.rect)}`,
  );
  assert(panelOf(after, TERMINAL_ID) === `__win__:${winId}`, "[5] the tab is still in the window panel", `panel=${panelOf(after, TERMINAL_ID)}`);
  await waitFor(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm')`, 30000, "xterm remounted");
  const w = await where(TERMINAL_ID, winId);
  assert(w.inWindow, "[5] the tab is alive inside the floating window", JSON.stringify(w));
  const pipTarget = await findPipTarget();
  assert(!pipTarget, "[5] no PiP window auto-opens on reload", `pipTarget=${pipTarget ? pipTarget.targetId : "none"}`);
  const dupes = await ev(`(async () => {
    const p = ${PANELS}.getState();
    const ids = Object.values(p.panels).flatMap(panel => panel.tabs.map(t => t.id));
    const seen = new Set(); const dup = [];
    for (const id of ids) { if (seen.has(id)) dup.push(id); seen.add(id); }
    return JSON.stringify({ ids, dup });
  })()`);
  const dupInfo = JSON.parse(dupes);
  record("[5] reload creates no duplicate tab entries", dupInfo.dup.length === 0, `ids=${JSON.stringify(dupInfo.ids)}`);
  await screenshot("05-window-restored-after-reload.png", { scenarioId: "5", step: "floating window restored after reload" });
  await closeWindowChrome();
}

async function scenario6() {
  // A second page in the same browser, booted with the API removed before any app code runs.
  const t = await (await fetch(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const sid = await cdp.attach(t.id);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid).catch(() => {});
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: pageInitScript(TOKEN, { deletePipApi: true }) }, sid);
  const savedMain = main;
  const savedTarget = mainTargetId;
  main = sid;
  mainTargetId = t.id;
  try {
    await neutralizeStrictMode(sid);
    await openApp();
    await resetWorkspace();
    const noApi = await ev(`!('documentPictureInPicture' in window)`);
    assert(noApi, "[6] documentPictureInPicture removed before boot", `absent=${noApi}`);
    await openTab({
      type: "terminal",
      title: "Terminal 1",
      projectId: PROJECT_NAME,
      closable: true,
      metadata: { terminalIndex: 1, projectName: PROJECT_NAME },
    });
    await waitFor(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm')`, 30000, "xterm mounted");
    const { winId } = await popOutViaMenu(TERMINAL_ID);
    const btn = await ev(`(() => {
      const all = [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label'));
      return JSON.stringify({
        pipButtons: all.filter(l => /picture-in-picture/i.test(l)),
        closeButtons: all.filter(l => l === 'Close window').length,
      });
    })()`);
    const info = JSON.parse(btn);
    assert(info.pipButtons.length === 0, "[6] PiP button is absent (not disabled) without the API", btn);
    assert(info.closeButtons > 0, "[6] the window itself still works", btn);
    await screenshot("06-no-pip-button-unsupported.png", { scenarioId: "6", step: "window chrome without the PiP API" });
    await ev(`${WINDOWS}.getState().close(${JSON.stringify(winId)})`);
    await sleep(600);
  } finally {
    main = savedMain;
    mainTargetId = savedTarget;
    await fetch(`http://localhost:${CDP_PORT}/json/close/${t.id}`).catch(() => {});
    await sleep(400);
  }
}

async function scenarioMobile() {
  await resetWorkspace();
  await openTab({
    type: "terminal",
    title: "Terminal 1",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { terminalIndex: 1, projectName: PROJECT_NAME },
  });
  await waitFor(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm')`, 30000, "xterm mounted");
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    main,
  );
  await sleep(1500);
  try {
    const isMobile = await ev(`${PANELS}.getState().isMobile()`);
    assert(isMobile, "[M] app is in the mobile layout", `innerWidth=${await ev("window.innerWidth")}`);
    const chips = await ev(`(() => {
      const els = [...document.querySelectorAll('[data-tab-item]')];
      return JSON.stringify({ total: els.length, visible: els.filter(e => e.offsetParent !== null).length });
    })()`);
    const menuText = await ev(`document.body.innerText.includes('Open in window')`);
    assert(!menuText, "[M] no 'Open in window' affordance anywhere on mobile", `chips=${chips}`);
    const rejected = await ev(`(async () => {
      const p = ${PANELS}.getState();
      const pid = Object.keys(p.panels).find(id => p.panels[id].tabs.some(t => t.id === 'terminal:1'));
      return p.popOutTab('terminal:1', pid) === null;
    })()`);
    assert(rejected, "[M] popOutTab is refused on a mobile viewport", `rejected=${rejected}`);
    const noWindows = await ev(`Object.keys(${WINDOWS}.getState().windows).length === 0 && document.querySelectorAll('[role="group"][aria-label]').length === 0`);
    assert(noWindows, "[M] no floating window exists on mobile", `noWindows=${noWindows}`);
    await screenshot("07-mobile-no-popout.png", { scenarioId: "mobile", step: "mobile viewport, no pop-out affordance" });
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, main).catch(() => {});
    await sleep(1200);
  }
}

/**
 * Focus must never land on a `__win__:` panel: a floating window has no tab bar, so the
 * next `openTab()` with no explicit panel would drop a tab somewhere unreachable — and
 * the id would be persisted with the layout.
 */
async function scenario8() {
  await resetWorkspace();
  const persistedFocus = `(() => {
    const raw = localStorage.getItem('ppm-panels-' + ${JSON.stringify(PROJECT_NAME)});
    return raw ? (JSON.parse(raw).focusedPanelId ?? null) : null;
  })()`;

  // --- singleton (settings) ---
  await openTab({ type: "settings", title: "Settings", projectId: PROJECT_NAME, closable: true, metadata: {} });
  await sleep(800);
  const { winId } = await popOutViaMenu("settings");
  const afterPopOut = await snapshot();
  assert(
    panelOf(afterPopOut, "settings") === `__win__:${winId}`,
    "[8] settings tab detached into the window panel",
    `panel=${panelOf(afterPopOut, "settings")}`,
  );

  // Re-trigger the singleton the way the nav/command path does, twice over: openTab's
  // dedupe branch and a bare setActiveTab with no panelId.
  await ev(`${PANELS}.getState().openTab({ type: 'settings', title: 'Settings', projectId: ${JSON.stringify(PROJECT_NAME)}, closable: true, metadata: {} })`);
  await sleep(500);
  await ev(`${PANELS}.getState().setActiveTab('settings')`);
  await sleep(700);

  const afterActivate = await snapshot();
  assert(
    afterActivate.grid.flat().includes(afterActivate.focused),
    "[8] focusedPanelId is a grid panel after re-activating the detached singleton",
    `focused=${afterActivate.focused} grid=${JSON.stringify(afterActivate.grid)}`,
  );
  assert(
    panelOf(afterActivate, "settings") === `__win__:${winId}`,
    "[8] the settings tab stayed in the window (activation did not pull it home)",
    `panel=${panelOf(afterActivate, "settings")}`,
  );

  // The consequence the invariant exists for: a new tab with no panelId must land in the grid.
  await openTab({
    type: "terminal",
    title: "Terminal 2",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { terminalIndex: 2, projectName: PROJECT_NAME },
  });
  const afterOpen = await snapshot();
  const newTabPanel = panelOf(afterOpen, "terminal:2");
  assert(
    newTabPanel && afterOpen.grid.flat().includes(newTabPanel),
    "[8] a new tab opened with no panelId lands in the GRID, not in the window",
    `panel=${newTabPanel} grid=${JSON.stringify(afterOpen.grid)}`,
  );
  const focusOnDisk = await ev(persistedFocus);
  assert(
    focusOnDisk && !String(focusOnDisk).startsWith("__win__:"),
    "[8] persisted ppm-panels-<project> holds no __win__ focusedPanelId",
    `persisted focusedPanelId=${focusOnDisk}`,
  );
  await screenshot("08-focus-invariant.png", { scenarioId: "8", step: "settings detached, new tab landed in the grid" });
  await closeWindowChrome();

  // --- chat, deduped by sessionId (the other focus-setting branch) ---
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const chatDef = {
    type: "chat",
    title: "Chat",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { sessionId, projectName: PROJECT_NAME },
  };
  const chatId = await openTab(chatDef);
  await sleep(800);
  const { winId: chatWin } = await popOutViaMenu(chatId);
  await ev(`${PANELS}.getState().openTab(${JSON.stringify(chatDef)})`); // dedupe branch
  await sleep(800);
  const afterChat = await snapshot();
  assert(
    afterChat.grid.flat().includes(afterChat.focused) && panelOf(afterChat, chatId) === `__win__:${chatWin}`,
    "[8] re-opening a detached chat by sessionId keeps focus on the grid",
    `focused=${afterChat.focused} chatPanel=${panelOf(afterChat, chatId)} tabs=${totalTabs(afterChat)}`,
  );
  assert(
    totalTabs(afterChat) === totalTabs(afterOpen) + 1,
    "[8] the dedupe branch opened no second chat tab",
    `tabs ${totalTabs(afterOpen)}→${totalTabs(afterChat)}`,
  );
  await closeWindowChrome();
}

/**
 * Crossing below the `md` breakpoint unmounts the whole window layer. The detached tab
 * must come home AND the window entry must go away, or the next desktop viewport paints
 * an empty "Loading…" window nothing can fill.
 */
async function scenario9() {
  await resetWorkspace();
  await openTab({
    type: "terminal",
    title: "Terminal 1",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { terminalIndex: 1, projectName: PROJECT_NAME },
  });
  await waitFor(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm')`, 30000, "xterm mounted");
  const { winId } = await popOutViaMenu(TERMINAL_ID);
  const storedWindows = `(() => { const raw = localStorage.getItem('ppm-windows'); return raw ? JSON.parse(raw).map(w => w.id) : []; })()`;
  const beforeMobile = await snapshot();
  assert(
    (await ev(storedWindows)).includes(winId),
    "[9] the window is in ppm-windows before the viewport shrinks",
    `stored=${JSON.stringify(await ev(storedWindows))}`,
  );

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, main);
  await sleep(2500);
  try {
    const onMobile = await snapshot();
    const homePanel = panelOf(onMobile, TERMINAL_ID);
    assert(
      homePanel && !String(homePanel).startsWith("__win__:"),
      "[9] the detached tab re-docks to the grid below the md breakpoint",
      `panel=${homePanel}`,
    );
    // Recorded, not asserted: the window layer renders nothing below md, so a surviving
    // entry is invisible there. What must never happen is a ghost on the way back — that
    // is asserted after the viewport is restored.
    const storeGone = !onMobile.windows.some((w) => w.id === winId);
    const stored = await ev(storedWindows);
    record(
      "[9] the window entry is dropped from the window store while below md",
      storeGone,
      `windows=${JSON.stringify(onMobile.windows.map((w) => w.id))}`,
    );
    record(
      "[9] the window entry is dropped from ppm-windows while below md",
      !stored.includes(winId),
      `stored=${JSON.stringify(stored)}`,
    );
    await screenshot("09-mobile-redock.png", {
      scenarioId: "9",
      step: "below md: tab re-docked to the grid",
      pass: storeGone,
    });
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, main).catch(() => {});
  }

  // Sample the first seconds back on the desktop: a window element that appears and is
  // then reconciled away is still a ghost the user can see.
  let peakWindowEls = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    peakWindowEls = Math.max(peakWindowEls, await ev(`document.querySelectorAll('[role="group"][aria-label]').length`));
  }
  record("[9] no window element flashes on the way back to desktop", peakWindowEls === 0, `peak window elements=${peakWindowEls}`);
  await sleep(1500);

  const back = await snapshot();
  assert(
    back.windows.length === 0,
    "[9] no window comes back on the desktop viewport",
    `windows=${JSON.stringify(back.windows.map((w) => w.id))}`,
  );
  const ghost = await ev(`(() => {
    const groups = [...document.querySelectorAll('[role="group"][aria-label]')];
    return JSON.stringify({ windowEls: groups.length, loading: document.body.innerText.includes('Loading…') });
  })()`);
  assert(
    JSON.parse(ghost).windowEls === 0 && !JSON.parse(ghost).loading,
    "[9] no empty 'Loading…' ghost window is painted",
    ghost,
  );
  assert(
    totalTabs(back) === totalTabs(beforeMobile),
    "[9] no tab was lost or duplicated across the viewport round trip",
    `${totalTabs(beforeMobile)}→${totalTabs(back)}`,
  );
  await screenshot("09b-back-to-desktop.png", { scenarioId: "9", step: "back above md: no ghost window" });

  // Harder case for the entry that survives on mobile: reload while below md (so the
  // persisted blob is all that is left), then come back to the desktop viewport.
  await openTab({
    type: "terminal",
    title: "Terminal 1",
    projectId: PROJECT_NAME,
    closable: true,
    metadata: { terminalIndex: 1, projectName: PROJECT_NAME },
  }).catch(() => {});
  await waitFor(`document.querySelector('[data-tab-pool-id="terminal:1"] .xterm')`, 30000, "xterm mounted");
  const { winId: win2 } = await popOutViaMenu(TERMINAL_ID);
  await sleep(1500);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, main);
  await sleep(2500);
  const reloaded = cdp.once("Page.loadEventFired", main, 25000);
  await cdp.send("Page.reload", {}, main);
  await reloaded;
  await sleep(4000);
  await cdp.send("Runtime.enable", {}, main).catch(() => {});
  await waitFor(`${PROJECTS}.getState().activeProject?.name === ${JSON.stringify(PROJECT_NAME)}`, 40000, "app after mobile reload");
  await sleep(2500);
  await installAppHelpers();
  const mobileReload = await snapshot();
  record(
    "[9] mobile reload paints no floating window",
    (await ev(`document.querySelectorAll('[role="group"][aria-label]').length`)) === 0,
    `windowsInStore=${JSON.stringify(mobileReload.windows.map((w) => w.id))} tabPanel=${panelOf(mobileReload, TERMINAL_ID)}`,
  );
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, main).catch(() => {});
  let peakAfterReload = 0;
  for (let i = 0; i < 16; i++) {
    await sleep(250);
    peakAfterReload = Math.max(peakAfterReload, await ev(`document.querySelectorAll('[role="group"][aria-label]').length`));
  }
  const end = await snapshot();
  record(
    "[9] no ghost window after a mobile reload followed by a desktop viewport",
    peakAfterReload === 0 && end.windows.length === 0,
    `peak window elements=${peakAfterReload}, windows=${JSON.stringify(end.windows.map((w) => w.id))}, tabPanel=${panelOf(end, TERMINAL_ID)}, win2=${win2}`,
  );
  await screenshot("09c-after-mobile-reload.png", {
    scenarioId: "9",
    step: "desktop viewport after a mobile reload",
    pass: peakAfterReload === 0 && end.windows.length === 0,
  });
}

async function scenario7() {
  const files = [
    "tests/unit/stores/window-panel-popout.test.ts",
    "tests/unit/stores/window-panel-redock.test.ts",
    "tests/unit/stores/window-panel-persistence.test.ts",
    "tests/unit/stores/reconcile-tab-host-windows.test.ts",
    "tests/unit/stores/tab-pool-collect-windows.test.ts",
    "tests/unit/web/pip-support.test.ts",
    "tests/unit/web/pip-geometry.test.ts",
    "tests/unit/web/pip-style-copy.test.ts",
    "tests/unit/web/pip-focus-target.test.ts",
    "tests/unit/web/portal-container-context.test.tsx",
  ];
  const missing = [];
  for (const f of files) {
    if (!(await Bun.file(join("C:\\Users\\PC\\ppm", f)).exists())) missing.push(f);
  }
  assert(missing.length === 0, "[7] phase-01/02/03 unit files exist", `missing=${JSON.stringify(missing)}`);
  const proc = Bun.spawn(["bun", "test", "tests/unit/stores", "tests/unit/web"], {
    cwd: "C:\\Users\\PC\\ppm",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  const tail = (err + out).split("\n").filter((l) => /\d+ pass|\d+ fail|error:/.test(l)).slice(-4).join(" | ");
  record("[7] bun test tests/unit/stores tests/unit/web is green", code === 0, `exit=${code} ${tail}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function writeVisualsIndex() {
  const lines = [
    "# Phase-05 e2e screenshots",
    "",
    `Run ${new Date().toISOString()} · capture method per file (\`os\` = PowerShell CopyFromScreen of the whole desktop,`,
    "`cdp-pip` / `cdp-main` = `Page.captureScreenshot` of the PiP target / the app page — the GDI path fails on a",
    "disconnected RDP session and cannot see the PiP window anyway).",
    "",
    "| File | Scenario | Step | Result | Method |",
    "|---|---|---|---|---|",
    ...shots.map((s) => `| \`${s.name}\` | ${s.scenarioId} | ${s.step} | ${s.pass ? "PASS" : "FAIL"} | ${s.method} |`),
    "",
    `## Checks: ${results.filter((r) => r.pass).length}/${results.length} passed`,
    "",
    ...(results.some((r) => !r.pass)
      ? results.filter((r) => !r.pass).map((r) => `- FAIL ${r.name} — ${r.detail.slice(0, 240)}`)
      : ["All checks passed."]),
    "",
  ];
  await writeFile(join(VISUALS_DIR, "README.md"), lines.join("\n"), "utf8");
}

async function run() {
  await mkdir(VISUALS_DIR, { recursive: true });
  await mkdir(PROJECT_DIR, { recursive: true });
  await writeFile(join(PROJECT_DIR, "scratch.ts"), "export const scratch = 1;\n", "utf8");
  const created = await api("POST", "/api/projects", { path: PROJECT_DIR, name: PROJECT_NAME });
  if (!created.ok) throw new Error(`project register failed: ${JSON.stringify(created)}`);
  console.log(`temp project ${PROJECT_NAME} → ${PROJECT_DIR}`);

  await bootBrowser();
  await openApp();

  // Measured with StrictMode ON, before anything else touches the page.
  await scenario("0", "StrictMode keeps the tab in its window", scenario0);

  const neutralized = await neutralizeStrictMode(main);
  if (neutralized) {
    const loaded = cdp.once("Page.loadEventFired", main, 25000);
    await cdp.send("Page.reload", { ignoreCache: true }, main);
    await loaded;
    await sleep(2500);
    await waitFor(`${PROJECTS}.getState().activeProject?.name === ${JSON.stringify(PROJECT_NAME)}`, 40000, "app after reload");
    await installAppHelpers();
    console.log("StrictMode neutralised for scenarios 1-7 (production builds have none)");
  }

  await scenario("1", "terminal survives the whole trip", scenario1);
  await scenario("2", "chat streams while detached", scenario2);
  await scenario("3", "editor keeps unsaved buffer + undo", scenario3);
  await scenario("4", "close semantics", scenario4);
  await scenario("5", "reload restores as a floating window", scenario5);
  await scenario("6", "unsupported browser", scenario6);
  await scenario("8", "focus never lands on a window panel", scenario8);
  await scenario("9", "no ghost window below the md breakpoint", scenario9);
  await scenario("mobile", "mobile guard", scenarioMobile);
  await scenario("7", "unit coverage", scenario7);
}

let exitCode = 0;
try {
  await run();
} catch (e) {
  record("harness", false, e?.message || String(e));
} finally {
  try {
    await writeVisualsIndex();
  } catch (e) {
    console.log("visuals index failed:", e.message);
  }
  // Unregister the throwaway project — twice if needed, and say so when it survives,
  // because a silent leak turns the dev workspace into the non-deterministic mess this
  // harness exists to avoid.
  for (let i = 0; i < 2; i++) {
    try {
      const r = await api("DELETE", `/api/projects/${PROJECT_NAME}`);
      if (r?.ok) break;
      if (i === 1) console.log(`WARN: temp project ${PROJECT_NAME} not removed: ${JSON.stringify(r)}`);
    } catch (e) {
      if (i === 1) console.log(`WARN: temp project ${PROJECT_NAME} not removed: ${e.message}`);
      await sleep(500);
    }
  }
  try {
    await cdp?.send("Browser.close");
  } catch {}
  try {
    chrome?.kill();
  } catch {}
  await sleep(1200);
  await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(PROJECT_DIR, { recursive: true, force: true }).catch(() => {});

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
  for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
  exitCode = failed.length;
}
process.exit(exitCode);
