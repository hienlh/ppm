// The chat toolbar must never push its pinned controls out of view.
//
// Repro this guards against: the toolbar row was one flat `flex` with no
// `min-w-0` and no overflow rule, so in a narrow chat pane the status chips
// (History / provider / usage / Team) — which cannot shrink below their text —
// shoved the connection indicator and the actions past the right edge. The pane
// clips, so the reconnect button vanished exactly when the socket was most
// likely to be down.
//
// Now: chips scroll in a left zone, controls stay pinned in a right zone, and
// low-frequency session actions live behind the overflow ("...") menu.
//
// Run:
//   bun tests/e2e/chat-toolbar-narrow-overflow.mjs
//
// Env:
//   PPM_E2E_WEB=http://localhost:5173   dev web origin
//   CHROME_PATH=...                     override Chrome executable path

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

const AUTH_TOKEN = "123123";
const TOKEN_KEY = "ppm-auth-token";
const WEB = process.env.PPM_E2E_WEB || "http://localhost:5173";
const WEB_PROJECT = `${WEB}/project/${encodeURIComponent("ppm")}`;
const CDP_PORT = 9226;
const SHOTS = join(process.cwd(), "tests", "e2e", "screenshots");
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// Widths a chat pane realistically shrinks to: desktop, split pane, phone.
const WIDTHS = [1280, 900, 700, 520, 390];

const log = (m) => console.log(m);
let chrome = null;

async function launchChrome() {
  const profile = join(tmpdir(), `ppm-toolbar-e2e-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1280,900",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json`, {
        signal: AbortSignal.timeout(1500),
      });
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
      const entry = msg.id && this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
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
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
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
        "evaluate threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
      );
    }
    return r.result?.value;
  }

  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(SHOTS, name), Buffer.from(data, "base64"));
  }
}

/** Locate the toolbar structurally — no test-only attributes in production code. */
const TOOLBAR_JS = `
  window.__toolbar = () => {
    const btns = Array.from(document.querySelectorAll("button"));
    const history = btns.find((b) => b.textContent.trim() === "History" && b.offsetParent !== null);
    if (!history) return null;
    const scroller = history.parentElement;          // left zone
    const row = scroller.parentElement;              // toolbar row
    const pinned = row.lastElementChild;             // right zone
    return { row, scroller, pinned };
  };
`;

const PROBE = `(() => {
  const t = window.__toolbar();
  if (!t) return { found: false };
  const row = t.row.getBoundingClientRect();
  const pinned = t.pinned.getBoundingClientRect();
  const more = t.pinned.querySelector('[aria-label="More actions"]');
  const moreRect = more ? more.getBoundingClientRect() : null;
  return {
    found: true,
    rowW: Math.round(row.width),
    rowH: Math.round(row.height),
    // Row itself must not overflow: the left zone absorbs it by scrolling.
    rowOverflow: t.row.scrollWidth - t.row.clientWidth,
    scrollerOverflow: t.scroller.scrollWidth - t.scroller.clientWidth,
    // Pinned zone must sit entirely inside the row's box.
    pinnedInside: pinned.left >= row.left - 0.5 && pinned.right <= row.right + 0.5,
    pinnedW: Math.round(pinned.width),
    hasMore: !!more,
    moreInside: moreRect
      ? moreRect.left >= row.left - 0.5 && moreRect.right <= row.right + 0.5
      : null,
    // The connection dot lives on the reload button and must stay visible.
    hasReload: !!t.pinned.querySelector("button[title*='Reload'], button[title*='Disconnected']"),
  };
})()`;

async function waitFor(cdp, expr, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expr);
      if (last) return last;
    } catch {
      /* page loading */
    }
    await Bun.sleep(300);
  }
  throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

/**
 * Keep dismissing modals. Whichever feature branch is checked out may pop a
 * setup dialog (and re-pop it on a socket event) that would swallow every click.
 */
async function killModals(cdp) {
  await cdp.evaluate(`(() => {
    clearInterval(window.__killModals);
    const kill = () => {
      // Radix dialogs: press their cancel/close control.
      document.querySelectorAll('[role="dialog"]').forEach((d) => {
        const b = Array.from(d.querySelectorAll("button")).find(
          (x) => /^(Huỷ|Cancel|Close|Skip)$/i.test(x.textContent.trim()) ||
                 x.getAttribute("aria-label") === "Close",
        );
        if (b) b.click();
      });
      // Bottom sheets are plain full-screen layers with no dialog role; hiding
      // them (rather than clicking) avoids firing an outside-click that would
      // also close the dropdown under test.
      document.querySelectorAll("div.fixed.inset-0").forEach((el) => {
        if (!el.querySelector('[role="menu"]')) el.style.display = "none";
      });
    };
    kill();
    window.__killModals = setInterval(kill, 500);
  })()`);
  await Bun.sleep(1200);
}

/** Open an existing session so the session-scoped toolbar actions render. */
async function openExistingSession(cdp) {
  await cdp.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent.trim() === "History");
    b && b.click();
  })()`);
  const opened = await cdp
    .evaluate(
      `new Promise((res) => setTimeout(() => {
        const rows = Array.from(document.querySelectorAll("div[class*='px-3'][class*='py-1.5']"))
          .filter((el) => el.offsetParent !== null && el.querySelector("button"));
        const title = rows[0] && rows[0].querySelector("button");
        if (!title) return res(false);
        title.click();
        res(true);
      }, 3000))`,
    )
    .catch(() => false);
  await Bun.sleep(4000);
  // Collapse the history panel again so only the toolbar is under test.
  await cdp.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent.trim() === "History" && b.offsetParent !== null);
    if (b && b.className.includes("bg-primary/10")) b.click();
  })()`);
  await Bun.sleep(800);
  return opened;
}

async function main() {
  log(`web: ${WEB}`);
  const wsUrl = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(AUTH_TOKEN)});`,
  });
  await cdp.send("Page.navigate", { url: WEB_PROJECT });

  await waitFor(cdp, `!!document.querySelector("button")`, "app shell");
  await Bun.sleep(6000);
  await killModals(cdp);

  // The workspace restores whatever tab was last open, so ask for a chat tab and
  // then load its URL directly — that is what makes the chat the *active* tab.
  await cdp.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent.trim() === "AI Chat");
    b && b.click();
  })()`);
  await Bun.sleep(4000);
  const chatUrl = await cdp.evaluate("location.href");
  if (!chatUrl.includes("/chat/")) throw new Error(`no chat tab opened (at ${chatUrl})`);
  await cdp.send("Page.navigate", { url: chatUrl });
  await Bun.sleep(8000);
  await killModals(cdp);

  await cdp.evaluate(TOOLBAR_JS);
  await waitFor(cdp, `(window.__toolbar(), !!window.__toolbar())`, "chat toolbar");

  const withSession = await openExistingSession(cdp);
  await cdp.evaluate(TOOLBAR_JS);
  log(withSession ? "  opened an existing session" : "  no stored session — new chat only");

  const failures = [];
  for (const width of WIDTHS) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
    await Bun.sleep(700);
    await cdp.evaluate(TOOLBAR_JS);
    const p = await cdp.evaluate(PROBE);
    if (!p.found) {
      failures.push(`${width}px — toolbar not found`);
      continue;
    }
    log(
      `  ${String(width).padStart(4)}px  rowOverflow=${p.rowOverflow}  ` +
        `chipsScroll=${p.scrollerOverflow}  pinnedInside=${p.pinnedInside}  ` +
        `more=${p.hasMore}  reload=${p.hasReload}`,
    );
    if (p.rowOverflow > 1) failures.push(`${width}px — toolbar row overflows by ${p.rowOverflow}px`);
    if (!p.pinnedInside) failures.push(`${width}px — pinned controls clipped outside the row`);
    if (!p.hasReload) failures.push(`${width}px — reload/connection indicator missing`);
    if (withSession && !p.hasMore) failures.push(`${width}px — overflow menu trigger missing`);
    if (withSession && p.hasMore && !p.moreInside) {
      failures.push(`${width}px — overflow menu trigger clipped`);
    }
    await cdp.shot(`chat-toolbar-${width}.png`);
  }

  // Control: with more chips than fit, the fix must absorb them by scrolling —
  // and the same measurement must catch a toolbar that lacks the fix. Without
  // this the run above proves nothing, since a short chip set fits anyway.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 900, deviceScaleFactor: 1, mobile: true,
  });
  await Bun.sleep(600);
  await cdp.evaluate(TOOLBAR_JS);
  const control = await cdp.evaluate(`(() => {
    const t = window.__toolbar();
    const pad = document.createElement("span");
    pad.id = "__chip_pad";
    pad.style.cssText = "flex:0 0 420px;height:16px";
    t.scroller.appendChild(pad);
    const measure = () => {
      const row = t.row.getBoundingClientRect();
      const pinned = t.pinned.getBoundingClientRect();
      return {
        rowOverflow: t.row.scrollWidth - t.row.clientWidth,
        chipsScroll: t.scroller.scrollWidth - t.scroller.clientWidth,
        pinnedInside: pinned.left >= row.left - 0.5 && pinned.right <= row.right + 0.5,
      };
    };
    const withFix = measure();
    // Emulate the pre-fix row: chips cannot shrink and nothing scrolls.
    t.scroller.style.minWidth = "auto";
    t.scroller.style.overflowX = "visible";
    t.scroller.style.flex = "0 0 auto";
    const withoutFix = measure();
    t.scroller.style.minWidth = "";
    t.scroller.style.overflowX = "";
    t.scroller.style.flex = "";
    pad.remove();
    return { withFix, withoutFix };
  })()`);
  log(`  control  with fix: ${JSON.stringify(control.withFix)}`);
  log(`  control  no fix:   ${JSON.stringify(control.withoutFix)}`);
  if (control.withFix.chipsScroll <= 0) failures.push("control — chips did not overflow; test is not exercising the fix");
  if (!control.withFix.pinnedInside) failures.push("control — pinned controls clipped despite the fix");
  if (control.withFix.rowOverflow > 1) failures.push("control — toolbar row itself overflowed");
  if (control.withoutFix.pinnedInside) failures.push("control — probe cannot detect the pre-fix layout");

  // The "..." menu must actually open and hold the moved actions.
  if (withSession) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 520,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await Bun.sleep(500);
    await cdp.evaluate(TOOLBAR_JS);
    // Radix opens on pointerdown, so a synthetic .click() would do nothing.
    const at = await cdp.evaluate(`(() => {
      const r = window.__toolbar().pinned
        .querySelector('[aria-label="More actions"]').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: 1,
      });
    }
    await Bun.sleep(800);
    const items = await cdp.evaluate(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).map((i) => i.textContent.trim())`,
    );
    log(`  menu items: ${JSON.stringify(items)}`);
    await cdp.shot("chat-toolbar-overflow-menu.png");
    const joined = items.join(" | ").toLowerCase();
    if (!/mark as (read|unread)/.test(joined)) failures.push("overflow menu missing read/unread action");
    if (!joined.includes("debug")) failures.push("overflow menu missing session debug action");
  }

  if (failures.length) {
    log("\nFAIL:");
    for (const f of failures) log(`  - ${f}`);
    throw new Error(`${failures.length} toolbar check(s) failed`);
  }
  log(`\nPASS — toolbar holds its pinned controls at ${WIDTHS.join(", ")}px`);
  log(`screenshots: ${SHOTS}`);
}

try {
  await main();
} finally {
  chrome?.kill();
}
