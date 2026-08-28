// Visual capture for the Read-tool image result panel.
//
// Re-renders an EXISTING chat session that already contains an image read, so no Claude
// turn is spent. Captures the tool card at three chat-pane widths in both themes, which is
// what the container-query breakpoint (470px) and the light/dark veil need reviewing at.
//
// Run (dev server on 8081 + vite on 5173):
//   bun tests/e2e/read-image-panel-visual.mjs
//
// Env:
//   PPM_E2E_WEB_PORT=5173   vite port
//   CHROME_PATH=...         Chrome executable

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";

const REPO = process.cwd();
const WEB = `http://localhost:${process.env.PPM_E2E_WEB_PORT ?? "5173"}`;
const PROJECT = "ppm";
const TOKEN_KEY = "ppm-auth-token";
const SETTINGS_KEY = "ppm-settings";
const DEV_DB = join(homedir(), ".ppm", "ppm.dev.db");
const CDP_PORT = 9361;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = join(REPO, "plans", "260828-0110-chat-inline-tool-images", "visuals", "redesign");

/** PPM_E2E_SLOW=1 throttles the image fetch so the loading skeleton can be captured. */
const SLOW = !!process.env.PPM_E2E_SLOW;

const VIEWPORTS = [
  { name: "wide", width: 1440, height: 960, mobile: false },
  { name: "mid", width: 900, height: 900, mobile: false },
  { name: "narrow", width: 390, height: 844, mobile: true },
];

const log = (...a) => console.log(...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method) {
        this.handlers.get(m.method)?.(m.params);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  on(method, fn) { this.handlers.set(method, fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)); }, 45000);
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} :: ${expression.slice(0, 120)}`);
    return r.result.value;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await cdp.evaluate(`!!(${expression})`)) return true; } catch {}
    await Bun.sleep(400);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The redesigned panel: the tool card that contains a blob-backed foreground image.
const CARD = `(() => {
  const img = [...document.querySelectorAll('img')].find(i => i.src.startsWith('blob:') && i.alt);
  return img ? img.closest('[data-tool-ref]') : null;
})()`;

const main = async () => {
  await mkdir(OUT, { recursive: true });

  const db = new Database(DEV_DB, { readonly: true });
  const token = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
  db.close();

  const profile = join(tmpdir(), `ppm-visual-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1440,960", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--force-device-scale-factor=2", "about:blank",
  ], { stdio: "ignore" });

  let wsUrl;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) })).json();
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
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
  await cdp.send("Network.enable");
  // The app fetches the stored theme on boot and it would overwrite the localStorage
  // value set below. Blocking it leaves localStorage in charge and avoids writing the
  // capture theme back to the user's real settings.
  await cdp.send("Network.setBlockedURLs", { urls: ["*/api/settings/theme*"] });

  try {
    for (const mode of ["light", "dark"]) {
      log(`\n=== theme: ${mode} ===`);
      await cdp.send("Page.navigate", { url: WEB });
      await Bun.sleep(2500);
      // Written straight to localStorage so the app picks it up on reload without
      // calling the setter, which would push the theme to the server.
      await cdp.evaluate(`(() => {
        localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)});
        const cur = JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}) || '{}');
        // Both keys are required: the store ignores a lone themeMode and falls back to the default theme.
        localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, JSON.stringify({ ...cur, themeStyle: "slate", themeMode: ${JSON.stringify(mode)} }));
        return true;
      })()`);

      await cdp.send("Page.navigate", { url: `${WEB}/project/${encodeURIComponent(PROJECT)}` });
      await Bun.sleep(10000);

      // Reopen the chat tab that already holds an image read.
      const opened = await cdp.evaluate(`(() => {
        const tab = [...document.querySelectorAll('[data-tab-id]')]
          .find(e => /read the image/i.test(e.textContent || ''));
        if (!tab) return false;
        tab.click();
        return true;
      })()`);
      log(`  reopened existing image chat: ${opened ? "yes" : "no (using active tab)"}`);

      if (SLOW) {
        // Capture the skeleton: it must occupy the same box as the loaded panel, so the
        // transcript does not shift when the image lands. Holding the raw-file request
        // open keeps the card in its loading state for as long as the capture needs.
        const held = [];
        cdp.on("Fetch.requestPaused", (p) => held.push(p.requestId));
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/fs/raw*" }] });
        await cdp.send("Page.reload");
        await waitFor(cdp, `document.querySelector('.img-skeleton')`, "loading skeleton", 45000);
        await Bun.sleep(400);
        const raw = await cdp.evaluate(`(() => {
          const el = document.querySelector('.img-skeleton')?.closest('[data-tool-ref]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
        })()`);
        if (raw) {
          const r = JSON.parse(raw);
          const shot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            clip: { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.w + 20, height: r.h + 20, scale: 2 },
          });
          await writeFile(join(OUT, `${mode}-loading.png`), Buffer.from(shot.data, "base64"));
          log(`  ${mode}-loading.png  (card ${Math.round(r.w)}×${Math.round(r.h)})`);
        }
        // Failing the same held requests exercises the failure chip without needing a
        // missing file on disk.
        for (const requestId of held) {
          await cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" }).catch(() => {});
        }
        await waitFor(cdp, `[...document.querySelectorAll('button')].some(b => b.textContent === 'retry')`, "failure chip", 20000);
        await cdp.evaluate(`(() => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'retry');
          btn?.closest('[data-tool-ref]')?.scrollIntoView({ block: 'center' });
          return true;
        })()`);
        await Bun.sleep(700);
        const failRaw = await cdp.evaluate(`(() => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'retry');
          const el = btn?.closest('[data-tool-ref]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
        })()`);
        if (failRaw) {
          const r = JSON.parse(failRaw);
          const shot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            clip: { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.w + 20, height: r.h + 20, scale: 2 },
          });
          await writeFile(join(OUT, `${mode}-failure.png`), Buffer.from(shot.data, "base64"));
          log(`  ${mode}-failure.png  (card ${Math.round(r.w)}×${Math.round(r.h)})`);
        }

        await cdp.send("Fetch.disable");
        cdp.on("Fetch.requestPaused", () => {});
        await cdp.send("Page.reload");
        await Bun.sleep(9000);
      }
      await Bun.sleep(5000);

      await waitFor(cdp, CARD, "image tool card", 45000);
      await cdp.evaluate(`(${CARD}).scrollIntoView({ block: 'center' }), null`);
      await Bun.sleep(1200);

      const themeClass = await cdp.evaluate(`document.documentElement.className`);
      log(`  html class: ${themeClass}`);

      for (const vp of VIEWPORTS) {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: vp.mobile,
        });
        await Bun.sleep(1800);
        await cdp.evaluate(`(${CARD})?.scrollIntoView({ block: 'center' }), null`);
        await Bun.sleep(900);

        const box = await cdp.evaluate(`(() => {
          const el = ${CARD};
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
        })()`);
        if (!box) { log(`  ${vp.name}: card not found`); continue; }
        const r = JSON.parse(box);

        const pad = 10;
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          clip: {
            x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
            width: Math.min(vp.width, r.w + pad * 2), height: r.h + pad * 2, scale: 2,
          },
        });
        const name = `${mode}-${vp.name}-${vp.width}px.png`;
        await writeFile(join(OUT, name), Buffer.from(shot.data, "base64"));
        log(`  ${name}  (card ${Math.round(r.w)}×${Math.round(r.h)})`);
      }
      await cdp.send("Emulation.clearDeviceMetricsOverride");
    }
    log(`\nsaved to ${OUT}`);
  } finally {
    chrome.kill();
  }
};

await main();
process.exit(0);
