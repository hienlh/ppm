import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOnboardingHarness } from "./fixtures/onboarding-harness.mjs";

const harness = await createOnboardingHarness();
const results = [];
let currentPage;
const tour = (page) => page.getByRole("complementary", { name: "PPM guided tour" });
const waitStep = (page, name) => tour(page).getByRole("heading", { name, exact: true }).waitFor({ timeout: 25000 });
const state = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ppm-onboarding-v1")));
const capture = (page, name) => page.screenshot({ path: join(harness.artifacts, `edge-${name}.png`), fullPage: true });
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

try {
  assert.equal((await (await fetch(`${harness.api}/api/projects`)).json()).data.length, 0);
  {
    const { page, context } = await setup();
    await choose(page);
    await waitStep(page, "Choose a project");
    for (let index = 0; index < 3; index++) await action(page, "Skip step");
    await waitStep(page, "Your walkthrough is complete");
    assert.deepEqual((await state(page)).completed, []);
    assert.deepEqual((await state(page)).skipped, ["project", "file", "search"]);
    assert.match(await tour(page).innerText(), /0 steps completed.*3 skipped/);
    await capture(page, "all-skipped-honest-summary");
    results.push({ case: "empty-project-all-skipped", passed: true });
    await context.close();
  }
  const added = await fetch(`${harness.api}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "tour-playground", path: harness.project }) });
  assert.equal(added.status, 201);
  {
    const { page, context } = await setup();
    await choose(page, "Work with AI");
    await waitStep(page, "Open AI chat");
    await action(page, "Open chat");
    await waitStep(page, "Ask about your project");
    const input = page.locator('[data-onboarding="chat-input"] textarea:visible');
    const send = page.locator('[data-onboarding="chat-input"] button[aria-label="Send"], [data-onboarding="chat-input"] button[aria-label="Send message"]').filter({ visible: true });
    await input.fill("Please explain this sandbox project.");
    await send.click();
    await page.getByText("This is a deterministic", { exact: false }).first().waitFor();
    await page.locator('button[aria-label="Stop"], button[aria-label="Stop response"]').filter({ visible: true }).click();
    await send.waitFor({ state: "visible" });
    // Wait beyond the provider's entire response duration so a late idle cannot pass unnoticed.
    await page.waitForTimeout(2000);
    assert.equal((await state(page)).currentStep, "send");
    assert.equal((await state(page)).completed.includes("send"), false);
    await capture(page, "partial-response-canceled-no-completion");
    await input.fill("Please explain this sandbox project again.");
    await send.click();
    await waitStep(page, "Find your conversation");
    const answered = await state(page);
    assert.equal(answered.completed.includes("send"), true);
    assert.ok(answered.sessionId);
    results.push({ case: "real-chat-partial-cancel-stays-send-retry-completes", passed: true });
    await page.getByRole("button", { name: "Pause tour", exact: true }).click();
    const deleted = await fetch(`${harness.api}/api/project/tour-playground/chat/sessions/${encodeURIComponent(answered.sessionId)}?providerId=tour-test`, { method: "DELETE" });
    assert.equal(deleted.ok, true);
    await tour(page).getByRole("button", { name: "Resume tour", exact: true }).click();
    await page.waitForFunction(() => {
      const value = JSON.parse(localStorage.getItem("ppm-onboarding-v1"));
      return value.sessionId === null && !value.completed.includes("send") && ["chat", "send"].includes(value.currentStep);
    });
    const reset = await state(page);
    assert.equal(reset.completed.includes("history"), false);
    assert.equal(reset.status, "active");
    await capture(page, "deleted-session-requires-new-chat-turn");
    results.push({ case: "deleted-session-history-resume-resets-to-chat-workflow", passed: true, currentStep: reset.currentStep });
    await context.close();
    // Keep later cases independent from this deleted chat tab.
    const resetWorkspace = await fetch(`${harness.api}/api/project/tour-playground/workspace`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: {
      panels: { main: { id: "main", tabs: [], activeTabId: null, tabHistory: [] } }, grid: [["main"]], focusedPanelId: "main",
    } }) });
    assert.equal(resetWorkspace.ok, true);
  }
  {
    const { page, context } = await setup();
    await choose(page);
    await waitStep(page, "Read a project file");
    await action(page, "Open files");
    await page.locator('[data-onboarding="explorer"]:visible').getByText("package.json", { exact: true }).first().click();
    await waitStep(page, "Search your project");
    const before = await state(page);
    await page.keyboard.press("Escape");
    await waitStep(page, "Continue when you're ready");
    await page.reload();
    await waitStep(page, "Continue when you're ready");
    assert.deepEqual((await state(page)).completed, before.completed);
    await tour(page).getByRole("button", { name: "Resume tour", exact: true }).click();
    await waitStep(page, "Search your project");
    assert.deepEqual((await state(page)).completed, before.completed);
    await capture(page, "reload-resume-preserves-progress");
    results.push({ case: "escape-pause-reload-resume", passed: true, completed: before.completed });
    await context.close();
  }
  {
    const { page, context } = await setup();
    await choose(page, "Work with AI");
    await waitStep(page, "Open AI chat");
    await action(page, "Open chat");
    await waitStep(page, "Ask about your project");
    await page.getByRole("button", { name: "Pause tour", exact: true }).click();
    await tour(page).getByRole("button", { name: "Maybe later", exact: true }).click();
    await tour(page).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Resume guided tour", exact: true }).click();
    await waitStep(page, "Ask about your project");
    await capture(page, "dismiss-reopen-chat-welcome");
    results.push({ case: "dismiss-reopen-through-chat-welcome", passed: true });
    await context.close();
  }
  {
    const { page, context } = await setup(320);
    await page.evaluate(() => localStorage.setItem("ppm-onboarding-v1", "{bad-json"));
    await page.reload();
    await page.getByRole("button", { name: "Start guided tour", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)), true);
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await capture(page, "320px-chooser-reduced-motion");
    await page.getByRole("button", { name: "I've used similar tools", exact: false }).click();
    await page.getByRole("button", { name: "Explore a project", exact: false }).click();
    await waitStep(page, "Read a project file");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press("Escape");
    await waitStep(page, "Continue when you're ready");
    await capture(page, "320px-paused-keyboard-emulation");
    results.push({ case: "corrupt-storage-320px-reduced-motion-tab-escape", passed: true, keyboard: "Playwright key emulation; no real mobile software keyboard" });
    await context.close();
  }
  {
    const { page, context } = await setup(768);
    await page.getByRole("button", { name: "Start guided tour", exact: true }).click();
    for (const mode of ["dark", "light"]) {
      await page.evaluate(async (mode) => {
        const { useSettingsStore } = await import("/stores/settings-store.ts");
        useSettingsStore.getState().setThemeMode(mode);
      }, mode);
      await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, mode === "dark");
      for (const size of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
        await page.setViewportSize(size);
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        const box = await dialog.boundingBox();
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await capture(page, `tablet-${mode}-${size.width}`);
      }
    }
    results.push({ case: "tablet-portrait-landscape-dark-light", passed: true });
    await context.close();
  }
} catch (error) {
  results.push({ passed: false, error: String(error) });
  if (currentPage && !currentPage.isClosed()) {
    await capture(currentPage, "failure");
    await writeFile(join(harness.artifacts, "edge-failure.html"), await currentPage.content());
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await harness.browser.close();
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "edge-results.json"), JSON.stringify({ isolation: { sandbox: harness.sandbox, api: harness.api, web: harness.web, realAI: false }, results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
