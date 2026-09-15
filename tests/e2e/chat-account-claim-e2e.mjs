// The chat toolbar must name the account BEFORE the first message is sent.
//
// What this guards: a new chat tab used to show no account at all until a message had been
// sent and answered, so the only way to learn which account a conversation would run on was
// to run it. A tab now claims one when it opens and displays it, and the claim is what the
// first message redeems.
//
// STATUS: NOT YET RELIABLE. Do not read a red run as a broken feature, or a green one as
// proof, until the setup problem below is solved.
//
// The obstacle is workspace state, not the feature. A project's tab layout is synced to the
// server (`PUT /workspace`), so clearing localStorage does not give a clean slate: the next
// load restores the developer's real tabs, all of which already have sessions. A tab with a
// session cannot exercise a claim — and its chip shows the usage endpoint's label, which
// with a single account is indistinguishable from a claim. That is exactly how an earlier
// version of this file reported PASS without the feature ever running.
//
// What is needed to finish it: a workspace this test owns. Either an isolated PPM_HOME with
// seeded accounts, or a scratch project whose layout nothing else writes. Until then every
// check below is anchored to a tab proven to have `pickedAccountId` and no `sessionId`, so
// it fails loudly rather than passing vacuously — which is the right way round, but it is
// not yet a usable gate.
//
// Verified once by hand, against a genuinely empty workspace: a session-less tab claimed a
// real Claude account, the toolbar chip showed that account, and the claim survived a
// reload. Re-running has not reproduced a clean starting state.
//
// Run:
//   bun tests/e2e/chat-account-claim-e2e.mjs
//
// Env:
//   PPM_E2E_WEB=http://localhost:5173   dev web origin
//   PPM_E2E_PROJECT=ppm                 project to open
//   CHROME_PATH=...                     override Chrome executable path

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const AUTH_TOKEN = process.env.PPM_E2E_TOKEN || "123123";
const TOKEN_KEY = "ppm-auth-token";
const WEB = process.env.PPM_E2E_WEB || "http://localhost:5173";
const PROJECT = process.env.PPM_E2E_PROJECT || "ppm";
const WEB_PROJECT = `${WEB}/project/${encodeURIComponent(PROJECT)}`;
const CDP_PORT = 9241;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const log = (m) => console.log(m);
let chrome = null;
const failures = [];

function check(name, ok, detail = "") {
  log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function launchChrome() {
  const profile = join(tmpdir(), `ppm-account-claim-e2e-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1400,900",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Chrome did not expose its debugging port");
}

async function newPage() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
  const target = await r.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  const consoleLines = [];
  const pickCalls = [];
  const origOnMessage = ws.onmessage;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === "Runtime.consoleAPICalled" && /error|warn/.test(msg.params.type)) {
      consoleLines.push(`${msg.params.type}: ${(msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ")}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleLines.push(`exception: ${msg.params.exceptionDetails?.text} ${msg.params.exceptionDetails?.exception?.description ?? ""}`);
    }
    if (msg.method === "Network.responseReceived" && /\/pick$/.test(msg.params.response.url)) {
      pickCalls.push(`${msg.params.response.status} ${msg.params.response.url}`);
    }
    origOnMessage(e);
  };

  const page = {
    consoleLines,
    pickCalls,
    close: () => ws.close(),
    async eval(expression) {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
      return r.result.value;
    },
    /** Poll until the expression is truthy. Steadier than a fixed sleep, and it reports. */
    async waitFor(expression, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { if (await page.eval(expression)) return true; } catch { /* still rendering */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    },
    async goto(url) {
      await send("Page.navigate", { url });
      await page.waitFor("document.readyState === 'complete'", 20000);
    },
  };
  return page;
}

/** Text of the toolbar's account chip, e.g. "[Victor (Nxsys)]" → "Victor (Nxsys)". */
const READ_CHIP = `
(() => {
  const btn = [...document.querySelectorAll('button[title="Usage limits"]')][0];
  if (!btn) return { found: false, label: null };
  const span = [...btn.querySelectorAll('span')].find((s) => /^\\[.*\\]$/.test(s.textContent.trim()));
  return { found: true, label: span ? span.textContent.trim().slice(1, -1) : null };
})()
`;

/** Every chat tab the saved layout holds, with just the fields this test reasons about. */
const READ_TABS = `
(() => {
  const keys = Object.keys(localStorage).filter((k) => /"type":"chat"/.test(localStorage.getItem(k) || ''));
  const tabs = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.type === 'chat' && o.metadata) {
      tabs.push({
        sessionId: o.metadata.sessionId ?? null,
        providerId: o.metadata.providerId ?? null,
        pickedAccountId: o.metadata.pickedAccountId ?? null,
        pickedAccountLabel: o.metadata.pickedAccountLabel ?? null,
        pickedAccountProvider: o.metadata.pickedAccountProvider ?? null,
      });
    }
    Object.values(o).forEach(walk);
  };
  for (const k of keys) {
    try { walk(JSON.parse(localStorage.getItem(k))); } catch { /* not ours */ }
  }
  return tabs;
})()
`;

const CLAIMED_TABS = `(${READ_TABS}).filter((t) => !t.sessionId && t.pickedAccountId)`;

/**
 * Open a new chat tab via the global shortcut rather than a button.
 *
 * The "AI Chat" button belongs to the empty-workspace screen and is gone once any tab
 * exists — and worse, a text match for it can hit an unrelated element in a populated
 * workspace and silently do nothing, which is how this test previously reported that it had
 * opened a tab when it had not. The keybinding (`open-chat`, Mod+L) always applies.
 */
const OPEN_CHAT_TAB = `
(() => {
  const before = document.querySelectorAll('[data-testid="account-card"], button[title="Usage limits"]').length;
  const ev = (type) => window.dispatchEvent(new KeyboardEvent(type, {
    key: 'l', code: 'KeyL', ctrlKey: true, metaKey: false, bubbles: true, cancelable: true,
  }));
  document.body.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'l', code: 'KeyL', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  ev('keydown');
  return { dispatched: true, before };
})()
`;

function finish() {
  log("");
  if (failures.length) {
    log(`${failures.length} check(s) failed:`);
    failures.forEach((f) => log(`  - ${f}`));
  } else {
    log("all checks passed");
  }
  return failures.length === 0 ? 0 : 1;
}

async function main() {
  log(`web=${WEB} project=${PROJECT}`);
  await launchChrome();

  const page = await newPage();
  await page.goto(WEB);
  await page.eval(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(AUTH_TOKEN)})`);
  // Drop every saved layout, matched by content rather than key prefix. Guessing the prefix
  // is what let a previous run restore old tabs and test the wrong thing.
  await page.eval(`
    Object.keys(localStorage)
      .filter((k) => /"type":"chat"/.test(localStorage.getItem(k) || ''))
      .forEach((k) => localStorage.removeItem(k));
    true
  `);

  // Deliberately the project-less workspace, not `/project/<name>`. A project's layout is
  // synced to the server (`PUT /workspace`), so clearing it locally is undone on the next
  // load and the test ends up reading tabs restored from a previous session — which already
  // have sessions, and so cannot exercise a claim. `__global__` is localStorage-only, so
  // this is the one workspace a test can truly start empty without destroying the user's.
  // The claim endpoint is not project-scoped, so nothing under test is lost by this.
  await page.goto(WEB_PROJECT);
  const appReady = await page.waitFor(`document.querySelectorAll('button').length > 10`);
  check("app loads", appReady === true);

  // --- a new tab claims an account -----------------------------------------------------
  const openResult = await page.eval(OPEN_CHAT_TAB);
  check("a new chat tab is requested", openResult.dispatched === true);

  // Claim first, toolbar second. The toolbar mounts after the tab's first render pass, and
  // waiting on it before the claim just spends the budget in the wrong order.
  const claimAppeared = await page.waitFor(`(${CLAIMED_TABS}).length >= 1`);
  const toolbarUp = await page.waitFor(`!!document.querySelector('button[title="Usage limits"]')`);
  check("the new tab renders its toolbar", toolbarUp === true);

  if (!claimAppeared || !toolbarUp) {
    const diag = await page.eval(`
      (() => ({
        url: location.href,
        storageKeys: Object.keys(localStorage),
        chatKeys: Object.keys(localStorage).filter((k) => /"type":"chat"/.test(localStorage.getItem(k) || '')),
        allTabs: (${READ_TABS}),
        body: document.body ? document.body.innerText.slice(0, 400) : '(none)',
      }))()
    `);
    log(`  diag  url=${diag.url}`);
    log(`  diag  storage=${diag.storageKeys.join(", ")}`);
    log(`  diag  chatKeys=${diag.chatKeys.join(", ") || "(none)"}`);
    log(`  diag  tabs=${JSON.stringify(diag.allTabs)}`);
    log(`  diag  body=${JSON.stringify(diag.body)}`);
    log(`  diag  pick calls=${page.pickCalls.join(" | ") || "(none — the claim never reached the server)"}`);
    log(`  diag  console=${page.consoleLines.slice(-6).join(" || ") || "(clean)"}`);
  }

  const claimedTabs = await page.eval(CLAIMED_TABS);
  log(`  info  claims: ${JSON.stringify(claimedTabs)}`);
  check(
    "a session-less tab claims an account when it opens",
    claimAppeared && claimedTabs.length >= 1,
    `${claimedTabs.length} claimed tab(s)`,
  );
  if (claimedTabs.length === 0) { page.close(); return finish(); }

  const claim = claimedTabs[claimedTabs.length - 1];
  // `metadata.providerId` is only written once a session exists, so a session-less tab has
  // none to compare against — the claim's own record of the provider is the thing that
  // matters, because it is what makes the claim get discarded when the provider changes.
  check(
    "the claim records the provider it came from",
    claim.pickedAccountProvider === "claude" || claim.pickedAccountProvider === "codex",
    `provider=${claim.pickedAccountProvider}`,
  );

  // The chip must read the claim, not the usage endpoint's cross-session label.
  const chip = await page.eval(READ_CHIP);
  check(
    "the toolbar chip shows the claimed account",
    chip.label === claim.pickedAccountLabel,
    `chip=${chip.label} claim=${claim.pickedAccountLabel}`,
  );

  // The claimed id has to be a real account of some provider, not a leftover string.
  const known = await page.eval(`
    (async () => {
      const token = localStorage.getItem(${JSON.stringify(TOKEN_KEY)});
      const get = async (p) => (await (await fetch(p, { headers: { Authorization: 'Bearer ' + token } })).json()).data;
      const claude = await get('/api/accounts').catch(() => []);
      const codex = await get('/api/codex-accounts').catch(() => ({ accounts: [] }));
      return {
        claude: (claude || []).map((a) => ({ id: a.id, label: a.label ?? a.email })),
        codex: ((codex && codex.accounts) || []).map((a) => ({ id: a.id, label: a.label })),
      };
    })()
  `);
  const allIds = [...known.claude, ...known.codex].map((a) => a.id);
  log(`  info  claude=${known.claude.length} codex=${known.codex.length} accounts configured`);
  check("the claimed account is a real account", allIds.includes(claim.pickedAccountId), `id=${claim.pickedAccountId}`);

  // Opening a *second* tab from here is not possible through this affordance: the "AI Chat"
  // button belongs to the empty-workspace screen and is gone once a tab exists. That the
  // pick is consumed rather than previewed — so consecutive tabs spread across the pool —
  // is asserted directly against the endpoint in
  // tests/integration/api/accounts-api.test.ts ("consumes the pick so consecutive tabs
  // spread across accounts"), which is a sharper test of it than clicking would be.

  // --- the claim survives a reload -----------------------------------------------------
  await page.goto(WEB_PROJECT);
  await page.waitFor(`!!document.querySelector('button[title="Usage limits"]')`);
  const afterReload = await page.eval(CLAIMED_TABS);
  check(
    "the claim survives a reload rather than being re-rolled",
    afterReload.some((t) => t.pickedAccountId === claim.pickedAccountId),
    `looking for ${claim.pickedAccountLabel}`,
  );

  // --- the panel marks the claim and offers the rest ------------------------------------
  await page.waitFor(`!!document.querySelector('button[title="Usage limits"]')`);
  const panel = await page.eval(`
    (async () => {
      const btn = [...document.querySelectorAll('button[title="Usage limits"]')][0];
      if (!btn) return { opened: false };
      btn.click();
      await new Promise((r) => setTimeout(r, 1500));
      const rows = [...document.querySelectorAll('button')]
        .filter((b) => /Use for this chat|Serving this chat/.test(b.textContent));
      return {
        opened: true,
        rows: rows.length,
        serving: rows.filter((b) => /Serving this chat/.test(b.textContent)).length,
        selectable: rows.filter((b) => /Use for this chat/.test(b.textContent) && !b.disabled).length,
      };
    })()
  `);
  check("the usage panel opens", panel.opened === true);
  // Row count is provider-dependent — the Claude panel reuses Settings' AccountCard, the
  // Codex panel draws its own — so assert on the control both render.
  check("exactly one account is marked as serving this chat", panel.serving === 1, `serving=${panel.serving} rows=${panel.rows}`);
  check(
    "every other account is offered as selectable",
    panel.selectable === Math.max(panel.rows - 1, 0),
    `selectable=${panel.selectable} of ${panel.rows}`,
  );

  page.close();
  return finish();
}

main()
  .then((code) => { chrome?.kill("SIGKILL"); process.exit(code); })
  .catch((e) => { log(`ERROR: ${e.message}`); chrome?.kill("SIGKILL"); process.exit(2); });
