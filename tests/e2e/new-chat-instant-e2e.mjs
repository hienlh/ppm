// "Instant new chat tab" end to end: the 9 scenarios of the plan's phase 06, in real Chrome
// against a disposable real server (isolated PPM_HOME, scripted mock providers, two
// placeholder Claude accounts, no network, no model). Slowness is injected with page.route
// holds, never by changing the server.
//
// Run (PowerShell):
//   $env:PPM_PLAYWRIGHT_MODULE = "<path to>/playwright/index.mjs"
//   $env:PPM_PLAYWRIGHT_CHANNEL = "chrome"
//   $env:PPM_HTML_PREVIEW_ARTIFACTS = "$env:TEMP\ppm-e2e-artifacts"
//   node tests/e2e/new-chat-instant-e2e.mjs
//
// Artifacts (server/vite logs, failure screenshots, results.json) go to
// PPM_HTML_PREVIEW_ARTIFACTS. Exit code is non-zero when any scenario fails.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import {
  instantInstrumentation, instrumentNetwork, recordChatFrames, until, sleep, bootProject, openChatTab,
  tabMetadata, closeAllTabs, waitForChips, composer, openSlashPicker, chatCalls, firstSeen,
} from "./fixtures/new-chat-instant-helpers.mjs";

const PROJECT = "instant-e2e";
const SKILL = "instant-e2e-skill";
const HOLD_MS = 1500;
const VIEWPORT = { width: 1366, height: 900 };

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/new-chat-instant-server.ts" });
const results = [];
const diagnostics = [];

async function api(path, init = {}) {
  const res = await fetch(`${harness.api}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const projectApi = (rest) => `/api/project/${encodeURIComponent(PROJECT)}${rest}`;
const serverState = async () => (await api("/__instant-test/state")).body;

function check(scenario, name, ok, evidence) {
  results.push({ scenario, name, passed: !!ok, evidence });
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${scenario}] ${name}${evidence !== undefined ? ` — ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}` : ""}`);
}

async function newPage({ blockStorage = false } = {}) {
  const context = await harness.browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(instantInstrumentation, { api: harness.api, blockStorage });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") diagnostics.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => diagnostics.push(`pageerror: ${e.stack || e.message}`));
  const net = await instrumentNetwork(context, page);
  const frames = recordChatFrames(page);
  return { context, page, net, frames };
}

const isPrepare = (req) => req.method() === "POST" && /\/chat\/prepare$/.test(new URL(req.url()).pathname);

/** Waits for the tab's prepare response to have been received by the page. */
async function prepareResponse(net, since) {
  const entry = await until("the prepare response", () => {
    const hit = chatCalls(net.since(since), PROJECT, "POST", "prepare").find((e) => e.res);
    return hit;
  }, { timeout: 20000 });
  return { entry, body: await entry.res.json().catch(() => null) };
}

/** Types a marker and presses Enter, then waits for the `message` frame carrying it. */
async function sendAndCaptureFrame(page, frames, tabId, text) {
  const box = composer(page, tabId);
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  return until(`the message frame for "${text}"`, () => frames.find((f) => f.data?.type === "message" && f.data.content === text), { timeout: 20000 });
}

let activePage = null;
/** PPM_E2E_ONLY=3,7 runs just those scenarios (the ones that need no earlier state). */
const ONLY = process.env.PPM_E2E_ONLY ? process.env.PPM_E2E_ONLY.split(",").map((s) => s.trim()) : null;
async function runScenario(label, fn) {
  const ids = label.match(/\d+/g) ?? [];
  if (ONLY && !ids.some((id) => ONLY.includes(id))) return;
  console.log(`\n${label}`);
  try {
    await fn();
  } catch (error) {
    check(label, "scenario completed without an exception", false, error.message.split("\n")[0]);
    diagnostics.push(`${label}: ${error.stack}`);
    const shot = join(harness.artifacts, `failure-${label.replace(/\W+/g, "-")}.png`);
    await activePage?.screenshot({ path: shot }).catch(() => {});
  }
}

let main;
try {
  const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ path: harness.project, name: PROJECT }) });
  if (created.status >= 300) throw new Error(`project registration: ${created.status} ${JSON.stringify(created.body)}`);
  for (const title of ["Seeded chat A", "Seeded chat B", "Seeded chat C"]) {
    const s = await api(projectApi("/chat/sessions"), { method: "POST", body: JSON.stringify({ providerId: "plain-test", title }) });
    if (s.status !== 201) throw new Error(`seeding session "${title}": ${s.status}`);
  }

  main = await newPage();
  const { page, net, frames } = main;
  activePage = page;

  // ---- warm-up: one tab fills the browser caches (settings, provider list, slash list, sessions)
  await runScenario("[0] warm-up", async () => {
    await bootProject(page, harness.web, PROJECT);
    await closeAllTabs(page);
    const t = Date.now();
    const { tabId } = await openChatTab(page, PROJECT);
    await prepareResponse(net, t);
    await waitForChips(page, tabId);
    await openSlashPicker(page, tabId, SKILL);
    // IndexedDB writes are fire-and-forget; wait until the slash list is really on disk.
    await until("the slash list in IndexedDB", () => page.evaluate(async (project) => {
      const { projectCacheId, slash } = await import("/lib/browser-cache/cache-keys.ts");
      const { idbGet } = await import("/lib/browser-cache/idb-keyval-cache.ts");
      const { projectRefForName } = await import("/stores/session-list-sync-triggers.ts");
      const id = projectCacheId(projectRefForName(project));
      return !!(await idbGet(slash(id, "claude"))) && !!(await idbGet(`${id}:sessions`));
    }, PROJECT));
    await closeAllTabs(page);
    check("[0] warm-up", "caches warmed by a first tab", true);
  });

  // ---- [1] + [2]: reload, then open a tab with every /api response held back 1.5 s
  let claimTabId = null;
  await runScenario("[1]+[2] warm cache after reload, request budget", async () => {
    await bootProject(page, harness.web, PROJECT, { reload: true });
    // What a reloaded tab can show before the network answers is whatever was hydrated from
    // IndexedDB at project activation. Read it through the app's own module, without
    // importing that module ourselves first (importing it would register its hydrator late
    // and change what is measured): the slash cache is only reachable once a chat chunk loaded.
    const hydratedBeforeOpen = await page.evaluate(async (project) => {
      const loaded = performance.getEntriesByType("resource").some((e) => /\/lib\/slash-items-cache\.ts/.test(e.name));
      if (!loaded) return { slashModuleLoaded: false, slashItems: 0 };
      const { getCachedSlashItems } = await import("/lib/slash-items-cache.ts");
      return { slashModuleLoaded: true, slashItems: getCachedSlashItems(project, "claude")?.items?.length ?? 0 };
    }, PROJECT);
    const picksBefore = (await serverState()).picks.length;

    net.setPolicy(() => HOLD_MS);
    const opened = await openChatTab(page, PROJECT);
    claimTabId = opened.tabId;
    const chips = await waitForChips(page, opened.tabId);
    const metaAtOpen = opened.metadataAtOpen;
    const slash = await openSlashPicker(page, opened.tabId, SKILL, 8000).catch(async (e) => ({
      at: Infinity, error: e.message.split("\n")[0],
      composer: await composer(page, opened.tabId).inputValue().catch(() => null),
      cached: await page.evaluate(async (p) => (await import("/lib/slash-items-cache.ts")).getCachedSlashItems(p, "claude")?.items?.map((i) => i.name), PROJECT),
    }));
    if (slash.error) console.log(`  info  slash picker never listed the skill: ${JSON.stringify(slash)}`);
    const firstRelease = await until("the first held response to be released", () => net.releasesSince(opened.at)[0], { timeout: 10000 });
    const { entry: prep, body } = await prepareResponse(net, opened.at);
    net.setPolicy(() => 0);

    const evidence = {
      chipsAfterOpenMs: chips.at - opened.at, slashTypedAfterOpenMs: slash.typedAt - opened.at, slashAfterOpenMs: slash.at - opened.at,
      firstReleaseAfterOpenMs: firstRelease.at - opened.at, prepareRespondedAfterOpenMs: prep.respondedAt - opened.at,
      chips: [chips.mode, chips.provider], firstSeen: await firstSeen(page), hydratedBeforeOpen,
    };
    check("[1]", "tab born resolved from cache (no providerPending, provider + permission set)", !metaAtOpen?.providerPending && metaAtOpen?.providerId === "claude" && !!metaAtOpen?.permissionMode, metaAtOpen);
    check("[1]", "chips rendered before any held response was released", chips.at < firstRelease.at, evidence);
    check("[1]", "`/` picker listed the cached skill before any held response was released", slash.at < firstRelease.at, evidence);

    // [2]: everything the tab-open window caused, up to 3 s after prepare landed.
    await sleep(3000);
    const win = net.since(opened.at).filter((e) => e.at <= prep.respondedAt + 3000);
    const count = (m, rest) => chatCalls(win, PROJECT, m, rest).length;
    const forbidden = {
      "GET /settings/ai": win.filter((e) => e.method === "GET" && e.path === "/api/settings/ai").length,
      "GET chat/providers": count("GET", "providers"),
      "GET chat/drafts/__new__": count("GET", "drafts/__new__"),
      "GET chat/usage": count("GET", "usage"),
      "GET chat/slash-items": count("GET", "slash-items"),
      "POST accounts/pick": win.filter((e) => e.method === "POST" && /\/(codex-)?accounts\/pick$/.test(e.path)).length,
    };
    const prepares = count("POST", "prepare");
    check("[2]", "exactly one POST /chat/prepare on tab open", prepares === 1, { prepares });
    check("[2]", "zero settings/providers/draft/usage/slash/pick requests on tab open", Object.values(forbidden).every((n) => n === 0), forbidden);
    const state = await serverState();
    const picked = body?.data?.pickedAccount;
    const meta = await tabMetadata(page, opened.tabId);
    check("[2]", "the account was picked inside prepare (one pick consumed, claim written to the tab)",
      picked && typeof picked === "object" && state.picks.length === picksBefore + 1 && meta?.pickedAccountId === picked.id,
      { pickedAccount: picked, picksConsumed: state.picks.length - picksBefore, metaClaim: meta?.pickedAccountId, requestBody: prep.body });
    console.log(`  info  all /api calls in window: ${win.map((e) => `${e.method} ${e.path.replace(`/api/project/${PROJECT}`, "…")}`).join(", ")}`);
  });

  // ---- [8]: reload with that sessionless, already-claimed tab restored
  await runScenario("[8] reload a claimed sessionless tab", async () => {
    if (!claimTabId) throw new Error("scenario [2] left no claimed tab");
    const before = await tabMetadata(page, claimTabId);
    await until("the claim to be persisted in the saved layout", () => page.evaluate((id) =>
      Object.keys(localStorage).some((k) => (localStorage.getItem(k) || "").includes(id)), before.pickedAccountId));
    const picksBefore = (await serverState()).picks.length;
    const t = Date.now();
    await bootProject(page, harness.web, PROJECT, { reload: true });
    const { entry, body } = await prepareResponse(net, t);
    await sleep(1500);
    const after = await tabMetadata(page, claimTabId);
    const sent = JSON.parse(entry.body || "{}");
    const picksAfter = (await serverState()).picks.length;
    check("[8]", "prepare is sent with skipPick: true", sent.skipPick === true, sent);
    check("[8]", "server answers pickedAccount \"skipped\" and consumes no pick", body?.data?.pickedAccount === "skipped" && picksAfter === picksBefore, { pickedAccount: body?.data?.pickedAccount, picksConsumed: picksAfter - picksBefore });
    check("[8]", "the tab keeps the account it claimed before the reload", after?.pickedAccountId === before.pickedAccountId, { before: before.pickedAccountId, after: after?.pickedAccountId });
    const pickPosts = net.since(t).filter((e) => e.method === "POST" && /\/accounts\/pick$/.test(e.path)).length;
    check("[8]", "no /accounts/pick fallback after the reload", pickPosts === 0, { pickPosts });
    await closeAllTabs(page);
  });

  // ---- [4]: stale cached permission, first send before prepare lands
  await runScenario("[4] stale cached permission", async () => {
    await api("/__instant-test/permission", { method: "POST", body: JSON.stringify({ provider: "claude", mode: "default" }) });
    await page.evaluate(() => {
      const pref = JSON.parse(localStorage.getItem("ppm-chat-pref") || "{}");
      pref.providers = { ...(pref.providers || {}), claude: { permission_mode: "bypassPermissions" } };
      localStorage.setItem("ppm-chat-pref", JSON.stringify(pref));
    });
    net.setPolicy((req) => (isPrepare(req) ? HOLD_MS : 0));
    const opened = await openChatTab(page, PROJECT);
    const chips = await waitForChips(page, opened.tabId);
    const marker = `stale-permission-${Date.now()}`;
    const box = composer(page, opened.tabId);
    await box.click();
    await page.keyboard.type(marker);
    const enterAt = Date.now();
    await page.keyboard.press("Enter");
    const frame = await until("the message frame", () => frames.find((f) => f.data?.type === "message" && f.data.content === marker), { timeout: 20000 });
    net.setPolicy(() => 0);
    const { entry } = await prepareResponse(net, opened.at);
    check("[4]", "the tab opened with the stale cached permission", chips.mode === "Permission mode: Bypass permissions", chips.mode);
    check("[4]", "Enter was pressed before prepare answered (the case under test)", enterAt < entry.respondedAt, { enterAfterOpenMs: enterAt - opened.at, prepareAfterOpenMs: entry.respondedAt - opened.at, frameAfterOpenMs: frame.at - opened.at });
    check("[4]", "the `message` frame carries the fresh server permission \"default\"", frame.data.permissionMode === "default", { permissionMode: frame.data.permissionMode });
    const turn = await until("the provider turn", async () => (await serverState()).turns.find((x) => x.message === marker));
    check("[4]", "the provider turn ran with permissionMode \"default\"", turn.permissionMode === "default", { turnPermission: turn.permissionMode });
    await closeAllTabs(page);
  });

  // ---- [9]: the user picks a mode by hand before prepare lands
  await runScenario("[9] user-chosen mode wins over prepare", async () => {
    await page.evaluate(() => {
      const pref = JSON.parse(localStorage.getItem("ppm-chat-pref") || "{}");
      pref.providers = { ...(pref.providers || {}), claude: { permission_mode: "bypassPermissions" } };
      localStorage.setItem("ppm-chat-pref", JSON.stringify(pref));
    });
    net.setPolicy((req) => (isPrepare(req) ? HOLD_MS : 0));
    const opened = await openChatTab(page, PROJECT);
    await waitForChips(page, opened.tabId);
    await page.locator(`[data-tab-pool-id="${opened.tabId}"] button[aria-label^="Permission mode:"]:visible`).first().click();
    // The composer renders a phone row and a desktop row; only one of them is on screen.
    await page.locator(`[data-tab-pool-id="${opened.tabId}"] [role="listbox"][aria-label="Permission modes"]:visible [role="option"]`).filter({ hasText: "Plan mode" }).click();
    const chosenAt = Date.now();
    const marker = `user-mode-${Date.now()}`;
    const frame = await sendAndCaptureFrame(page, frames, opened.tabId, marker);
    net.setPolicy(() => 0);
    const { entry } = await prepareResponse(net, opened.at);
    check("[9]", "mode chosen by hand while prepare was still held", chosenAt < entry.respondedAt, { chosenAfterOpenMs: chosenAt - opened.at, prepareAfterOpenMs: entry.respondedAt - opened.at, frameAfterOpenMs: frame.at - opened.at });
    check("[9]", "the `message` frame carries the user's choice \"plan\", not the server's \"default\"", frame.data.permissionMode === "plan", { permissionMode: frame.data.permissionMode });
    await closeAllTabs(page);
  });

  // ---- [5]: the __new__ draft now arrives inside prepare
  await runScenario("[5] late draft", async () => {
    const seed = async (content) => api(projectApi("/chat/drafts/__new__"), { method: "PUT", body: JSON.stringify({ content, attachments: "[]" }) });
    // 5a: a draft that lands late is restored into the already-usable composer.
    const saved = `server-draft-${Date.now()}`;
    if ((await seed(saved)).status >= 300) throw new Error("could not seed the __new__ draft");
    net.setPolicy((req) => (isPrepare(req) ? 2500 : 0));
    let opened = await openChatTab(page, PROJECT);
    const chips = await waitForChips(page, opened.tabId);
    const valueAtFirstFrame = await composer(page, opened.tabId).inputValue();
    const restored = await until("the late draft in the composer", async () => (await composer(page, opened.tabId).inputValue()) === saved, { timeout: 10000 }).catch(() => false);
    let { entry } = await prepareResponse(net, opened.at);
    check("[5]", "composer usable before the draft arrived", chips.at < entry.respondedAt && valueAtFirstFrame === "", { composerAfterOpenMs: chips.at - opened.at, prepareAfterOpenMs: entry.respondedAt - opened.at, valueAtFirstFrame });
    check("[5]", "the late draft (from prepare) is restored into the composer", restored === true, { value: await composer(page, opened.tabId).inputValue() });
    check("[5]", "no separate GET drafts/__new__", chatCalls(net.since(opened.at), PROJECT, "GET", "drafts/__new__").length === 0);
    await composer(page, opened.tabId).fill("");
    await closeAllTabs(page);

    // 5b: text typed before the late draft lands is kept.
    const stale = `stale-draft-${Date.now()}`;
    await sleep(1500); // the composer's own debounced draft save from 5a must land before re-seeding
    if ((await seed(stale)).status >= 300) throw new Error("could not seed the __new__ draft");
    net.setPolicy((req) => (isPrepare(req) ? 3000 : 0));
    opened = await openChatTab(page, PROJECT);
    await waitForChips(page, opened.tabId);
    const typed = `typed-before-draft-${Date.now()}`;
    await composer(page, opened.tabId).click();
    await page.keyboard.type(typed);
    const typedAt = Date.now();
    ({ entry } = await prepareResponse(net, opened.at));
    net.setPolicy(() => 0);
    await sleep(1500);
    const value = await composer(page, opened.tabId).inputValue();
    check("[5]", "typed before prepare landed", typedAt < entry.respondedAt, { typedAfterOpenMs: typedAt - opened.at, prepareAfterOpenMs: entry.respondedAt - opened.at });
    check("[5]", "text typed before the draft arrived is kept", value === typed, { value, typed, staleDraft: stale });
    await composer(page, opened.tabId).fill("");
    await sleep(1500);
    await api(projectApi("/chat/drafts/__new__"), { method: "DELETE" });
    await closeAllTabs(page);
  });

  // ---- [6]: sidebar and welcome screen share one session fetch
  await runScenario("[6] sidebar + welcome share one fetch", async () => {
    // An empty layout, saved to the server, so the reload lands on the empty-panel welcome
    // screen (its "Recent chats" list) beside the sidebar's Chat History.
    await closeAllTabs(page, { save: true });
    // The newest cached row is in both lists (the welcome screen shows the top five).
    const newestCached = await page.evaluate(async (project) => {
      const { projectCacheId, sessions } = await import("/lib/browser-cache/cache-keys.ts");
      const { idbGet } = await import("/lib/browser-cache/idb-keyval-cache.ts");
      const { projectRefForName } = await import("/stores/session-list-sync-triggers.ts");
      const cached = await idbGet(sessions(projectCacheId(projectRefForName(project))));
      return cached?.sessions?.[0]?.title ?? null;
    }, PROJECT);
    if (!newestCached) throw new Error("no cached session list in IndexedDB");
    const isSessionList = (req) => {
      const u = new URL(req.url());
      return req.method() === "GET" && u.pathname === `/api/project/${PROJECT}/chat/sessions` && !u.searchParams.get("q");
    };
    net.setPolicy((req) => (isSessionList(req) ? HOLD_MS : 0));
    const t = Date.now();
    await bootProject(page, harness.web, PROJECT, { reload: true });
    const shown = await (await page.waitForFunction((title) => {
      const sidebarBox = document.querySelector('input[placeholder="Filter sessions…"]')?.closest("div.flex.flex-col.h-full");
      const welcomeBox = document.querySelector('input[placeholder="Search chats..."]')?.closest(".relative")?.parentElement;
      const sidebar = !!sidebarBox && sidebarBox.textContent.includes(title);
      const welcome = !!welcomeBox && welcomeBox.textContent.includes(title);
      const syncing = [...document.querySelectorAll('[role="status"]')].filter((s) => s.textContent.includes("Syncing")).length;
      if (!welcome || !sidebar) return false;
      return { at: Date.now(), welcome, sidebar, syncing };
    }, newestCached, { timeout: 15000, polling: "raf" })).jsonValue();
    const release = await until("the held session list to be released", () => net.releasesSince(t).find((r) => r.path.endsWith("/chat/sessions")), { timeout: 10000 });
    const gone = await until("the syncing indicator to go away", () => page.evaluate(() =>
      [...document.querySelectorAll('[role="status"]')].every((s) => !s.textContent.includes("Syncing"))), { timeout: 10000 }).catch(() => false);
    net.setPolicy(() => 0);
    await sleep(2000);
    const fetches = net.since(t).filter((e) => e.method === "GET" && e.path === `/api/project/${PROJECT}/chat/sessions` && !new URLSearchParams(e.search).get("q"));
    check("[6]", "cached rows in the sidebar AND the welcome screen before the session list answered", shown.at < release.at, { row: newestCached, rowsAfterReloadMs: shown.at - t, releaseAfterReloadMs: release.at - t });
    check("[6]", "the syncing indicator is visible while the sync runs", shown.syncing >= 1, { syncingIndicators: shown.syncing });
    check("[6]", "the syncing indicator disappears once the sync lands", gone === true);
    check("[6]", "exactly one /chat/sessions fetch shared by both lists", fetches.length === 1, { fetches: fetches.map((f) => f.search) });
  });

  // ---- [3]: cold slash on the server, cold browser
  await runScenario("[3] cold server slash cache", async () => {
    const cold = await newPage();
    activePage = cold.page;
    try {
      await bootProject(cold.page, harness.web, PROJECT);
      await closeAllTabs(cold.page, { save: true });
      // A cold browser too: whatever the restored layout already fetched is dropped, so the
      // only way this tab can get a list is the one under test.
      await cold.page.evaluate(async () => (await import("/lib/slash-items-cache.ts")).clearSlashItemsCache());
      await api("/__instant-test/cold-skill-ms", { method: "POST", body: JSON.stringify({ ms: 3000 }) });
      const inv = await api(projectApi("/chat/slash-items/cache"), { method: "DELETE" });
      if (inv.status !== 200) throw new Error(`slash cache invalidation: ${inv.status}`);
      const opened = await openChatTab(cold.page, PROJECT);
      const { entry, body } = await prepareResponse(cold.net, opened.at);
      const tookMs = entry.respondedAt - entry.at;
      check("[3]", "prepare answers within budget despite a 3 s cold skill list", tookMs < 1500, { prepareMs: tookMs });
      check("[3]", "prepare carries slash: null and still the draft/account/usage/tags parts",
        body?.data?.slash === null && "draft" in body.data && body.data.pickedAccount && typeof body.data.pickedAccount === "object" && body.data.tags !== null,
        { slash: body?.data?.slash, pickedAccount: body?.data?.pickedAccount, hasUsage: body?.data?.usage != null, tags: !!body?.data?.tags, draft: body?.data?.draft });
      await waitForChips(cold.page, opened.tabId);
      const slash = await openSlashPicker(cold.page, opened.tabId, SKILL, 20000);
      const gets = chatCalls(cold.net.since(opened.at), PROJECT, "GET", "slash-items");
      check("[3]", "the client then fetches /slash-items separately, exactly once", gets.length === 1, { slashGets: gets.length, pickerAfterOpenMs: slash.at - opened.at });
    } finally {
      await cold.context.close();
    }
  });

  // ---- [7]: the cache layer's storage throws (IndexedDB entirely, and its localStorage keys)
  await runScenario("[7] storage blocked", async () => {
    const diagStart = diagnostics.length;
    const blocked = await newPage({ blockStorage: "cache" });
    activePage = blocked.page;
    try {
      await bootProject(blocked.page, harness.web, PROJECT);
      await closeAllTabs(blocked.page, { save: true });
      const opened = await openChatTab(blocked.page, PROJECT);
      const { body } = await prepareResponse(blocked.net, opened.at).catch(async (e) => {
        const state = await blocked.page.evaluate((id) => ({
          firstSeen: window.__e2e.firstSeen, deniedSinceBoot: window.__e2e.deniedFrom.slice(-8),
          rootText: document.querySelector(`[data-tab-pool-id="${id}"]`)?.innerText?.slice(0, 200) ?? null,
          body: document.body.innerText.slice(0, 300),
        }), opened.tabId).catch((x) => ({ evalError: x.message }));
        const calls = blocked.net.since(opened.at).map((x) => `${x.method} ${x.path} ${x.status ?? "…"}`);
        throw new Error(`${e.message}; opened=${JSON.stringify(opened.metadataAtOpen)} state=${JSON.stringify(state)} calls=${JSON.stringify(calls)}`);
      });
      const chips = await waitForChips(blocked.page, opened.tabId, 20000);
      await openSlashPicker(blocked.page, opened.tabId, SKILL, 20000);
      const marker = `blocked-storage-${Date.now()}`;
      const frame = await sendAndCaptureFrame(blocked.page, blocked.frames, opened.tabId, marker);
      const turn = await until("the provider turn", async () => (await serverState()).turns.find((x) => x.message === marker));
      const prepares = chatCalls(blocked.net.since(opened.at), PROJECT, "POST", "prepare").length;
      const { storageErrors, deniedFrom } = await blocked.page.evaluate(() => ({ storageErrors: window.__e2e.storageErrors, deniedFrom: window.__e2e.deniedFrom }));
      const cacheErrors = diagnostics.slice(diagStart).filter((d) => /pageerror/.test(d) && /insecure/.test(d)).length;
      check("[7]", "the tab becomes usable network-only (cold path, one prepare)", !!chips && !!body?.data && opened.metadataAtOpen.providerPending === true && prepares === 1,
        { deniedStorageAccesses: storageErrors, prepares, chips: [chips.mode, chips.provider], bornPending: opened.metadataAtOpen.providerPending });
      check("[7]", "`/` list and first send work without storage", !!frame && !!turn, { permissionMode: frame.data.permissionMode });
      check("[7]", "no uncaught storage exception reached the page", cacheErrors === 0, { uncaught: cacheErrors, deniedFrom });
    } finally {
      await blocked.context.close();
    }
  });

  // ---- [7-strict]: the whole localStorage global throws. Informational: the boot chain is
  // out of this feature's scope and fails on its own (see the report), so this is recorded,
  // not counted.
  await runScenario("[7-strict] all storage blocked (informational)", async () => {
    const strict = await newPage({ blockStorage: "all" });
    activePage = strict.page;
    try {
      await strict.page.goto(`${harness.web}/project/${PROJECT}`);
      const booted = await strict.page.waitForFunction(() => !!document.querySelector('[aria-label^="AI Provider:"], textarea, [data-tab-id]') || /Recent chats|Chat History/.test(document.body.innerText), undefined, { timeout: 15000 })
        .then(() => true, () => false);
      const { deniedFrom } = await strict.page.evaluate(() => ({ deniedFrom: window.__e2e.deniedFrom }));
      const body = await strict.page.evaluate(() => document.body.innerText.slice(0, 80));
      results.push({ scenario: "[7-strict]", name: "app shell renders with the whole localStorage global throwing", passed: true, informational: true, evidence: { booted, body, firstDenied: deniedFrom.slice(0, 12) } });
      console.log(`  INFO  [7-strict] app shell rendered=${booted} body=${JSON.stringify(body)}`);
    } finally {
      await strict.context.close();
    }
  });
} catch (error) {
  results.push({ scenario: "setup", name: "setup", passed: false, evidence: error.message });
  console.error("setup failed:", error.stack);
} finally {
  if (main) await main.page.screenshot({ path: join(harness.artifacts, "new-chat-instant-final.png") }).catch(() => {});
  await harness.browser.close().catch(() => {});
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "new-chat-instant-results.json"), JSON.stringify({ results, diagnostics, sandbox: harness.sandbox }, null, 2));
  const counted = results.filter((r) => !r.informational);
  const failed = counted.filter((r) => !r.passed);
  console.log(`\n${counted.length - failed.length}/${counted.length} checks passed. Artifacts: ${harness.artifacts}`);
  if (diagnostics.length) console.log(`diagnostics (${diagnostics.length}): ${diagnostics.slice(0, 12).join("\n  ")}`);
  process.exitCode = failed.length ? 1 : 0;
}
