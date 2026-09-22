import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOnboardingHarness } from "./fixtures/onboarding-harness.mjs";

const harness = await createOnboardingHarness();
const results = [];
let currentPage;
const diagnostics = [];
const levels = ["I'm just getting started", "I've used similar tools", "I'm a developer / advanced user"];
const goals = { ai: "Work with AI", explore: "Explore a project", developer: "Use development tools" };
const waitStep = (page, text) => page.getByRole("complementary", { name: "PPM guided tour" }).getByRole("heading", { name: text, exact: true }).waitFor({ timeout: 25000 });
async function expand(page) {
  const button = page.getByRole("button", { name: "Expand guide", exact: true });
  if (await button.isVisible()) await button.click();
}
async function action(page, name) {
  await expand(page);
  await page.getByRole("complementary", { name: "PPM guided tour" }).getByRole("button", { name, exact: true }).click();
}
async function screenshot(page, name) {
  await page.screenshot({ path: join(harness.artifacts, `${name}.png`), fullPage: true });
}
try {
  // Start with a truly empty registry; add only a newly created scratch project.
  const empty = await (await fetch(`${harness.api}/api/projects`)).json();
  assert.equal(empty.data.length, 0);
  for (const mobile of [false, true]) for (let level = 0; level < levels.length; level++) for (const goal of Object.keys(goals)) {
    const name = `${mobile ? "mobile" : "desktop"}-${level}-${goal}`;
    if (process.env.PPM_TOUR_CASE && name !== process.env.PPM_TOUR_CASE) continue;
    if (results.length) {
      // Each case starts with an empty workspace in the disposable instance,
      // rather than inheriting already-open editors from the previous case.
      const reset = await fetch(`${harness.api}/api/project/tour-playground/workspace`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: {
        panels: { main: { id: "main", tabs: [], activeTabId: null, tabHistory: [] } }, grid: [["main"]], focusedPanelId: "main",
      } }) });
      assert.equal(reset.ok, true);
    }
    const context = await harness.browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: mobile, hasTouch: mobile,
      recordVideo: level === 0 ? { dir: harness.artifacts, size: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } } : undefined });
    // PPM's DEV sockets bypass Vite on fixed 8081. Redirect only their destination,
    // never the real protocol/messages, and forbid traffic outside this sandbox.
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
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") diagnostics.push(message.text()); });
    page.on("websocket", (socket) => {
      diagnostics.push(`WS ${socket.url()}`);
      socket.on("framereceived", ({ payload }) => diagnostics.push(`RX ${String(payload).slice(0, 500)}`));
      socket.on("framesent", ({ payload }) => diagnostics.push(`TX ${String(payload).slice(0, 500)}`));
      socket.on("socketerror", (error) => diagnostics.push(`WS ERROR ${error}`));
    });
    await page.goto(harness.web);
    await page.getByRole("button", { name: "Start guided tour", exact: true }).click();
    if (level === 0 && goal === "ai") await screenshot(page, `${name}-choose-experience`);
    await page.getByRole("button", { name: levels[level], exact: false }).click();
    if (level === 0 && goal === "ai") await screenshot(page, `${name}-choose-goal`);
    await page.getByRole("button", { name: goals[goal], exact: false }).click();
    if (!mobile && level === 0 && goal === "ai") {
      await action(page, "Choose project");
      await page.getByRole("button", { name: "Add Project", exact: true }).click();
      await page.getByPlaceholder("/path/to/project", { exact: true }).fill(harness.project);
      await page.getByPlaceholder("my-project", { exact: true }).fill("tour-playground");
      await page.getByRole("dialog").getByRole("button", { name: "Add Project", exact: true }).click();
    }
    if (goal === "ai") {
      await waitStep(page, "Open AI chat");
      await action(page, "Open chat");
      await waitStep(page, "Ask about your project");
      await action(page, "Use suggested question");
      const input = page.locator('[data-onboarding="chat-input"] textarea:visible');
      await input.waitFor();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some((el) => el.value.startsWith("Summarize this project")));
      await page.locator('[data-onboarding="chat-input"] button[aria-label="Send"], [data-onboarding="chat-input"] button[aria-label="Send message"]').filter({ visible: true }).click();
      await waitStep(page, "Find your conversation");
      if (level === 0) await screenshot(page, `${name}-answer`);
      await action(page, "Show conversation history");
      await page.locator('[data-onboarding="chat-history-session"]:visible').first().click();
    } else if (goal === "explore") {
      await waitStep(page, "Read a project file");
      await action(page, "Open files");
      await page.locator('[data-onboarding="explorer"]:visible').getByText("package.json", { exact: true }).first().click();
      await waitStep(page, "Search your project");
      await action(page, "Open search");
      await page.locator('[data-onboarding="search"] input').first().fill("playground");
    } else {
      await waitStep(page, "Open the terminal");
      await action(page, "Open terminal");
      await waitStep(page, "View project changes");
      await action(page, "Open Git changes");
      await waitStep(page, "Find how to run the project");
      await action(page, "Find run instructions");
      // Opening the document is asynchronous and collapses guidance when it
      // finishes. Wait for that transition before reopening the card.
      await page.getByRole("heading", { name: "Tour playground", exact: true }).waitFor();
      await page.getByRole("button", { name: "Expand guide", exact: true }).waitFor();
      await expand(page);
      await page.getByRole("button", { name: "I know where to run commands", exact: true }).click();
    }
    await waitStep(page, "Your walkthrough is complete");
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem("ppm-onboarding-v1")));
    assert.equal(state.skipped.length, 0, name);
    assert.equal(state.status, "finished", name);
    assert.deepEqual(errors, [], `${name}: page errors`);
    if (level === 0) await screenshot(page, `${name}-complete`);
    const video = page.video();
    await context.close();
    if (video) await video.saveAs(join(harness.artifacts, `${name}.webm`));
    results.push({ name, passed: true, steps: state.completed });
    console.log(`PASS ${name}`);
  }
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await screenshot(currentPage, "failure");
    await writeFile(join(harness.artifacts, "failure.html"), await currentPage.content());
  }
  results.push({ passed: false, error: String(error) });
  process.exitCode = 1;
  console.error(error);
} finally {
  await harness.browser.close();
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ isolation: { sandbox: harness.sandbox, api: harness.api, web: harness.web, realAI: false }, results }, null, 2));
  await writeFile(join(harness.artifacts, "diagnostics.log"), diagnostics.join("\n"));
}
