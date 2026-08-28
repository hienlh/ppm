// Ratio-variant capture for the Read-tool image panel.
//
// Spends ONE Claude turn reading three shapes the default sample cannot show: a panorama
// (band variant), a phone capture (fitted inside the tall clamp) and an icon (native 1:1).
//
// Run:
//   bun tests/e2e/read-image-panel-ratios.mjs
//
// Env:
//   PPM_E2E_IMAGES=a.png,b.png   override the images to read
//   PPM_E2E_WEB_PORT=5173        vite port

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const REPO = process.cwd();
const WEB = `http://localhost:${process.env.PPM_E2E_WEB_PORT ?? "5173"}`;
const PROJECT = "ppm";
const TOKEN_KEY = "ppm-auth-token";
const DEV_DB = join(homedir(), ".ppm", "ppm.dev.db");
const CDP_PORT = 9362;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = join(REPO, "plans", "260828-0110-chat-inline-tool-images", "visuals", "redesign");

const SAMPLES = join(
  tmpdir(), "ppm-design-handoff", "design_handoff_read_image_preview",
  "prototype", "assets", "samples",
);
const IMAGES = (process.env.PPM_E2E_IMAGES?.split(",") ?? [
  join(SAMPLES, "pano-21x9.png"),
  join(SAMPLES, "phone-9x19.png"),
  join(SAMPLES, "icon-48.png"),
]).map((p) => p.trim());

const log = (...a) => console.log(...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
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
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)); }, 60000);
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
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function typeIntoExpr(selectorExpr, value) {
  return `(() => {
    const el = ${selectorExpr};
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
}

const cardBoxExpr = (alt) => `(() => {
  const img = [...document.querySelectorAll('img')].find(i => i.alt === ${JSON.stringify(alt)});
  const el = img?.closest('[data-tool-ref]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
})()`;

const main = async () => {
  for (const p of IMAGES) {
    if (!existsSync(p)) throw new Error(`sample image missing: ${p}`);
  }
  await mkdir(OUT, { recursive: true });

  const db = new Database(DEV_DB, { readonly: true });
  const token = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
  db.close();

  const profile = join(tmpdir(), `ppm-ratios-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1100,960", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "about:blank",
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

  try {
    await cdp.send("Page.navigate", { url: WEB });
    await Bun.sleep(2500);
    await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)}), null`);
    await cdp.send("Page.navigate", { url: `${WEB}/project/${encodeURIComponent(PROJECT)}` });
    await Bun.sleep(10000);

    await waitFor(cdp, `document.querySelector('textarea[placeholder="Ask anything..."]')`, "composer", 45000);

    const prompt = `Read these three image files, then reply with only the word OK:\n${IMAGES.join("\n")}`;
    log("prompt:\n" + prompt);
    await cdp.evaluate(typeIntoExpr(`document.querySelector('textarea[placeholder="Ask anything..."]')`, prompt));
    await Bun.sleep(400);
    await cdp.evaluate(`(() => {
      const b = document.querySelector('[aria-label="Send"], [aria-label="Send message"]');
      if (!b) return false; b.click(); return true;
    })()`);

    log(`waiting for ${IMAGES.length} image cards (real turn, up to 240s)...`);
    await waitFor(
      cdp,
      `[...document.querySelectorAll('img')].filter(i => i.src.startsWith('blob:') && i.alt).length >= ${IMAGES.length}`,
      `${IMAGES.length} image cards`,
      240000,
    );
    await Bun.sleep(2500);

    const alts = JSON.parse(await cdp.evaluate(`JSON.stringify(
      [...new Set([...document.querySelectorAll('img')]
        .filter(i => i.src.startsWith('blob:') && i.alt).map(i => i.alt))]
    )`));

    for (const alt of alts) {
      await cdp.evaluate(`(() => {
        const img = [...document.querySelectorAll('img')].find(i => i.alt === ${JSON.stringify(alt)});
        img?.closest('[data-tool-ref]')?.scrollIntoView({ block: 'center' });
        return true;
      })()`);
      await Bun.sleep(900);
      const raw = await cdp.evaluate(cardBoxExpr(alt));
      if (!raw) continue;
      const box = JSON.parse(raw);
      const pad = 10;
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: {
          x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
          width: box.w + pad * 2, height: box.h + pad * 2, scale: 2,
        },
      });
      const slug = alt.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      await writeFile(join(OUT, `ratio-${slug}.png`), Buffer.from(shot.data, "base64"));
      log(`  ratio-${slug}.png  (card ${Math.round(box.w)}×${Math.round(box.h)})`);
    }
    log(`\nsaved to ${OUT}`);
  } finally {
    chrome.kill();
  }
};

await main();
process.exit(0);
