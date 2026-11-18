/**
 * The chat footer — one context row over the composer — checked and photographed in a real
 * browser against an isolated stack (scratch PPM_HOME, scripted mock providers, Vite).
 *
 * What the server cannot produce on its own is stubbed at the network edge: the account pool and
 * its usage (3 or 9 accounts), the session's changed files, the models list (a long name on
 * demand) and linked child sessions. Liveness of those children is set in the page's own stores,
 * which is what `/ws/global` would do. The connection states come from refusing the chat socket.
 *
 *   PPM_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs PPM_PLAYWRIGHT_CHANNEL=chrome \
 *   PPM_FOOTER_SHOTS=<dir> node tests/e2e/chat-footer-e2e.mjs
 *
 * Screenshots go to PPM_FOOTER_SHOTS (default: the harness's artifacts directory).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { bootProject, closeAllTabs, instantInstrumentation, openChatTab, until } from "./fixtures/new-chat-instant-helpers.mjs";

const PROJECT = "ppm-footer";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/chat-footer-server.ts" });
const SHOTS = resolve(process.env.PPM_FOOTER_SHOTS ?? join(harness.artifacts, "chat-footer"));
await mkdir(SHOTS, { recursive: true });
// Files for the "@" picker to find (the scratch project starts empty).
for (const f of ["src/web/components/chat/chat-tab.tsx", "src/web/components/chat/chat-history-panel.tsx", "src/web/hooks/use-chat.ts", "tests/unit/web/chat-tab-reply.test.tsx", "README.md"]) {
  await mkdir(join(harness.project, f, ".."), { recursive: true });
  await writeFile(join(harness.project, f), "// fixture\n");
}

// ---------------------------------------------------------------- stubbed data
const PARENT = "aaaaaaaa-0000-4000-8000-0000000000aa";
const CHILD1 = "cccccccc-0000-4000-8000-0000000000c1";
const CHILD2 = "cccccccc-0000-4000-8000-0000000000c2";
const CHILD3 = "cccccccc-0000-4000-8000-0000000000c3";
const state = { accounts: 3, longModel: false, children: false, current: "acc-v2", sessionId: null };
const bucket = (u, mins, h) => ({ utilization: u, resetsAt: new Date(Date.now() + mins * 60_000).toISOString(), resetsInMinutes: h <= 5 ? mins : null, resetsInHours: h > 5 ? mins / 60 : null, windowHours: h });
const ACCOUNTS = [
  { id: "acc-v2", label: "Victor 2 (Nxsys)", plan: "max", h5: 0.47, wk: 0.52 },
  { id: "acc-a", label: "Nxsys team A", plan: "max", h5: 0.05, wk: 0.18 },
  { id: "acc-v", label: "Victor", plan: "pro", h5: 0.12, wk: 0.30 },
  { id: "acc-b", label: "Nxsys team B", plan: "max", h5: 0.33, wk: 0.41 },
  { id: "acc-h", label: "Hien personal", plan: "pro", h5: 0.64, wk: 0.71 },
  { id: "acc-q", label: "QA bot", plan: null, h5: 0.81, wk: 0.60 },
  { id: "acc-s", label: "Nxsys shared", plan: "max", h5: 1, wk: 0.88 },
  { id: "acc-d", label: "Demo account", plan: "pro", h5: 0.96, wk: 1 },
  { id: "acc-o", label: "Old work", plan: "pro", h5: 0.2, wk: 0.3, signedOut: true },
];
const shown = () => state.accounts === 3 ? ACCOUNTS.filter((a) => ["acc-v2", "acc-v", "acc-s"].includes(a.id)) : ACCOUNTS;
const usageEntries = () => shown().map((a) => ({ accountId: a.id, accountLabel: a.label, accountStatus: "active", isOAuth: true,
  usage: { session: bucket(a.h5, 130, 5), weekly: bucket(a.wk, 3 * 1440, 168) } }));
const accountInfos = () => shown().map((a, i) => ({ id: a.id, label: a.label, email: null, expiresAt: Math.floor(Date.now() / 1000) + 86400,
  status: "active", cooldownUntil: null, priority: i, totalRequests: 0, lastUsedAt: null, createdAt: 0, hasRefreshToken: true,
  grantedAt: null, reauthRequired: !!a.signedOut, grantExpiresAt: null,
  profileData: a.plan ? { account: { has_claude_max: a.plan === "max", has_claude_pro: a.plan === "pro" } } : null }));
const chatUsage = () => {
  const a = ACCOUNTS.find((x) => x.id === state.current) ?? ACCOUNTS[0];
  return { fiveHour: a.h5, sevenDay: a.wk, session: bucket(a.h5, 130, 5), weekly: bucket(a.wk, 3 * 1440, 168), activeAccountId: a.id, activeAccountLabel: a.label };
};
const DESIGN_FILES = [
  ["src/web/components/chat/chat-tab.tsx", "modified", 42, 8],
  ["src/web/components/chat/message-input.tsx", "modified", 17, 31],
  ["src/web/components/chat/composer-context-row.tsx", "added", 96, 0],
  ["src/web/components/chat/prompt-cache-chip.tsx", "deleted", 0, 88],
];
const changedFiles = () => {
  const files = DESIGN_FILES.map(([p, status, additions, deletions]) => ({ path: `${harness.project}/${p}`, status, additions, deletions, baseline: "session", version: "1" }));
  for (let i = 0; i < 496; i++) files.push({ path: `${harness.project}/src/generated/module-${i}.ts`, status: "modified", additions: 2, deletions: 0, baseline: "session", version: "1" });
  return files;
};
// One list for the whole run: the picker caches it for five minutes.
const MODELS = () => [
  { value: "opus", label: "Claude Opus 5.5" },
  { value: "sonnet", label: "Claude Sonnet 5" },
  { value: "claude-sonnet-5-preview-20261101", label: "claude-sonnet-5-preview-20261101 (1M context)" },
];
const SCHEDULES = () => ["Morning digest", "Check CI", "Release notes", "Nightly e2e", "Ping reviewers"].map((name, i) => ({
  id: 900 + i, name, cron_expr: `0 ${8 + i} * * *`, provider_id: "claude", project_path: harness.project, prompt: name, permission_mode: "default",
  max_turns: null, timeout_ms: 600000, enabled: 1, session_id: null, last_run_at: null,
  next_fire_at: new Date(Date.now() + (i + 1) * 3600_000).toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  kind: "session", mode: "tick", description: "", script: null, target_session_id: state.sessionId, timezone: null, recurring: 1,
  pending_since: null, paused_reason: null, task_id: null, inputs: [], inputValues: {}, secretsSet: [],
  status: { state: "idle", pid: null, since: null, restartAt: null, restarts: 0, lastError: null }, target_title: null, held_after_stop: false,
}));
const ok = (data) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });

async function stub(context) {
  await context.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname, m = route.request().method();
    if (p === "/api/accounts/usage") return route.fulfill(ok(usageEntries()));
    if (p === "/api/accounts") return route.fulfill(ok(accountInfos()));
    if (p === "/api/accounts/active") return route.fulfill(ok({ id: state.current }));
    if (p.endsWith("/chat/usage")) return route.fulfill(ok(chatUsage()));
    if (p.endsWith("/file-changes/count")) return route.fulfill(ok({ count: 500 }));
    if (p.endsWith("/file-changes") && m === "POST") return route.fulfill(ok({ files: changedFiles() }));
    if (p.endsWith("/chat/providers/claude/models")) return route.fulfill(ok(MODELS()));
    if (/\/chat\/sessions\/[^/]+\/account$/.test(p) && m === "PUT") {
      state.current = JSON.parse(route.request().postData() ?? "{}").accountId ?? state.current;
      return route.fulfill(ok({}));
    }
    if (/\/chat\/sessions$/.test(p) && m === "GET" && state.sessionId) {
      const res = await route.fetch();
      const body = await res.json();
      const list = body.data?.sessions ?? [];
      for (const s of list) if (s.id === state.sessionId) { s.spawnedBy = PARENT; s.parentTitle = "Quản lý"; }
      if (state.children) {
        list.push({ id: CHILD1, providerId: "claude", title: "Scout git panel", createdAt: new Date().toISOString(), spawnedBy: state.sessionId, parentTitle: null });
        list.push({ id: CHILD2, providerId: "claude", title: "Write the e2e test", createdAt: new Date().toISOString(), spawnedBy: state.sessionId, parentTitle: null });
        list.push({ id: CHILD3, providerId: "claude", title: "Fix icon sizes", createdAt: new Date().toISOString(), spawnedBy: state.sessionId, parentTitle: null });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (p.endsWith("/stop-children") && m === "POST") return route.fulfill(ok({ stopped: 2 }));
    // The manager chat's Tasks chip and the chat's schedules: the chips the reported row carried.
    if (p === "/api/assistant/managers" && state.extras && state.sessionId) return route.fulfill(ok({ managers: [{ sessionId: state.sessionId, projectName: PROJECT }] }));
    if (p === "/api/tasks/projects" && state.extras) return route.fulfill(ok([{ name: PROJECT, projectKey: PROJECT, enabled: true, hasManager: true, open: 124, now: 11, snoozed: 0 }]));
    if (p === "/api/schedules" && state.extras && url.searchParams.get("session")) return route.fulfill(ok(SCHEDULES()));
    return route.fallback();
  });
}

// ---------------------------------------------------------------- page helpers
let refuse = false;
const sockets = new Set();
async function routeChatSocket(page) {
  await page.routeWebSocket(/\/ws\/project\/[^/]+\/chat\//, (ws) => {
    if (refuse) { ws.close(); return; }
    ws.connectToServer();
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
  });
}
/**
 * Agents are reported by the server's transcript hub over `/ws/global`; the run has none, so the
 * page's subscription is answered here with two running agents when asked to.
 */
const agentSubs = new Map();
async function routeGlobalSocket(page) {
  await page.routeWebSocket(/\/ws\/global/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      server.send(m);
      try {
        const msg = JSON.parse(String(m));
        if (msg.type === "agent-activity:subscribe" && msg.sessionId) agentSubs.set(page, { ws, subId: msg.subId });
      } catch { /* not JSON */ }
    });
  });
}
async function setAgents(page, on) {
  const sub = agentSubs.get(page);
  if (!sub) throw new Error("no agent-activity subscription seen");
  const now = Date.now();
  sub.ws.send(JSON.stringify({ type: "agent-activity", subId: sub.subId, running: on ? [
    { cardId: "toolu_agent_1", memberName: "Port e2e scripts to new chat footer", lastWriteAt: now, lastStep: "Bash · bun tests/e2e/chat-footer-e2e.mjs" },
    { cardId: "toolu_agent_2", memberName: "Scout git panel", lastWriteAt: now, lastStep: "Read git-status-panel.tsx" },
  ] : [] }));
  await sleep(250);
}
const dropSockets = async () => { for (const ws of [...sockets]) { sockets.delete(ws); await ws.close(); } };

async function newPage(phone, width = 1280) {
  const context = await harness.browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width, height: 860 }, deviceScaleFactor: 2 });
  if (!process.env.PPM_FOOTER_NO_STUB) await stub(context);
  // Points the dev client's direct :8081 sockets at this run's server and dismisses the tour.
  await context.addInitScript(instantInstrumentation, { api: harness.api, blockStorage: false });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));
  page.on("console", (m) => { if ((m.type() === "error" && !/ws\/extensions|ERR_CONNECTION_REFUSED|status of 40[34]/.test(m.text())) || process.env.PPM_FOOTER_DEBUG) console.log(`  console.${m.type()}: ${m.text().slice(0, 300)}`); });
  if (!process.env.PPM_FOOTER_NO_WS_ROUTE) await routeChatSocket(page);
  await routeGlobalSocket(page);
  return { context, page };
}

const root = (tabId) => `[data-tab-pool-id="${tabId}"]`;
const footer = (page, tabId) => page.locator(`${root(tabId)} [data-chat-footer]`);
const shot = async (page, tabId, name) => {
  await page.mouse.move(640, 5);
  await sleep(250);
  const vp = page.viewportSize();
  if (vp.width < 768) {
    // A phone shows the footer and any sheet over it: the whole screen.
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  } else {
    // The chat pane from the top of the open popover (or a little above the row) to the composer.
    const box = await footer(page, tabId).boundingBox();
    const pop = await page.evaluate((r) => document.querySelector(`${r} [data-footer-popover], ${r} [data-composer-picker="floating"]`)?.getBoundingClientRect().top ?? null, root(tabId));
    const top = Math.max(0, Math.min(box.y - 40, pop != null ? pop - 12 : Infinity));
    await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: Math.max(0, box.x - 8), y: top, width: Math.min(vp.width - box.x + 8, box.width + 16), height: box.y + box.height + 8 - top } });
  }
  console.log(`  shot ${name}.png`);
};
const inFooter = (page, tabId, sel) => page.locator(`${root(tabId)} [data-chat-footer] ${sel}`).first();
// A phone's sheet closes from its backdrop; a desktop popover from Escape.
const closePop = async (page) => {
  if (page.viewportSize().width < 768) await page.mouse.click(page.viewportSize().width / 2, 105); // under any toast, above the tallest sheet
  else await page.keyboard.press("Escape");
  await sleep(300);
};

async function setupChat(phone, width) {
  const { context, page } = await newPage(phone, width);
  await bootProject(page, harness.web, PROJECT);
  await closeAllTabs(page);
  const { tabId } = await openChatTab(page, PROJECT);
  const box = page.locator(`${root(tabId)} textarea:visible`).first();
  await box.waitFor({ timeout: 20000 });
  // A session with one finished turn: the footer then has a session, files and a linked parent.
  await box.click();
  await page.keyboard.type("first message");
  await page.keyboard.press("Enter");
  const sid = await until("the session id", () => page.evaluate(async (id) => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    const tab = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.id === id);
    return tab?.metadata?.sessionId ?? null;
  }, tabId), { timeout: 20000 });
  state.sessionId = sid;
  await until("the turn to finish", () => page.locator(`${root(tabId)} [aria-label="Send message"]`).first().isVisible(), { timeout: 20000 });
  await resyncSessions(page);
  return { context, page, tabId };
}

async function resyncSessions(page) {
  await page.evaluate(async () => {
    const { useSessionListStore } = await import("/stores/session-list-store.ts");
    const { useProjectStore } = await import("/stores/project-store.ts");
    const p = useProjectStore.getState().activeProject;
    await useSessionListStore.getState().sync({ name: p.name, path: p.path });
  });
  await sleep(300);
}

async function setChildren(page, on, needsYou = false) {
  state.children = on;
  await resyncSessions(page);
  await page.evaluate(async ({ on, needsYou, c1, c2, project }) => {
    const { useStreamingStore } = await import("/stores/streaming-store.ts");
    const { useSessionCollabStore } = await import("/stores/session-collab-store.ts");
    const sessions = new Map(useStreamingStore.getState().sessions);
    for (const id of [c1, c2]) { if (on) sessions.set(id, project); else sessions.delete(id); }
    useStreamingStore.setState({ sessions });
    useSessionCollabStore.setState((s) => {
      const pendingApprovals = { ...s.pendingApprovals };
      if (on && needsYou) pendingApprovals[c2] = "r1"; else delete pendingApprovals[c2];
      return { pendingApprovals };
    });
  }, { on, needsYou, c1: CHILD1, c2: CHILD2, project: PROJECT });
  await sleep(200);
}

async function pickModel(page, tabId, label, effort = "High") {
  const chip = inFooter(page, tabId, "[data-model-chip]");
  const effortHeading = page.getByText("Effort", { exact: true }).filter({ visible: true });
  const option = (text) => page.locator("button", { hasText: text }).filter({ visible: true }).last();
  await chip.click();
  await effortHeading.waitFor({ timeout: 10000 });
  await option(label).click({ timeout: 10000 });
  if (!(await effortHeading.count())) { await chip.click(); await effortHeading.waitFor({ timeout: 10000 }); }
  await option(new RegExp(`^${effort}`)).click({ timeout: 10000 });
  // A phone keeps its sheet open after a pick; its backdrop closes it.
  if (await effortHeading.count()) await page.mouse.click(page.viewportSize().width / 2, 105);
  await sleep(300);
}

async function narrow(page, tabId, width) {
  await page.evaluate(({ r, width }) => {
    const chat = document.querySelector(`${r} [data-onboarding="chat"]`);
    chat.style.width = width ? `${width}px` : "";
  }, { r: root(tabId), width });
  await sleep(150);
}

// ---------------------------------------------------------------- scenarios
async function scenarios(phone) {
  const tag = phone ? "phone" : "desktop";
  console.log(`\n== ${tag}`);
  const { context, page, tabId } = await setupChat(phone);
  try {
    await pickModel(page, tabId, "Opus 5.5");

    // Idle: one row over the composer, no rules, the warm cache hidden.
    check(await inFooter(page, tabId, '[data-testid="session-changes-chip"]').isVisible(), `${tag}: changes chip in the context row`);
    check(await inFooter(page, tabId, "[data-activity-chip]").isVisible(), `${tag}: activity chip in the context row`);
    check((await inFooter(page, tabId, "[data-activity-chip]").innerText()).includes("1"), `${tag}: the linked parent is counted`);
    check((await inFooter(page, tabId, "[data-activity-chip]").innerText()).includes("SESSION") === false, `${tag}: no SESSION badge`);
    check(await inFooter(page, tabId, '[data-prompt-cache="cold"]').count() === 0, `${tag}: warm cache shows nothing`);
    const ringText = await inFooter(page, tabId, "[data-usage-ring]").innerText();
    check(/5h\s*47%/.test(ringText) && /Wk\s*52%/.test(ringText), `${tag}: one labelled ring per usage window`, ringText.replace(/\s+/g, " "));
    // The right cluster is one chip: the left chips' background, border, radius and height.
    const look = await page.evaluate((r) => {
      const pick = (el) => { const s = getComputedStyle(el); return { h: Math.round(el.getBoundingClientRect().height), bg: s.backgroundColor, border: s.borderTopColor, radius: s.borderTopLeftRadius }; };
      return { cluster: pick(document.querySelector(`${r} [data-footer-cluster]`)), chip: pick(document.querySelector(`${r} [data-activity-chip]`)) };
    }, root(tabId));
    check(JSON.stringify(look.cluster) === JSON.stringify(look.chip), `${tag}: right cluster matches the left chips`, JSON.stringify(look));
    check(await inFooter(page, tabId, "[data-usage-divider]").isVisible(), `${tag}: divider between usage and the buttons`);
    await shot(page, tabId, `${tag}-idle`);

    // "/" and "@": a popover floating above the composer — its width, 6px above it, over the
    // context row without moving it.
    {
      const input = page.locator(`${root(tabId)} textarea:visible`).first();
      const rowTop = async () => (await inFooter(page, tabId, "[data-chat-context-row]").boundingBox()).y;
      const before = await rowTop();
      for (const [text, name] of [["/", "slash"], ["@chat", "at"]]) {
        await input.fill("");
        await input.pressSequentially(text);
        const picker = page.locator(`${root(tabId)} [data-composer-picker="floating"]:visible`);
        await picker.first().waitFor({ timeout: 10000 });
        await sleep(250);
        const geo = await page.evaluate((r) => {
          const p = [...document.querySelectorAll(`${r} [data-composer-picker="floating"]`)].find((e) => e.offsetParent).getBoundingClientRect();
          const t = document.querySelector(`${r} [data-chat-footer] textarea:not(.md\\:hidden)`) ?? document.querySelector(`${r} [data-chat-footer] textarea`);
          let c = t; while (c && !/rounded-\[18px\]/.test(c.className)) c = c.parentElement;
          const cb = c.getBoundingClientRect();
          const row = document.querySelector(`${r} [data-chat-context-row]`).getBoundingClientRect();
          // Anything of the conversation's under the picker — the scroll buttons — stays under it.
          const nav = document.querySelector(`${r} [data-chat-scroll-nav]`)?.getBoundingClientRect();
          const navX = nav && nav.left + nav.width / 2, navY = nav && nav.top + nav.height / 2;
          const navUnder = nav && navX >= p.left && navX <= p.right && navY >= p.top && navY <= p.bottom;
          const onTop = !navUnder || !!document.elementFromPoint(navX, navY)?.closest("[data-composer-picker]");
          return { gap: Math.round(cb.top - p.bottom), dw: Math.round(Math.abs(cb.width - p.width)), covers: p.top < row.top, onTop };
        }, root(tabId));
        check(Math.abs(geo.gap - 6) <= 1 && geo.dw <= 2 && geo.covers && geo.onTop, `${tag}: "${text}" picker floats over the row, composer-wide, 6px above it`, JSON.stringify(geo));
        check(Math.abs((await rowTop()) - before) < 1, `${tag}: "${text}" picker does not push the row up`);
        await shot(page, tabId, `${tag}-picker-${name}`);
        await page.keyboard.press("Escape");
        await sleep(150);
      }
      await input.fill("");
    }

    // Streaming: Stop replaces Send; no priority toggle (Queue and Send now are the only modes).
    const box = page.locator(`${root(tabId)} textarea:visible`).first();
    await box.click();
    await page.keyboard.type("hold this turn");
    await page.keyboard.press("Enter");
    await until("Stop", () => inFooter(page, tabId, '[aria-label="Stop response"]').isVisible(), { timeout: 15000 });
    check((await inFooter(page, tabId, '[aria-label^="Message priority"]').count()) === 0, `${tag}: no priority toggle while streaming`);
    check((await box.getAttribute("placeholder")) === "Queue a message, or Stop...", `${tag}: streaming placeholder`);
    await shot(page, tabId, `${tag}-streaming`);
    await fetch(`${harness.api}/__instant-test/release`, { method: "POST" });
    await until("Send back", () => inFooter(page, tabId, '[aria-label="Send message"]').isVisible(), { timeout: 15000 });

    // A conversation long enough to scroll: it fades out above the footer instead of a hard edge.
    for (let i = 1; i <= 5; i++) {
      await box.click();
      await page.keyboard.type(`Message ${i}: a longer line of text so the conversation fills the screen and scrolls under the footer.`);
      await page.keyboard.press("Enter");
      await until("reply", () => inFooter(page, tabId, '[aria-label="Send message"]').isVisible(), { timeout: 15000 });
      await sleep(250);
    }
    const mask = await page.evaluate((r) => {
      const el = document.querySelector(`${r} .chat-scroll-fade`);
      el.scrollTop = el.scrollHeight - el.clientHeight - 140;
      return getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage;
    }, root(tabId));
    check(/linear-gradient/.test(mask), `${tag}: the conversation fades out above the footer`, mask.slice(0, 60));
    await page.mouse.move(640, 5);
    await sleep(400);
    await page.screenshot({ path: join(SHOTS, `${tag}-scroll-fade.png`) });

    // Changes popover.
    await inFooter(page, tabId, '[data-testid="session-changes-chip"]').click();
    await until("change rows", async () => (await page.locator('[data-testid="session-change-row"]:visible').count()) > 0, { timeout: 10000 });
    await shot(page, tabId, `${tag}-changes-open`);
    await closePop(page);

    // ··· menu, More expanded, Switch account (3 accounts).
    await inFooter(page, tabId, '[aria-label="More"]').click();
    await until("menu", () => page.locator("[data-chat-more-menu]:visible").count(), { timeout: 10000 });
    if (!phone) {
      const anim = await page.evaluate((r) => getComputedStyle(document.querySelector(`${r} [data-footer-popover]`)).animationName, root(tabId));
      check(anim === "footerPopIn", `${tag}: popover rises in`, anim);
    }
    await sleep(400);
    // A quick view: the countdown alone beside each meter, and in the rings' tooltip.
    const menuResets = await page.locator("[data-chat-more-menu]:visible [data-meter-reset]").allInnerTexts();
    check(menuResets.length === 2 && menuResets.every((t) => /^in \d+[dhm]( \d+[hm])?$/.test(t)), `${tag}: menu meters show the countdown only`, menuResets.join(" | "));
    const ringTip = await inFooter(page, tabId, "[data-usage-ring]").getAttribute("title");
    check(/5h \d+% \(resets in [^)·]+\) · Week \d+% \(resets in [^)·]+\)/.test(ringTip ?? ""), `${tag}: ring tooltip gives each window's countdown`, ringTip);
    await shot(page, tabId, `${tag}-more-menu`);
    await page.locator("[data-chat-more-menu]:visible").getByText("More", { exact: true }).click();
    const fold = await page.locator("[data-chat-more-menu]:visible .grid").first().evaluate((el) => getComputedStyle(el).transitionProperty);
    check(fold.includes("grid-template-rows"), `${tag}: More unfolds by grid rows`, fold);
    await sleep(350);
    await shot(page, tabId, `${tag}-more-expanded`);
    await page.locator("[data-chat-more-menu]:visible").getByText("Switch account").click();
    await until("accounts", () => page.locator("[data-account-row]:visible").count(), { timeout: 10000 });
    const slide = await page.locator("[data-switch-account-view]:visible").evaluate((el) => getComputedStyle(el).animationName);
    check(slide === "footerFromRight", `${tag}: Switch account slides in`, slide);
    await sleep(350);
    const rows3 = await page.locator("[data-account-row]:visible").evaluateAll((els) => els.map((e) => e.getAttribute("data-account-row")));
    check(rows3[0] === "acc-v2", `${tag}: current account first`, rows3.join(","));
    // Every bar on every card is one length, whatever its label ("5h"/"Week") or figure ("8%"/"100%").
    const bars = await page.locator("[data-account-row]:visible span.h-1").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    check(bars.length >= 4 && new Set(bars).size === 1, `${tag}: account usage bars share one length`, bars.join(","));
    // Cards say when each bar resets, countdown and clock.
    const cardResets = await page.locator("[data-account-row]:visible [data-account-reset]").allInnerTexts();
    check(cardResets.length === bars.length && cardResets.every((t) => /^Resets in \d+[dhm]( \d+[hm])? · .*\d\d:\d\d$/.test(t)),
      `${tag}: every card bar says when it resets`, cardResets.slice(0, 2).join(" | "));
    await shot(page, tabId, `${tag}-accounts-3`);
    // Pick another account: ring follows, menu returns to main.
    await page.locator('[data-account-row="acc-v"]:visible').click();
    await until("main menu back", () => page.locator("[data-chat-more-menu]:visible").count(), { timeout: 5000 });
    await sleep(500);
    check((await inFooter(page, tabId, "[data-usage-ring]").innerText()).includes("30%"), `${tag}: ring follows the picked account`);
    await closePop(page);
    state.current = "acc-v2";

    // 9 accounts: search, folded Out of usage.
    state.accounts = 9;
    await inFooter(page, tabId, '[aria-label="More"]').click();
    await page.locator("[data-chat-more-menu]:visible").getByText("Switch account").click();
    await until("accounts", async () => (await page.locator("[data-account-row]:visible").count()) >= 6, { timeout: 10000 });
    await sleep(400);
    await shot(page, tabId, `${tag}-accounts-9`);
    await page.locator("[data-switch-account-view]:visible").getByText("Out of usage").click();
    await sleep(350);
    await page.locator("[data-switch-account-view]:visible [data-account-row]").last().scrollIntoViewIfNeeded();
    await shot(page, tabId, `${tag}-accounts-9-out-of-usage`);
    await closePop(page);
    state.accounts = 3;

    // History.
    await inFooter(page, tabId, '[aria-label="History"]').click();
    await sleep(400);
    await shot(page, tabId, `${tag}-history`);
    await closePop(page);

    // Activity: the linked parent alone, then two agents, then running children and unlinking.
    const activity = inFooter(page, tabId, "[data-activity-chip]");
    const tabSelected = (name) => page.locator(`[data-activity-tab="${name}"]:visible`).getAttribute("aria-selected");
    await activity.click();
    await sleep(300);
    check(await page.locator('[data-activity-tab="agents"]:visible').count() === 0, `${tag}: no Agents tab while none runs`);
    await shot(page, tabId, `${tag}-linked-one`);
    await closePop(page);

    await setAgents(page, true);
    const both = (await activity.innerText()).replace(/\s+/g, " ");
    check(/2/.test(both) && (phone || /agents/.test(both)), `${tag}: chip counts the running agents`, both);
    await shot(page, tabId, `${tag}-activity-chip`);
    await activity.click();
    await sleep(300);
    check(await tabSelected("agents") === "true", `${tag}: opens on Agents while agents run`);
    check(await page.locator("[data-agent-row]:visible").count() === 2, `${tag}: Agents tab lists both agents`);
    await shot(page, tabId, `${tag}-activity-agents`);
    await page.locator('[data-activity-tab="sessions"]:visible').click();
    const tabSlide = await page.locator('[role="tabpanel"]:visible').evaluate((el) => getComputedStyle(el).animationName);
    check(tabSlide === "footerFromRight", `${tag}: tab switch slides`, tabSlide);
    await sleep(300);
    await shot(page, tabId, `${tag}-activity-sessions`);
    await closePop(page);

    await setChildren(page, true);
    const many = (await activity.innerText()).replace(/\s+/g, " ");
    check(/4/.test(many), `${tag}: chip counts the linked sessions`, many);
    await shot(page, tabId, `${tag}-children-chip`);
    await activity.click();
    await page.locator('[data-activity-tab="sessions"]:visible').click();
    await sleep(300);
    const busy = page.locator(`[data-linked-session="${CHILD1}"] [data-unlink-action]:visible`);
    check(await busy.getAttribute("aria-disabled") === "true", `${tag}: a running child cannot be unlinked`);
    check((await page.locator("[data-unlink-finished]:visible").innerText()).includes("(2)"), `${tag}: Unlink idle & done counts the finished ones`);
    await shot(page, tabId, `${tag}-children-open`);
    await page.locator(`[data-linked-session="${CHILD3}"] [data-unlink-action="unlink"]:visible`).click();
    await sleep(450);
    check(await page.locator("[data-undo-bar]:visible").count() === 1, `${tag}: Undo offered after an unlink`);
    await page.locator("[data-unlinked-toggle]:visible").click();
    await sleep(350);
    check(await page.locator(`[data-linked-session="${CHILD3}"] [data-unlink-action="relink"]:visible`).count() === 1, `${tag}: the unlinked session waits under Unlinked with Relink`);
    await shot(page, tabId, `${tag}-unlinked`);
    await page.locator("[data-undo-bar]:visible").getByText("Undo").click();
    await sleep(300);
    check(await page.locator("[data-unlinked-toggle]:visible").count() === 0, `${tag}: Undo puts it back`);
    await page.getByText("Stop all child sessions").last().click();
    await sleep(300);
    check(await page.locator("[data-stop-children-confirm]:visible").count() === 1, `${tag}: stop-all asks first`);
    await shot(page, tabId, `${tag}-children-confirm`);
    await closePop(page);
    await setChildren(page, true, true);
    check((await activity.getAttribute("data-activity-dot")) === "needs_approval", `${tag}: chip turns red while one needs the person`);
    await shot(page, tabId, `${tag}-children-needs-you`);
    await activity.click();
    await sleep(300);
    check(await tabSelected("sessions") === "true", `${tag}: opens on Sessions when one needs the person`);
    await closePop(page);
    if (!phone) { await narrow(page, tabId, 400); await shot(page, tabId, `${tag}-narrow-activity`); await narrow(page, tabId, 0); }
    await setChildren(page, false);
    await setAgents(page, false);

    // Long model name: the model chip gives way with an ellipsis.
    state.longModel = true;
    await pickModel(page, tabId, "claude-sonnet-5-preview-20261101 (1M context)", "Extra");
    const chip = inFooter(page, tabId, "[data-model-chip]");
    const chipBox = await chip.boundingBox();
    check(chipBox && chipBox.width <= 260, `${tag}: long model chip stays bounded`, `${chipBox?.width}px`);
    await shot(page, tabId, `${tag}-long-model`);

    if (!phone) {
      await narrow(page, tabId, 400);
      await shot(page, tabId, `${tag}-narrow-long-model`);
      await pickModel(page, tabId, "Opus 5.5");
      await narrow(page, tabId, 400);
      const narrowLook = await page.evaluate((r) => {
        const chip = document.querySelector(`${r} [data-model-chip]`);
        const svgs = [...chip.querySelectorAll("svg")];
        const name = chip.querySelector("span.truncate");
        const rings = [...document.querySelectorAll(`${r} [data-usage-window] svg`)];
        return {
          chevron: getComputedStyle(svgs[svgs.length - 1]).display,
          cut: name ? name.scrollWidth > name.clientWidth : null,
          rings: rings.map((s) => getComputedStyle(s).display),
          labels: [...document.querySelectorAll(`${r} [data-usage-window]`)].map((w) => w.innerText.replace(/\s+/g, " ")),
        };
      }, root(tabId));
      check(narrowLook.chevron === "none", `${tag}: narrow hides the model chevron`, narrowLook.chevron);
      check(narrowLook.cut === false, `${tag}: narrow shows "Opus 5.5" uncut`);
      check(narrowLook.rings.every((d) => d === "none") && /^5h \d+%,Wk \d+%$/.test(narrowLook.labels.join(",")), `${tag}: narrow drops the rings, keeps the labels`, JSON.stringify(narrowLook));
      await shot(page, tabId, `${tag}-narrow`);
      await narrow(page, tabId, 0);
    } else {
      await pickModel(page, tabId, "Opus 5.5");
    }
    state.longModel = false;

    // Connection: reconnecting, then lost; Retry reconnects.
    refuse = true;
    await dropSockets();
    await until("Reconnecting", () => inFooter(page, tabId, '[data-reconnect-stage="reconnecting"]').isVisible(), { timeout: 5000 });
    check((await box.getAttribute("placeholder")) === "Will send when reconnected...", `${tag}: offline placeholder`);
    await shot(page, tabId, `${tag}-reconnecting${phone ? "" : ""}`);
    if (!phone) {
      await narrow(page, tabId, 400);
      const gone = await page.evaluate((r) => ["[data-usage-ring]", "[data-usage-divider]"].map((q) => getComputedStyle(document.querySelector(`${r} ${q}`)).display), root(tabId));
      check(gone.every((d) => d === "none"), `${tag}: narrow + reconnecting hides usage and its divider together`, gone.join(","));
      await shot(page, tabId, `${tag}-narrow-reconnecting`);
      await narrow(page, tabId, 0);
    }
    await until("lost", () => inFooter(page, tabId, '[data-reconnect-stage="lost"]').isVisible(), { timeout: 12000 });
    await shot(page, tabId, `${tag}-lost`);
    if (!phone) { await narrow(page, tabId, 400); await shot(page, tabId, `${tag}-narrow-lost`); await narrow(page, tabId, 0); }
    if (phone) {
      // Drawn small, answered large: measure the press area a thumb actually hits, not the box.
      const reach = await page.evaluate((r) => {
        const chip = document.querySelector(`${r} [data-reconnect-stage="lost"]`);
        const box = chip.getBoundingClientRect();
        const x = box.left + box.width / 2, mid = box.top + box.height / 2;
        let up = 0, down = 0;
        while (up < 40 && chip.contains(document.elementFromPoint(x, mid - up - 0.5))) up += 0.5;
        while (down < 40 && chip.contains(document.elementFromPoint(x, mid + down + 0.5))) down += 0.5;
        return { drawn: box.height, answers: up + down + 1 };
      }, root(tabId));
      check(reach.answers >= 44, `${tag}: lost chip answers a 44px press`, `${reach.answers}px answered, ${reach.drawn}px drawn`);
      const ghost = await page.evaluate((r) => {
        const btn = document.querySelector(`${r} [data-footer-cluster] [aria-label="History"]`);
        const box = btn.getBoundingClientRect();
        const x = box.left + box.width / 2, mid = box.top + box.height / 2;
        let up = 0, down = 0;
        while (up < 40 && btn.contains(document.elementFromPoint(x, mid - up - 0.5))) up += 0.5;
        while (down < 40 && btn.contains(document.elementFromPoint(x, mid + down + 0.5))) down += 0.5;
        return { drawn: box.height, answers: up + down + 1 };
      }, root(tabId));
      check(ghost.answers >= 44, `${tag}: History answers a 44px press`, `${ghost.answers}px answered, ${ghost.drawn}px drawn`);
    }
    refuse = false;
    await inFooter(page, tabId, '[data-reconnect-stage="lost"]').click();
    await until("connected again", async () => (await inFooter(page, tabId, "[data-reconnect-stage]").count()) === 0, { timeout: 15000 });
    check(true, `${tag}: Retry reconnects and the chip goes away`);
  } catch (e) {
    check(false, `${tag}: scenario threw`, e.message.split("\n")[0]);
    await page.screenshot({ path: join(SHOTS, `${tag}-failure.png`) }).catch(() => {});
  } finally {
    refuse = false;
    await fetch(`${harness.api}/__instant-test/release`, { method: "POST" }).catch(() => {});
    await context.close();
  }
}

/**
 * The left chips when they do not fit: they scroll sideways (touchpad, Shift+wheel, a finger) while
 * the right cluster stays put, the hidden side fades, and a chip's popover still opens whole.
 * `PPM_FOOTER_SHOT_PREFIX` names the shots, so the same walk photographs a build without the
 * scroller ("before") beside one with it.
 */
async function chipOverflow(phone) {
  const tag = phone ? "phone" : "desktop";
  const prefix = process.env.PPM_FOOTER_SHOT_PREFIX ?? "after";
  console.log(`\n== chip overflow, ${tag}`);
  const { context, page, tabId } = await setupChat(phone);
  const measure = () => page.evaluate((r) => {
    const row = document.querySelector(`${r} [data-chat-context-row]`);
    const el = row.querySelector(":scope > [data-footer-chips]") ?? row.firstElementChild;
    const cluster = row.querySelector("[data-footer-cluster]").getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      overflowX: s.overflowX,
      scrollLeft: Math.round(el.scrollLeft),
      max: el.scrollWidth - el.clientWidth,
      fadeStart: el.hasAttribute("data-fade-start"),
      fadeEnd: el.hasAttribute("data-fade-end"),
      mask: s.maskImage || s.webkitMaskImage || "none",
      scrollbar: el.offsetHeight - el.clientHeight,
      cluster: { left: Math.round(cluster.left), right: Math.round(cluster.right), width: Math.round(cluster.width) },
      rowRight: Math.round(row.getBoundingClientRect().right),
      box: (() => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })(),
    };
  }, root(tabId));
  const setScroll = (x) => page.evaluate(({ r, x }) => {
    const row = document.querySelector(`${r} [data-chat-context-row]`);
    const el = row.querySelector(":scope > [data-footer-chips]") ?? row.firstElementChild;
    el.scrollLeft = x;
  }, { r: root(tabId), x });
  try {
    // Every left chip the footer has: the manager chat's tasks, agents and linked sessions,
    // changed files, schedules, and on a phone the connection.
    state.extras = true;
    await page.evaluate(async () => {
      const { refreshManagerChats } = await import("/hooks/use-manager-chats.ts");
      await refreshManagerChats();
      window.dispatchEvent(new CustomEvent("schedules:changed"));
      window.dispatchEvent(new CustomEvent("tasks:changed", { detail: {} }));
    });
    await until("the tasks and schedules chips", async () => (await inFooter(page, tabId, '[data-testid="session-schedules-chip"]').count()) > 0
      && (await page.locator(`${root(tabId)} [data-chat-context-row] [aria-haspopup]`).count()) >= 4, { timeout: 10000 });
    await setAgents(page, true);
    await setChildren(page, true);
    if (phone) {
      // A phone drops the chips' words, so it takes the lost connection's "Offline · Retry" as well.
      refuse = true;
      await dropSockets();
      await until("lost", () => inFooter(page, tabId, '[data-reconnect-stage="lost"]').isVisible(), { timeout: 15000 });
    }
    await setScroll(0);
    await sleep(200);

    if (!phone) {
      // Wide pane first: everything fits, nothing scrolls, no fade.
      await page.setViewportSize({ width: 1680, height: 860 });
      await sleep(400);
      const wide = await measure();
      check(wide.max <= 1 && !wide.fadeStart && !wide.fadeEnd, `${tag} wide: chips fit, no fade`, JSON.stringify({ max: wide.max, fadeStart: wide.fadeStart, fadeEnd: wide.fadeEnd }));
      await shot(page, tabId, `${prefix}-desktop-wide`);
      await page.setViewportSize({ width: 1280, height: 860 });
      await sleep(400);
      // A pane narrow enough that the chips overflow but still show their words (above 420px).
      for (const w of [560, 520, 480, 450, 430]) {
        await narrow(page, tabId, w);
        await sleep(150);
        if ((await measure()).max > 20) break;
      }
    }

    const start = await measure();
    console.log(`  overflow: ${start.max}px hidden, overflow-x ${start.overflowX}`);
    check(start.max > 20, `${tag}: the left chips overflow the row`, `${start.max}px`);
    check(/auto|scroll/.test(start.overflowX), `${tag}: the left chips scroll sideways`, start.overflowX);
    check(start.scrollbar === 0, `${tag}: no scrollbar drawn`, `${start.scrollbar}px`);
    check(!start.fadeStart && start.fadeEnd && /gradient/.test(start.mask), `${tag}: at the start only the end fades`, JSON.stringify({ fadeStart: start.fadeStart, fadeEnd: start.fadeEnd, mask: start.mask.slice(0, 40) }));
    check(start.cluster.right <= start.rowRight + 1, `${tag}: the right cluster stays inside the row`, JSON.stringify(start.cluster));
    await shot(page, tabId, `${prefix}-${tag}-narrow`);

    // Scroll the way a person does: Shift+wheel and a sideways touchpad swipe on a desktop, a
    // finger on a phone.
    await setScroll(0);
    await sleep(100);
    const cx = start.box.x + Math.min(start.box.w / 2, 60), cy = start.box.y + start.box.h / 2;
    if (phone) {
      // A real finger: touch down on a chip, drag 160px to the left over a few frames, lift.
      const cdp = await context.newCDPSession(page);
      const touch = (type, x) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(cy) }] });
      await touch("touchStart", cx + 160);
      for (let i = 1; i <= 8; i++) { await touch("touchMove", cx + 160 - i * 20); await sleep(16); }
      await touch("touchEnd", cx);
      await sleep(400);
      const swiped = await measure();
      check(swiped.scrollLeft > 20, `${tag}: a finger swipe scrolls the chips`, `${swiped.scrollLeft}px`);
    } else {
      await page.mouse.move(cx, cy);
      await page.keyboard.down("Shift");
      await page.mouse.wheel(0, 300);
      await page.keyboard.up("Shift");
      await sleep(400);
      const shifted = await measure();
      check(shifted.scrollLeft > 20, `${tag}: Shift+wheel scrolls the chips`, `${shifted.scrollLeft}px`);
      await setScroll(0);
      await sleep(100);
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(300, 0);
      await sleep(400);
      const swiped = await measure();
      check(swiped.scrollLeft > 20, `${tag}: a sideways touchpad swipe scrolls the chips`, `${swiped.scrollLeft}px`);
    }

    // Halfway: both ends fade. At the end: only the start does. The cluster never moves.
    await setScroll(Math.round(start.max / 2));
    await sleep(250);
    const mid = await measure();
    check(mid.fadeStart && mid.fadeEnd, `${tag}: midway both ends fade`, JSON.stringify({ fadeStart: mid.fadeStart, fadeEnd: mid.fadeEnd }));
    await shot(page, tabId, `${prefix}-${tag}-narrow-mid`);
    await setScroll(start.max + 50);
    await sleep(250);
    const end = await measure();
    check(end.fadeStart && !end.fadeEnd, `${tag}: at the end only the start fades`, JSON.stringify({ fadeStart: end.fadeStart, fadeEnd: end.fadeEnd }));
    check(JSON.stringify(end.cluster) === JSON.stringify(start.cluster), `${tag}: scrolling does not move the right cluster`, `${JSON.stringify(start.cluster)} → ${JSON.stringify(end.cluster)}`);
    await shot(page, tabId, `${prefix}-${tag}-narrow-end`);

    // Each chip's popover opens whole while the chips are scrolled.
    for (const [sel, name] of [
      ["[data-manager-tasks-chip]", "tasks"],
      ["[data-activity-chip]", "activity"],
      ['[data-testid="session-changes-chip"]', "changes"],
      ['[data-testid="session-schedules-chip"]', "schedules"],
    ]) {
      await setScroll(Math.round(start.max / 2));
      await sleep(150);
      const chip = inFooter(page, tabId, sel);
      // A phone's changes chip gives way to the Tasks chip (`yieldNarrow`), so it is not there to press.
      if (!(await chip.isVisible())) { console.log(`  ${tag}: no ${name} chip shown at this width`); continue; }
      await chip.click();
      await sleep(450);
      const pop = await page.evaluate(({ r, phone }) => {
        const panel = phone ? [...document.querySelectorAll('[role="dialog"]')].find((d) => d.offsetParent) : document.querySelector(`${r} [data-footer-popover]`);
        if (!panel) return null;
        const b = panel.getBoundingClientRect();
        const row = document.querySelector(`${r} [data-chat-context-row]`);
        const el = row.querySelector(":scope > [data-footer-chips]") ?? row.firstElementChild;
        // Points across the panel: each must be the panel itself, not whatever the clip left showing.
        const pts = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9]].map(([fx, fy]) => [b.left + b.width * fx, b.top + b.height * fy]);
        const hits = pts.filter(([x, y]) => panel.contains(document.elementFromPoint(x, y))).length;
        const s = getComputedStyle(el);
        return { w: Math.round(b.width), h: Math.round(b.height), hits, of: pts.length, mask: s.maskImage || s.webkitMaskImage || "none", scrollerW: Math.round(el.clientWidth) };
      }, { r: root(tabId), phone });
      check(!!pop && pop.hits === pop.of && pop.h > 80, `${tag}: the ${name} popover opens whole while the chips are scrolled`, JSON.stringify(pop));
      if (!phone && pop) check(pop.mask === "none", `${tag}: no mask over an open ${name} popover`, pop.mask.slice(0, 40));
      await shot(page, tabId, `${prefix}-${tag}-narrow-${name}-open`);
      await closePop(page);
    }

    if (!phone) await narrow(page, tabId, 0);
  } catch (e) {
    check(false, `${tag}: chip overflow threw`, e.message.split("\n")[0]);
    await page.screenshot({ path: join(SHOTS, `${prefix}-${tag}-overflow-failure.png`) }).catch(() => {});
  } finally {
    refuse = false;
    state.extras = false;
    await setChildren(page, false).catch(() => {});
    await fetch(`${harness.api}/__instant-test/release`, { method: "POST" }).catch(() => {});
    await context.close();
  }
}

/**
 * A script schedule the chat's AI created is listed by this chat's schedules chip, through the
 * real `/api/schedules?session=` (nothing stubbed): a script delivers into no chat, so only
 * `created_by_session_id` links it. The row says Script and its Open hands it to the Schedules
 * window (a tab on a phone). `PPM_FOOTER_SHOT_PREFIX=before` photographs a build without the link.
 */
async function createdByChat(phone) {
  const tag = phone ? "phone-390" : "desktop-1440";
  const prefix = process.env.PPM_FOOTER_SHOT_PREFIX ?? "after";
  console.log(`\n== schedules created by the chat, ${tag}`);
  const { context, page, tabId } = await setupChat(phone, 1440);
  try {
    const res = await fetch(`${harness.api}/api/schedules`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "script", mode: "tick", name: "Hourly Nxsys sync", cron_expr: "0 3 * * *", project_path: harness.project,
        script: "export default async (ctx) => { ctx.log('tick'); }", enabled: true, created_by_session_id: state.sessionId,
      }),
    });
    const created = (await res.json()).data;
    check(res.status === 201 && !!created?.id, `${tag}: the chat's script schedule was created`, `${res.status} #${created?.id}`);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("schedules:changed")));
    const chip = inFooter(page, tabId, '[data-testid="session-schedules-chip"]');
    const listed = await until("the schedules chip", async () => (await chip.count()) > 0, { timeout: 6000 }).then(() => true, () => false);
    await shot(page, tabId, `${prefix}-${tag}-created-script`);
    check(listed, `${tag}: the chip lists the script schedule the chat created`);
    if (!listed) return;
    check((await chip.innerText()).includes("1"), `${tag}: the chip counts it`, await chip.innerText());
    await chip.click();
    const row = page.locator(`[data-session-schedule="${created.id}"]:visible`);
    await row.waitFor({ timeout: 6000 });
    check(await row.locator('[data-schedule-kind="script"]').isVisible(), `${tag}: the row says Script`);
    check((await row.innerText()).includes("Hourly Nxsys sync"), `${tag}: the row names it`);
    await sleep(350);
    await shot(page, tabId, `${prefix}-${tag}-created-script-open`);
    await row.locator('[data-testid="session-schedule-open"]').click();
    const opened = await until("the Schedules window on it", async () => (await page.locator(`[data-schedule-detail="${created.id}"]:visible, [data-schedule-row="${created.id}"]:visible, [data-schedule-card="${created.id}"]:visible`).count()) > 0, { timeout: 10000 }).then(() => true, () => false);
    check(opened, `${tag}: Open shows it in Schedules`);
    await sleep(400);
    await page.screenshot({ path: join(SHOTS, `${prefix}-${tag}-created-script-schedules.png`) });
    await fetch(`${harness.api}/api/schedules/${created.id}`, { method: "DELETE" }).catch(() => {});
  } catch (e) {
    check(false, `${tag}: scenario threw`, e.message.split("\n")[0]);
    await page.screenshot({ path: join(SHOTS, `${prefix}-${tag}-created-script-failure.png`) }).catch(() => {});
  } finally {
    await fetch(`${harness.api}/__instant-test/release`, { method: "POST" }).catch(() => {});
    await context.close();
  }
}

/** Under reduced motion nothing animates: the popover has no animation and chips do not scale. */
async function reducedMotion() {
  const context = await harness.browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  await context.addInitScript(instantInstrumentation, { api: harness.api, blockStorage: false });
  await stub(context);
  const page = await context.newPage();
  try {
    await bootProject(page, harness.web, PROJECT);
    await closeAllTabs(page);
    const { tabId } = await openChatTab(page, PROJECT);
    await inFooter(page, tabId, '[aria-label="More"]').click();
    await page.locator("[data-chat-more-menu]:visible").waitFor({ timeout: 10000 });
    const anim = await page.evaluate((r) => getComputedStyle(document.querySelector(`${r} [data-footer-popover]`)).animationName, root(tabId));
    check(anim === "none", "reduced motion: popover does not animate", anim);
    check(await inFooter(page, tabId, "[data-usage-divider]").count() === 0 && await inFooter(page, tabId, "[data-footer-cluster]").isVisible(),
      "no usage yet: the cluster has no divider before History");
    // A brand-new chat has no usage figure, so no ring: the menu's meters animate the same way.
    const meter = await page.locator("[data-chat-more-menu]:visible i").first().evaluate((el) => getComputedStyle(el).transitionProperty);
    check(meter === "none", "reduced motion: usage meters do not animate", meter);
  } finally {
    await context.close();
  }
}

try {
  const created = await fetch(`${harness.api}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }) });
  if (created.status >= 300) throw new Error(`project registration: ${created.status}`);
  const only = process.env.PPM_FOOTER_ONLY;
  console.log(`scratch servers: ${JSON.stringify(harness.pids())}`);
  if (only === "overflow") {
    await chipOverflow(false);
    await chipOverflow(true);
  } else if (only === "schedules") {
    await createdByChat(false);
    await createdByChat(true);
  } else {
    if (only !== "phone") await scenarios(false);
    if (only !== "desktop") await scenarios(true);
    if (!only) { await chipOverflow(false); await chipOverflow(true); await createdByChat(false); await createdByChat(true); await reducedMotion(); }
  }
} finally {
  await harness.browser.close().catch(() => {});
  await harness.cleanup();
}
console.log(`\nScreenshots: ${SHOTS}`);
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
