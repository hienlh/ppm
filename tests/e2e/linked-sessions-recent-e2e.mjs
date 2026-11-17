/**
 * The activity chip's Sessions list, ordered by each linked session's latest interaction with
 * this chat and filterable once long, checked and photographed in a real browser against an
 * isolated stack (scratch PPM_HOME, scripted mock providers, Vite) — desktop popover and phone
 * bottom sheet, with a long list (filter shown) and a short one (no filter).
 *
 * The linked sessions are stubbed at the network edge: the session list (creator and children,
 * each with its creation time) and the links route (each with `lastInteractionAt`). What each is
 * doing is set in the page's own stores, which is what `/ws/global` would do.
 *
 *   PPM_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs PPM_LINKED_SHOTS=<dir> node tests/e2e/linked-sessions-recent-e2e.mjs
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { bootProject, closeAllTabs, instantInstrumentation, openChatTab, until } from "./fixtures/new-chat-instant-helpers.mjs";

const PROJECT = "ppm-linked";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/chat-footer-server.ts" });
const SHOTS = resolve(process.env.PPM_LINKED_SHOTS ?? join(harness.artifacts, "linked-sessions-recent"));
await mkdir(SHOTS, { recursive: true });

// ---------------------------------------------------------------- stubbed sessions
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const id = (n) => `11110000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PARENT = id(1);
/** [id, title, relation, created ago, last interaction ago (null: only the creation is known), status] */
const LINKED = [
  [id(10), "PSR correction Ireland: tự động hoá báo cáo", "child", 26 * HOUR, 4 * MIN, "running"],
  [id(11), "QL Review PR", "child", 3 * DAY, 40 * MIN, "running"],
  [id(12), "NX-6587 Employment Allowance", "child", 2 * DAY, 2 * HOUR, "new_message"],
  [id(13), "Brainstorm: GI Group Ireland", "child", 5 * DAY, null, "idle"],
  // Waits on the person, with an older interaction than most: pinned to the top of its group anyway.
  [id(14), "QL Release staging", "child", 20 * HOUR, 6 * HOUR, "needs_approval"],
  [id(15), "Reset password: BE tự động gửi mail", "child", 9 * DAY, null, "idle"],
  [id(16), "NX-6687 debug: Conaty không xuất được P60", "child", 7 * HOUR, 7 * HOUR, "new_message"],
  [id(17), "Deploy staging NX-6690", "child", 12 * DAY, 30 * MIN, "idle"],
  [id(20), "QL PPM", "messaged", 30 * DAY, 15 * MIN, "idle"],
  [id(21), "NX-6612 pension auto-enrolment", "messaged", 6 * DAY, 3 * HOUR, "idle"],
  [id(22), "Docs: payroll FAQ", "messaged", 10 * DAY, 2 * DAY, "idle"],
  [id(23), "Slack digest", "messaged", 40 * DAY, 20 * DAY, "idle"],
];
const FEW = new Set([id(10), id(11), id(12), id(13), id(20)]);
const state = { sessionId: null, many: true, now: Date.now() };
const linked = () => LINKED.filter(([sid]) => state.many || FEW.has(sid));
const iso = (ago) => new Date(state.now - ago).toISOString();
const ok = (data) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });

async function stub(context) {
  await context.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname, m = route.request().method();
    if (/\/chat\/sessions\/[^/]+\/links$/.test(p) && state.sessionId) {
      return route.fulfill(ok([
        { sessionId: PARENT, relations: ["parent"], lastInteractionAt: state.now - 10 * MIN },
        ...linked().map(([sid, , relation, , ago]) => ({ sessionId: sid, relations: [relation], ...(ago == null ? {} : { lastInteractionAt: state.now - ago }) })),
      ]));
    }
    if (/\/chat\/sessions$/.test(p) && m === "GET" && state.sessionId) {
      const res = await route.fetch();
      const body = await res.json();
      const list = body.data?.sessions ?? [];
      for (const s of list) if (s.id === state.sessionId) { s.spawnedBy = PARENT; s.parentTitle = "QL Nxsys"; s.createdAt = iso(5 * DAY); }
      list.push({ id: PARENT, providerId: "claude", title: "QL Nxsys", createdAt: iso(60 * DAY), spawnedBy: null, parentTitle: null });
      for (const [sid, title, relation, created] of linked()) {
        list.push({ id: sid, providerId: relation === "messaged" && sid === id(21) ? "codex" : "claude", title, createdAt: iso(created),
          spawnedBy: relation === "child" ? state.sessionId : null, parentTitle: null });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    return route.fallback();
  });
}

// ---------------------------------------------------------------- page helpers
async function newPage(phone) {
  const context = await harness.browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await stub(context);
  await context.addInitScript(instantInstrumentation, { api: harness.api, blockStorage: false });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));
  page.on("console", (msg) => { if (msg.type() === "error" && !/ws\/extensions|ERR_CONNECTION_REFUSED|status of 40[34]/.test(msg.text())) console.log(`  console.error: ${msg.text().slice(0, 300)}`); });
  return { context, page };
}
const root = (tabId) => `[data-tab-pool-id="${tabId}"]`;

async function setupChat(phone) {
  const { context, page } = await newPage(phone);
  await bootProject(page, harness.web, PROJECT);
  await closeAllTabs(page);
  const { tabId } = await openChatTab(page, PROJECT);
  const box = page.locator(`${root(tabId)} textarea:visible`).first();
  await box.waitFor({ timeout: 20000 });
  await box.click();
  await page.keyboard.type("first message");
  await page.keyboard.press("Enter");
  state.sessionId = await until("the session id", () => page.evaluate(async (tid) => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    const tab = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.id === tid);
    return tab?.metadata?.sessionId ?? null;
  }, tabId), { timeout: 20000 });
  await until("the turn to finish", () => page.locator(`${root(tabId)} [aria-label="Send message"]`).first().isVisible(), { timeout: 20000 });
  return { context, page, tabId };
}

/** Re-reads the session list and the links (as opening the chat does), then sets what each is doing. */
async function loadLinks(page) {
  state.now = Date.now();
  await page.evaluate(async ({ sid, rows, project }) => {
    const { useSessionListStore } = await import("/stores/session-list-store.ts");
    const { useProjectStore } = await import("/stores/project-store.ts");
    const { useSessionCollabStore } = await import("/stores/session-collab-store.ts");
    const { useStreamingStore } = await import("/stores/streaming-store.ts");
    const { useNotificationStore } = await import("/stores/notification-store.ts");
    const { fetchSessionLinks } = await import("/lib/session-collab-client.ts");
    const p = useProjectStore.getState().activeProject;
    useSessionCollabStore.setState({ links: {}, interactedAt: {} });
    await useSessionListStore.getState().sync({ name: p.name, path: p.path });
    useSessionCollabStore.getState().seedLinks(sid, await fetchSessionLinks(p.name, sid));
    const sessions = new Map();
    const notifications = new Map();
    const pendingApprovals = {};
    for (const [rid, status] of rows) {
      if (status === "running") sessions.set(rid, project);
      if (status === "new_message") notifications.set(rid, { count: 1, type: "done", projectName: project });
      if (status === "needs_approval") pendingApprovals[rid] = `r-${rid}`;
    }
    useStreamingStore.setState({ sessions });
    useNotificationStore.setState({ notifications });
    useSessionCollabStore.setState({ pendingApprovals });
  }, { sid: state.sessionId, rows: linked().map(([rid, , , , , status]) => [rid, status]), project: PROJECT });
  await sleep(400);
}

async function openSessions(page, tabId) {
  await page.locator(`${root(tabId)} [data-chat-footer] [data-activity-chip]`).first().click();
  await sleep(250);
  const tab = page.locator('[data-activity-tab="sessions"]:visible');
  if (await tab.count()) await tab.click();
  await page.locator("[data-linked-sessions-panel]:visible").waitFor({ timeout: 5000 });
  await sleep(350);
}
const closePop = async (page) => {
  if (page.viewportSize().width < 768) await page.mouse.click(page.viewportSize().width / 2, 105);
  else await page.keyboard.press("Escape");
  await sleep(300);
};
const shot = async (page, tabId, name) => {
  await page.mouse.move(5, 5);
  await sleep(200);
  const vp = page.viewportSize();
  if (vp.width < 768) {
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  } else {
    const footer = await page.locator(`${root(tabId)} [data-chat-footer]`).boundingBox();
    const pop = await page.locator("[data-footer-popover]:visible").first().boundingBox();
    const top = Math.max(0, Math.min(footer.y, pop?.y ?? footer.y) - 16);
    const left = Math.max(0, Math.min(footer.x, pop?.x ?? footer.x) - 16);
    const right = Math.min(vp.width, Math.max(pop ? pop.x + pop.width : 0, left + 720) + 16);
    await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: left, y: top, width: right - left, height: footer.y + footer.height + 8 - top } });
  }
  console.log(`  shot ${name}.png`);
};

/** The rows as shown: title, status word, time, per group heading. */
const rows = (page) => page.evaluate(() => {
  const panel = [...document.querySelectorAll("[data-linked-sessions-panel]")].find((el) => el.getClientRects().length);
  const out = [];
  for (const el of panel.querySelectorAll("[data-linked-session]")) {
    if (el.closest("[data-unlinked-toggle]") || !el.getClientRects().length) continue;
    out.push({ title: el.querySelector("button")?.getAttribute("title"), time: el.querySelector("[data-linked-interaction]")?.textContent ?? null });
  }
  return out;
});
/**
 * A group's titles: what waits on the person first, then newest interaction first (a child's
 * creation counts, a messaged one has only the server's time).
 */
const titlesOf = (relation) => LINKED.filter(([sid, , r]) => r === relation && (state.many || FEW.has(sid)))
  .map(([, title, r, created, ago, status]) => ({ title, pin: status === "needs_approval" ? 0 : 1, ago: Math.min(r === "child" ? created : Infinity, ago ?? Infinity) }))
  .sort((a, b) => a.pin - b.pin || a.ago - b.ago).map((g) => g.title);

// ---------------------------------------------------------------- run
try {
  const created = await fetch(`${harness.api}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }) });
  if (created.status >= 300) throw new Error(`project registration: ${created.status}`);
  for (const phone of [false, true]) {
    const tag = phone ? "390" : "1440";
    const { context, page, tabId } = await setupChat(phone);
    try {
      state.many = true;
      await loadLinks(page);
      await openSessions(page, tabId);
      const shown = await rows(page);
      const expected = ["QL Nxsys", ...titlesOf("child"), ...titlesOf("messaged")];
      check(JSON.stringify(shown.map((r) => r.title)) === JSON.stringify(expected), `${tag}: each group lists the latest interaction first`, shown.map((r) => r.title).join(" | "));
      const time = (t) => shown.find((r) => r.title === t)?.time;
      check(time("PSR correction Ireland: tự động hoá báo cáo") === "4m ago", `${tag}: a row says how long ago`, time("PSR correction Ireland: tự động hoá báo cáo"));
      const children = shown.map((r) => r.title).slice(1, 1 + titlesOf("child").length);
      check(children[0] === "QL Release staging" && time("QL Release staging") === "6h ago",
        `${tag}: "Needs you" heads its group though its interaction is older`, `${children[0]}, ${time("QL Release staging")}`);
      check(time("Brainstorm: GI Group Ireland") === "5d ago", `${tag}: a child with no later interaction shows its creation`, time("Brainstorm: GI Group Ireland"));
      check(time("NX-6612 pension auto-enrolment") === "3h ago", `${tag}: a messaged session shows the server's time`, time("NX-6612 pension auto-enrolment"));
      check(await page.locator("[data-linked-filter]:visible").count() === 1, `${tag}: a filter past eight rows`);
      if (!phone) {
        // Only the list scrolls: it grows to min(60vh, 30rem) and gives way to the popover's own cap,
        // while the filter and the foot stay whole inside the popover.
        const m = await page.evaluate(() => {
          const vis = (sel) => [...document.querySelectorAll(sel)].find((el) => el.getClientRects().length);
          const box = (el) => el?.getBoundingClientRect();
          const list = vis("[data-linked-list]");
          const pop = box(vis("[data-footer-popover]"));
          const filter = box(vis("[data-linked-filter]")?.closest("label"));
          const foot = box(vis("[data-unlink-finished]")?.parentElement);
          return {
            list: Math.round(box(list).height), scrolls: list.scrollHeight > list.clientHeight, maxHeight: getComputedStyle(list).maxHeight,
            inside: !!pop && [filter, foot].every((b) => b && b.top >= pop.top - 0.5 && b.bottom <= pop.bottom + 0.5), pop: Math.round(pop.height),
            vh: innerHeight,
          };
        });
        const cap = Math.min(0.6 * m.vh, 480);
        check(m.list > 256 && m.list <= cap + 0.5, `${tag}: the list is taller than before and within min(60vh, 30rem)`, `list ${m.list}px, cap ${cap}px, max-height ${m.maxHeight}, popover ${m.pop}px`);
        check(m.scrolls, `${tag}: the list scrolls inside`);
        check(m.inside, `${tag}: the filter and the foot stay whole inside the popover`);
      }
      await shot(page, tabId, `${tag}-long-list`);

      await page.locator("[data-linked-filter]:visible").fill("nx");
      await sleep(250);
      const filtered = (await rows(page)).map((r) => r.title);
      check(JSON.stringify(filtered) === JSON.stringify(expected.filter((t) => t.toLowerCase().includes("nx"))),
        `${tag}: the filter narrows by name and keeps the order`, filtered.join(" | "));
      await shot(page, tabId, `${tag}-filtered`);
      await page.locator("[data-linked-filter]:visible").fill("tu dong");
      await sleep(250);
      const accentless = (await rows(page)).map((r) => r.title);
      check(accentless.length === 2 && accentless.every((t) => t.includes("tự động")), `${tag}: the filter ignores accents`, accentless.join(" | "));
      await closePop(page);

      state.many = false;
      await loadLinks(page);
      await openSessions(page, tabId);
      check(await page.locator("[data-linked-filter]:visible").count() === 0, `${tag}: no filter on a short list`);
      const few = (await rows(page)).map((r) => r.title);
      check(JSON.stringify(few) === JSON.stringify(["QL Nxsys", ...titlesOf("child"), ...titlesOf("messaged")]), `${tag}: a short list is ordered the same way`, few.join(" | "));
      await shot(page, tabId, `${tag}-short-list`);
      await closePop(page);
    } finally {
      await context.close();
    }
  }
} catch (e) {
  failures++;
  console.log(`FAIL run aborted — ${e?.stack ?? e}`);
} finally {
  await harness.browser.close().catch(() => {});
  await harness.cleanup();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
console.log(`shots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
