// Shared helpers of tests/e2e/ppm-tasks-e2e.mjs: the fixture's routes, PPM's task routes, the
// browser pages (a 1440 desktop, a 390 phone, a Telegram frame) and, in video mode, the scenes:
// each opens on a caption card drawn over the page and is cut out of the page's recording later.
import assert from "node:assert/strict";
import { until, sleep } from "../assistant-telegram/harness.mjs";

export { until, sleep };

const ONBOARDING_DONE = JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null });

/** Everything a step needs, built once by the runner. */
export function tasksKit({ web, fx, tg, browser, shotsDir, videoDir, owner, record }) {
  const data = async (path, init) => (await fx.api(path, init)).data;
  /** Every page opened, with when its recording started and the scenes it holds. */
  const pages = [];
  const errors = [];
  const contexts = [];
  let current = null;

  async function newPage(kind, options) {
    const context = await browser.newContext({
      serviceWorkers: "block", ...options,
      ...(videoDir ? { recordVideo: { dir: `${videoDir}/raw`, size: options.viewport } } : {}),
    });
    contexts.push(context);
    await context.addInitScript((onboarding) => {
      if (window.top !== window) return;
      localStorage.setItem("ppm-onboarding-v1", onboarding);
    }, ONBOARDING_DONE);
    const page = await context.newPage();
    const entry = { page, kind, startedAt: Date.now(), scenes: [] };
    pages.push(entry);
    page.on("pageerror", (e) => errors.push(`${kind}: ${e}\n${e.stack ?? ""}`));
    return entry;
  }

  const kit = {
    web, fx, tg, owner, record, video: !!videoDir,
    get page() { return current.page; },
    pageErrors: () => errors,

    // ── PPM's own routes ──────────────────────────────────────────────────────────────────────
    tasks: async (project = "all", query = "") => (await data(`/api/tasks?project=${encodeURIComponent(project)}&closed=1${query}`)).tasks,
    task: async (id) => (await data(`/api/tasks/${id}`)).task,
    taskByTitle: async (title) => {
      const t = (await kit.tasks()).find((x) => x.title === title);
      assert(t, `a task titled "${title}"`);
      return t;
    },
    history: async (id) => data(`/api/tasks/${id}/history`),
    createTask: async (body) => (await data("/api/tasks", { method: "POST", body: JSON.stringify(body) })).task,
    patch: (id, body) => fx.call(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    settings: (project) => data(`/api/tasks/projects/${project}/settings`),
    saveSettings: (project, body) => data(`/api/tasks/projects/${project}/settings`, { method: "PUT", body: JSON.stringify(body) }),
    cards: async (query = "") => (await data(`/api/assistant/cards${query}`)).cards,
    async cardOf(kind, title, timeout = 30000) {
      return until(`a ${kind} card "${title}"`, async () => (await kit.cards()).find((c) => c.kind === kind && c.title.includes(title)), timeout);
    },

    // ── The scripted chats ────────────────────────────────────────────────────────────────────
    turnsIn: async (sessionId) => (await fx.state()).turns.filter((t) => t.sessionId === sessionId),
    script: (label, ops, opts = {}) => fx.api("/__assistant-test/script", { method: "POST", body: JSON.stringify({ label, ops, ...opts }) }),
    say: (project, sessionId, text) => fx.post("/__assistant-test/say", { project, sessionId, text }),
    /** A turn typed into a chat, whose ops call the session server's tools (`ppm_task_*` among them). */
    async chatTurn(project, sessionId, label, ops, text) {
      await kit.script(label, ops, { match: text, sessionId });
      await kit.say(project, sessionId, text);
      return until(`${label}: every call answered`, async () => {
        const mine = await fx.recordsOf(label);
        return mine.length === ops.filter((o) => !("text" in o) && !("sleep" in o)).length && mine.every((c) => c.done) ? mine : null;
      }, 30000);
    },
    parse: (rec) => JSON.parse(rec.text),
    /** Messages that entered a chat, with their origin, oldest first. */
    messages: async (sessionId) => (await fx.api("/__assistant-test/tasks/messages")).filter((m) => !sessionId || m.sessionId === sessionId),
    /** Moves the checker's clock and runs one check now. */
    check: (advanceMs = 0) => fx.post("/__assistant-test/tasks/check", { advanceMs }),
    childLines: (sessionId, lines) => fx.post("/__assistant-test/tasks/child-lines", { sessionId, lines }),
    async idle(sessionId, timeout = 30000) {
      await until(`${sessionId} idle`, async () => {
        const live = (await fx.tg("live")).find((l) => l.sessionId === sessionId);
        return !live || (!live.running && !live.card);
      }, timeout, 200);
    },

    // ── Pages ─────────────────────────────────────────────────────────────────────────────────
    async openDesktop() {
      current = await newPage("desktop", { viewport: { width: 1440, height: 900 } });
      kit.desktop = current;
      await current.page.goto(`${web}/project/alpha`);
      await current.page.locator("[data-tasks-panel], button:has(> span:text-is('Tasks'))").first().waitFor({ timeout: 60000 });
      return current.page;
    },
    async openPhone() {
      current = await newPage("phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      kit.phonePage = current;
      await current.page.goto(`${web}/project/alpha`);
      await current.page.waitForLoadState("domcontentloaded");
      return current.page;
    },
    async openFrame(html) {
      current = await newPage("frame", { viewport: { width: 1440, height: 900 } });
      await current.page.setContent(html);
      return current.page;
    },
    use(entry) { current = entry; return entry.page; },

    /** The Tasks section of the desktop sidebar, open. */
    async openTasks() {
      const page = kit.page;
      const panel = page.locator("[data-tasks-panel]:visible").first();
      // The rail button toggles: clicking it while its section is already open (and still loading)
      // collapses the sidebar. Give a loading page a moment, and click again if it went the wrong way.
      for (let i = 0; i < 4; i++) {
        if (await panel.waitFor({ timeout: i === 0 ? 3000 : 2500 }).then(() => true, () => false)) return;
        await page.locator("button:has(> span:text-is('Tasks'))").first().click();
      }
      await panel.waitFor({ timeout: 10000 });
    },
    row: (title) => kit.page.locator("[data-task-row]", { hasText: title }).first(),
    detail: () => kit.page.locator("[data-task-detail]:visible").first(),
    async selectTask(title) {
      await kit.openTasks();
      // The title, not the row's middle: the row also holds chips (its working chat) that open other tabs.
      await kit.row(title).getByText(title, { exact: true }).first().click();
      await kit.detail().getByText(title).first().waitFor({ timeout: 20000 });
    },

    // ── Video ─────────────────────────────────────────────────────────────────────────────────
    /** Opens a scene: a caption card for a moment, then a small label while the scene plays. */
    async scene(id, title, line) {
      if (!videoDir) return;
      const entry = current;
      const at = (Date.now() - entry.startedAt) / 1000;
      entry.scenes.push({ id, title, from: Math.max(0, at - 0.2), to: null });
      await entry.page.evaluate(({ title, line }) => {
        document.getElementById("ppm-e2e-caption")?.remove();
        document.getElementById("ppm-e2e-label")?.remove();
        const card = document.createElement("div");
        card.id = "ppm-e2e-caption";
        card.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(10,12,16,.88);color:#fff;font:600 30px/1.3 system-ui,sans-serif;text-align:center;padding:24px;pointer-events:none";
        card.innerHTML = `<div style="max-width:900px">${title}</div><div style="max-width:900px;font:400 18px/1.4 system-ui,sans-serif;opacity:.85">${line}</div>`;
        document.body.appendChild(card);
      }, { title, line });
      await sleep(2800);
      await entry.page.evaluate((title) => {
        document.getElementById("ppm-e2e-caption")?.remove();
        const label = document.createElement("div");
        label.id = "ppm-e2e-label";
        label.style.cssText = "position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483647;max-width:90%;background:rgba(10,12,16,.78);color:#fff;font:500 13px/1.3 system-ui,sans-serif;padding:5px 12px;border-radius:999px;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        label.textContent = title;
        document.body.appendChild(label);
      }, title);
    },
    /** Ends the open scene of the current page (a beat after what it showed). */
    async endScene() {
      if (!videoDir) return;
      await sleep(1200);
      const entry = current;
      const open = entry.scenes.findLast((x) => x.to === null);
      if (open) open.to = (Date.now() - entry.startedAt) / 1000;
      await entry.page.evaluate(() => document.getElementById("ppm-e2e-label")?.remove()).catch(() => {});
    },
    /** A pause a person watching can follow; nothing in test mode. */
    beat: (ms = 900) => (videoDir ? sleep(ms) : Promise.resolve()),

    async shot(name) {
      await kit.page.screenshot({ path: `${shotsDir}/${name}.png` });
    },
    async failureShots(id) {
      for (const p of pages) await p.page.screenshot({ path: `${shotsDir}/failure-${id}-${p.kind}.png` }).catch(() => {});
    },
    /** Closes every context (which finishes the recordings); answers the scenes with their files. */
    async closeAll() {
      for (const c of contexts) await c.close().catch(() => {});
      const scenes = [];
      for (const p of pages) {
        const file = videoDir ? await p.page.video()?.path().catch(() => null) : null;
        for (const sc of p.scenes) scenes.push({ ...sc, to: sc.to ?? sc.from + 8, file, kind: p.kind });
      }
      return scenes;
    },
  };
  return kit;
}
