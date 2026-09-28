import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createOnboardingHarness } from "./fixtures/onboarding-harness.mjs";

process.env.PPM_ONBOARDING_ARTIFACTS = resolve("plans/260921-1839-adaptive-user-onboarding/artifacts/empty-search");
const harness = await createOnboardingHarness();
const results = [];
let currentPage;
const tour = (page) => page.getByRole("complementary", { name: "PPM guided tour" });
const waitStep = (page, name) => tour(page).getByRole("heading", { name, exact: true }).waitFor({ timeout: 25000 });
const state = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ppm-onboarding-v1")));
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

async function search(page) {
  await action(page, "Open search");
  const response = page.waitForResponse((res) => res.url().includes("/files/search?") && new URL(res.url()).searchParams.get("q") === "bunx");
  await page.locator('[data-onboarding="search"]:visible input').first().fill("bunx");
  const result = await response;
  assert.equal(result.status(), 200);
  const body = await result.json();
  assert.equal(body.ok, true);
  await waitStep(page, "Your walkthrough is complete");
  return body.data;
}

try {
  const plainProject = join(harness.sandbox, "plain-files-only");
  await mkdir(plainProject);
  await writeFile(join(plainProject, "notes.txt"), "My notes\nUse bunx to run a package.\n");
  await writeFile(join(plainProject, "guide.md"), "# Project notes\n\nYou can try bunx from a terminal.\n");
  await addProject("tour-playground", plainProject);
  for (const [width, file] of [[1366, "notes.txt"], [390, "guide.md"]]) {
    const { page, context } = await setup(width);
    await choose(page); await waitStep(page, "Read a project file");
    assert.match(await tour(page).innerText(), /Choose any text file/);
    assert.match(await tour(page).innerText(), /No README or package.json is required/);
    await action(page, "Open files");
    await page.locator('[data-onboarding="explorer"]:visible').getByText(file, { exact: true }).first().click();
    await waitStep(page, "Search your project");
    if (file.endsWith(".md")) assert.equal(await page.getByRole("heading", { name: "Project notes", exact: true }).isVisible(), true);
    const data = await search(page);
    assert.ok(data.total >= 2, "real backend search finds bunx content without a fixture grep PATH");
    assert.deepEqual(data.results.map((entry) => entry.file).sort(), ["guide.md", "notes.txt"]);
    const progress = await state(page);
    assert.deepEqual(progress.completed, ["project", "file", "search"]);
    assert.deepEqual(progress.skipped, []);
    await capture(page, `arbitrary-file-real-search-${width}`);
    results.push({ case: `arbitrary-${file}-and-real-bunx-search-${width}`, passed: true, total: data.total, files: data.results.map((entry) => entry.file) });
    await context.close(); await resetWorkspace();
  }
  {
    const emptyProject = join(harness.sandbox, "empty-project");
    await mkdir(emptyProject); await addProject("tour-empty", emptyProject);
    const { page, context } = await setup();
    await page.locator('[data-onboarding="project"]:visible').click();
    await page.getByText("tour-empty", { exact: true }).last().click();
    await choose(page); await waitStep(page, "Read a project file");
    const skip = tour(page).getByRole("button", { name: "Skip empty project step", exact: true });
    await skip.waitFor();
    assert.match(await tour(page).innerText(), /No files are visible in this project yet/);
    await capture(page, "empty-project-clear-skip");
    await skip.click(); await waitStep(page, "Search your project");
    assert.equal((await state(page)).completed.includes("file"), false);
    assert.equal((await state(page)).skipped.includes("file"), true);
    const data = await search(page);
    assert.equal(data.total, 0); assert.deepEqual(data.results, []);
    const progress = await state(page);
    assert.deepEqual(progress.completed, ["project", "search"]);
    assert.deepEqual(progress.skipped, ["file"]);
    assert.equal(await page.getByText("Search failed.", { exact: false }).count(), 0);
    await capture(page, "empty-search-zero-success-honest-summary");
    results.push({ case: "empty-project-explicit-skip-zero-search-success", passed: true });
    await context.close();
  }
} catch (error) {
  results.push({ passed: false, error: String(error) });
  if (currentPage && !currentPage.isClosed()) { await capture(currentPage, "failure"); await writeFile(join(harness.artifacts, "failure.html"), await currentPage.content()); }
  console.error(error); process.exitCode = 1;
} finally {
  await harness.browser.close(); await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ isolation: { sandbox: harness.sandbox, api: harness.api, web: harness.web, realAI: false, injectedGrepPath: false }, results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
