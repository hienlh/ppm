import assert from "node:assert/strict";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";

// Settings → AI Provider: the memory guard's three thresholds, in a real Chrome at a desktop and a
// phone viewport, against the disposable chat fixture server (isolated PPM_HOME and home folder,
// random ports, auth off). Each field shows its default (15 GB, 10 GB, 60 min), a value typed and
// blurred is saved and read back from the server, an out-of-range one is brought into range, and
// the route refuses an invalid value outright. Screenshots land in the harness's artifacts folder.
// Run with Node + Bun and Playwright (PPM_PLAYWRIGHT_MODULE, PPM_PLAYWRIGHT_CHANNEL=chrome).

const PROJECT = "memory-guard-e2e";
const VIEWPORTS = [
  { width: 1366, height: 900, mobile: false },
  { width: 390, height: 844, mobile: true },
];
const FIELDS = {
  warn: "ai-memory-warn",
  block: "ai-memory-block",
  idle: "ai-idle-cli-release",
};

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/new-chat-instant-server.ts" });
const apiPort = new URL(harness.api).port;
const results = [], diagnostics = [];
const getAi = async () => (await (await fetch(`${harness.api}/api/settings/ai`)).json()).data;
const putAi = (body) => fetch(`${harness.api}/api/settings/ai`, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

try {
  const created = await fetch(`${harness.api}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }),
  });
  assert.ok(created.ok, `project registration: ${created.status}`);

  // The route itself: invalid values are refused, valid ones saved.
  for (const bad of [{ memory_warn_free_gb: -1 }, { memory_block_free_gb: 2.3 }, { idle_cli_release_minutes: 1.5 }, { memory_warn_free_gb: "15" }]) {
    const res = await putAi(bad);
    assert.equal(res.status, 400, `PUT ${JSON.stringify(bad)} → ${res.status}`);
  }
  results.push({ name: "the route refuses invalid thresholds", passed: true });
  console.log("PASS the route refuses invalid thresholds");

  for (const { width, height, mobile } of VIEWPORTS) {
    // Back to the defaults before each viewport.
    const reset = await putAi({ memory_warn_free_gb: 15, memory_block_free_gb: 10, idle_cli_release_minutes: 60 });
    assert.equal(reset.status, 200);
    const context = await harness.browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
    // The dev client dials sockets on :8081; point them at this stack, never at a developer's own server.
    await context.addInitScript(`(() => {
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(input, protocols) {
          const url = new URL(String(input), location.href);
          if (url.port === "8081") { url.hostname = "127.0.0.1"; url.port = ${JSON.stringify(apiPort)}; }
          super(url.href, protocols);
        }
      };
    })()`);
    const page = await context.newPage();
    page.on("pageerror", (e) => diagnostics.push(`${width}px pageerror ${e.message}`));
    const pass = (name) => { results.push({ name: `${width}px ${name}`, passed: true }); console.log(`PASS ${width}px ${name}`); };
    try {
      await page.goto(harness.web);
      await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
      await page.evaluate(async (name) => {
        const projects = (await import("/stores/project-store.ts")).useProjectStore;
        await projects.getState().fetchProjects();
        projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
        (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
        (await import("/components/settings/open-settings.ts")).openSettings("ai-provider");
      }, PROJECT);
      const later = page.getByRole("complementary", { name: "PPM guided tour" }).getByRole("button", { name: "Maybe later" });
      try { await later.click({ timeout: 4000 }); } catch { /* not shown */ }

      const warn = page.locator(`#${FIELDS.warn}:visible`);
      await warn.waitFor({ timeout: 20000 });
      const block = page.locator(`#${FIELDS.block}:visible`);
      const idle = page.locator(`#${FIELDS.idle}:visible`);
      assert.equal(await warn.inputValue(), "15");
      assert.equal(await block.inputValue(), "10");
      assert.equal(await idle.inputValue(), "60");
      pass("shows the defaults: warn 15 GB, hold heavy commands 10 GB, release after 60 min");

      // The three fields together: the first scrolled to the top of the pane, then the page.
      await warn.evaluate((el) => el.closest("div")?.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(harness.artifacts, `memory-guard-settings-page-${width}.png`) });
      // And each field with its explanation, on its own.
      for (const [key, id] of Object.entries(FIELDS)) {
        await page.locator(`div:has(> #${id}):visible`).first().screenshot({ path: join(harness.artifacts, `memory-guard-field-${key}-${width}.png`) });
      }

      await warn.fill("20");
      await warn.blur();
      await block.fill("12.5");
      await block.blur();
      await idle.fill("0");
      await idle.blur();
      let ai;
      for (let i = 0; i < 40; i++) {
        ai = await getAi();
        if (ai.memory_warn_free_gb === 20 && ai.memory_block_free_gb === 12.5 && ai.idle_cli_release_minutes === 0) break;
        await page.waitForTimeout(250);
      }
      assert.equal(ai.memory_warn_free_gb, 20);
      assert.equal(ai.memory_block_free_gb, 12.5);
      assert.equal(ai.idle_cli_release_minutes, 0);
      pass("typed values are saved on blur and read back from the server");

      await idle.fill("99999999");
      await idle.blur();
      for (let i = 0; i < 40 && (await getAi()).idle_cli_release_minutes !== 10080; i++) await page.waitForTimeout(250);
      assert.equal(await idle.inputValue(), "10080");
      assert.equal((await getAi()).idle_cli_release_minutes, 10080);
      pass("an out-of-range value is brought into range (7 days at most)");

      await page.reload();
      await page.waitForFunction(async () => !!(await import("/components/settings/open-settings.ts")).openSettings);
      await page.evaluate(async () => (await import("/components/settings/open-settings.ts")).openSettings("ai-provider"));
      await page.locator(`#${FIELDS.warn}:visible`).waitFor({ timeout: 20000 });
      assert.equal(await page.locator(`#${FIELDS.warn}:visible`).inputValue(), "20");
      pass("the saved values come back after a reload");
    } finally {
      await context.close();
    }
  }
} catch (error) {
  results.push({ name: "run", passed: false, error: String(error?.stack ?? error) });
  console.error(error);
} finally {
  await harness.browser.close().catch(() => {});
  await harness.cleanup();
}

const failed = results.filter((r) => !r.passed);
if (diagnostics.length) console.log(`diagnostics:\n  ${diagnostics.join("\n  ")}`);
console.log(`\n${results.length - failed.length}/${results.length} passed — artifacts: ${harness.artifacts}`);
process.exit(failed.length ? 1 : 0);
