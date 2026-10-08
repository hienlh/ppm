import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { pageInstrumentation } from "./fixtures/design-mode-page-instrumentation.mjs";
import { apiJson, canvasSelector, sendDesignTurn, until, waitCanvasReady } from "./fixtures/design-mode-helpers.mjs";
import { assertUntouched, layoutBaseline } from "./fixtures/design-mode-steps-layout.mjs";

// A design in a floating window, against a disposable real server (isolated PPM_HOME,
// scripted provider): it opens in a window with the chat in a column on the right, the
// status bar's dock lists it, and minimize / restore / snap / maximize / the dock list all
// work without the canvas reloading or the chat opening a second socket. On a phone the same
// call opens it full screen, as a tab. Same environment variables as design-mode-e2e.mjs
// (PPM_PLAYWRIGHT_MODULE, PPM_PLAYWRIGHT_CHANNEL=chrome).

const PROJECT = "design-window-e2e";
const WINDOW = '[aria-roledescription="window"]';
const DOCK = '[role="toolbar"][aria-label="Windows"]';

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/design-mode-server.ts" });
const results = [], diagnostics = [];

async function openPage(viewport, touch) {
  const context = await harness.browser.newContext({ viewport, isMobile: touch, hasTouch: touch });
  await context.addInitScript(pageInstrumentation, { api: harness.api });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") diagnostics.push(`${viewport.width} ${m.text()}`); });
  page.on("pageerror", (e) => diagnostics.push(`${viewport.width} pageerror ${e.message}`));
  await page.goto(harness.web);
  await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  await page.evaluate(async (name) => {
    const projects = (await import("/stores/project-store.ts")).useProjectStore;
    await projects.getState().fetchProjects();
    projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
    (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
  }, PROJECT);
  return { context, page };
}

async function createAndOpen(ctx, title) {
  ctx.designTitle = title;
  const res = await apiJson(ctx, `/api/project/${encodeURIComponent(PROJECT)}/designs`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, kind: "page" }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  ctx.slug = res.body.data.slug;
  ctx.tabId = await ctx.page.evaluate(async ({ projectName, slug }) =>
    (await import("/lib/design/open-design-tab.ts")).openDesignTab({ projectName, slug }), { projectName: PROJECT, slug: ctx.slug });
  await ctx.page.locator(`${canvasSelector(ctx)}:visible`).waitFor({ timeout: 30000 });
}

const panelOfTab = (ctx) => ctx.page.evaluate(async (tabId) =>
  (await import("/stores/panel-store.ts")).usePanelStore.getState().getPanelForTab(tabId)?.id ?? null, ctx.tabId);

const box = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, shown: el.getClientRects().length > 0 };
});

const designWindow = (ctx) => ctx.page.locator(`${WINDOW}[aria-label="${ctx.designTitle}"]`);
const layer = (ctx) => designWindow(ctx).locator("xpath=..");
const chip = (ctx, title) => ctx.page.locator(`${DOCK} button[data-chip][aria-label^="${title}"]`).first();

try {
  await mkdir(join(harness.project, "designs"), { recursive: true });
  const created = await fetch(`${harness.api}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }),
  });
  assert.ok(created.ok, `project registration: ${created.status}`);

  // ── Desktop ────────────────────────────────────────────────────────────────────────────
  {
    const { context, page } = await openPage({ width: 1440, height: 900 }, false);
    const ctx = { harness, context, page, mobile: false, projectName: PROJECT };
    const pass = (name, detail = {}) => { results.push({ name: `desktop: ${name}`, passed: true, ...detail }); console.log(`PASS desktop: ${name}`); };
    try {
      await createAndOpen(ctx, "Window landing");
      assert.match(await panelOfTab(ctx), /^__win__:/, "the design opened in a window panel");
      await designWindow(ctx).waitFor();
      pass("opens in a floating window");

      const call = await sendDesignTurn(ctx, "Build the page [[design:build]]");
      ctx.sessionId = call.sessionId;
      await waitCanvasReady(ctx);
      const baseline = await layoutBaseline(ctx);

      // The chat is a column on the right of the canvas, min(380px, 50%) wide by default.
      const frame = await box(page.locator(`${canvasSelector(ctx)}:visible`));
      const chatPane = page.locator(`${WINDOW} [data-design-pane="chat"]`).first();
      const chat = await box(chatPane);
      const win = await box(designWindow(ctx));
      assert.ok(chat.x > frame.x + frame.w - 2, `chat (${chat.x}) is right of the canvas (${frame.x}+${frame.w})`);
      assert.ok(Math.abs(chat.w - Math.min(380, (win.w - 2) * 0.5)) < 4, `chat column width ${chat.w}`);
      await page.screenshot({ path: join(harness.artifacts, "design-window-float.png") });
      pass("canvas left, chat column right", { chatWidth: chat.w });

      // The toolbar's Chat button closes and reopens the column.
      const chatBtn = page.locator(`${WINDOW} button[aria-label="Chat"]`).first();
      await chatBtn.click();
      await until("the chat column to close", async () => !(await box(chatPane)).shown);
      await chatBtn.click();
      await until("the chat column to open", async () => (await box(chatPane)).shown);
      await assertUntouched(ctx, baseline, "chat column toggle");
      pass("Chat button toggles the column");

      // The column's left edge drags; narrowed to its minimum the chat compacts: the bars and
      // the composer chips drop their words to icons, and the chip row stays on one line.
      const handle = page.locator(`${WINDOW} [role="separator"][aria-label="Chat width"]`).first();
      const h = await box(handle);
      await page.mouse.move(h.x + h.w / 2, h.y + h.h / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(h.x + h.w / 2 + i * 40, h.y + h.h / 2);
      await page.mouse.up();
      await until("the chat column to narrow", async () => Math.abs((await box(chatPane)).w - 280) < 3);
      const compact = await chatPane.evaluate((pane) => {
        const shown = (el) => !!el && el.getClientRects().length > 0;
        const words = (label) => [...pane.querySelectorAll(`button[aria-label^="${label}"] span`)].some(shown);
        // The composer also renders a phone row (hidden on a desktop); take the chip on screen.
        const chip = [...pane.querySelectorAll('button[aria-label^="Permission mode"]')].find(shown);
        const chips = chip?.parentElement?.parentElement;
        // One line: every chip's centre within a few px of the others (they differ in height).
        const mids = chips ? [...chips.children].filter(shown).map((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; }) : [];
        const oneLine = mids.length > 1 && Math.max(...mids) - Math.min(...mids) < 6;
        return { history: words("History"), permission: words("Permission mode"), oneLine };
      });
      assert.deepEqual(compact, { history: false, permission: false, oneLine: true }, `compact chat ${JSON.stringify(compact)}`);
      await page.screenshot({ path: join(harness.artifacts, "design-window-chat-narrow.png") });
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("ppm-design-view-prefs") ?? "{}").windowChatWidth);
      assert.equal(stored, 280, "the column width is remembered");
      await handle.focus();
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
      await until("the chat column to widen from the keyboard", async () => Math.abs((await box(chatPane)).w - 380) < 3);
      await assertUntouched(ctx, baseline, "chat column resize");
      pass("chat column drags, remembers its width and compacts when narrow");

      // The dock lists it; its chip minimizes the window in front and brings it back.
      const designChip = chip(ctx, ctx.designTitle);
      await designChip.waitFor();
      assert.equal(await designChip.getAttribute("aria-pressed"), "true");
      await designChip.click();
      await until("the window to minimize", async () => !(await box(designWindow(ctx))).shown);
      assert.equal(await designChip.getAttribute("aria-pressed"), "false");
      await designChip.click();
      await until("the window to come back", async () => (await box(designWindow(ctx))).shown);
      await assertUntouched(ctx, baseline, "minimize and restore from the dock");
      pass("dock chip minimizes and restores");

      // Snap from the titlebar button, then back.
      const area = await box(layer(ctx));
      await designWindow(ctx).locator('button[aria-label="Snap to the right"]').click();
      await until("the window to snap", async () => {
        const r = await box(designWindow(ctx));
        return Math.abs(r.x + r.w - (area.x + area.w)) < 2 && Math.abs(r.h - area.h) < 2 && Math.abs(r.w - Math.round(area.w * 0.55)) < 3;
      });
      await page.screenshot({ path: join(harness.artifacts, "design-window-snapped.png") });
      await designWindow(ctx).locator('button[aria-label="Snap to the right"]').click();
      await until("the window to unsnap", async () => (await box(designWindow(ctx))).w < area.w * 0.95);
      pass("snap button snaps to the right and back");

      // Dragging the titlebar off the right edge snaps on release.
      const title = designWindow(ctx).locator('[role="toolbar"][aria-label$="title bar"]');
      const t = await box(title);
      await page.mouse.move(t.x + 60, t.y + t.h / 2);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(t.x + 60 + i * 80, t.y + t.h / 2);
      await until("the snap preview to show", async () => page.evaluate(async () =>
        (await import("/components/floating-window/window-store.ts")).useWindowStore.getState().snapPreviewId !== null));
      await page.mouse.up();
      await until("the dragged window to snap", async () => page.evaluate(async () =>
        Object.values((await import("/components/floating-window/window-store.ts")).useWindowStore.getState().windows)
          .some((w) => w.state === "snapped")));
      pass("dragging past the right edge snaps");

      // Double-clicking the titlebar maximizes.
      await designWindow(ctx).locator('button[aria-label="Snap to the right"]').click();
      const t2 = await box(title);
      await page.mouse.dblclick(t2.x + 80, t2.y + t2.h / 2);
      await until("the window to maximize", async () => {
        const r = await box(designWindow(ctx));
        return Math.abs(r.w - area.w) < 2 && Math.abs(r.h - area.h) < 2;
      });
      await page.mouse.dblclick(t2.x + 80, t2.y + t2.h / 2);
      await assertUntouched(ctx, baseline, "snap, drag and maximize");
      pass("double-click maximizes and restores");

      // A second window: the dock shows both, its list searches and minimizes all.
      await page.evaluate(async () => (await import("/components/settings/open-settings.ts")).openSettings());
      await chip(ctx, "Settings").waitFor();
      await page.locator(DOCK).click({ button: "right", position: { x: 4, y: 10 } });
      const list = page.getByRole("dialog", { name: "All windows" });
      await list.waitFor();
      await page.screenshot({ path: join(harness.artifacts, "design-window-dock-list.png") });
      await list.getByRole("textbox", { name: "Find a window" }).fill("landing");
      await until("the list to filter", async () => (await list.locator('button[aria-label^="Close "]').count()) === 1);
      await list.getByRole("textbox", { name: "Find a window" }).fill("");
      await list.getByRole("button", { name: "Minimize all" }).click();
      await until("every window to minimize", async () => page.evaluate(async () =>
        Object.values((await import("/components/floating-window/window-store.ts")).useWindowStore.getState().windows)
          .every((w) => w.state === "minimized")));
      await assertUntouched(ctx, baseline, "minimize all");
      pass("dock list filters and minimizes all");

      // Closing the window closes the design: it was the design's home, not a detour.
      await chip(ctx, ctx.designTitle).click();
      await designWindow(ctx).locator('button[aria-label="Close window"]').click();
      await until("the design to close", async () => (await panelOfTab(ctx)) === null);
      assert.equal(await chip(ctx, ctx.designTitle).count(), 0, "its chip left the dock");
      pass("closing the window closes the design");
    } catch (error) {
      await page.screenshot({ path: join(harness.artifacts, "design-window-failure-desktop.png") }).catch(() => {});
      throw error;
    }
    await context.close();
  }

  // ── Phone ──────────────────────────────────────────────────────────────────────────────
  {
    const { context, page } = await openPage({ width: 390, height: 844 }, true);
    const ctx = { harness, context, page, mobile: true, projectName: PROJECT };
    await createAndOpen(ctx, "Window phone");
    const panel = await panelOfTab(ctx);
    assert.ok(panel && !panel.startsWith("__win__:"), `a phone opens the design as a tab (panel ${panel})`);
    assert.equal(await page.locator(WINDOW).count(), 0, "no window on a phone");
    results.push({ name: "phone: opens full screen as a tab", passed: true });
    console.log("PASS phone: opens full screen as a tab");
    await context.close();
  }
} catch (error) {
  process.exitCode = 1;
  results.push({ passed: false, error: String(error), stack: error.stack });
  console.error(error.message, "\n", error.stack);
} finally {
  await harness.browser.close();
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ results, diagnostics }, null, 2));
  console.log(`Artifacts: ${harness.artifacts}`);
}
