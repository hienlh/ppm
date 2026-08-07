// Confirms the version switcher still RENDERS after being converted from a
// per-message fetch to a versionMap prop. Deep-links to a session known to have
// forks and asserts the `n/m` control appears with the expected counts.
//
// Run: bun spike-version-switcher-check.mjs <sessionId> <providerId> <expected n/m>

import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";

const [SESSION, PROVIDER = "codex", EXPECT = "1/9"] = process.argv.slice(2);
const WEB = "http://localhost:5173";
const CDP_PORT = 9335;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const db = new Database(join(homedir(), ".ppm", "ppm.dev.db"), { readonly: true });
const TOKEN = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
db.close();

let chrome;
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`timeout ${method}`)); }, 30000);
    });
  }
  async evalJs(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

const main = async () => {
  const profile = join(tmpdir(), `ppm-vsw-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1440,900", "--no-first-run", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });

  let wsUrl;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !wsUrl) {
    try {
      const t = await (await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) })).json();
      wsUrl = t.find((x) => x.type === "page")?.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await Bun.sleep(400);
  }
  const cdp = await new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => res(new Cdp(ws)));
    ws.addEventListener("error", rej);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  await cdp.send("Page.navigate", { url: WEB });
  await Bun.sleep(2500);
  await cdp.evalJs(`localStorage.setItem("ppm-auth-token", ${JSON.stringify(TOKEN)})`);

  const deep = `${WEB}/project/ppm/chat/${PROVIDER}/${SESSION}`;
  console.log(`\nnavigating to ${deep}`);
  await cdp.send("Page.navigate", { url: deep });

  // Poll for the switcher to appear.
  let found = null;
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    found = await cdp.evalJs(`(() => {
      const prev = [...document.querySelectorAll('[aria-label="Previous version"]')];
      if (!prev.length) return null;
      return JSON.stringify(prev.map(b => {
        const row = b.parentElement;
        const label = row?.querySelector('span.tabular-nums')?.textContent ?? '';
        const next = row?.querySelector('[aria-label="Next version"]');
        return { label, prevDisabled: b.disabled, nextDisabled: next?.disabled };
      }));
    })()`);
    if (found) break;
  }

  if (!found) {
    console.log("RESULT: FAIL — no version switcher rendered");
    const dbg = await cdp.evalJs(`JSON.stringify({
      msgs: document.querySelectorAll('[data-msg-index]').length,
      mounted: document.querySelectorAll('[data-tab-pool-id]').length,
      text: (document.body.innerText||'').slice(0,200)
    })`);
    console.log("  debug:", dbg);
    return;
  }

  const switchers = JSON.parse(found);
  console.log(`switchers rendered: ${switchers.length}`);
  for (const s of switchers) {
    console.log(`  label="${s.label}"  prevDisabled=${s.prevDisabled} nextDisabled=${s.nextDisabled}`);
  }
  const match = switchers.some((s) => s.label === EXPECT);
  console.log(`\nRESULT: ${match ? "PASS" : "FAIL"} — expected label "${EXPECT}"`);
  // Viewing the original (currentIndex 0) => prev disabled, next enabled.
  const first = switchers.find((s) => s.label === EXPECT);
  if (first) console.log(`  nav state correct: ${first.prevDisabled === true && first.nextDisabled === false}`);
};

try { await main(); } finally { chrome?.kill(); }
process.exit(0);
