// The last step of the restart-news e2e: Settings → PPM Assistant → Digest & quiet hours on the
// production bundle. On a desktop the switch is turned off and on again and the stored setting
// follows; on both a desktop (1440x900) and a phone (390x844) the switch is on screen, nothing
// covers it, and a screenshot is kept.
import assert from "node:assert/strict";
import { join } from "node:path";
import { until } from "./restart-kit.mjs";

const LABEL = "Tell the Assistant after PPM restarts";
const DEVICES = [
  { name: "desktop", context: { viewport: { width: 1440, height: 900 } } },
  { name: "phone", context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
];

export async function settingsScreens(k, s) {
  const browser = await s.launch();
  const sizes = {};
  for (const device of DEVICES) {
    const context = await browser.newContext({ ...device.context, serviceWorkers: "block" });
    await context.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    try {
      await page.goto(`${s.web}/project/alpha/settings`);
      const body = page.locator('[data-testid="settings-window"]:visible').first();
      await body.waitFor({ timeout: 30000 });
      // The rail and the index both name it; only one of them is shown at a given width.
      await body.locator(':text-is("PPM Assistant"):visible').first().click();
      await page.locator('[data-testid="assistant-settings-tab-digest"]:visible').first().click();
      const toggle = page.locator(`[role="switch"][aria-label="${LABEL}"]:visible`).first();
      await toggle.waitFor({ timeout: 30000 });
      assert.equal(await toggle.getAttribute("aria-checked"), "true", `${device.name}: the switch shows the stored setting (on)`);

      if (device.name === "desktop") {
        await toggle.click();
        await until("the switch saved off", async () => (await k.settings()).restart_news === false && (await toggle.getAttribute("aria-checked")) === "false");
        await toggle.click();
        await until("the switch saved on", async () => (await k.settings()).restart_news === true && (await toggle.getAttribute("aria-checked")) === "true");
      }

      await page.locator('[data-testid="assistant-restart-news"]:visible').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const box = await toggle.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= device.context.viewport.height, `${device.name}: the switch is on screen`);
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[role="switch"]')?.getAttribute("aria-label") ?? null,
        [box.x + box.width / 2, box.y + box.height / 2]);
      assert.equal(hit, LABEL, `${device.name}: nothing (a tour, a popup) covers the switch`);
      const help = await page.locator('[data-testid="assistant-restart-news"]:visible').first().innerText();
      assert.ok(help.includes("which chats were cut off"), `${device.name}: the help line is shown`);
      sizes[device.name] = { width: Math.round(box.width), height: Math.round(box.height) };
      await page.screenshot({ path: join(s.shotsDir, `${device.name}-settings-assistant-restart-news.png`) });
      assert.deepEqual(errors.filter((e) => !/read the 'serviceWorker' property/.test(e)), [], `${device.name}: no page errors`);
    } finally {
      await context.close();
    }
  }
  console.log(`switch sizes: ${JSON.stringify(sizes)}`);
  k.record("ui", "Settings → PPM Assistant → Digest & quiet hours: the switch saves restart_news off and on; shown uncovered on desktop and phone (screenshots kept)");
}
