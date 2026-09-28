import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createOnboardingHarness } from "./fixtures/onboarding-harness.mjs";

const harness = await createOnboardingHarness();
const results = [];
let currentPage;
try {
  for (const width of [1366, 390, 320]) {
    const name = width > 768 ? "desktop" : `mobile-${width}`;
    const context = await harness.browser.newContext({ viewport: { width, height: width > 768 ? 900 : 844 },
      isMobile: width < 768, hasTouch: width < 768,
      recordVideo: width !== 320 ? { dir: harness.artifacts, size: { width, height: width > 768 ? 900 : 844 } } : undefined });
    await context.addInitScript(({ api, web }) => {
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(input, protocols) {
          const url = new URL(String(input), location.href);
          if (url.hostname === "127.0.0.1" && url.port === "8081" && url.pathname.startsWith("/ws/")) url.port = new URL(api).port;
          if (![new URL(api).host, new URL(web).host].includes(url.host)) throw new Error("Socket outside sandbox refused");
          super(url.href, protocols);
        }
      };
    }, { api: harness.api, web: harness.web });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return [new URL(harness.api).host, new URL(harness.web).host].includes(url.host) || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage(); currentPage = page;
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(harness.web);
    const tour = page.getByRole("complementary", { name: "PPM guided tour" });
    await tour.getByRole("button", { name: "Quick orientation", exact: true }).click();
    await page.getByRole("heading", { name: "Find your way around PPM" }).waitFor();
    await page.screenshot({ path: join(harness.artifacts, `${name}-palette-intro.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: width > 768 ? "Left rail" : "Navigation buttons", exact: true }).click();
    for (const label of ["Chat History", "Teams", "Explorer", "Search", "Git", "Database", "Cloudflare Tunnels", "AI Resources", "File Explorer", "Settings", "Report Bug"]) {
      assert.ok(await page.getByRole("dialog").getByText(label, { exact: true }).count(), label);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(harness.artifacts, `${name}-navigation.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("dialog").getByText("Report Bug", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(harness.artifacts, `${name}-utilities.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Back to what I was doing", exact: true }).click();
    await tour.getByRole("button", { name: "Start guided tour", exact: true }).click();
    await page.getByRole("button", { name: "I'm just getting started", exact: false }).click();
    await page.getByRole("button", { name: "Explore a project", exact: false }).click();
    await tour.getByRole("heading", { name: "Choose a project", exact: true }).waitFor();
    const before = await page.evaluate(() => localStorage.getItem("ppm-onboarding-v1"));
    await tour.getByRole("button", { name: "Quick orientation", exact: true }).click();
    await page.getByRole("button", { name: "Open Command Palette", exact: true }).click();
    const input = page.getByPlaceholder("Search actions & files... (type / or ~/ for filesystem)", { exact: true });
    await input.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("placeholder")?.startsWith("Search actions & files"));
    await input.fill("Settings");
    await page.screenshot({ path: join(harness.artifacts, `${name}-real-palette.png`), fullPage: true, animations: "disabled" });
    await input.press("Escape");
    await input.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => localStorage.getItem("ppm-onboarding-v1")), before, "Palette must not pause/reset/advance tour");
    await tour.getByRole("button", { name: "Expand guide", exact: true }).click();
    await tour.getByRole("button", { name: "Quick orientation", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => localStorage.getItem("ppm-onboarding-v1")), before, "Closing orientation preserves progress");
    if (width > 768) {
      await page.keyboard.press("Shift"); await page.keyboard.press("Shift");
      await input.waitFor(); await input.press("Escape");
      await page.keyboard.press("F1"); await input.waitFor(); await input.press("Escape");
    }
    assert.deepEqual(errors, []);
    assert.equal((await (await fetch(`${harness.api}/api/projects`)).json()).data.length, 0);
    const video = page.video(); await context.close();
    if (video) await video.saveAs(join(harness.artifacts, `${name}-quick-orientation.webm`));
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  }
} catch (error) {
  results.push({ passed: false, error: String(error) }); process.exitCode = 1;
  if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: join(harness.artifacts, "failure.png"), fullPage: true, animations: "disabled" });
  console.error(error);
} finally {
  await harness.browser.close(); await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ isolation: { sandbox: harness.sandbox, api: harness.api, web: harness.web }, results }, null, 2));
}
