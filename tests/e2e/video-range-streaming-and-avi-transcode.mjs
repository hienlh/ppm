// E2E proof for Range-streamed native video and ffmpeg-transcoded AVI playback in the editor tab.
// Hand-rolled CDP over system Chrome (same style as tests/e2e/os-explorer-window.mjs).
//
// Run against an already-running stack:
//   PPM_E2E_API_PORT=8082 PPM_E2E_WEB_PORT=5174 PPM_E2E_AVI="D:\New folder\AVI00013.avi" bun tests/e2e/video-range-streaming-and-avi-transcode.mjs
// Needs ffmpeg on PATH (to build the small mp4 fixture and to transcode the AVI).

import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const API_PORT = process.env.PPM_E2E_API_PORT || "8082";
const WEB_PORT = process.env.PPM_E2E_WEB_PORT || "5174";
const ORIGIN = `http://localhost:${WEB_PORT}`;
const CDP_PORT = Number(process.env.PPM_E2E_CDP_PORT || 9341);
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const AVI = process.env.PPM_E2E_AVI || "D:\\New folder\\AVI00013.avi";
const FIXTURE_DIR = join(tmpdir(), "ppm-video-e2e");
const MP4 = join(FIXTURE_DIR, "native-clip.mp4");
const VISUALS_DIR = process.env.PPM_E2E_VISUALS || "C:\\Users\\PC\\ppm\\plans\\reports\\visuals-video-streaming";
const PROFILE_DIR = join(tmpdir(), `ppm-video-e2e-${Date.now()}`);

const db = new Database(join(homedir(), ".ppm", "ppm.dev.db"), { readonly: true });
const TOKEN = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
db.close();

const results = [];
const record = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
};
async function scenario(name, fn) {
  try { const d = await fn(); record(name, true, d); } catch (e) { record(name, false, e?.message || String(e)); }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data);
      if (m.id !== undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
      else if (m.method) { for (const fn of this.listeners.get(m.method) ?? []) fn(m.params); } }); }
  send(method, params = {}, timeoutMs = 30000) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)); }, timeoutMs); }); }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, new Set()); this.listeners.get(method).add(fn); }
  once(method) { return new Promise((res) => { const fn = (p) => { this.listeners.get(method).delete(fn); res(p); }; this.on(method, fn); }); }
  async evalJs(expression, timeoutMs = 30000) {
    const r = await this.send("Runtime.evaluate", { expression: `(async () => { return (${expression}); })()`, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + " :: " + expression.slice(0, 200));
    return r.result.value;
  }
}

async function openTab() {
  const t = await (await fetch(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = await new Promise((res, rej) => { const s = new WebSocket(t.webSocketDebuggerUrl); s.addEventListener("open", () => res(s)); s.addEventListener("error", rej); });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  cdp.on("Page.javascriptDialogOpening", () => cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}));
  return cdp;
}

async function reloadPage(cdp) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.reload");
  await Promise.race([loaded, Bun.sleep(15000)]);
  await cdp.send("Runtime.enable").catch(() => {});
  for (let i = 0; i < 8; i++) { try { await cdp.evalJs("1+1", 3000); await Bun.sleep(1200); return; } catch { await Bun.sleep(1000); } }
  throw new Error("runtime never recovered");
}

async function screenshot(cdp, name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(VISUALS_DIR, name), Buffer.from(r.data, "base64"));
}

/** Poll until `expr` is truthy, returning its value. */
async function waitFor(cdp, expr, ms = 20000, label = expr) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await cdp.evalJs(expr, 5000).catch(() => null); if (v) return v; await Bun.sleep(400); }
  throw new Error(`timeout waiting for ${label}`);
}

const TAB_STORE = `(await import('/stores/tab-store.ts')).useTabStore`;
const VIDEO_STATE = `(() => { const v = document.querySelector('video'); return v && JSON.stringify({ src: v.currentSrc, ready: v.readyState, t: v.currentTime, dur: v.duration, w: v.videoWidth, paused: v.paused, seekEnd: v.seekable.length ? v.seekable.end(0) : -1, err: v.error && v.error.code }); })()`;
const vstate = async (cdp) => JSON.parse((await cdp.evalJs(VIDEO_STATE)) || "null");

async function openFileTab(cdp, path) {
  await cdp.evalJs(`${TAB_STORE}.getState().openTab({ type: "editor", title: ${JSON.stringify(path.split(/[\\/]/).pop())}, projectId: null, metadata: { filePath: ${JSON.stringify(path)} }, closable: true })`);
}
async function closeAllTabs(cdp) {
  await cdp.evalJs(`(async () => { const s = ${TAB_STORE}.getState(); for (const t of s.tabs) s.closeTab(t.id); return true; })()`);
}

async function makeMp4Fixture() {
  await mkdir(FIXTURE_DIR, { recursive: true });
  if (existsSync(MP4)) return;
  const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", MP4], { stdout: "ignore", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error("fixture mp4 failed");
}

let chromeProc = null;
async function main() {
  await makeMp4Fixture();
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(VISUALS_DIR, { recursive: true });
  chromeProc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE_DIR}`, "--window-size=1440,900",
    "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "about:blank"], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { try { await (await fetch(`http://localhost:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); break; } catch {} await Bun.sleep(300); }

    const cdp = await openTab();
    await cdp.send("Page.navigate", { url: ORIGIN + "/" });
    await Bun.sleep(1800);
    await cdp.evalJs(`localStorage.setItem("ppm-auth-token", ${JSON.stringify(TOKEN)})`);
    await reloadPage(cdp);
    await closeAllTabs(cdp).catch(() => {});

    // ── native mp4: direct URL + Range → duration known, seekable, plays ──
    await scenario("native mp4 streams from /api/fs/raw with known duration", async () => {
      await openFileTab(cdp, MP4);
      await waitFor(cdp, `(() => { const v = document.querySelector('video'); return v && v.readyState >= 1 && isFinite(v.duration); })()`, 15000, "mp4 metadata");
      const s = await vstate(cdp);
      if (!s.src.includes("/api/fs/raw?")) throw new Error(`unexpected src ${s.src}`);
      if (!(s.dur > 11 && s.dur < 13)) throw new Error(`duration ${s.dur}`);
      if (!(s.seekEnd > 11)) throw new Error(`seekable end ${s.seekEnd}`);
      return `dur=${s.dur.toFixed(1)} seekable=${s.seekEnd.toFixed(1)}`;
    });
    await scenario("native mp4 seeks via Range (206)", async () => {
      await cdp.evalJs(`(() => { const v = document.querySelector('video'); v.currentTime = 9; return v.play().catch(() => {}); })()`);
      await waitFor(cdp, `(() => { const v = document.querySelector('video'); return v && v.currentTime >= 9.2 && v.readyState >= 3; })()`, 10000, "playback after seek");
      await screenshot(cdp, "native-mp4-after-seek.png");
      return `t=${(await vstate(cdp)).t.toFixed(1)}`;
    });
    await scenario("keyboard: → seeks +5s, r rotates, > speeds up, ↓ lowers volume", async () => {
      await cdp.evalJs(`(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 2; document.querySelector('[data-testid="video-player"]').focus(); return true; })()`);
      await Bun.sleep(300);
      const key = async (k, code, shift = false) => {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, text: k.length === 1 ? k : undefined, modifiers: shift ? 8 : 0 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers: shift ? 8 : 0 });
        await Bun.sleep(150);
      };
      await key("ArrowRight", "ArrowRight");
      await key("r", "KeyR");
      await key(">", "Period", true);
      await key("ArrowDown", "ArrowDown");
      const s = JSON.parse(await cdp.evalJs(`(() => { const v = document.querySelector('video'); return JSON.stringify({ t: v.currentTime, tr: v.style.transform, rate: v.playbackRate, vol: v.volume }); })()`));
      if (!(s.t >= 6.9 && s.t <= 7.3)) throw new Error(`currentTime ${s.t}, want ≈7`);
      if (!/rotate\(90deg\)/.test(s.tr)) throw new Error(`transform ${s.tr}`);
      if (s.rate !== 1.25) throw new Error(`playbackRate ${s.rate}`);
      if (Math.abs(s.vol - 0.9) > 0.01) throw new Error(`volume ${s.vol}`);
      await screenshot(cdp, "native-mp4-rotated-keyboard.png");
      return `t=${s.t.toFixed(1)} ${s.tr} ${s.rate}x vol=${s.vol}`;
    });
    await closeAllTabs(cdp);

    // ── AVI (MJPEG+PCM): probe → transcode player, plays, seeks by restarting ffmpeg ──
    if (!existsSync(AVI)) { record("avi transcode (skipped: fixture missing)", true, AVI); }
    else {
      await scenario("avi opens through the transcode player and plays", async () => {
        await openFileTab(cdp, AVI);
        await waitFor(cdp, `(() => { const v = document.querySelector('video'); return v && v.currentSrc.includes('/api/fs/transcode?'); })()`, 15000, "transcode video element");
        await waitFor(cdp, `(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0 && v.currentTime > 1; })()`, 30000, "avi frames decoding");
        const s = await vstate(cdp);
        await screenshot(cdp, "avi-transcode-playing.png");
        const label = await cdp.evalJs(`document.querySelector('input[aria-label="Seek"]') ? document.querySelector('input[aria-label="Seek"]').max : null`);
        if (Math.round(Number(label)) !== 600) throw new Error(`seek bar max ${label}, want 600 from ffprobe`);
        return `w=${s.w} t=${s.t.toFixed(1)} paused=${s.paused}`;
      });
      await scenario("avi seek restarts the stream at ?start=", async () => {
        await cdp.evalJs(`(() => { const i = document.querySelector('input[aria-label="Seek"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '300'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); i.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return true; })()`);
        await waitFor(cdp, `(() => { const v = document.querySelector('video'); return v && /start=300/.test(v.currentSrc) && v.currentTime > 0.5 && v.videoWidth > 0; })()`, 30000, "stream restarted at 300s");
        const clock = await cdp.evalJs(`document.querySelector('span.tabular-nums')?.textContent`);
        if (!/^5:0\d/.test(clock)) throw new Error(`clock shows ${clock}, want ~5:00`);
        await screenshot(cdp, "avi-transcode-after-seek.png");
        // Keyboard seek on a transcoded stream must restart ffmpeg 10s further on, and the
        // restarted element must keep the user's volume (a fresh load resets it to 1).
        await cdp.evalJs(`document.querySelector('[data-testid="video-player"]').focus()`);
        for (const [key, code] of [["ArrowDown", "ArrowDown"], ["ArrowDown", "ArrowDown"], ["l", "KeyL"]]) {
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: key.length === 1 ? key : undefined });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
          await Bun.sleep(120);
        }
        await waitFor(cdp, `(() => { const v = document.querySelector('video'); const m = /start=([\\d.]+)/.exec(v.currentSrc); return m && Number(m[1]) >= 309 && Number(m[1]) <= 315 && v.videoWidth > 0 && v.currentTime > 0.3; })()`, 30000, "keyboard +10s restart");
        const after = JSON.parse(await cdp.evalJs(`(() => { const v = document.querySelector('video'); return JSON.stringify({ start: /start=([\\d.]+)/.exec(v.currentSrc)[1], sid: /sid=/.test(v.currentSrc), vol: v.volume, paused: v.paused }); })()`));
        if (!after.sid) throw new Error("transcode URL lacks sid");
        if (Math.abs(after.vol - 0.8) > 0.01) throw new Error(`volume after restart ${after.vol}, want 0.8`);
        if (after.paused) throw new Error("stream restarted paused although the user never paused");
        return `clock=${clock}, L → ${after.start}s, vol=${after.vol}`;
      });
      await closeAllTabs(cdp);
      await scenario("closing the tab leaves no ffmpeg running", async () => {
        // Kill → exit is asynchronous; poll a few seconds before calling it a leak.
        const count = async () => {
          const p = Bun.spawn(["powershell", "-NoProfile", "-Command", "@(Get-Process ffmpeg -ErrorAction SilentlyContinue).Count"], { stdout: "pipe" });
          return Number((await new Response(p.stdout).text()).trim());
        };
        let n = -1;
        for (let i = 0; i < 12; i++) { n = await count(); if (n === 0) break; await Bun.sleep(500); }
        if (n !== 0) throw new Error(`${n} ffmpeg process(es) still alive after 6s`);
      });
    }
  } finally {
    chromeProc?.kill();
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  process.exit(failed ? 1 : 0);
}

setTimeout(() => { console.error("watchdog: e2e exceeded 4 min"); chromeProc?.kill(); process.exit(2); }, 240_000).unref();
main().catch((e) => { console.error(e); chromeProc?.kill(); process.exit(1); });
