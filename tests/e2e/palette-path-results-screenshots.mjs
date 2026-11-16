/**
 * Screenshots of the command palette's path mode on a folder whose files share a long prefix,
 * the case reported as "every row looks the same and every icon is a folder". Desktop and a
 * 390px phone, a folder query and an exact file query. Runs against disposable API/Vite
 * instances from the HTML preview harness, never the running PPM.
 *
 *   docker run --rm --cpus=4 --memory=3g -v <repo>:/app -v ppm-e2e-nm:/app/node_modules \
 *     -v <out>:/out -w /app ppm-e2e-chromium:latest \
 *     sh -c 'bun install --frozen-lockfile && SHOT_PREFIX=after SHOT_DIR=/out node tests/e2e/palette-path-results-screenshots.mjs'
 *
 * The script uses nothing the change introduced, so the same file run on the commit before it
 * gives the "before" pictures (SHOT_PREFIX=before).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";

const OUT = process.env.SHOT_DIR || "/out";
const PREFIX = process.env.SHOT_PREFIX || "after";
const NAMES = [
  "NX-6641-fail-existing-nx6618-summary-261116.png",
  "NX-6641-pass-bureau-admin-dashboard-261116.png",
  "NX-6641-pass-bureau-employer-dashboard-261116.png",
  "NX-6641-pass-ie-confirmed-261116.png",
  "NX-6641-pass-ie-dashboard-261116.png",
  "NX-6641-pass-ie-manual-draft-result-261116.png",
  "NX-6641-pass-ie-manual-generate-261116.png",
  "NX-6641-pass-ie-payment-confirmed-261116.png",
  "NX-6641-pass-uk-bank-file-261116.png",
  "NX-6641-pass-uk-dashboard-261116.png",
  "NX-6641-notes-261116.md",
];

const harness = await createHtmlPreviewHarness();
await mkdir(OUT, { recursive: true });
try {
  const dir = join(harness.sandbox, "home", ".agents", "skills", "nxsys-e2e-test", "evidence", "NX-6641");
  await mkdir(join(dir, "raw"), { recursive: true });
  for (const name of NAMES) await writeFile(join(dir, name), "x");
  await writeFile(join(dir, "raw", "NX-6641-pass-uk-dashboard-261116.webm"), "x");

  const shots = [
    { name: "folder", query: `${dir}/` },
    { name: "exact-file", query: `${dir}/NX-6641-pass-ie-manual-generate-261116.png` },
  ];
  const devices = [
    { name: "desktop", options: { viewport: { width: 1280, height: 800 } } },
    { name: "phone-390", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ];
  for (const device of devices) {
    const context = await harness.browser.newContext(device.options);
    await context.addInitScript(({ api }) => {
      localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ state: { status: "dismissed" }, version: 1 }));
      // The dev bundle opens its sockets on 8081, which may be another PPM on this machine.
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(input, protocols) {
          const url = new URL(String(input), location.href);
          if (url.hostname === "127.0.0.1" && url.port === "8081") url.port = new URL(api).port;
          super(url.href, protocols);
        }
      };
    }, { api: harness.api });
    const page = await context.newPage();
    await page.goto(harness.web, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    for (const shot of shots) {
      await page.evaluate((q) => window.dispatchEvent(new CustomEvent("open-command-palette", { detail: q })), shot.query);
      await page.waitForSelector("input[placeholder^='Search actions']");
      await page.waitForTimeout(1200);
      const file = join(OUT, `${PREFIX}-${device.name}-${shot.name}.png`);
      await page.screenshot({ path: file });
      console.log(`saved ${file}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
    await context.close();
  }
} finally {
  await harness.browser.close();
  await harness.cleanup();
}
