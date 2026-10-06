import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";

// The HTML preview loads CDN scripts and styles, and its bridge answers the self-check the
// AI's `open_preview` tool asks for. Needs Node + Playwright (PPM_PLAYWRIGHT_MODULE) + Bun,
// and internet access for the CDNs. Runs on a disposable API + Vite pair; no user files.
const harness = await createHtmlPreviewHarness();
const results = [], diagnostics = [];
const record = (name, detail = {}) => { results.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
let page;

const DASHBOARD = `<!doctype html><html><head><meta charset="utf-8"><title>Sales</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@700&display=swap" rel="stylesheet">
</head><body class="bg-slate-900 p-6">
<h1 id="title" class="text-3xl font-bold text-emerald-400" style="font-family: Inter, sans-serif">Sales</h1>
<div class="w-[600px] h-[300px]"><canvas id="chart"></canvas></div>
<script>
new Chart(document.getElementById("chart"), { type: "bar", data: { labels: ["Q1", "Q2", "Q3"],
  datasets: [{ label: "Revenue", data: [3, 5, 2], backgroundColor: "#34d399" }] }, options: { animation: false, maintainAspectRatio: false } });
window.__chartDrawn = true;
</script></body></html>`;

const BROKEN = `<!doctype html><html><head><meta charset="utf-8"><title>Broken</title>
<script src="https://esm.sh/canvas-confetti@1.9.3"></script>
<script src="missing.js"></script>
</head><body><p>Broken page</p>
<script>window.notDefinedFunction();</script>
</body></html>`;

async function openPreview(context, filePath) {
  page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") diagnostics.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) diagnostics.push(`${r.status()} ${r.url()}`); });
  await page.goto(harness.web);
  await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  await page.evaluate(async ({ filePath }) => {
    const projects = (await import("/stores/project-store.ts")).useProjectStore.getState();
    await projects.fetchProjects();
    const project = (await import("/stores/project-store.ts")).useProjectStore.getState().projects.find((p) => p.name === "cdn-check");
    projects.setActiveProject(project);
    const tabs = (await import("/stores/tab-store.ts")).useTabStore.getState();
    tabs.switchProject(project.name);
    tabs.openTab({ type: "editor", title: filePath, projectId: project.name, closable: true, metadata: { filePath, projectName: project.name } });
  }, { filePath });
  // Tabs persist in this context, so the previous file's preview may be mounted too.
  const iframe = page.locator(`iframe[title="HTML preview"][src*="/${filePath.split("/").pop()}?"]`);
  await iframe.waitFor({ timeout: 30000 });
  return (await iframe.elementHandle()).contentFrame();
}

/** Runs the check the way the tool will: through the registry, after the load finished. */
const runCheck = (filePath, screenshot) => page.evaluate(async ({ filePath, screenshot }) => {
  const loads = await import("/lib/html-preview-loads.ts");
  const load = await loads.waitForPreviewLoad(loads.previewKey("cdn-check", filePath), 0, 20000);
  if (!load) return { error: "no load" };
  await new Promise((done) => setTimeout(done, 1500));
  const report = await load.check({ screenshot, frame: "Desktop" });
  return { ...report, screenshot: report.screenshot ? { width: report.screenshot.width, height: report.screenshot.height, bytes: report.screenshot.dataUrl.length } : undefined };
}, { filePath, screenshot });

try {
  const site = join(harness.project, "site");
  await mkdir(site, { recursive: true });
  await writeFile(join(site, "dashboard.html"), DASHBOARD);
  await writeFile(join(site, "broken.html"), BROKEN);
  const created = await fetch(`${harness.api}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: "cdn-check" }) });
  assert.ok(created.ok);
  const context = await harness.browser.newContext({ viewport: { width: 1366, height: 900 } });
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

  let frame = await openPreview(context, "site/dashboard.html");
  await frame.waitForFunction(() => window.__chartDrawn === true, null, { timeout: 30000 });
  const rendered = await frame.evaluate(() => {
    const title = document.getElementById("title");
    const canvas = document.getElementById("chart");
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++;
    return { color: getComputedStyle(title).color, background: getComputedStyle(document.body).backgroundColor, painted, bridgeGone: !document.querySelector("script[data-ppm-bridge]") };
  });
  assert.equal(rendered.color, "rgb(52, 211, 153)", "Tailwind CDN styled the heading");
  assert.equal(rendered.background, "rgb(15, 23, 42)", "Tailwind CDN styled the body");
  assert.ok(rendered.painted > 1000, `Chart.js drew the chart (${rendered.painted} painted pixels)`);
  assert.equal(rendered.bridgeGone, true, "the bridge removed its own tag");
  record("Tailwind CDN + Chart.js from jsdelivr render in the preview", rendered);

  const clean = await runCheck("site/dashboard.html", true);
  assert.equal(clean.error, undefined, JSON.stringify(clean));
  assert.equal(clean.file, "dashboard.html");
  assert.match(clean.gen, /^[0-9a-f]{16}$/);
  assert.ok(clean.screenshot && clean.screenshot.width > 0, `screenshot attached: ${JSON.stringify(clean.screenshot)} ${clean.screenshotNote ?? ""}`);
  const runtime = clean.findings.filter((f) => f.kind === "runtime");
  assert.deepEqual(runtime, [], `no runtime problems on the clean page: ${JSON.stringify(runtime)}`);
  record("check of the clean page: no runtime problems, screenshot attached", { viewport: clean.viewport, page: clean.page, screenshot: clean.screenshot, findings: clean.findings.length });
  await page.screenshot({ path: join(harness.artifacts, "dashboard.png") });
  await page.close();

  frame = await openPreview(context, "site/broken.html");
  await frame.locator("text=Broken page").waitFor();
  const broken = await runCheck("site/broken.html", false);
  assert.equal(broken.error, undefined, JSON.stringify(broken));
  const messages = broken.findings.filter((f) => f.kind === "runtime").map((f) => f.message);
  assert.ok(messages.some((m) => /csp/.test(m) && /esm\.sh/.test(m)), `blocked CDN host reported: ${JSON.stringify(messages)}`);
  assert.ok(messages.some((m) => /resource/.test(m) && /missing\.js/.test(m)), `missing local script reported: ${JSON.stringify(messages)}`);
  assert.ok(messages.some((m) => /notDefinedFunction/.test(m)), `script error reported: ${JSON.stringify(messages)}`);
  assert.equal(broken.screenshot, undefined);
  record("check of the broken page reports the blocked host, the missing file and the script error", { messages });
  await context.close();
} catch (error) {
  process.exitCode = 1; results.push({ passed: false, error: String(error), stack: error.stack }); console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(harness.artifacts, "failure.png"), fullPage: true });
} finally {
  await harness.browser.close(); await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ results, diagnostics, sandbox: harness.sandbox }, null, 2));
  console.log(`Artifacts: ${harness.artifacts}`);
}
