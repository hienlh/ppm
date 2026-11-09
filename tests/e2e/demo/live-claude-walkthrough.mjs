// Live walkthrough of session collaboration and turn references against a scratch PPM server that
// runs the REAL Claude provider (tests/e2e/demo/live-claude-server.ts). Records one video per
// scenario plus screenshots, and writes results.json. A walkthrough, not a test suite: every
// scenario records what it saw and goes on, so one stumble does not hide the rest.
//
//   L1 create_session behind the card (Allow for this session), linked bar + list badge, waited reply,
//      the child's from-session bubble
//   L2 a no-wait message to the child, the child's send_to_session back, the header jumping to it
//   L3 Copy turn link → paste into a new chat → chip → read_session_turns → chip opens the turn
//   L4 session_status
//   L5 Settings → Tools → Session collaboration
//   P  phone shots (390x844)
//   L3r (opt-in) turn refs alone: a one-turn chat, its link in a new chat, read_session_turns
// Every page load is timed into <out>/load-timings.json.
//
// Env: PPM_LIVE_URL (http://127.0.0.1:<port>), PPM_LIVE_PROJECT_PATH (scratch project folder),
// PPM_LIVE_OUT (media folder), PPM_PLAYWRIGHT_MODULE (playwright-core index.mjs),
// PPM_PLAYWRIGHT_CHANNEL (chrome | chromium), PPM_LIVE_SCENARIOS (e.g. "L3,L4"; default all).
// Ids are kept in <out>/state.json so a later run of some scenarios reuses the sessions made before.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createKit, pageInit, COMPOSER } from "../fixtures/session-turn-refs-helpers.mjs";
import { closeLinkedSessions, linkedSessionRow, openLinkedSessions } from "../fixtures/linked-sessions-panel-helpers.mjs";

const web = process.env.PPM_LIVE_URL;
const projectPath = process.env.PPM_LIVE_PROJECT_PATH;
const out = resolve(process.env.PPM_LIVE_OUT ?? "live-out");
if (!web || !projectPath) throw new Error("PPM_LIVE_URL and PPM_LIVE_PROJECT_PATH are required");
const PROJECT = "demo";
const only = (process.env.PPM_LIVE_SCENARIOS ?? "L1,L2,L3,L4,L5,P").split(",").map((s) => s.trim());
const VIEW = { width: 1280, height: 800 };
await mkdir(out, { recursive: true });

const statePath = join(out, "state.json");
const state = existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : {};
const saveState = () => writeFile(statePath, JSON.stringify(state, null, 2));
const resultsPath = join(out, "results.json");
const results = existsSync(resultsPath) ? JSON.parse(await readFile(resultsPath, "utf8")) : {};

let current = null;
const kit = createKit({ web, artifacts: out, currentPage: () => current });
const { until, api, post } = kit;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── helpers ──
async function newSession(title) {
  const created = await post(`/api/project/${PROJECT}/chat/sessions`, { providerId: "claude", title });
  const id = created.data.id;
  await fetch(`${web}/api/project/${PROJECT}/chat/sessions/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ title }),
  }).catch(() => {});
  return { id, providerId: "claude", title };
}

async function listed() {
  return (await api(`/api/project/${PROJECT}/chat/sessions?limit=200`)).data.sessions;
}

async function turnsOf(id) {
  return (await api(`/api/project/${PROJECT}/chat/sessions/${id}/turns?providerId=claude`)).data.turns;
}

/** Shows exactly these chats as tabs of one panel, the first one open. */
async function show(page, sessions) {
  const tabs = sessions.map((s) => ({
    id: `chat:${s.providerId}/${s.id}`, type: "chat", title: s.title, projectId: PROJECT, closable: true,
    metadata: { projectName: PROJECT, sessionId: s.id, providerId: s.providerId },
  }));
  await api(`/api/project/${PROJECT}/workspace`, { method: "PUT", body: JSON.stringify({ layout: {
    panels: { main: { id: "main", tabs, activeTabId: tabs[0].id, tabHistory: tabs.map((t) => t.id) } }, grid: [["main"]], focusedPanelId: "main",
  } }) });
  await page.evaluate((p) => localStorage.removeItem(`ppm-panels-${p}`), PROJECT).catch(() => {});
  // The composer is what the scenarios need, so do not hang on the window `load` event (it once
  // took over 30 s while a child session was cold-starting); log when it is that slow.
  // Every load is timed (DOM ready, load event, composer drawn) into <out>/load-timings.json.
  const started = Date.now();
  const timing = { at: new Date().toISOString(), tabs: sessions.map((s) => s.title) };
  loadTimings.push(timing);
  try {
    await page.goto(`${web}/project/${PROJECT}`, { waitUntil: "domcontentloaded" });
  } catch (e) {
    // A hung navigation: record what the browser was still waiting for, then try once more.
    timing.hang = await hangReport(page, started, e);
    log(`  navigation hung: ${JSON.stringify(timing.hang)}`);
    await writeFile(join(out, "load-timings.json"), JSON.stringify(loadTimings, null, 2));
    await page.screenshot({ path: join(out, `hang-${loadTimings.length}.png`), timeout: 5000 }).catch(() => {});
    const retried = Date.now();
    await page.goto(`${web}/project/${PROJECT}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    timing.retryDomReadyMs = Date.now() - retried;
  }
  timing.domReadyMs = Date.now() - started;
  page.waitForLoadState("load", { timeout: 60000 })
    .then(() => { timing.loadMs = Date.now() - started; if (timing.loadMs > 10000) log(`  slow load event: ${timing.loadMs} ms`); })
    .catch((e) => { timing.loadError = String(e).split("\n")[0].slice(0, 120); log(`  load event not seen: ${timing.loadError}`); });
  await page.locator(`${COMPOSER}:visible`).first().waitFor({ timeout: 30000 });
  timing.composerMs = Date.now() - started;
  timing.slowestResources = await page.evaluate(() => performance.getEntriesByType("resource")
    .sort((a, b) => b.duration - a.duration).slice(0, 5)
    .map((e) => `${Math.round(e.duration)} ms ${e.name.replace(location.origin, "")}`)).catch(() => []);
  log(`  page load: dom ${timing.domReadyMs} ms, composer ${timing.composerMs} ms; slowest: ${timing.slowestResources[0] ?? "-"}`);
  await writeFile(join(out, "load-timings.json"), JSON.stringify(loadTimings, null, 2));
  await page.waitForTimeout(1200);
}
const loadTimings = [];

/** Every request a page has started and not finished, with when it started; set up per page. */
function trackRequests(page) {
  const inflight = new Map();
  const events = [];
  const note = (kind, req) => { events.push(`${Date.now()} ${kind} ${req.resourceType()} ${req.url().replace(web, "")}`); if (events.length > 200) events.shift(); };
  page.on("request", (req) => { inflight.set(req, Date.now()); note("start", req); });
  page.on("requestfinished", (req) => { inflight.delete(req); note("done", req); });
  page.on("requestfailed", (req) => { inflight.delete(req); note(`failed(${req.failure()?.errorText})`, req); });
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) events.push(`${Date.now()} navigated ${f.url().replace(web, "")}`); });
  page.__requests = { inflight, events };
}

/** What a hung navigation was waiting for: pending requests, the last network events, page state. */
async function hangReport(page, started, error) {
  const now = Date.now();
  const { inflight, events } = page.__requests ?? { inflight: new Map(), events: [] };
  const pending = [...inflight].map(([req, at]) => `${now - at} ms ${req.resourceType()} ${req.method()} ${req.url().replace(web, "")}`);
  const recent = events.filter((line) => Number(line.split(" ")[0]) >= started - 2000)
    .map((line) => { const [t, ...rest] = line.split(" "); return `+${Number(t) - started} ${rest.join(" ")}`; });
  const state = await Promise.race([
    page.evaluate(() => ({ url: location.href, readyState: document.readyState, bodyChildren: document.body?.children.length ?? -1 })),
    new Promise((r) => setTimeout(() => r("evaluate did not answer in 3 s"), 3000)),
  ]).catch((e) => `evaluate failed: ${String(e).slice(0, 120)}`);
  return { afterMs: now - started, error: String(error).split("\n")[0].slice(0, 160), pending, recent: recent.slice(-40), state };
}

async function send(page, text) {
  const box = page.locator(`${COMPOSER}:visible`).first();
  await box.click();
  await box.fill(text);
  await page.waitForTimeout(400);
  await box.press("Enter");
}

/** The open chat's turn is over: no Stop button for a few seconds in a row. */
async function waitIdle(page, timeout = 300000) {
  let quiet = 0;
  await until("turn idle", async () => {
    const running = await page.getByRole("button", { name: "Stop response" }).count();
    quiet = running ? 0 : quiet + 1;
    return quiet >= 4;
  }, timeout, 1000);
}

const shot = async (page, name, opts = {}) => {
  await page.screenshot({ path: join(out, `${name}.png`), ...opts });
  log(`  shot ${name}.png`);
};

let browser;
async function withContext(name, options, fn) {
  const videoDir = join(out, "_video", name);
  await rm(videoDir, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: VIEW, serviceWorkers: "block", recordVideo: { dir: videoDir, size: options.viewport ?? VIEW }, ...options });
  await context.addInitScript(pageInit);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const page = current = await context.newPage();
  trackRequests(page);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const notes = [];
  const record = { name, ok: true, notes, startedAt: new Date().toISOString() };
  try {
    await fn(page, notes);
  } catch (e) {
    record.ok = false;
    record.error = String(e?.stack ?? e);
    log(`FAIL ${name}: ${record.error}`);
    try { await shot(page, `${name}-FAIL`); } catch { /* page gone */ }
  } finally {
    record.pageErrors = pageErrors.filter((e) => !/serviceWorker/.test(e));
    record.endedAt = new Date().toISOString();
    await context.close();
    const files = existsSync(videoDir) ? await readdir(videoDir) : [];
    const webm = files.find((f) => f.endsWith(".webm"));
    if (webm) { await rename(join(videoDir, webm), join(out, `${name}.webm`)); record.video = `${name}.webm`; }
    await rm(videoDir, { recursive: true, force: true });
    results[name] = record;
    await writeFile(resultsPath, JSON.stringify(results, null, 2));
    log(`${record.ok ? "DONE" : "FAILED"} ${name}${notes.length ? `: ${notes.join(" | ")}` : ""}`);
  }
}

// ── setup ──
await until("server healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000, 500);
const projects = (await api("/api/projects")).data ?? [];
if (!projects.some?.((p) => p.name === PROJECT)) await post("/api/projects", { name: PROJECT, path: projectPath });
if (!state.A) { state.A = await newSession("Điều phối"); await saveState(); }
const A = state.A;

const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
const channel = process.env.PPM_PLAYWRIGHT_CHANNEL ?? "chrome";
browser = await pw.chromium.launch({ headless: true, channel });

try {
  // ── L1 ──
  if (only.includes("L1")) await withContext("L1-create-session", {}, async (page, notes) => {
    await show(page, [A]);
    await shot(page, "L1-00-chat-A-empty");
    await send(page, 'Hãy dùng tool create_session để tạo một session mới tên "Đếm file TS" với nhiệm vụ: đếm số file .ts trong thư mục src của project này (kể cả thư mục con), rồi trả lời lại cho bạn kết quả bằng send_to_session. Dùng wait: true để chờ câu trả lời, sau đó báo lại cho tôi con số.');
    const card = page.locator('[data-collab-approval="create"]:visible').first();
    await card.waitFor({ timeout: 240000 });
    await page.waitForTimeout(800);
    await shot(page, "L1-01-approval-card");
    notes.push(`card: ${(await card.innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
    await card.getByRole("button", { name: "Allow for this session" }).click();
    await card.waitFor({ state: "detached", timeout: 20000 });

    const B = await until("child in the list", async () => (await listed()).find((s) => s.spawnedBy === A.id), 60000, 1000);
    state.B = { id: B.id, providerId: B.providerId ?? "claude", title: B.title };
    await saveState();
    notes.push(`child "${B.title}" (${B.id}) spawnedBy=${B.spawnedBy} parentTitle=${B.parentTitle}`);

    const row = await linkedSessionRow(page, B.id, { timeout: 30000 });
    await row.waitFor({ timeout: 30000 });
    notes.push(`Sessions tab row: ${(await row.innerText()).replace(/\s+/g, " ")}`);
    await closeLinkedSessions(page);
    const badge = page.locator(`[data-spawned-badge="${A.id}"]:visible`).first();
    try {
      await badge.waitFor({ timeout: 20000 });
      await badge.hover();
      const tip = page.getByRole("tooltip").first();
      await tip.waitFor({ timeout: 5000 });
      notes.push(`badge tooltip: ${(await tip.innerText()).trim()}`);
    } catch (e) { notes.push(`badge not seen: ${String(e).slice(0, 120)}`); }
    await shot(page, "L1-02-linked-bar-and-badge");
    const waiting = page.locator('[data-session-collab-card="create_session"]:visible').first();
    await waiting.waitFor({ timeout: 20000 });
    await shot(page, "L1-03-tool-card-waiting");

    // The child, while it works: its first message is a from-session bubble.
    await show(page, [state.B, A]);
    const bubble = page.locator(`[data-from-session="${A.id}"]:visible`).first();
    await bubble.waitFor({ timeout: 30000 });
    notes.push(`child header: ${(await bubble.locator("button").first().innerText()).replace(/\s+/g, " ")}`);
    await shot(page, "L1-04-child-from-session-bubble");
    await waitIdle(page, 300000);
    await shot(page, "L1-05-child-done");

    await show(page, [A, state.B]);
    const reply = page.locator('[data-session-collab-card="create_session"]:visible [data-collab-reply]').first();
    await reply.waitFor({ timeout: 300000 });
    await waitIdle(page, 300000);
    notes.push(`reply on A's card: ${(await reply.innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
    await page.locator('[data-session-collab-card="create_session"]:visible button[aria-expanded]').first().click().catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, "L1-06-tool-card-reply");
  });

  // ── L1b (opt-in): L1's shots after the child exists, from the sessions L1 already made ──
  // No message is sent, so no Claude usage; for when L1 stopped after creating the child.
  if (only.includes("L1b")) await withContext("L1b-child-and-reply", {}, async (page, notes) => {
    if (!state.B) throw new Error("L1 made no child");
    await show(page, [state.B, A]);
    const bubble = page.locator(`[data-from-session="${A.id}"]:visible`).first();
    await bubble.waitFor({ timeout: 30000 });
    await bubble.scrollIntoViewIfNeeded();
    notes.push(`child header: ${(await bubble.locator("button").first().innerText()).replace(/\s+/g, " ")}`);
    await shot(page, "L1-04-child-from-session-bubble");
    await show(page, [A, state.B]);
    const card = page.locator('[data-session-collab-card="create_session"]:visible').first();
    await card.waitFor({ timeout: 30000 });
    await card.scrollIntoViewIfNeeded();
    const reply = card.locator("[data-collab-reply]").first();
    notes.push(`reply on A's card: ${(await reply.count()) ? (await reply.innerText()).replace(/\s+/g, " ").slice(0, 200) : "none"}`);
    await card.locator("button[aria-expanded]").first().click().catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, "L1-06-tool-card-reply");
  });

  // ── L2 ──
  if (only.includes("L2")) await withContext("L2-send-no-wait", {}, async (page, notes) => {
    const B = state.B;
    if (!B) throw new Error("L1 made no child");
    await show(page, [A, B]);
    const before = (await listed()).length;
    await send(page, `Dùng send_to_session gửi tới session "${B.title}" (id ${B.id}) với wait: false, hỏi thêm: "File .ts nào dài nhất (bao nhiêu dòng)? Trả lời lại tôi bằng send_to_session." Gửi xong thì kết thúc lượt, đừng chờ.`);
    const sent = page.locator('[data-session-collab-card="send_to_session"]:visible').first();
    await sent.waitFor({ timeout: 240000 });
    await waitIdle(page, 240000);
    await shot(page, "L2-01-A-sent-no-wait");

    await show(page, [B, A]);
    await until("second from-session bubble in the child", async () => (await page.locator(`[data-from-session="${A.id}"]`).count()) >= 2, 60000, 1000);
    await page.locator(`[data-from-session="${A.id}"]`).last().scrollIntoViewIfNeeded();
    await shot(page, "L2-02-child-received");
    await page.locator('[data-session-collab-card="send_to_session"]:visible').first().waitFor({ timeout: 300000 });
    await waitIdle(page, 300000);
    await shot(page, "L2-03-child-replied");

    await show(page, [A, B]);
    const incoming = page.locator(`[data-from-session="${B.id}"]:visible`).last();
    await incoming.waitFor({ timeout: 120000 });
    await incoming.scrollIntoViewIfNeeded();
    notes.push(`incoming header: ${(await incoming.locator("button").first().innerText()).replace(/\s+/g, " ")}`);
    await shot(page, "L2-04-A-incoming-bubble");
    await waitIdle(page, 300000);
    await incoming.locator("button").first().click();
    await page.waitForTimeout(3000);
    const bTurns = await turnsOf(B.id).catch(() => []);
    notes.push(`child turns: ${bTurns.length}; history window open: ${await page.locator("[data-history-window]:visible").count()}`);
    await shot(page, "L2-05-header-jumped-to-child-turn");
    notes.push(`sessions listed before/after: ${before}/${(await listed()).length}`);
  });

  // ── L3 ──
  if (only.includes("L3")) await withContext("L3-turn-refs", {}, async (page, notes) => {
    const turns = await turnsOf(A.id);
    if (!turns.length) throw new Error("A has no turns");
    const target = turns[0];
    state.refTurn = target.turnId; await saveState();
    notes.push(`A turn ${target.turnId}: ${String(target.prompt ?? "").slice(0, 60)}`);
    await show(page, [A]);
    const row = page.locator(`[data-turn-start="${target.turnId}"]:visible`).first();
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await page.waitForTimeout(500);
    await shot(page, "L3-01-copy-turn-link-button");
    await row.getByRole("button", { name: /Copy turn link|Link ready/ }).click();
    const link = await until("link copied", async () => (await kit.copied(page)).at(-1), 15000);
    notes.push(`link: ${link}`);

    if (!state.C) { state.C = await newSession("Tóm tắt"); await saveState(); }
    await show(page, [state.C, A]);
    const box = page.locator(`${COMPOSER}:visible`).first();
    await kit.paste(box, link);
    await until("ready chip", async () => (await page.locator('[data-composer-turn-refs] [data-turn-chip="ready"]').count()) >= 1, 20000);
    notes.push(`chip: ${(await page.locator('[data-composer-turn-refs] [data-turn-chip="ready"]').first().innerText()).replace(/\s+/g, " ")}`);
    await shot(page, "L3-02-chip-in-composer");
    await send(page, "Tóm tắt lượt này");
    await waitIdle(page, 300000);
    const toolText = await page.locator("text=/read_session_turns/").count();
    notes.push(`read_session_turns mentions on screen: ${toolText}`);
    await shot(page, "L3-03-B-answered");

    const sentChip = page.locator('[data-turn-refs] [data-turn-chip="ready"]:visible').last();
    await sentChip.click();
    await page.waitForTimeout(3500);
    const at = await kit.offsetOf(page, target.turnId).catch(() => null);
    notes.push(`after chip click: ${JSON.stringify(at)}`);
    await shot(page, "L3-04-chip-opened-A-at-turn");
  });

  // ── L3r (opt-in): turn refs on their own, from a fresh one-turn chat ──
  // A answers one small question; its turn link goes to a new chat, whose AI has to read the turn
  // with read_session_turns (the reference carries no content of its own) to summarise it.
  if (only.includes("L3r")) await withContext("L3r-turn-refs", {}, async (page, notes) => {
    await show(page, [A]);
    await send(page, "Trong thư mục src có những file .ts nào? Liệt kê ngắn gọn kèm số dòng của mỗi file.");
    await waitIdle(page, 240000);
    const turns = await turnsOf(A.id);
    if (!turns.length) throw new Error("A has no turns");
    const target = turns.at(-1);
    state.refTurnL3r = target.turnId; await saveState();
    notes.push(`A turn ${target.turnId}`);
    await shot(page, "L3r-01-A-answered");
    await show(page, [A]);
    const row = page.locator(`[data-turn-start="${target.turnId}"]:visible`).first();
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await page.waitForTimeout(500);
    await row.getByRole("button", { name: /Copy turn link|Link ready/ }).click();
    const link = await until("link copied", async () => (await kit.copied(page)).at(-1), 15000);
    notes.push(`link: ${link}`);
    await shot(page, "L3r-02-copy-turn-link");

    if (!state.B3r) { state.B3r = await newSession("Tóm tắt lượt"); await saveState(); }
    await show(page, [state.B3r, A]);
    const box = page.locator(`${COMPOSER}:visible`).first();
    await kit.paste(box, link);
    await until("ready chip", async () => (await page.locator('[data-composer-turn-refs] [data-turn-chip="ready"]').count()) >= 1, 20000);
    notes.push(`chip: ${(await page.locator('[data-composer-turn-refs] [data-turn-chip="ready"]').first().innerText()).replace(/\s+/g, " ")}`);
    await shot(page, "L3r-03-chip-in-composer");
    await send(page, "Tóm tắt lượt này");
    await waitIdle(page, 300000);
    // Whether the AI read the turn is checked in its transcript; the screen only says a card exists.
    const calls = await page.locator("text=/read_session_turns/").count();
    notes.push(`read_session_turns on screen: ${calls}`);
    await shot(page, "L3r-04-B-read-and-summarised");

    const sentChip = page.locator('[data-turn-refs] [data-turn-chip="ready"]:visible').last();
    await sentChip.click();
    await page.waitForTimeout(3500);
    notes.push(`after chip click: ${JSON.stringify(await kit.offsetOf(page, target.turnId).catch(() => null))}`);
    await shot(page, "L3r-05-chip-opened-A-at-turn");
  });

  // ── L4 ──
  if (only.includes("L4")) await withContext("L4-session-status", {}, async (page, notes) => {
    await show(page, [A]);
    await send(page, "Trạng thái các session liên quan? Dùng tool session_status.");
    const card = page.locator('[data-session-collab-card="session_status"]:visible').last();
    await card.waitFor({ timeout: 240000 });
    await waitIdle(page, 240000);
    await card.locator("button[aria-expanded]").first().click().catch(() => {});
    await page.waitForTimeout(600);
    await card.scrollIntoViewIfNeeded();
    notes.push(`status card: ${(await card.innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
    await shot(page, "L4-01-session-status-card");
  });

  // ── L5 ──
  if (only.includes("L5")) await withContext("L5-settings-tools", {}, async (page, notes) => {
    await show(page, [A]);
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("button", { name: "Tools", exact: true }).first().click();
    const sw = page.getByRole("switch", { name: /create_session/ });
    await sw.waitFor({ timeout: 15000 });
    await page.locator("text=Session collaboration").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(800);
    notes.push(`create_session switch: ${await sw.getAttribute("aria-checked")}`);
    await shot(page, "L5-01-settings-session-collaboration");
    await page.getByRole("switch", { name: /Ask before creating sessions/ }).scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, "L5-02-settings-session-collaboration-limits");
  });

  // ── Phone ──
  if (only.includes("P")) await withContext("P-phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, async (page, notes) => {
    if (state.B) {
      await show(page, [state.B]);
      await page.locator(`[data-from-session="${A.id}"]:visible`).first().waitFor({ timeout: 30000 });
      await shot(page, "P-01-phone-child-bubble");
    }
    await show(page, [A]);
    // On a phone the activity chip shows numbers only; its sheet's Sessions tab lists the sessions.
    const chip = page.locator("[data-activity-chip]:visible").first();
    await chip.waitFor({ timeout: 15000 });
    notes.push(`activity chip: ${(await chip.innerText()).replace(/\s+/g, " ")}`);
    await openLinkedSessions(page);
    await page.waitForTimeout(600);
    await shot(page, "P-02-phone-sessions-sheet");
    await closeLinkedSessions(page);
  });
} finally {
  await browser.close();
  await saveState();
  await writeFile(join(out, "load-timings.json"), JSON.stringify(loadTimings, null, 2));
  log(`results in ${resultsPath}`);
}
