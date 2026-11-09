// The chat footer must name the account BEFORE the first message is sent.
//
// What this guards: a new chat tab used to show no account at all until a message had been
// sent and answered, so the only way to learn which account a conversation would run on was
// to run it. A tab now claims one when it opens and the footer's usage ring names it (its
// title reads "<account> · 5h … · Week …"), and the claim is what the first message redeems.
// The ring's chat menu names the same account on its first line, and its Switch account view
// ticks it (`aria-current`) and offers every other account; picking one moves the claim.
//
// Run it against a workspace it owns. A project's tab layout is synced to the server
// (`PUT /workspace`), so against a developer's own instance clearing localStorage does not
// give a clean slate: the next load restores real tabs, all of which already have sessions
// and cannot exercise a claim — which is how an earlier version reported PASS without the
// feature ever running. Every check is anchored to a tab proven to have `pickedAccountId`
// and no `sessionId`, so a wrong starting state fails loudly rather than passing vacuously.
//
// Run (isolated PPM_HOME, two seeded placeholder accounts, mock providers):
//   PPM_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs PPM_PLAYWRIGHT_CHANNEL=chrome \
//   node tests/e2e/fixtures/isolated-chat-stack.mjs -- node tests/e2e/chat-account-claim-e2e.mjs
// Under the stack (PPM_E2E_API_PORT set) the dev client's direct :8081 sockets are pointed at
// the stack's server, so nothing reaches a running `bun dev:server`, and the chat usage read is
// answered at the network edge, because the ring stays hidden until a usage figure exists and
// the stack's placeholder accounts have none.
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
    // Its own process group on POSIX, so the cleanup below can signal the whole tree with
    // one negative pid. Not on Windows, where detaching would open a console window and
    // taskkill /T walks the tree anyway.
    { stdio: "ignore", detached: process.platform !== "win32" },
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
  // The dev client dials the backend's sockets on :8081 directly. Under the isolated stack that
  // would reach a developer's own `bun dev:server` (and its ~/.ppm/ppm.dev.db), so point every
  // such socket at the stack's server before any page script runs.
  if (process.env.PPM_E2E_API_PORT) {
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(input, protocols) {
            const url = new URL(String(input), location.href);
            if (url.port === "8081") { url.hostname = "127.0.0.1"; url.port = ${JSON.stringify(process.env.PPM_E2E_API_PORT)}; }
            super(url.href, protocols);
          }
        };
      })()`,
    });
  }

  const consoleLines = [];
  const prepareCalls = [];
  const origOnMessage = ws.onmessage;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === "Runtime.consoleAPICalled" && /error|warn/.test(msg.params.type)) {
      consoleLines.push(`${msg.params.type}: ${(msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ")}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleLines.push(`exception: ${msg.params.exceptionDetails?.text} ${msg.params.exceptionDetails?.exception?.description ?? ""}`);
    }
    // The claim is made inside the tab's `POST /chat/prepare` now, not by a separate `/pick`.
    if (msg.method === "Network.responseReceived" && /\/chat\/prepare$/.test(msg.params.response.url)) {
      prepareCalls.push(`${msg.params.response.status} ${msg.params.response.url}`);
    }
    if (msg.method === "Fetch.requestPaused") answerUsage(msg.params);
    origOnMessage(e);
  };

  // The ring is drawn only once a usage figure exists, and the stack's placeholder accounts
  // have none: their usage would be fetched from Anthropic. So under the stack the figures are
  // supplied at the network edge, for whichever account the tab claimed: in the usage seed the
  // `POST /chat/prepare` answer carries (what a new tab shows first) and in `GET /chat/usage`
  // (what it reads afterwards, `accountId=` being the claim). Nothing else in either answer is
  // touched, and no label is added, so the name the ring shows can only be the claim's own.
  const FIGURES = { fiveHour: 0.2, sevenDay: 0.35 };
  const fulfill = (requestId, body) => send("Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    body: Buffer.from(JSON.stringify(body)).toString("base64"),
  }).catch(() => {});
  async function answerUsage({ requestId, request, responseStatusCode }) {
    const url = new URL(request.url);
    // A CDP pattern's `?` is a one-character wildcard and `*` spans slashes, so check the path
    // itself: `/components/chat/usage-meters.tsx` matches the usage pattern too.
    if (/^\/api\/project\/[^/]+\/chat\/usage$/.test(url.pathname)) {
      const data = { ...FIGURES, activeAccountId: url.searchParams.get("accountId"), activeAccountLabel: null };
      return fulfill(requestId, { ok: true, data });
    }
    if (/^\/api\/project\/[^/]+\/chat\/prepare$/.test(url.pathname) && responseStatusCode === 200) {
      try {
        const res = await send("Fetch.getResponseBody", { requestId });
        const body = JSON.parse(res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body);
        const picked = body?.data?.pickedAccount;
        if (picked && typeof picked === "object" && picked.id) {
          body.data.usage = { ...(body.data.usage ?? {}), ...FIGURES, activeAccountId: picked.id };
        }
        return fulfill(requestId, body);
      } catch { /* fall through to the real answer */ }
    }
    send("Fetch.continueRequest", { requestId }).catch(() => {});
  }
  if (process.env.PPM_E2E_API_PORT) {
    await send("Fetch.enable", { patterns: [
      { urlPattern: "*/api/project/*/chat/usage*", requestStage: "Request" },
      { urlPattern: "*/api/project/*/chat/prepare*", requestStage: "Response" },
    ] });
  }

  const page = {
    consoleLines,
    prepareCalls,
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

/**
 * The account the footer's usage ring names. Its title reads "<label> · 5h 47% · Week 52%",
 * or just "5h -- · Week --" when no account is known yet.
 */
// The visible one: the tab pool keeps other chat tabs mounted, hidden, with rings of their own.
const RING = `[...document.querySelectorAll('[data-chat-footer] [data-usage-ring]')].find((el) => el.offsetParent !== null)`;
const READ_CHIP = `
(() => {
  const btn = ${RING};
  if (!btn) return { found: false, label: null, title: null };
  const title = btn.getAttribute('title') || '';
  const m = title.match(/^(.*) · 5h /);
  return { found: true, label: m ? m[1] : null, title };
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
  const before = document.querySelectorAll('[data-chat-footer] [data-usage-ring]').length;
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
  // The claim is made by the tab's project-scoped `POST /chat/prepare`, so the tab has to be
  // opened inside the project: pressing Ctrl+L before the project is active puts it in the
  // project-less workspace, where there is nothing to prepare against. (Dev-server only:
  // the store is reached through Vite's module URL.)
  const projectActive = await page.waitFor(`(async () => {
    const { useProjectStore } = await import("/stores/project-store.ts");
    return useProjectStore.getState().activeProject?.name === ${JSON.stringify(PROJECT)};
  })()`);
  check("the project is active before the tab is opened", projectActive === true);

  // --- a new tab claims an account -----------------------------------------------------
  const openResult = await page.eval(OPEN_CHAT_TAB);
  check("a new chat tab is requested", openResult.dispatched === true);

  // Claim first, footer second. The footer mounts after the tab's first render pass, and
  // waiting on it before the claim just spends the budget in the wrong order.
  const claimAppeared = await page.waitFor(`(${CLAIMED_TABS}).length >= 1`);
  const toolbarUp = await page.waitFor(`!!${RING}`);
  check("the new tab renders its footer usage ring", toolbarUp === true);

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
    log(`  diag  prepare calls=${page.prepareCalls.join(" | ") || "(none — the claim never reached the server)"}`);
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

  // The ring must read the claim, not the usage endpoint's cross-session label. The title is
  // filled in once the claim lands, so wait for it rather than reading the first render.
  await page.waitFor(`((${READ_CHIP}).label) === ${JSON.stringify(claim.pickedAccountLabel)}`, 10000);
  const chip = await page.eval(READ_CHIP);
  check(
    "the footer usage ring names the claimed account",
    chip.label === claim.pickedAccountLabel,
    `ring title=${JSON.stringify(chip.title)} claim=${claim.pickedAccountLabel}`,
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
  await page.waitFor(`!!${RING}`);
  const afterReload = await page.eval(CLAIMED_TABS);
  check(
    "the claim survives a reload rather than being re-rolled",
    afterReload.some((t) => t.pickedAccountId === claim.pickedAccountId),
    `looking for ${claim.pickedAccountLabel}`,
  );

  // The ring after the reload still names the claim, before any message has been sent.
  await page.waitFor(`((${READ_CHIP}).label) === ${JSON.stringify(claim.pickedAccountLabel)}`, 10000);
  const chipAfter = await page.eval(READ_CHIP);
  check(
    "after the reload the ring still names the claimed account",
    chipAfter.label === claim.pickedAccountLabel,
    `ring title=${JSON.stringify(chipAfter.title)}`,
  );

  // --- the menu marks the claim and offers the rest -------------------------------------
  // The ring opens the chat menu; its first line is "<account> · Claude <plan>", and its
  // Switch account drill-in lists one card per account with the serving one aria-current.
  const menu = await page.eval(`
    (async () => {
      const ring = ${RING};
      if (!ring) return { opened: false };
      ring.click();
      const wait = async (fn, ms = 5000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
        return null;
      };
      const pop = await wait(() => document.querySelector('[data-footer-popover="Chat menu"] [data-chat-more-menu]'));
      if (!pop) return { opened: false };
      const who = pop.querySelector('.truncate')?.textContent?.trim() ?? null;
      const switchBtn = [...pop.querySelectorAll('button')].find((b) => /Switch account/.test(b.textContent));
      if (!switchBtn) return { opened: true, who, switchFound: false };
      switchBtn.click();
      const view = await wait(() => {
        const v = document.querySelector('[data-switch-account-view]');
        return v && v.querySelector('[data-account-row]') ? v : null;
      }, 8000);
      if (!view) return { opened: true, who, switchFound: true, rows: [] };
      // Usage arrives after the list; give the cards a moment to settle their refusals.
      await new Promise((r) => setTimeout(r, 800));
      const rows = [...view.querySelectorAll('[data-account-row]')].map((el) => ({
        id: el.getAttribute('data-account-row'),
        current: el.getAttribute('aria-current') === 'true',
        disabled: el.getAttribute('aria-disabled') === 'true',
        text: el.innerText.replace(/\\s+/g, ' ').slice(0, 120),
      }));
      return { opened: true, who, switchFound: true, rows };
    })()
  `);
  check("the ring opens the chat menu", menu.opened === true);
  check(
    "the menu names the claimed account first",
    typeof menu.who === "string" && menu.who.startsWith(`${claim.pickedAccountLabel} · `),
    `who=${JSON.stringify(menu.who)}`,
  );
  check("the menu offers Switch account", menu.switchFound === true);
  const rows = menu.rows ?? [];
  log(`  info  accounts: ${JSON.stringify(rows)}`);
  const current = rows.filter((r) => r.current);
  check(
    "exactly one account is marked as serving the chat, and it is the claim",
    current.length === 1 && current[0].id === claim.pickedAccountId,
    `current=${current.map((r) => r.id).join(",") || "(none)"} claim=${claim.pickedAccountId}`,
  );
  const others = rows.filter((r) => !r.current);
  const offered = others.filter((r) => !r.disabled);
  check(
    "every account except the serving one offers a switch",
    others.length >= 1 && offered.length === others.length,
    `others=${others.length} offered=${offered.length}`,
  );

  // --- picking another card moves the claim --------------------------------------------
  if (offered.length) {
    const target = offered[0].id;
    const targetLabel = known.claude.find((a) => a.id === target)?.label ?? null;
    await page.eval(`document.querySelector('[data-account-row=${JSON.stringify(target)}]').click(); true`);
    // A landed pick goes back to the main menu ~260ms later.
    const back = await page.waitFor(`!document.querySelector('[data-switch-account-view]') && !!document.querySelector('[data-footer-popover="Chat menu"] [data-chat-more-menu]')`, 8000);
    check("a pick returns to the main menu", back === true);
    const moved = await page.waitFor(`(${CLAIMED_TABS}).some((t) => t.pickedAccountId === ${JSON.stringify(target)})`, 8000);
    check("the pick moves the session-less tab's claim", moved === true, `to ${target}`);
    const ringMoved = await page.waitFor(`((${READ_CHIP}).label) === ${JSON.stringify(targetLabel)}`, 8000);
    check("the ring follows the pick", ringMoved === true, JSON.stringify((await page.eval(READ_CHIP)).title));
  }

  page.close();
  return finish();
}

/**
 * Kill the browser and everything it spawned.
 *
 * `chrome.kill()` reaches only the launcher. Chrome's renderers, GPU and utility processes
 * are its children, and on Windows they are not in the launcher's job object, so they
 * survive it — a single aborted run leaks a dozen of them, each holding tens of megabytes.
 * Enough runs in one session and the machine is out of memory, which is how this was found:
 * 126 orphans holding 10.5 GB, taking Docker, bun and the build down with them.
 */
function killChromeTree() {
  if (!chrome?.pid) return;
  try {
    if (process.platform === "win32") {
      // /T takes the tree, /F because a headless child ignores a polite close.
      spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // Negative pid signals the process group, which spawn() gave its own.
      process.kill(-chrome.pid, "SIGKILL");
    }
  } catch { /* already gone */ }
  try { chrome.kill("SIGKILL"); } catch { /* already gone */ }
}

// Ctrl-C and an unhandled throw both used to leave the whole tree behind.
process.on("SIGINT", () => { killChromeTree(); process.exit(130); });
process.on("SIGTERM", () => { killChromeTree(); process.exit(143); });

main()
  .then((code) => { killChromeTree(); process.exit(code); })
  .catch((e) => { log(`ERROR: ${e.message}`); killChromeTree(); process.exit(2); });
