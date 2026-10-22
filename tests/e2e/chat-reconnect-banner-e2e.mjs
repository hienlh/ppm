// Checks the chat's reconnect pill in a real browser at phone size, against a running dev
// instance (`bun dev:server` + `bun dev:web`). The chat socket is routed through Playwright so
// the test can drop it and refuse reconnects at will.
//
//   PPM_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs PPM_E2E_TOKEN=<dev token> \
//   PPM_E2E_CHAT=/project/<name>/chat/<provider>/<session id> node tests/e2e/chat-reconnect-banner-e2e.mjs
//
// Optional: PPM_E2E_BASE (default http://localhost:5173), PPM_PLAYWRIGHT_CHANNEL (default chrome),
// PPM_E2E_SHOTS (directory for screenshots).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE).href);
const BASE = process.env.PPM_E2E_BASE ?? "http://localhost:5173";
const TOKEN = process.env.PPM_E2E_TOKEN;
const CHAT = process.env.PPM_E2E_CHAT;
const SHOTS = process.env.PPM_E2E_SHOTS;
if (!TOKEN || !CHAT) throw new Error("PPM_E2E_TOKEN and PPM_E2E_CHAT are required");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: process.env.PPM_PLAYWRIGHT_CHANNEL ?? "chrome" });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript((token) => {
  try { localStorage.setItem("ppm-auth-token", token); } catch {}
  // Lets the test play "the phone sent the page to the background".
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  window.__setVisibility = (v) => { visibility = v; document.dispatchEvent(new Event("visibilitychange")); };
}, TOKEN);

const page = await context.newPage();
let refuse = false;
// The workspace may restore other chat tabs too; only the one on screen is under test.
const SESSION = CHAT.split("/").pop();
let greetedAt = 0;
const open = new Set();
await page.routeWebSocket(/\/ws\/project\/[^/]+\/chat\//, (ws) => {
  if (process.env.PPM_E2E_DEBUG) console.log(`  route ${refuse ? "refused" : "open"} ${ws.url().replace(/token=[^&]+/, "token=…")}`);
  if (refuse) { ws.close(); return; }
  const server = ws.connectToServer();
  const mine = ws.url().includes(`/chat/${SESSION}`);
  // Forwarding by hand only to time the greeting that ends a reconnect.
  server.onMessage((m) => {
    if (mine && typeof m === "string" && m.includes('"session_state"')) greetedAt = Date.now();
    ws.send(m);
  });
  open.add(ws);
  ws.onClose(() => open.delete(ws));
});
const dropSockets = async () => { for (const ws of [...open]) { open.delete(ws); await ws.close(); } };

// Every mounted chat tab has its own pill, and the tab pool parks the others half off screen under
// the active tab, where `checkVisibility()` still calls them visible. What counts is the pill a
// person can actually see: the one that is topmost at its own centre.
const onScreen = (el) => {
  const r = el.getBoundingClientRect();
  return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("[data-reconnect-stage]") === el;
};
const stage = () => page.evaluate((fn) => {
  const visible = new Function(`return ${fn}`)();
  return [...document.querySelectorAll("[data-reconnect-stage]")].find(visible)?.getAttribute("data-reconnect-stage") ?? "hidden";
}, onScreen.toString());
/** Samples the stage for `ms` and returns every value seen. */
async function stagesDuring(ms) {
  const seen = new Set();
  const end = Date.now() + ms;
  while (Date.now() < end) { seen.add(await stage()); await sleep(50); }
  return seen;
}
async function waitStage(want, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await stage() === want) return true; await sleep(50); }
  return false;
}

await page.goto(BASE + CHAT);
await page.waitForFunction(() => document.body.innerText.length > 200, null, { timeout: 30_000 });
// A cold dev server can take many seconds to greet the first socket; start only once it has.
for (const end = Date.now() + 60_000; !greetedAt && Date.now() < end;) await sleep(100);
await sleep(1000);
check(open.size > 0 && greetedAt > 0, "chat socket is routed through the test and greeted");
check(await stage() === "hidden", "no pill while connected");

// 1. The phone case: socket dies in the background, page comes back, reconnect is quick.
await page.evaluate(() => window.__setVisibility("hidden"));
await dropSockets();
await sleep(300);
const returnedAt = Date.now();
await page.evaluate(() => window.__setVisibility("visible"));
const quick = await stagesDuring(2000);
const greetMs = greetedAt > returnedAt ? greetedAt - returnedAt : Infinity;
console.log(`  greeting arrived ${Number.isFinite(greetMs) ? greetMs + " ms" : "never"} after returning`);
if (greetMs < 600) {
  check(!quick.has("reconnecting") && !quick.has("lost"), `quick reconnect after returning shows nothing (saw ${[...quick].join(",")})`);
} else {
  // A slow server makes the pill correct here, so this run cannot judge the quick case.
  console.log(`SKIP quick reconnect check — the server took longer than the grace period`);
}
check(open.size > 0, "socket reconnected after returning to the page");

// 2. A slow reconnect: the pill appears, and the chat under it stays reachable.
refuse = true;
await dropSockets();
check(await waitStage("reconnecting", 3000), "pill appears when reconnecting drags on");
const blocked = await page.evaluate(() => {
  const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  return !el || !!el.closest("[data-reconnect-stage]") || /\binset-0\b/.test(el.className?.toString?.() ?? "");
});
check(!blocked, "the middle of the chat is not covered");
if (SHOTS) await page.screenshot({ path: join(SHOTS, "reconnecting.png") });

check(await waitStage("lost", 10_000), "pill turns into Connection lost after the grace period");
await page.evaluate((fn) => {
  const visible = new Function(`return ${fn}`)();
  [...document.querySelectorAll("[data-reconnect-stage]")].find(visible)?.setAttribute("data-e2e-target", "");
}, onScreen.toString());
const retry = page.locator("[data-e2e-target] button");
const box = await retry.boundingBox();
check(!!box && box.height >= 44, `Retry is a 44px touch target on a phone (height ${box?.height})`);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "lost.png") });

// 3. Retry reconnects and the pill goes away.
refuse = false;
const retriedAt = Date.now();
await retry.tap();
// Retry restarts the grace period, so "hidden" right after the tap proves nothing: wait for the
// server to greet this chat, then the pill must be gone and stay gone.
for (const end = Date.now() + 15_000; greetedAt <= retriedAt && Date.now() < end;) await sleep(50);
console.log(`  greeting arrived ${greetedAt > retriedAt ? greetedAt - retriedAt + " ms" : "never"} after Retry`);
const after = greetedAt > retriedAt ? await stagesDuring(1500) : new Set(["no greeting"]);
const cleared = after.size === 1 && after.has("hidden");
check(cleared, `Retry reconnects and the pill stays gone (saw ${[...after].join(",")})`);
if (!cleared && process.env.PPM_E2E_DEBUG) {
  console.log("  pills:", await page.evaluate(() => [...document.querySelectorAll("[data-reconnect-stage]")]
    .map((el) => `${el.getAttribute("data-reconnect-stage")}@${Math.round(el.getBoundingClientRect().left)}`).join(" ")));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "after-retry.png") });
}
check(open.size > 0, "socket is open again after Retry");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
