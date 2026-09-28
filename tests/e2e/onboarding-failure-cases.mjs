import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createOnboardingHarness } from "./fixtures/onboarding-harness.mjs";

process.env.PPM_ONBOARDING_ARTIFACTS = resolve("plans/260921-1839-adaptive-user-onboarding/artifacts/failures");
const harness = await createOnboardingHarness();
const results = [];
let currentPage;
const tour = (page) => page.getByRole("complementary", { name: "PPM guided tour" });
const waitStep = (page, name) => tour(page).getByRole("heading", { name, exact: true }).waitFor({ timeout: 25000 });
const state = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ppm-onboarding-v1")));
const capture = (page, name) => page.screenshot({ path: join(harness.artifacts, `${name}.png`), fullPage: true });
async function setup() {
  const context = await harness.browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
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

try {
  assert.equal((await (await fetch(`${harness.api}/api/projects`)).json()).data.length, 0);
  await addProject("tour-playground", harness.project);
  {
    const { page, context } = await setup();
    await choose(page); await waitStep(page, "Read a project file");
    await action(page, "Open files");
    const file = (name) => page.locator('[data-onboarding="explorer"]:visible').getByText(name, { exact: true }).first();
    await page.route("**/files/read?path=package.json", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Tour file failure" }) }));
    await file("package.json").click();
    await page.getByText("Tour file failure", { exact: false }).first().waitFor();
    assert.equal((await state(page)).currentStep, "file");
    await capture(page, "file-error-does-not-complete");
    let pendingRead;
    await page.route("**/files/read?path=index.js", async (route) => { pendingRead = route; });
    await file("index.js").click();
    await page.waitForTimeout(300);
    assert.ok(pendingRead, "actual index.js read intercepted");
    await file("README.md").click();
    await pendingRead.continue();
    await page.waitForTimeout(1200);
    assert.equal((await state(page)).currentStep, "file", "hidden loaded editor must not complete");
    await page.unroute("**/files/read?path=index.js");
    // Reopen the now-loaded real text editor in the foreground.
    await file("index.js").click();
    await waitStep(page, "Search your project");
    await capture(page, "visible-file-retry-completes");
    results.push({ case: "file-error-hidden-delayed-response-visible-retry", passed: true });
    await context.close(); await resetWorkspace();
  }
  {
    const { page, context } = await setup();
    let sends = 0;
    page.on("request", (req) => { if (req.method() === "POST" && /\/chat\/.*(?:send|message)/.test(req.url())) sends++; });
    await choose(page, "Work with AI"); await waitStep(page, "Open AI chat");
    await page.route("**/api/settings/ai", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Tour settings failure" }) }));
    await action(page, "Open chat");
    await page.getByText("Could not load chat settings.", { exact: false }).waitFor();
    assert.equal((await state(page)).currentStep, "chat");
    await capture(page, "provider-settings-failure-retry");
    await page.unroute("**/api/settings/ai");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await waitStep(page, "Ask about your project");
    const input = page.locator('[data-onboarding="chat-input"] textarea:visible');
    await input.fill("My existing draft must stay unchanged.");
    await action(page, "Use suggested question");
    assert.equal(await input.inputValue(), "My existing draft must stay unchanged.");
    await page.waitForTimeout(500);
    assert.equal(sends, 0);
    assert.equal((await state(page)).currentStep, "send");
    await capture(page, "draft-preserved-no-automatic-send");
    results.push({ case: "provider-settings-retry-preserves-draft-no-auto-send", passed: true });
    await context.close(); await resetWorkspace();
  }
  {
    const secondProject = join(harness.sandbox, "second-project");
    await mkdir(secondProject); await writeFile(join(secondProject, "example.txt"), "Second isolated project\n");
    await addProject("tour-second", secondProject);
    const { page, context } = await setup();
    await choose(page); await waitStep(page, "Read a project file");
    const before = await state(page);
    const nextProject = before.projectName === "tour-second" ? "tour-playground" : "tour-second";
    await page.locator('[data-onboarding="project"]:visible').click();
    await page.getByText(nextProject, { exact: true }).last().click();
    await waitStep(page, "Continue when you're ready");
    assert.equal((await state(page)).status, "paused");
    await tour(page).getByRole("button", { name: "Resume tour", exact: true }).click();
    await waitStep(page, "Read a project file");
    const after = await state(page);
    assert.equal(after.projectName, nextProject);
    assert.deepEqual(after.completed, ["project"]);
    assert.deepEqual(after.skipped, []);
    await capture(page, "project-switch-pauses-resume-new-context");
    results.push({ case: "project-switch-pauses-resume-resets-context", passed: true });
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
