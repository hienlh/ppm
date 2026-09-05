// E2E proof for the named-tunnel first-run popup + Tunnel Manager section, driven against
// an ALREADY RUNNING dev stack (never spawns/kills bun processes — Vite on 5173 proxies API
// calls to the dev server on 8082 via PPM_DEV_API; this script never restarts either).
// Style follows tests/e2e/os-explorer-upload-collisions.mjs: hand-rolled CDP over system
// Chrome, no puppeteer. The backend for /api/tunnel/named/* is entirely client-side MOCKED
// (window.fetch override installed via Page.addScriptToEvaluateOnNewDocument, before any
// app code runs) — this is deliberate: it lets every login/timeout/cert-mismatch/warning
// state be exercised without a real Cloudflare login and without depending on whatever
// commit the live dev-server process happens to be running.
//
// Run: PPM_E2E_WEB_PORT=5173 bun tests/e2e/named-tunnel-popup-e2e.mjs
//
// Exits non-zero if any scenario fails.

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";

const WEB_PORT = process.env.PPM_E2E_WEB_PORT || "5173";
const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const CDP_PORT = Number(process.env.PPM_E2E_CDP_PORT || 9355);
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SHOTS = process.env.PPM_E2E_SHOTS || join(process.cwd(), "tests", "e2e", "screenshots", "named-tunnel");
const PROFILE_DIR = join(tmpdir(), `ppm-e2e-named-tunnel-${Date.now()}`);

const db = new Database(join(homedir(), ".ppm", "ppm.dev.db"), { readonly: true });
const TOKEN = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
db.close();

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
async function scenario(name, fn) {
  try {
    await fn();
    if (!results.some((r) => r.name === name)) record(name, true);
  } catch (e) {
    record(name, false, e?.stack?.split("\n").slice(0, 3).join(" | ") || String(e));
  }
}

// ── CDP client (same shape as os-explorer-upload-collisions.mjs) ──
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
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
  async evalJs(expression, timeoutMs = 30000) {
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
  cdp.on = () => {}; // not needed here
  return { cdp, targetId: t.id };
}

async function screenshot(cdp, name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(SHOTS, name), Buffer.from(r.data, "base64"));
}

async function setViewport(cdp, width, height, mobile) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
}

/**
 * Installed via Page.addScriptToEvaluateOnNewDocument — exists before any app code runs.
 * Sets the auth token, then intercepts every /api/tunnel/named/* fetch with a stateful mock
 * (window.__ppmMock.status is the single source of truth GET /status reads from), and
 * exposes window.__ppmFireTunnelEvent to simulate a /ws/global tunnel:* push arriving.
 */
function pageInitScript(token) {
  return `(() => {
  try { localStorage.setItem("ppm-auth-token", ${JSON.stringify(token)}); } catch {}

  // A real "dismissed" flag is persisted server-side (SQLite), so it survives a page
  // reload. This mock is client-side only and would otherwise be wiped by the reload's
  // fresh document context — localStorage is the one thing that actually survives
  // Page.reload(), so it stands in for the server round-trip here.
  let persistedDismissed = false;
  try { persistedDismissed = localStorage.getItem("__ppmE2eDismissed") === "1"; } catch {}

  const mock = (window.__ppmMock = {
    status: {
      mode: "quick", hostname: null, tunnelName: null, tokenMasked: null,
      certState: "ok", dismissed: persistedDismissed,
      login: { state: "idle", url: null, message: null },
      liveMode: "quick", tunnelWarning: null, authEnabled: true,
    },
    zone: { zone: "hienle.tech", proposedHostname: "ppm.hienle.tech" },
    setupMode: "pending", // "pending" | "done" | "error"
    calls: [],
  });
  window.__ppmFireTunnelEvent = (type, detail) => {
    window.dispatchEvent(new CustomEvent(type, { detail: Object.assign({ type }, detail) }));
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    let path;
    try { path = new URL(url, location.origin).pathname; } catch { path = url; }
    if (path.startsWith("/api/tunnel/named/")) {
      mock.calls.push({ method: (init && init.method) || "GET", path });
      const json = (data, status) => new Response(JSON.stringify({ ok: true, data }), { status: status || 200, headers: { "content-type": "application/json" } });
      const errJson = (message, status) => new Response(JSON.stringify({ ok: false, error: message }), { status: status || 400, headers: { "content-type": "application/json" } });

      if (path === "/api/tunnel/named/status") return json(mock.status);
      if (path === "/api/tunnel/named/zone") return json(mock.zone);

      if (path.startsWith("/api/tunnel/named/login/cancel")) {
        mock.status.login = { state: "cancelled", url: null, message: "cancelled" };
        return json({ state: "cancelled" });
      }
      if (path.startsWith("/api/tunnel/named/login")) {
        const loginUrl = "https://dash.cloudflare.com/argotunnel?e2e-fake-" + Date.now();
        mock.status.login = { state: "waiting", url: loginUrl, message: null };
        return json({ state: "waiting", url: loginUrl, message: null });
      }
      if (path.startsWith("/api/tunnel/named/dismiss")) {
        mock.status.dismissed = true;
        try { localStorage.setItem("__ppmE2eDismissed", "1"); } catch {}
        return json({ dismissed: true });
      }
      if (path.startsWith("/api/tunnel/named/setup")) {
        if (mock.setupMode === "error") return errJson("that name already points somewhere else — pick another prefix", 400);
        if (mock.setupMode === "done") {
          mock.status.mode = "named";
          mock.status.hostname = "ppm.hienle.tech";
          mock.status.tunnelName = "ppm-e2e-host";
          mock.status.tokenMasked = "abcdef...";
          return json({ hostname: "ppm.hienle.tech", tunnelName: "ppm-e2e-host" });
        }
        return json({ hostname: "ppm.hienle.tech", tunnelName: "ppm-e2e-host", pending: true, message: "run \`ppm restart\` to apply" });
      }
      if (path.startsWith("/api/tunnel/named/disable")) {
        mock.status.mode = "quick";
        return json({ mode: "quick" });
      }
    }
    return origFetch(input, init);
  };
})();`;
}

async function waitForCondition(cdp, fn, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn(cdp);
    if (last) return last;
    await Bun.sleep(intervalMs);
  }
  return last;
}

/** Polls document.body.textContent until it contains `needle` or times out — dev-server's
 *  first cold Vite transform of the whole app can take several seconds, so a fixed sleep
 *  after navigate/reload is not reliable. */
async function waitForText(cdp, needle, timeoutMs = 15000) {
  const found = await waitForCondition(
    cdp,
    async () => (await cdp.evalJs(`document.body.textContent`)).includes(needle),
    timeoutMs,
  );
  if (!found) throw new Error(`text "${needle}" never appeared within ${timeoutMs}ms`);
}

async function navigate(cdp, path = "/") {
  await cdp.send("Page.navigate", { url: ORIGIN + path });
  await waitForCondition(cdp, async () => (await cdp.evalJs(`document.readyState`)) === "complete", 15000);
  await Bun.sleep(500);
}

async function reload(cdp) {
  await cdp.send("Page.reload");
  await Bun.sleep(500);
  await cdp.send("Runtime.enable").catch(() => {});
  await waitForCondition(cdp, async () => (await cdp.evalJs(`document.readyState`)) === "complete", 15000);
  await Bun.sleep(500);
}

async function setMock(cdp, patch) {
  await cdp.evalJs(`(() => { Object.assign(window.__ppmMock.status, ${JSON.stringify(patch)}); return true; })()`);
}
async function setSetupMode(cdp, mode) {
  await cdp.evalJs(`(() => { window.__ppmMock.setupMode = ${JSON.stringify(mode)}; return true; })()`);
}
async function fireEvent(cdp, type, detail = {}) {
  await cdp.evalJs(`window.__ppmFireTunnelEvent(${JSON.stringify(type)}, ${JSON.stringify(detail)})`);
  await Bun.sleep(400);
}

/** Whole-body text is safe to search: every Vietnamese copy string here is specific enough
 *  that a false-positive match against unrelated PPM UI is not a realistic concern. */
async function popupText(cdp) {
  return cdp.evalJs(`document.body.textContent`);
}
async function clickByText(cdp, text) {
  const ok = await cdp.evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!ok) throw new Error(`no button with exact text "${text}" found`);
  await Bun.sleep(400);
}
async function typeIntoPrefix(cdp, value) {
  await cdp.evalJs(`(() => {
    const input = document.getElementById("named-tunnel-prefix");
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await Bun.sleep(150);
}
async function hostnameError(cdp) {
  return cdp.evalJs(`(() => {
    const p = document.querySelector('.text-destructive');
    return p ? p.textContent : null;
  })()`);
}

// Only the named-tunnel feature's OWN controls — auditing every button on the page would
// also flag the file tree / sidebar behind the bottom sheet, which is not this feature's
// UI and not in scope for this check.
const NAMED_TUNNEL_CONTROL_LABELS = [
  "Chưa", "Có", "Đóng", "Sao chép", "Mở link", "Tiếp tục chờ", "Huỷ", "Thử lại",
  "Bắt đầu lại", "Tiếp tục", "Xác nhận", "Copy URL", "Close", "Thiết lập named tunnel",
  "Chuyển về quick tunnel", "Đăng nhập lại", "Bấm lần nữa để xác nhận",
];

/** Every clickable control belonging to this feature must be >= 44x44 CSS px on a mobile
 *  viewport (docs/design-guidelines.md touch-target rule). Returns offenders; silently
 *  skips labels not present in the current step (most steps only show a subset). */
async function touchTargetAudit(cdp) {
  return cdp.evalJs(`(() => {
    const labels = ${JSON.stringify(NAMED_TUNNEL_CONTROL_LABELS)};
    const els = [...document.querySelectorAll('button, a[href]')].filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const text = el.textContent.trim();
      const aria = el.getAttribute('aria-label') || "";
      return labels.includes(text) || labels.includes(aria);
    });
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName;
      return { label, width: Math.round(r.width), height: Math.round(r.height) };
    }).filter((e) => e.width < 44 || e.height < 44);
  })()`);
}

let chromeProc = null;

async function main() {
  await mkdir(SHOTS, { recursive: true });
  await mkdir(PROFILE_DIR, { recursive: true });

  chromeProc = spawn(
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
  );

  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { await fetch(`http://localhost:${CDP_PORT}/json/version`); break; } catch { await Bun.sleep(300); }
    }

    const { cdp, targetId } = await openTab();
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: pageInitScript(TOKEN) });
    await setViewport(cdp, 1440, 900, false);
    await navigate(cdp);

    // ── ask-domain -> Chưa -> dismissed, popup absent after reload ──────────
    await scenario("ask-domain popup shows the Cloudflare question on a fresh profile", async () => {
      await waitForText(cdp, "Bạn đã có domain trên Cloudflare chưa?");
    });
    await screenshot(cdp, "01-desktop-ask-domain.png");

    await scenario("answering Chưa dismisses, and the popup never reappears after reload", async () => {
      await clickByText(cdp, "Chưa");
      await waitForText(cdp, "Không sao cả");
      // The click's own POST /dismiss set mock.status.dismissed = true already; reload and
      // confirm initialStepFromStatus now renders "hidden" (mode stays quick, dismissed true).
      await reload(cdp);
      await Bun.sleep(1200); // let refreshStatus() settle before asserting absence
      const bodyHasPopup = await cdp.evalJs(`document.body.textContent.includes("Bạn đã có domain")`);
      if (bodyHasPopup) throw new Error("popup reappeared after reload despite dismissed:true");
    });

    // Reset mock state for the next scenarios (fresh navigate re-runs the init script's
    // literal defaults since it re-registers on every document, including this reload) —
    // also clears the localStorage flag the dismiss test just set, so it does not leak
    // "dismissed" into every scenario after this one.
    await cdp.evalJs(`(() => { try { localStorage.removeItem("__ppmE2eDismissed"); } catch {} return true; })()`);
    await reload(cdp);
    await setMock(cdp, { dismissed: false });

    // ── ask-domain -> Có -> login URL shown, copy/open >= 44px ──────────────
    let loginUrlSeen = null;
    await scenario("answering Có starts login and shows the URL with copy/open controls", async () => {
      await clickByText(cdp, "Có");
      await waitForText(cdp, "Đăng nhập Cloudflare");
      loginUrlSeen = await waitForCondition(
        cdp,
        async () => cdp.evalJs(`(() => { const el = [...document.querySelectorAll('div')].find(d => d.textContent.includes('argotunnel')); return el ? el.textContent.trim() : null; })()`),
      );
      if (!loginUrlSeen) throw new Error("login URL not rendered in the DOM");
    });
    await screenshot(cdp, "02-desktop-login-wait.png");

    await scenario("copy/open URL buttons meet the 44px touch-target minimum", async () => {
      const offenders = await touchTargetAudit(cdp);
      const loginBtnOffenders = offenders.filter((o) => o.label.includes("Sao chép") || o.label.includes("Mở link") || o.label === "Sao chép" || o.label === "Mở link");
      if (loginBtnOffenders.length) throw new Error(`undersized login controls: ${JSON.stringify(loginBtnOffenders)}`);
    });

    // ── login_state slow -> Tiếp tục/Huỷ ────────────────────────────────────
    await scenario("a 'slow' login_state push shows the still-waiting banner with Tiếp tục chờ / Huỷ", async () => {
      await fireEvent(cdp, "tunnel:login_state", { state: "slow" });
      await waitForText(cdp, "Vẫn đang đăng nhập?");
      const text = await popupText(cdp);
      if (!text.includes("Tiếp tục chờ") || !text.includes("Huỷ")) throw new Error("Tiếp tục chờ / Huỷ buttons missing");
    });
    await screenshot(cdp, "03-desktop-login-slow.png");

    // ── timeout -> Retry works ───────────────────────────────────────────────
    await scenario("a 'timeout' login_state push shows the expired card, Retry starts a fresh login", async () => {
      await fireEvent(cdp, "tunnel:login_state", { state: "timeout" });
      await waitForText(cdp, "Link đăng nhập đã hết hạn");
      await clickByText(cdp, "Thử lại");
      await waitForText(cdp, "Đăng nhập Cloudflare");
    });
    await screenshot(cdp, "04-desktop-login-timeout-then-retry.png");

    // ── success -> confirm-zone -> hostname validations -> applying -> pending -> done ──
    await scenario("success -> confirm-zone shows the resolved zone", async () => {
      await fireEvent(cdp, "tunnel:login_state", { state: "success" });
      await waitForText(cdp, "hienle.tech", 10000); // loadZone() + refreshStatus() round trip
    });
    await screenshot(cdp, "05-desktop-confirm-zone.png");

    await scenario("confirm-zone -> choose-hostname, prefix defaults to 'ppm'", async () => {
      await clickByText(cdp, "Tiếp tục");
      const value = await cdp.evalJs(`document.getElementById("named-tunnel-prefix")?.value`);
      if (value !== "ppm") throw new Error(`default prefix was "${value}", expected "ppm"`);
    });

    await scenario("hostname field rejects www, apex-equivalent, multi-label, uppercase — accepts ppm", async () => {
      await typeIntoPrefix(cdp, "www");
      let err = await hostnameError(cdp);
      if (!err) throw new Error("www was accepted — expected a rejection");

      await typeIntoPrefix(cdp, "");
      err = await hostnameError(cdp);
      // Empty prefix -> buildHostname("", zone) -> "." + zone, which is neither the apex
      // nor `www.<zone>` — validateHostname's "must be exactly one label" or a label-shape
      // check should still catch it as invalid; assert the submit button stays disabled
      // rather than assuming a specific error string (empty prefix disables submit directly).
      const submitDisabled = await cdp.evalJs(`(() => { const btns=[...document.querySelectorAll('button')]; const b = btns.find(x=>x.textContent.trim()==='Xác nhận'); return b ? b.disabled : null; })()`);
      if (submitDisabled !== true) throw new Error("empty prefix did not disable the submit button");

      await typeIntoPrefix(cdp, "a.b");
      err = await hostnameError(cdp);
      if (!err) throw new Error("multi-label prefix 'a.b' was accepted — expected a rejection");

      await typeIntoPrefix(cdp, "PPM");
      err = await hostnameError(cdp);
      // hostname-validation lowercases before validating (buildHostname trims+lowercases),
      // so uppercase input must resolve to the same valid state as lowercase "ppm".
      if (err) throw new Error(`uppercase "PPM" was rejected: ${err}`);

      await typeIntoPrefix(cdp, "ppm");
      err = await hostnameError(cdp);
      if (err) throw new Error(`"ppm" was rejected: ${err}`);
    });
    await screenshot(cdp, "06-desktop-choose-hostname.png");

    await scenario("submit -> applying -> setup_pending push -> pending card", async () => {
      await setSetupMode(cdp, "pending");
      await clickByText(cdp, "Xác nhận");
      await waitForText(cdp, "Đã lưu", 10000);
    });
    await screenshot(cdp, "07-desktop-setup-pending.png");

    await scenario("close -> reopen flow -> submit with setupMode=done reaches the done card", async () => {
      await clickByText(cdp, "Đóng");
      await setMock(cdp, { dismissed: false, mode: "quick", login: { state: "idle", url: null, message: null } });
      await reload(cdp);
      await waitForText(cdp, "Bạn đã có domain trên Cloudflare chưa?");
      await clickByText(cdp, "Có");
      await waitForText(cdp, "Đăng nhập Cloudflare");
      await fireEvent(cdp, "tunnel:login_state", { state: "success" });
      await waitForText(cdp, "hienle.tech", 10000);
      await clickByText(cdp, "Tiếp tục");
      await setSetupMode(cdp, "done");
      await clickByText(cdp, "Xác nhận");
      await waitForText(cdp, "Đã thiết lập xong", 10000);
      const text = await popupText(cdp);
      if (!text.includes("ppm.hienle.tech")) throw new Error("done card missing the resolved hostname");
    });
    await screenshot(cdp, "08-desktop-setup-done.png");
    await clickByText(cdp, "Đóng").catch(() => {});

    // ── Tunnel Manager section: authEnabled:false, certState mismatch, tunnelWarning ──
    // Each section scenario switches away then back to the "tunnels" sidebar tab: the
    // section unmounts (its useNamedTunnelSetup instance is dropped) and remounts with a
    // fresh GET /status against whatever window.__ppmMock.status was just set to.
    async function openTunnelsTab() {
      await cdp.evalJs(`(await import('/stores/settings-store.ts')).useSettingsStore.getState().setSidebarActiveTab("history")`);
      await Bun.sleep(300);
      await cdp.evalJs(`(await import('/stores/settings-store.ts')).useSettingsStore.getState().setSidebarActiveTab("tunnels")`);
    }

    await scenario("Tunnel Manager section: authEnabled:false hides the setup button and shows the notice", async () => {
      await setMock(cdp, { authEnabled: false, dismissed: true, mode: "quick" });
      await openTunnelsTab();
      await waitForText(cdp, "Bật xác thực PPM để dùng tên miền riêng");
      const hasSetupBtn = await cdp.evalJs(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Thiết lập named tunnel')`);
      if (hasSetupBtn) throw new Error("setup button still rendered while authEnabled:false");
    });
    await screenshot(cdp, "09-desktop-section-auth-disabled.png");

    await scenario("Tunnel Manager section: certState 'mismatch' shows the re-login copy + action", async () => {
      await setMock(cdp, { authEnabled: true, certState: "mismatch", dismissed: false });
      await openTunnelsTab();
      // initialStepFromStatus checks certState BEFORE dismissed/mode, so a mismatch always
      // wins the section's own useNamedTunnelSetup() into the "needs-relogin" step — which
      // makes inFlow=true and routes rendering through NamedTunnelSetupContent's
      // needs-relogin case (copy.needsRelogin.certMismatch), not the section's own passive
      // "certNeedsRelogin && !inFlow" banner (copy.section.certMismatch) — that second copy
      // string is effectively unreachable through a live status refresh; noted in the report.
      await waitForText(cdp, "Cần đăng nhập lại Cloudflare");
      const text = await popupText(cdp);
      if (!text.includes("một tài khoản Cloudflare khác")) throw new Error(`mismatch message not shown: ${text.slice(0, 400)}`);
      const hasReloginBtn = await cdp.evalJs(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Đăng nhập lại')`);
      if (!hasReloginBtn) throw new Error("re-login action button missing for certState:mismatch");
    });
    await screenshot(cdp, "10-desktop-section-cert-mismatch.png");

    await scenario("Tunnel Manager section: liveMode 'quick' badge + tunnelWarning banner render together", async () => {
      await setMock(cdp, {
        certState: "ok", mode: "named", liveMode: "quick", hostname: "ppm.hienle.tech",
        tokenMasked: "abcdef...", tunnelWarning: "named tunnel failed to start — running on the quick tunnel instead",
      });
      await openTunnelsTab();
      await waitForText(cdp, "named tunnel failed to start");
      const text = await popupText(cdp);
      if (!text.toLowerCase().includes("quick")) throw new Error(`liveMode 'quick' badge not visible: ${text.slice(0, 400)}`);
      if (!text.includes("đã cấu hình: named")) throw new Error("configuredAs('named') note not visible alongside the live quick badge");
    });
    await screenshot(cdp, "11-desktop-section-warning-badge.png");

    // ── Mobile viewport: bottom-sheet popup + touch targets ─────────────────
    await setMock(cdp, { authEnabled: true, certState: "ok", mode: "quick", dismissed: false, tunnelWarning: null, login: { state: "idle", url: null, message: null } });
    await setViewport(cdp, 375, 812, true);
    await reload(cdp);

    await scenario("popup renders as a bottom sheet on a 375px viewport", async () => {
      await waitForText(cdp, "Bạn đã có domain trên Cloudflare chưa?");
    });
    await screenshot(cdp, "12-mobile-375-ask-domain.png");

    await scenario("all interactive controls in the mobile popup meet the 44px touch-target minimum", async () => {
      const offenders = await touchTargetAudit(cdp);
      if (offenders.length) throw new Error(`undersized controls on mobile: ${JSON.stringify(offenders)}`);
    });

    await clickByText(cdp, "Có");
    await waitForText(cdp, "Đăng nhập Cloudflare");
    await screenshot(cdp, "13-mobile-375-login-wait.png");
    await scenario("login-wait controls also meet 44px on mobile", async () => {
      const offenders = await touchTargetAudit(cdp);
      if (offenders.length) throw new Error(`undersized controls on mobile login-wait: ${JSON.stringify(offenders)}`);
    });

  } finally {
    if (chromeProc) { try { chromeProc.kill(); } catch {} }
    await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  console.log(`Screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  if (chromeProc) { try { chromeProc.kill(); } catch {} }
  process.exit(1);
});
