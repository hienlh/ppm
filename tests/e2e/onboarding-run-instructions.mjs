import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createOnboardingHarness } from "./fixtures/onboarding-harness.mjs";

process.env.PPM_ONBOARDING_ARTIFACTS = resolve("plans/260921-1839-adaptive-user-onboarding/artifacts/run-instructions");
const harness = await createOnboardingHarness();
const results = [];
let currentPage;
const tour = (page) => page.getByRole("complementary", { name: "PPM guided tour" });
const waitStep = (page, name) => tour(page).getByRole("heading", { name, exact: true }).waitFor({ timeout: 25000 });
const state = (page) => page.evaluate(async () => { const { useOnboardingStore } = await import("/stores/onboarding-store.ts"); return JSON.parse(JSON.stringify(useOnboardingStore.getState())); });
const capture = (page, name) => page.screenshot({ path: join(harness.artifacts, `${name}.png`), fullPage: true });
async function setup(width = 1366) {
  const context = await harness.browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(({ api, web }) => {
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(input, protocols) {
        const url = new URL(String(input), location.href);
        if (url.hostname === "127.0.0.1" && url.port === "8081" && url.pathname.startsWith("/ws/")) url.port = new URL(api).port;
        if (![new URL(api).host, new URL(web).host].includes(url.host)) throw new Error("Socket outside tour sandbox refused");
        super(url.href, protocols);
      }
    };
  }, { api: harness.api, web: harness.web });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return [new URL(harness.api).host, new URL(harness.web).host].includes(url.host) || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort();
  });
  const page = await context.newPage(); currentPage = page;
  await page.goto(harness.web);
  return { page, context };
}
async function choose(page, goal = "Explore a project") {
  await page.getByRole("button", { name: "Start guided tour", exact: true }).click();
  await page.getByRole("button", { name: "I'm just getting started", exact: false }).click();
  await page.getByRole("button", { name: goal, exact: false }).click();
}
async function action(page, name) {
  const expand = page.getByRole("button", { name: "Expand guide", exact: true });
  if (await expand.isVisible()) await expand.click();
  await tour(page).getByRole("button", { name, exact: true }).click();
}
async function resetWorkspace() {
  const response = await fetch(`${harness.api}/api/project/tour-playground/workspace`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: {
    panels: { main: { id: "main", tabs: [], activeTabId: null, tabHistory: [] } }, grid: [["main"]], focusedPanelId: "main",
  } }) });
  assert.equal(response.ok, true);
}
async function addProject(name, path) {
  const response = await fetch(`${harness.api}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, path }) });
  assert.equal(response.status, 201);
}

async function reachRun(page) {
  await choose(page, "Use development tools");
  await waitStep(page, "Open the terminal");
  await action(page, "Skip step");
  await waitStep(page, "View project changes");
  await action(page, "Skip step");
  await waitStep(page, "Find how to run the project");
}
async function expandGuide(page) {
  const expand = page.getByRole("button", { name: "Expand guide", exact: true });
  if (await expand.isVisible()) await expand.click();
}
async function selectProject(page, name) {
  await page.locator('[data-onboarding="project"]:visible').click();
  await page.getByText(name, { exact: true }).last().click();
}

try {
  await addProject("tour-playground", harness.project);
  for (const width of [1366, 390]) {
    const { page, context } = await setup(width);
    await reachRun(page);
    await action(page, "Find run instructions");
    await page.waitForFunction(async () => { const { useOnboardingStore } = await import("/stores/onboarding-store.ts"); return useOnboardingStore.getState().runDocumentReady === true; });
    await expandGuide(page);
    await tour(page).getByRole("button", { name: "I know where to run commands", exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Tour playground", exact: true }).isVisible(), true);
    await capture(page, `readme-preview-ready-${width}`);
    // Pause and resume an already-open preview: no new editor load or file-tree click.
    await tour(page).getByRole("button", { name: "Pause tour", exact: true }).click();
    await tour(page).getByRole("button", { name: "Resume tour", exact: true }).click();
    await page.waitForFunction(async () => { const { useOnboardingStore } = await import("/stores/onboarding-store.ts"); return useOnboardingStore.getState().runDocumentReady === true; });
    await action(page, "I know where to run commands");
    await waitStep(page, "Your walkthrough is complete");
    assert.equal((await state(page)).completed.includes("run"), true);
    // A fresh guide clears readiness; the mounted preview must supply new evidence.
    await tour(page).getByRole("button", { name: "Try another guide", exact: true }).click();
    await page.getByRole("button", { name: "I'm just getting started", exact: false }).click();
    await page.getByRole("button", { name: "Use development tools", exact: false }).click();
    await action(page, "Skip step");
    await action(page, "Skip step");
    await page.waitForFunction(async () => { const { useOnboardingStore } = await import("/stores/onboarding-store.ts"); return useOnboardingStore.getState().runDocumentReady === true; });
    await action(page, "I know where to run commands");
    await waitStep(page, "Your walkthrough is complete");
    await capture(page, `readme-acknowledged-${width}`);
    results.push({ case: `direct-readme-preview-refresh-ack-${width}`, passed: true });
    await context.close(); await resetWorkspace();
  }
  {
    const fallback = join(harness.sandbox, "package-only");
    await mkdir(fallback); await writeFile(join(fallback, "package.json"), JSON.stringify({ name: "fallback", scripts: { start: "node app.js" } }));
    await addProject("tour-package-only", fallback);
    const { page, context } = await setup();
    await selectProject(page, "tour-package-only");
    await reachRun(page); await action(page, "Find run instructions");
    await page.waitForFunction(async () => { const { useOnboardingStore } = await import("/stores/onboarding-store.ts"); return useOnboardingStore.getState().runDocumentReady === true; });
    await expandGuide(page); await capture(page, "package-json-fallback-ready");
    await action(page, "I know where to run commands");
    await waitStep(page, "Your walkthrough is complete");
    results.push({ case: "package-json-fallback-without-readme", passed: true });
    await context.close();
  }
  {
    const empty = join(harness.sandbox, "no-run-docs");
    await mkdir(empty); await addProject("tour-no-docs", empty);
    const { page, context } = await setup();
    await selectProject(page, "tour-no-docs");
    await reachRun(page); await action(page, "Find run instructions");
    await tour(page).getByRole("status").filter({ hasText: /No README/ }).waitFor();
    const notice = await tour(page).getByRole("status").innerText();
    assert.match(notice, /no .*readme|no .*instructions|could not find|no .*manifest/i);
    assert.equal((await state(page)).runDocumentReady, false);
    assert.equal((await state(page)).currentStep, "run");
    await capture(page, "no-docs-explained");
    await action(page, "Skip step");
    await waitStep(page, "Your walkthrough is complete");
    assert.equal((await state(page)).skipped.includes("run"), true);
    results.push({ case: "no-root-document-explicit-notice-and-skip", passed: true, notice });
    await context.close();
  }
  {
    const { page, context } = await setup();
    await selectProject(page, "tour-playground");
    await reachRun(page);
    await page.route("**/files/list**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Run document listing unavailable" }) }));
    await action(page, "Find run instructions");
    await tour(page).getByRole("status").filter({ hasText: /Could not find/ }).waitFor();
    const notice = await tour(page).getByRole("status").innerText();
    assert.match(notice, /failed|could not|couldn't|unavailable|retry/i);
    assert.equal((await state(page)).runDocumentReady, false);
    assert.equal((await state(page)).currentStep, "run");
    await capture(page, "listing-error-no-success");
    results.push({ case: "listing-failure-explicit-error-no-success", passed: true, notice });
    await context.close();
  }
} catch (error) {
  results.push({ passed: false, error: String(error) });
  if (currentPage && !currentPage.isClosed()) { await capture(currentPage, "failure"); await writeFile(join(harness.artifacts, "failure.html"), await currentPage.content()); }
  console.error(error); process.exitCode = 1;
} finally {
  await harness.browser.close(); await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ isolation: { sandbox: harness.sandbox, api: harness.api, web: harness.web, realAI: false }, results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
