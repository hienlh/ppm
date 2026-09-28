import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The canvas self-check against a real browser: the design that triggered it (a grid whose
// activity bar was pushed into an implicit fourth column) served under the design CSP in a
// `sandbox="allow-scripts"` frame with the real bridge, asked over the real postMessage
// protocol. The broken copy must name `.activity-bar`; the repaired copy must be clean.
// Needs no PPM server. Run with Node: PPM_PLAYWRIGHT_MODULE=<playwright/index.mjs>
// PPM_PLAYWRIGHT_CHANNEL=chrome node tests/e2e/design-canvas-check-e2e.mjs

const NONCE = "canvasCheckNonce0123456789";
const ORIGIN = "http://canvas-check.test";
const docs = JSON.parse(execFileSync("bun", ["tests/e2e/fixtures/design-canvas-check-documents.ts", NONCE], {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PPM_HOME: mkdtempSync(join(tmpdir(), "ppm-check-")) },
}));

const parentHtml = (page) => `<!doctype html><html><body style="margin:0">
<iframe id="canvas" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/design/${page}"
  style="border:0;width:1280px;height:800px"></iframe>
<script>
  window.readyGen = null;
  const answers = new Map();
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== document.getElementById("canvas").contentWindow || !m || m.ppm !== "design-bridge") return;
    if (m.nonce !== ${JSON.stringify(NONCE)}) return;
    if (m.type === "ready") window.readyGen = m.gen;
    if (m.type === "check-result" || m.type === "check-error") answers.get(m.requestId)?.(m);
  });
  window.runCheck = (screenshot, lib) => new Promise((resolve) => {
    const requestId = "req" + Math.random().toString(36).slice(2, 12);
    answers.set(requestId, resolve);
    const msg = { ppm: "design-bridge", v: 1, nonce: null, type: "check-run", requestId, screenshot };
    if (lib) msg.lib = lib;
    document.getElementById("canvas").contentWindow.postMessage(msg, "*");
  });
</script></body></html>`;

const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
const browser = await chromium.launch({ channel: process.env.PPM_PLAYWRIGHT_CHANNEL || undefined });
const artifacts = process.env.PPM_HTML_PREVIEW_ARTIFACTS || mkdtempSync(join(tmpdir(), "ppm-check-art-"));
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const design = { "Content-Security-Policy": docs.csp, "Content-Type": "text/html; charset=utf-8" };
    const files = {
      "/broken.html": [parentHtml("broken.html"), { "Content-Type": "text/html" }],
      "/repaired.html": [parentHtml("repaired.html"), { "Content-Type": "text/html" }],
      "/design/broken.html": [docs.broken, design],
      "/design/repaired.html": [docs.repaired, design],
      "/design/styles.css": [docs.css, { "Content-Type": "text/css" }],
      "/tokens.css": [docs.tokens, { "Content-Type": "text/css" }],
    };
    const hit = files[url.pathname];
    return hit ? route.fulfill({ status: 200, body: hit[0], headers: hit[1] }) : route.fulfill({ status: 404, body: "" });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${ORIGIN}/broken.html`);
  await page.waitForFunction(() => window.readyGen === "0123456789abcdef");
  const broken = await page.evaluate(([lib]) => window.runCheck(true, lib), [docs.lib]);
  assert.equal(broken.type, "check-result", `check answered ${broken.type}: ${broken.message ?? ""}`);
  const grid = broken.report.findings.find((f) => f.kind === "implicit-grid");
  assert.ok(grid, `no implicit-grid finding in ${JSON.stringify(broken.report.findings)}`);
  assert.match(grid.element, /div\.workspace/);
  assert.match(grid.message, /grid-template-columns defines 3 columns, but 3 columns were added implicitly/);
  assert.match(grid.message, /aside\.activity-bar \(grid-row: 1 \/ -1\)/);
  assert.match(grid.message, /\.status-bar \(grid-column: 1 \/ -1; grid-row: 2\)/);
  assert.equal(broken.report.viewport.width, 1280);
  console.log("PASS broken grid:", grid.message);

  if (broken.report.screenshot) {
    const shot = broken.report.screenshot;
    assert.match(shot.dataUrl, /^data:image\/jpeg;base64,/);
    assert.ok(shot.width <= 1280 && (shot.dataUrl.length * 3) / 4 <= 400 * 1024 + 64, "screenshot within limits");
    writeFileSync(join(artifacts, "broken-canvas.jpg"), Buffer.from(shot.dataUrl.split(",")[1], "base64"));
    await page.locator("#canvas").screenshot({ path: join(artifacts, "broken-browser.png") });
    console.log(`PASS screenshot ${shot.width}x${shot.height} (${broken.report.screenshotNote ?? ""})`);
  } else {
    console.log(`NOTE no screenshot: ${broken.report.screenshotNote}`);
  }

  await page.goto(`${ORIGIN}/repaired.html`);
  await page.waitForFunction(() => window.readyGen === "0123456789abcdef");
  const repaired = await page.evaluate(([lib]) => window.runCheck(true, lib), [docs.lib]);
  if (repaired.report.screenshot) writeFileSync(join(artifacts, "repaired-canvas.jpg"), Buffer.from(repaired.report.screenshot.dataUrl.split(",")[1], "base64"));
  assert.equal(repaired.type, "check-result");
  const leftover = repaired.report.findings.filter((f) => f.kind === "implicit-grid");
  assert.deepEqual(leftover, [], "the repaired grid is clean");
  console.log(`PASS repaired grid: ${repaired.report.findings.length} other findings`, repaired.report.findings.map((f) => f.kind));
  writeFileSync(join(artifacts, "results.json"), JSON.stringify({ broken: broken.report.findings, repaired: repaired.report.findings }, null, 2));
  assert.deepEqual(errors, [], "no page errors");
  console.log(`artifacts: ${artifacts}`);
} finally {
  await browser.close();
}
