import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { pageInstrumentation } from "./fixtures/design-mode-page-instrumentation.mjs";
import { apiJson, canvasSelector, sendDesignTurn, waitCanvasReady } from "./fixtures/design-mode-helpers.mjs";
import { stepAdaptiveLayoutDesktop, stepAdaptiveLayoutPhone, layoutBaseline } from "./fixtures/design-mode-steps-layout.mjs";

// The design tab's width-adaptive layout on its own, against a disposable real server
// (isolated PPM_HOME, scripted provider): resize the tab across the thresholds, pick every
// layout, toggle panes, expand, and cross the phone breakpoint, asserting throughout that the
// canvas never reloads and the chat never opens a second socket. Same environment variables
// as design-mode-e2e.mjs (PPM_PLAYWRIGHT_MODULE, PPM_PLAYWRIGHT_CHANNEL=chrome).

const PROJECT = "design-layout-e2e";
const RUNS = [
  { name: "desktop", viewport: { width: 1366, height: 900 }, touch: false },
  { name: "touch phone", viewport: { width: 390, height: 844 }, touch: true },
];

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/design-mode-server.ts" });
const results = [], diagnostics = [];
try {
  await mkdir(join(harness.project, "designs"), { recursive: true });
  const created = await fetch(`${harness.api}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }),
  });
  assert.ok(created.ok, `project registration: ${created.status}`);

  for (const run of RUNS) {
    const context = await harness.browser.newContext({ viewport: run.viewport, isMobile: run.touch, hasTouch: run.touch });
    await context.addInitScript(pageInstrumentation, { api: harness.api });
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") diagnostics.push(`${run.name} ${m.text()}`); });
    page.on("pageerror", (e) => diagnostics.push(`${run.name} pageerror ${e.message}`));
    await page.goto(harness.web);
    await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
    await page.evaluate(async (name) => {
      const projects = (await import("/stores/project-store.ts")).useProjectStore;
      await projects.getState().fetchProjects();
      projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
      (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
    }, PROJECT);
    const ctx = {
      harness, context, page, width: run.viewport.width, mobile: run.touch, projectName: PROJECT,
      record: (name, detail = {}) => { results.push({ name: `${run.name}: ${name}`, passed: true, ...detail }); console.log(`PASS ${run.name}: ${name}`); },
    };
    ctx.designTitle = `Layout ${run.name}`;
    const res = await apiJson(ctx, `/api/project/${encodeURIComponent(PROJECT)}/designs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: ctx.designTitle, kind: "slides" }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ctx.slug = res.body.data.slug;
    ctx.designDir = join(harness.project, "designs", ctx.slug);
    ctx.tabId = await page.evaluate(async ({ projectName, slug }) =>
      (await import("/lib/design/open-design-tab.ts")).openDesignTab({ projectName, slug }), { projectName: PROJECT, slug: ctx.slug });
    await page.locator(`${canvasSelector(ctx)}:visible`).waitFor({ timeout: 30000 });
    const call = await sendDesignTurn(ctx, "Build the deck [[design:build]]");
    ctx.sessionId = call.sessionId;
    await waitCanvasReady(ctx);
    try {
      const baseline = run.touch ? await layoutBaseline(ctx) : await stepAdaptiveLayoutDesktop(ctx);
      await stepAdaptiveLayoutPhone(ctx, baseline);
      results.push({ name: `${run.name}: counts`, passed: true, readies: baseline.readies, sockets: baseline.sockets });
    } catch (error) {
      await page.screenshot({ path: join(harness.artifacts, `layout-failure-${run.name.replace(/\W+/g, "-")}.png`) }).catch(() => {});
      diagnostics.push(await page.evaluate(() => JSON.stringify({
        fileChanged: window.__e2e.fileChanged,
        bridge: window.__e2e.bridge.filter((m) => m.type === "ready").map((m) => `${m.type}:${m.nonce?.slice(0, 6)}@${m.at}`),
        now: Date.now(),
      })).catch(() => "no page state"));
      throw new Error(`${run.name}: ${error.message}`, { cause: error });
    }
    await context.close();
  }
} catch (error) {
  process.exitCode = 1;
  results.push({ passed: false, error: String(error), stack: error.cause?.stack ?? error.stack });
  console.error(error.message, "\n", error.cause?.stack ?? error.stack);
} finally {
  await harness.browser.close();
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ results, diagnostics }, null, 2));
  console.log(`Artifacts: ${harness.artifacts}`);
}
