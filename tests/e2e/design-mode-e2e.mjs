import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { pageInstrumentation } from "./fixtures/design-mode-page-instrumentation.mjs";
import { stepCanvasSecurity, stepChatToCanvas, stepHistory, stepNoDotDesignEvents } from "./fixtures/design-mode-steps-canvas.mjs";
import { stepPicker } from "./fixtures/design-mode-steps-picker.mjs";
import { stepMoveDesktop, stepMovePhone, stepTweaks } from "./fixtures/design-mode-steps-edit.mjs";
import { stepBuildInNewChat, stepExports } from "./fixtures/design-mode-steps-export.mjs";
import { stepVariants } from "./fixtures/design-mode-steps-variants.mjs";
import { stepKitStyles } from "./fixtures/design-mode-steps-kit.mjs";
import {
  stepDesignModeHolds, stepMobilePanes, stepNewDesignDialog, stepNormalChat, stepSplitAndExpiry,
} from "./fixtures/design-mode-steps-session.mjs";
import { stepDesignSystemsPerApp } from "./fixtures/design-mode-steps-systems.mjs";

// Design mode end to end, at a desktop and a phone viewport, against a disposable real
// server (isolated PPM_HOME, scripted providers, no network). Run with Node + Bun and
// Playwright (PPM_PLAYWRIGHT_MODULE, PPM_PLAYWRIGHT_CHANNEL=chrome for the installed Chrome).
// Artifacts (logs, screenshots, downloads, results.json) go to PPM_HTML_PREVIEW_ARTIFACTS.

const PROJECT = "design-e2e";
const VIEWPORTS = [
  { width: 1366, height: 900, mobile: false },
  { width: 390, height: 844, mobile: true },
];
const desktop = (ctx) => !ctx.mobile;
const phone = (ctx) => ctx.mobile;
/**
 * Mostly in requirement order; `when` limits a step to one layout. The ordinary chat runs
 * before build-in-new-chat, which must leave that chat untouched.
 */
const STEPS = [
  { name: "chat to canvas", run: stepChatToCanvas },
  { name: "canvas security", run: stepCanvasSecurity },
  { name: "history", run: stepHistory },
  { name: "picker and comments", run: stepPicker },
  { name: "tweaks", run: stepTweaks },
  { name: "move", run: stepMoveDesktop, when: desktop },
  { name: "move handles", run: stepMovePhone, when: phone },
  { name: "exports", run: stepExports },
  { name: "normal chat", run: stepNormalChat },
  { name: "build in new chat", run: stepBuildInNewChat },
  { name: "mobile panes", run: stepMobilePanes, when: phone },
  { name: "design mode holds", run: stepDesignModeHolds },
  { name: "split and expiry", run: stepSplitAndExpiry, when: desktop },
  { name: "new design dialog", run: stepNewDesignDialog },
  { name: "variants", run: stepVariants },
  // Opens and switches focus to a design of its own, same as "variants" just above: kept
  // after every step that assumes the original deck's tab is still the one in view.
  { name: "kit styles", run: stepKitStyles },
  { name: "no .design events", run: stepNoDotDesignEvents },
  // Last: opens its own Settings/New Design flows and leaves a different tab focused, so
  // every step above (which assumes the original deck's tab is active) must run before it.
  { name: "design systems per app", run: stepDesignSystemsPerApp },
];

/** `PPM_DESIGN_E2E_ONLY="variants"`: run just the named steps (comma-separated), for a focused check. */
const ONLY = (process.env.PPM_DESIGN_E2E_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/design-mode-server.ts" });
const results = [], diagnostics = [];
let page;
try {
  const designs = join(harness.project, "designs");
  await mkdir(designs, { recursive: true });
  await writeFile(join(designs, "tokens.css"), ":root { --brand: #0f766e; }\n");
  await writeFile(join(designs, "DESIGN.md"), "# Design system\n\nTeal brand colour, Arial.\n");
  await mkdir(join(designs, "kit", "icons"), { recursive: true });
  await writeFile(join(designs, "kit", "app.css"), ".kit-card { background-color: rgb(15, 23, 42); color: #fff; padding: 8px; }\n");
  await writeFile(join(designs, "kit", "icons", "star.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z"/></svg>\n');
  const created = await fetch(`${harness.api}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }),
  });
  assert.ok(created.ok, `project registration: ${created.status}`);

  for (const viewport of VIEWPORTS) {
    const { width, height, mobile } = viewport;
    const context = await harness.browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
    await context.addInitScript(pageInstrumentation, { api: harness.api });
    page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") diagnostics.push(`${width}px ${m.text()}`); });
    page.on("pageerror", (e) => diagnostics.push(`${width}px pageerror ${e.message}`));
    await page.goto(harness.web);
    await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
    await page.evaluate(async (name) => {
      const projects = (await import("/stores/project-store.ts")).useProjectStore;
      await projects.getState().fetchProjects();
      projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
      (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
    }, PROJECT);
    const ctx = {
      harness, context, page, width, mobile, projectName: PROJECT,
      record: (name, detail = {}) => { results.push({ name: `${width}px ${name}`, passed: true, ...detail }); console.log(`PASS ${width}px ${name}`); },
    };
    for (const step of STEPS) {
      if (step.when && !step.when(ctx)) continue;
      if (ONLY.length && !ONLY.includes(step.name)) continue;
      try {
        await step.run(ctx);
      } catch (error) {
        await page.screenshot({ path: join(harness.artifacts, `failure-${width}-${step.name.replace(/\W+/g, "-")}.png`), fullPage: true }).catch(() => {});
        const recent = await page.evaluate(() => window.__e2e.bridge.slice(-40).map((m) => `${m.type}:${m.nonce?.slice(0, 6)}`)).catch(() => []);
        diagnostics.push(`${width}px last bridge messages before "${step.name}" failed: ${recent.join(" ")}`);
        throw new Error(`${width}px step "${step.name}": ${error.message}`, { cause: error });
      }
    }
    await page.screenshot({ path: join(harness.artifacts, `design-${width}.png`), fullPage: true });
    await context.close();
  }
} catch (error) {
  process.exitCode = 1;
  results.push({ passed: false, error: String(error), stack: error.cause?.stack ?? error.stack });
  console.error(error.message, "\n", error.cause?.stack ?? error.stack);
} finally {
  await harness.browser.close();
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ results, diagnostics, sandbox: harness.sandbox }, null, 2));
  console.log(`Artifacts: ${harness.artifacts}`);
}
