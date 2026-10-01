// Agent card: one-line chat row + live session window/sheet, end to end.
//
// Against a disposable real server (isolated PPM_HOME/HOME/USERPROFILE, own ports, real
// provider registry but no message ever sent — everything here is a filesystem read: the
// history route (`GET /chat/sessions/:id/messages`) and the agent-transcript hub over
// `/ws/global`). A synthetic Claude session is written straight to `<home>/.claude/projects/`
// (see fixtures/agent-session/agent-session-fixture.mjs), never touching a real ~/.claude.
//
// Run with plain `node`, not `bun` — on this machine Playwright's own driver process hangs
// forever on Chrome's CDP handshake (pipe transport and a manual WebSocket-over-CDP connection
// both hung for 60-180s) when the calling process is Bun; the exact same launch succeeds
// immediately under Node. Only the top-level test runner needs to be Node — the harness still
// spawns the real backend via Bun (PPM_BUN) and Vite via `process.execPath`.
//
// Run: PPM_BUN=<path to bun> PPM_PLAYWRIGHT_MODULE=<path to playwright/index.mjs> \
//      PPM_PLAYWRIGHT_CHANNEL=chrome node tests/e2e/agent-session-window-e2e.mjs
// Artifacts (logs, results.json) go to PPM_HTML_PREVIEW_ARTIFACTS; screenshots go to
// plans/261001-0232-agent-card-compact-window/screenshots/ relative to cwd — run this from the
// repo root you want the screenshots in (override the whole path via PPM_E2E_SHOTS).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { writeAgentSessionFixture, appendRootStep } from "./fixtures/agent-session/agent-session-fixture.mjs";

const PROJECT = "agent-session-e2e";
const REPO = process.cwd();
const SHOTS = process.env.PPM_E2E_SHOTS
  || join(REPO, "plans", "261001-0232-agent-card-compact-window", "screenshots");

const results = [];
const log = (...a) => console.log(...a);
async function scenario(name, fn) {
  try { await fn(); results.push({ name, pass: true }); log(`  [PASS] ${name}`); }
  catch (e) { results.push({ name, pass: false }); log(`  [FAIL] ${name} — ${e?.stack ?? e?.message ?? e}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openProjectAndSession(page, { projectName, sessionId, providerId, title }) {
  await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  await page.evaluate(async (name) => {
    const projects = (await import("/stores/project-store.ts")).useProjectStore;
    await projects.getState().fetchProjects();
    projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
    (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
  }, projectName);
  await page.evaluate(async ({ projectName, sessionId, providerId, title }) => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    usePanelStore.getState().openTab({
      type: "chat", title, projectId: projectName, closable: true,
      metadata: { projectName, sessionId, providerId },
    });
  }, { projectName, sessionId, providerId, title });
}

/** The one-line Agent card's button in the chat transcript (no handle, so the generic title). */
const cardButtonSel = 'button[title="Open agent session"]';
const windowSel = '[role="group"][aria-roledescription="window"]';
/** The bottom sheet's own panel (not the whole page): `mobile-bottom-sheet.tsx` gives it no
 *  testid, so it's found by its distinctive class plus its Close button. Scoping to this,
 *  rather than `document.body`, matters — the chat card behind the sheet already contains the
 *  same step text, so a `document.body.innerText` check is trivially true from the moment the
 *  sheet opens, before its own content has loaded at all. */
const sheetPanelSel = 'div.rounded-t-2xl:has(button[aria-label="Close"])';

/**
 * In dev mode the app's `WsClient` deliberately bypasses Vite's WS proxy and dials
 * `ws://<host>:8081<path>` directly ("Vite's dev proxy has unreliable WebSocket upgrade
 * handling" — `src/web/lib/ws-client.ts`), so under this harness's dynamic port every socket
 * would otherwise try the real dev port instead of the fixture. Same rewrite
 * `design-mode-page-instrumentation.mjs` and `mcp-sign-in-e2e.mjs` already apply. Also dismisses
 * the first-run onboarding card so it never covers the chat.
 */
function pointWsAtFixture({ api }) {
  try {
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({
      version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null,
      completed: [], skipped: [], projectName: null, sessionId: null,
    }));
  } catch { /* storage unavailable: a stray onboarding card blocks no assertion below */ }
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(input, protocols) {
      const url = new URL(String(input), location.href);
      if (url.hostname === "127.0.0.1" && url.port === "8081") url.port = new URL(api).port;
      super(url.href, protocols);
    }
  };
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/agent-session/agent-session-server.ts" });
  const home = join(harness.sandbox, "home"); // same join html-preview-harness.mjs used to build the sandbox
  let desktopPage, mobilePage;
  try {
    const created = await fetch(`${harness.api}/api/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: harness.project, name: PROJECT }),
    });
    const createdBody = await created.json();
    assert.ok(createdBody.ok, `project registration: ${created.status} ${JSON.stringify(createdBody)}`);
    const projectPath = createdBody.data.path;

    const sessionId = randomUUID();
    const cardId = "toolu_card_1";
    const fixture = await writeAgentSessionFixture({ claudeHome: home, projectPath, sessionId, cardId });
    const cardTitle = "Investigate flaky test"; // description AgentCardSummary/opener use as the fallback title

    // The mobile scenario gets its own untouched fixture (never appended to) so its
    // assertions don't depend on what the desktop scenarios above already mutated on disk.
    const mobileSessionId = randomUUID();
    const mobileCardId = "toolu_card_2";
    await writeAgentSessionFixture({ claudeHome: home, projectPath, sessionId: mobileSessionId, cardId: mobileCardId });

    // ---------------------------------------------------------------- desktop
    const desktopCtx = await harness.browser.newContext({ viewport: { width: 1280, height: 800 } });
    await desktopCtx.addInitScript(pointWsAtFixture, { api: harness.api });
    desktopPage = await desktopCtx.newPage();
    const diagnostics = [];
    desktopPage.on("console", (m) => { if (m.type() === "error") diagnostics.push(m.text()); });
    desktopPage.on("pageerror", (e) => diagnostics.push(e.message));
    await desktopPage.goto(harness.web);
    await openProjectAndSession(desktopPage, { projectName: PROJECT, sessionId, providerId: "claude", title: "Fixture session" });

    await scenario("desktop: chat shows the Agent card as one line, no step rows in the DOM", async () => {
      await desktopPage.waitForSelector(cardButtonSel, { timeout: 20_000 });
      // At least one card row for this card in the chat transcript — there may already be a
      // second, identical-title row from the running-agents bar (liveness is disk-derived and
      // can appear immediately), which is a feature, not a duplicate of the chat card itself.
      const cardCount = await desktopPage.locator(cardButtonSel).count();
      assert.ok(cardCount >= 1, `expected at least one card row, got ${cardCount}`);
      const rowText = await desktopPage.locator(cardButtonSel).first().innerText();
      assert.ok(rowText.includes(cardTitle), `row text missing description: ${rowText}`);
      // formatStepCount() pluralises — our fixture's root card starts with exactly one step
      // (one Grep call), so this reads "1 step" (singular), not "1 steps".
      assert.ok(/\bsteps?\b/.test(rowText), `row text missing step count: ${rowText}`);
      // The step's own tool_result output ("3 matches in tests/") only ever renders inside
      // the expanded window view — its presence here would mean the card expanded inline.
      const bodyText = await desktopPage.locator("body").innerText();
      assert.ok(!bodyText.includes("3 matches in tests/"), "chat DOM contains step detail — card expanded inline");
      await desktopPage.screenshot({ path: join(SHOTS, "desktop-01-one-line-card.png") });
    });

    await scenario("desktop: tap opens a portrait window at the top-right", async () => {
      await desktopPage.locator(cardButtonSel).first().click();
      await desktopPage.waitForSelector(windowSel, { timeout: 10_000 });
      const box = await desktopPage.locator(windowSel).first().boundingBox();
      assert.ok(box, "window has no bounding box");
      assert.ok(box.height > box.width, `expected portrait (h>w), got ${box.width}x${box.height}`);
      const viewport = desktopPage.viewportSize();
      const rightGap = viewport.width - (box.x + box.width);
      // portraitSpawnRect pins the window near the layer's right edge with a fixed margin
      // (measured 48px at 1280x800, matching window-geometry.test.ts's own fixture) — not 0.
      assert.ok(rightGap <= 60, `window right edge not near the layer's right edge (gap=${rightGap}px)`);
      await desktopPage.screenshot({ path: join(SHOTS, "desktop-02-portrait-window.png") });
    });

    await scenario("desktop: the window streams the card's real subagent transcript (live hub, not memory fallback)", async () => {
      await desktopPage.waitForFunction(
        () => document.querySelector('[role="group"][aria-roledescription="window"]')?.innerText.includes("Grep flaky"),
        { timeout: 10_000 },
      );
      const winText = await desktopPage.locator(windowSel).first().innerText();
      assert.ok(winText.includes("Grep flaky"), `expected the Grep step in the window: ${winText}`);
      assert.ok(!winText.includes("offline"), `window should not show the memory-only fallback badge: ${winText}`);
    });

    await scenario("desktop: a line appended on disk appears in the window within ~1s", async () => {
      const t0 = Date.now();
      await appendRootStep(fixture.rootJsonl, "toolu_r1", "src/flaky.test.ts");
      await desktopPage.waitForFunction(
        () => document.querySelector('[role="group"][aria-roledescription="window"]')?.innerText.includes("flaky.test.ts"),
        { timeout: 3_000 },
      );
      const elapsed = Date.now() - t0;
      log(`    appended line visible after ${elapsed}ms`);
      assert.ok(elapsed <= 1_000, `took ${elapsed}ms, wanted <= 1000ms`);
      await desktopPage.screenshot({ path: join(SHOTS, "desktop-03-live-append.png") });
    });

    await scenario("desktop: WS dropped and restored — no gap, no duplicate row", async () => {
      await desktopCtx.setOffline(true);
      await sleep(300);
      await appendRootStep(fixture.rootJsonl, "toolu_r2", "src/other.test.ts");
      await sleep(1_200); // while offline: must not be lost
      await desktopCtx.setOffline(false);
      await desktopPage.waitForFunction(
        () => document.querySelector('[role="group"][aria-roledescription="window"]')?.innerText.includes("other.test.ts"),
        { timeout: 10_000 },
      );
      const winText = await desktopPage.locator(windowSel).first().innerText();
      const firstCount = winText.split("flaky.test.ts").length - 1;
      assert.equal(firstCount, 1, `"flaky.test.ts" appeared ${firstCount} times after reconnect — expected exactly once (no duplicate)`);
      await desktopPage.screenshot({ path: join(SHOTS, "desktop-04-after-reconnect.png") });
    });

    await scenario("desktop: the running-agents bar lists the agent while it writes", async () => {
      await desktopPage.waitForFunction(
        (sel) => document.querySelectorAll(sel).length >= 2,
        cardButtonSel,
        { timeout: 15_000 }, // agent-activity ticks every 3s server-side
      );
      await desktopPage.screenshot({ path: join(SHOTS, "desktop-05-running-bar.png") });
    });

    await desktopCtx.close();

    // ---------------------------------------------------------------- mobile
    const mobileCtx = await harness.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobileCtx.addInitScript(pointWsAtFixture, { api: harness.api });
    mobilePage = await mobileCtx.newPage();
    mobilePage.on("console", (m) => { if (m.type() === "error") diagnostics.push(`[mobile] ${m.text()}`); });
    mobilePage.on("pageerror", (e) => diagnostics.push(`[mobile] ${e.message}`));
    await mobilePage.goto(harness.web);
    await openProjectAndSession(mobilePage, { projectName: PROJECT, sessionId: mobileSessionId, providerId: "claude", title: "Fixture session (mobile)" });

    await scenario("mobile: the same tap opens a bottom sheet, not a floating window", async () => {
      await mobilePage.waitForSelector(cardButtonSel, { timeout: 20_000 });
      await mobilePage.screenshot({ path: join(SHOTS, "mobile-01-one-line-card.png") });
      await mobilePage.locator(cardButtonSel).first().click();
      await mobilePage.waitForFunction(() => document.querySelector('button[aria-label="Close"]') != null, { timeout: 10_000 });
      const windowCount = await mobilePage.locator(windowSel).count();
      assert.equal(windowCount, 0, "a floating window opened on a mobile viewport instead of a sheet");
      // Wait for the hub's live stream to land *inside the sheet's own panel* before reading or
      // screenshotting it — the chat card behind the sheet already contains "Grep flaky", so a
      // body-wide check here would pass instantly even while the sheet itself still shows
      // "Loading session…" (this is exactly what produced a "Loading…" screenshot before).
      await mobilePage.waitForFunction(
        (sel) => document.querySelector(sel)?.innerText.includes("Grep flaky"),
        sheetPanelSel,
        { timeout: 10_000 },
      );
      const sheetText = await mobilePage.locator(sheetPanelSel).innerText();
      assert.ok(sheetText.includes("Grep flaky"), `sheet panel did not render the stream: ${sheetText}`);
      assert.ok(!sheetText.includes("Loading session"), `sheet panel still loading: ${sheetText}`);
      await mobilePage.screenshot({ path: join(SHOTS, "mobile-02-bottom-sheet.png") });
    });

    await mobileCtx.close();

    if (diagnostics.length) log(`  console diagnostics: ${diagnostics.slice(0, 10).join(" | ")}`);
  } finally {
    await harness.browser.close();
    await harness.cleanup();
  }

  const failed = results.filter((r) => !r.pass);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
