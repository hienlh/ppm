// Inline tool images — real browser end-to-end harness (headless Chrome via raw CDP).
//
// Verifies that when the assistant runs `Read` on an image file, the chat tool card renders
// the image inline (thumbnail + tap-to-enlarge) and no base64 text reaches the DOM.
//
// This runs ONE real Claude turn: the whole point is to exercise
// provider -> websocket -> tool card -> blob fetch -> /api/fs/raw end to end.
// The prompt is a single explicit Read, so the turn stays small.
//
// Run (servers must already be up on 8081/5173, e.g. `bun dev`):
//   bun tests/e2e/chat-inline-tool-images.mjs
//
// Env overrides:
//   CHROME_PATH=...   override Chrome executable path
//   PPM_E2E_KEEP=1    leave Chrome open after the run (debugging)

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";

const REPO = process.cwd();
const WEB = `http://localhost:${process.env.PPM_E2E_WEB_PORT ?? "5173"}`;
const PROJECT_NAME = "ppm";
const WEB_PROJECT = `${WEB}/project/${encodeURIComponent(PROJECT_NAME)}`;
const TOKEN_KEY = "ppm-auth-token"; // src/web/lib/api-client.ts
const DEV_DB = join(homedir(), ".ppm", "ppm.dev.db");
const CDP_PORT = 9337;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const KEEP = !!process.env.PPM_E2E_KEEP;

const IMAGE_PATH = join(REPO, "docs", "media", "ppm-ad-poster.png");
const PROMPT = `Read the image at ${IMAGE_PATH} then reply with only the word OK.`;
const VISUALS = join(REPO, "plans", "260828-0110-chat-inline-tool-images", "visuals");

const log = (...a) => console.log(...a);
const step = (s) => log(`\n${s}`);
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, 60000);
    });
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`${r.exceptionDetails.text} :: ${expression.slice(0, 140)}`);
    }
    return r.result.value;
  }

  async setViewport(width, height, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
      ...(mobile ? { hasTouch: true } : { hasTouch: false }),
    });
  }

  async screenshot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    const path = join(VISUALS, name);
    await writeFile(path, Buffer.from(r.data, "base64"));
    log(`   screenshot -> ${path}`);
    return path;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(`!!(${expression})`)) return true;
    } catch {}
    await Bun.sleep(400);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Set a React-controlled input's value the way React's own listeners expect. */
function typeIntoExpr(selectorExpr, value) {
  return `(() => {
    const el = ${selectorExpr};
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
}

// The tool card for an image Read: an <img> with a blob: src inside the chat feed.
const THUMB_SELECTOR = `[...document.querySelectorAll('img')].find(i => i.src.startsWith('blob:'))`;

const main = async () => {
  await mkdir(VISUALS, { recursive: true });

  const db = new Database(DEV_DB, { readonly: true });
  const token = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
  db.close();

  step("1. Launch headless Chrome");
  const profile = join(tmpdir(), `ppm-inline-images-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,980",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let wsUrl;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await (
        await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) })
      ).json();
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await Bun.sleep(400);
  }
  if (!wsUrl) throw new Error("Chrome CDP never became ready");

  const cdp = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(new Cdp(ws)));
    ws.addEventListener("error", reject);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  try {
    step("2. Authenticate and open the ppm project");
    await cdp.send("Page.navigate", { url: WEB });
    await Bun.sleep(2500);
    await cdp.evaluate(
      `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)}), null`,
    );
    await cdp.send("Page.navigate", { url: WEB_PROJECT });
    await Bun.sleep(9000);

    step("3. Wait for the chat composer");
    await waitFor(
      cdp,
      `document.querySelector('textarea[placeholder="Ask anything..."]')`,
      "chat composer",
      45000,
    );

    step("4. Send a single Read-an-image turn");
    log(`   prompt: ${PROMPT}`);
    const typed = await cdp.evaluate(
      typeIntoExpr(`document.querySelector('textarea[placeholder="Ask anything..."]')`, PROMPT),
    );
    if (!typed) throw new Error("could not type into the composer");
    await Bun.sleep(400);
    await cdp.evaluate(`(() => {
      const btn = document.querySelector('[aria-label="Send"], [aria-label="Send message"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);

    step("5. Wait for the inline image to render (real turn, up to 180s)");
    await waitFor(cdp, THUMB_SELECTOR, "inline blob image in the tool card", 180000);
    await Bun.sleep(1200);

    const thumb = await cdp.evaluate(`(() => {
      const img = ${THUMB_SELECTOR};
      return JSON.stringify({
        alt: img.alt,
        w: img.naturalWidth,
        h: img.naturalHeight,
        renderedH: Math.round(img.getBoundingClientRect().height),
      });
    })()`).then(JSON.parse);
    check(
      "thumbnail decoded from a blob URL",
      thumb.w > 0 && thumb.h > 0,
      `${thumb.w}x${thumb.h} natural, ${thumb.renderedH}px tall, alt="${thumb.alt}"`,
    );
    check("thumbnail is capped to the card", thumb.renderedH > 0 && thumb.renderedH <= 160,
      `${thumb.renderedH}px`);

    // The pre-fix behaviour dumped ~1.6MB of base64 into this card as text.
    const base64Leak = await cdp.evaluate(`(() => {
      const img = ${THUMB_SELECTOR};
      const card = img.closest('[data-tool-ref]') || img.parentElement;
      const text = card ? card.innerText : '';
      const run = text.match(/[A-Za-z0-9+/]{300,}/);
      return JSON.stringify({ len: text.length, leak: run ? run[0].length : 0 });
    })()`).then(JSON.parse);
    check("no base64 run in the tool card", base64Leak.leak === 0,
      `card text ${base64Leak.len} chars, longest base64-ish run ${base64Leak.leak}`);

    await cdp.screenshot("desktop-01-thumbnail.png");

    step("6. Open the enlarged view (desktop dialog)");
    await cdp.evaluate(`(() => { ${THUMB_SELECTOR}.closest('button').click(); return true; })()`);
    await waitFor(cdp, `document.querySelector('[data-slot="dialog-content"]')`, "dialog", 10000);
    await Bun.sleep(700);
    const dialogImg = await cdp.evaluate(
      `!!document.querySelector('[data-slot="dialog-content"] img')`,
    );
    check("desktop enlarged view is a dialog with the image", dialogImg);
    await cdp.screenshot("desktop-02-enlarged.png");

    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });
    await Bun.sleep(600);

    step("7. Mobile viewport (390x844) — enlarged view must be a bottom sheet");
    await cdp.setViewport(390, 844, true);
    await Bun.sleep(1500);
    await waitFor(cdp, THUMB_SELECTOR, "thumbnail at mobile width", 15000);
    await cdp.screenshot("mobile-01-thumbnail.png");

    await cdp.evaluate(`(() => { ${THUMB_SELECTOR}.closest('button').click(); return true; })()`);
    await Bun.sleep(1200);
    const sheet = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[data-slot="dialog-content"]');
      // The bottom sheet is a portal panel anchored to the bottom, not a radix dialog.
      const imgs = [...document.querySelectorAll('img')].filter(i => i.src.startsWith('blob:'));
      const enlarged = imgs.find(i => i.getBoundingClientRect().width > 300);
      return JSON.stringify({ hasDialog: !!dialog, enlargedCount: imgs.length, hasEnlarged: !!enlarged });
    })()`).then(JSON.parse);
    check("mobile enlarged view is NOT a desktop dialog", !sheet.hasDialog);
    check("mobile enlarged view shows the image", sheet.hasEnlarged,
      `${sheet.enlargedCount} blob images present`);
    await cdp.screenshot("mobile-02-bottom-sheet.png");

    step("RESULT");
    const failed = results.filter((r) => !r.pass);
    log(`   ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      log(`   failing: ${failed.map((f) => f.name).join(", ")}`);
      process.exitCode = 1;
    }
  } finally {
    if (!KEEP) chrome.kill();
  }
};

await main();
process.exit(process.exitCode ?? 0);
