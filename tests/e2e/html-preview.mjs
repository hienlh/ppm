import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";

// Run with Node + Playwright and Bun installed. The supplied gallery needs linked PNG
// images and a playable video. It is copied into scratch space before any edits.
// PPM_HTML_PREVIEW_SOURCE can point to another gallery; no user files are changed.
const source = resolve(process.env.PPM_HTML_PREVIEW_SOURCE || "plans/260921-1839-adaptive-user-onboarding/artifacts/index.html");
await readFile(source).catch(() => { throw new Error(`Missing sample gallery: ${source}. Set PPM_HTML_PREVIEW_SOURCE to its HTML entry file.`); });
const harness = await createHtmlPreviewHarness();
const results = [], diagnostics = [];
let page;
const record = (name, detail = {}) => { results.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
try {
  const gallery = join(harness.project, "gallery");
  await cp(dirname(source), gallery, { recursive: true });
  const filePath = join(gallery, basename(source));
  const original = await readFile(filePath, "utf8");
  await writeFile(join(gallery, "preview-proof.css"), "#module-proof { color: rgb(12, 34, 56) }");
  await writeFile(join(gallery, "preview-proof.mjs"), "document.getElementById('module-proof').textContent = 'Module executed';");
  await writeFile(join(gallery, "child.html"), "<!doctype html><h1>Linked child page</h1>");
  const proof = '<link rel="stylesheet" href="preview-proof.css"><p id="inline-proof"></p><p id="module-proof"></p><script>document.getElementById("inline-proof").textContent="Inline executed";</script><script type="module" src="preview-proof.mjs"></script><a id="child-link" href="child.html">Child page</a>';
  await writeFile(filePath, original + proof);
  const projectResponse = await fetch(`${harness.api}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: "html-preview-test" }) });
  assert.ok(projectResponse.ok);
  for (const width of [1366, 390]) {
    const context = await harness.browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768 });
    await context.addInitScript(({ api }) => {
      localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ state: { status: "dismissed" }, version: 1 }));
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(input, protocols) {
          const url = new URL(String(input), location.href);
          if (url.hostname === "127.0.0.1" && url.port === "8081") url.port = new URL(api).port;
          super(url.href, protocols);
        }
      };
    }, { api: harness.api });
    page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") diagnostics.push(m.text()); });
    await page.goto(harness.web);
    await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
    const tabId = await page.evaluate(async ({ filePath }) => {
      const projects = (await import("/stores/project-store.ts")).useProjectStore.getState();
      await projects.fetchProjects();
      const project = (await import("/stores/project-store.ts")).useProjectStore.getState().projects.find((p) => p.name === "html-preview-test");
      projects.setActiveProject(project);
      const tabs = (await import("/stores/tab-store.ts")).useTabStore.getState();
      tabs.switchProject(project.name);
      return tabs.openTab({ type: "editor", title: "index.html", projectId: project.name, closable: true, metadata: { filePath, projectName: project.name } });
    }, { filePath });
    const iframe = page.locator('iframe[title="HTML preview"]');
    await iframe.waitFor({ timeout: 30000 });
    let frame = await (await iframe.elementHandle()).contentFrame();
    await frame.waitForFunction(() => document.images.length > 0 && [...document.images].every((image) => image.complete && image.naturalWidth > 0), { timeout: 30000 });
    const media = await frame.evaluate(async () => {
      const video = document.querySelector("video");
      if (video.readyState < 1) await new Promise((done, reject) => { video.onloadedmetadata = done; video.onerror = reject; setTimeout(() => reject(new Error("Video metadata timeout")), 15000); });
      video.muted = true;
      await video.play();
      await new Promise((done, reject) => { video.onseeked = done; video.currentTime = Math.min(2, video.duration / 2); setTimeout(() => reject(new Error("Video seek timeout")), 15000); });
      video.pause();
      return { images: document.images.length, duration: video.duration, currentTime: video.currentTime };
    });
    assert.ok(media.currentTime > 0);
    record(`${width}px gallery images, playback and seeking`, media);
    assert.equal(await frame.locator("#inline-proof").textContent(), "Inline executed");
    await frame.waitForFunction(() => document.getElementById("module-proof")?.textContent === "Module executed");
    assert.equal(await frame.locator("#module-proof").evaluate((el) => getComputedStyle(el).color), "rgb(12, 34, 56)");
    record(`${width}px inline JS, sibling module and CSS`);
    const toolbar = page.getByRole("toolbar", { name: "HTML preview" });
    // Reproduce the user's navigation trap using a real linked gallery image.
    await frame.locator('a[href$=".png"] img').first().click();
    await frame.waitForURL(/\.png$/);
    await toolbar.getByRole("button", { name: "Refresh preview", exact: true }).click();
    await iframe.waitFor();
    frame = await (await iframe.elementHandle()).contentFrame();
    await frame.waitForFunction((count) => document.images.length === count && [...document.images].every((image) => image.complete && image.naturalWidth > 0), media.images);
    record(`${width}px image click and Refresh preview returns gallery`);
    const controls = [];
    for (const name of ["Code", "Preview", "Refresh preview", "More HTML actions"]) {
      const box = await toolbar.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(box, `${name} visible`);
      if (width < 768) assert.ok(box.width >= 44 && box.height >= 44, `${name} mobile touch target >=44px`);
      controls.push(box.y + box.height / 2);
    }
    assert.ok(Math.max(...controls) - Math.min(...controls) <= 1, "HTML controls occupy one row");
    const toolbarBox = await toolbar.boundingBox();
    if (width > 768) assert.ok(toolbarBox.height <= 36, `Desktop toolbar is compact: ${toolbarBox.height}px`);
    record(`${width}px compact single-row toolbar`, { height: toolbarBox.height });
    await page.screenshot({ path: join(harness.artifacts, `preview-${width}.png`), fullPage: true });
    await toolbar.getByRole("button", { name: "Code", exact: true }).click();
    await iframe.waitFor({ state: "hidden" });
    await page.locator(".monaco-editor").first().waitFor();
    const reloadMarker = `Code reload proof ${width}`;
    await writeFile(filePath, `${original}${proof}<p>${reloadMarker}</p>`);
    await toolbar.getByRole("button", { name: "More HTML actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Reload code from disk", exact: true }).click();
    await page.waitForFunction((marker) => window.monaco?.editor.getModels().some((model) => model.getValue().includes(marker)), reloadMarker);
    assert.equal(await toolbar.getByRole("button", { name: "Code", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await iframe.count(), 0, "Reload code stays in Code mode");
    record(`${width}px Reload code from disk updates Monaco and preserves Code mode`);
    await page.evaluate(() => {
      window.__previewEditorNode = document.querySelector(".monaco-editor");
      window.__previewModel = window.monaco?.editor.getModels()[0];
    });
    await toolbar.getByRole("button", { name: "Preview", exact: true }).click();
    await iframe.waitFor();
    await toolbar.getByRole("button", { name: "Code", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__previewEditorNode === document.querySelector(".monaco-editor")), true);
    assert.equal(await page.evaluate(() => !!window.__previewModel && window.monaco.editor.getModels().includes(window.__previewModel)), true);
    await toolbar.getByRole("button", { name: "Preview", exact: true }).click();
    await iframe.waitFor();
    await writeFile(filePath, `${original}${proof}<p id="refresh-proof">Saved refresh ${width}</p>`);
    await toolbar.getByRole("button", { name: "Refresh preview", exact: true }).click();
    await page.frameLocator('iframe[title="HTML preview"]').locator("#refresh-proof").waitFor();
    record(`${width}px Code/Preview and Refresh`);
    frame = await (await iframe.elementHandle()).contentFrame();
    const security = await frame.evaluate(async () => {
      const result = {};
      try { void parent.document.body; result.parent = false; } catch { result.parent = true; }
      try { void localStorage.length; result.storage = false; } catch { result.storage = true; }
      try { await fetch("/api/projects"); result.api = false; } catch { result.api = true; }
      return result;
    });
    assert.deepEqual(security, { parent: true, storage: true, api: true });
    record(`${width}px sandbox blocks parent, storage and API`, security);
    const direct = await context.newPage();
    await direct.goto(new URL(await iframe.getAttribute("src"), harness.web).href);
    assert.equal(await direct.evaluate(() => { try { void localStorage.length; return false; } catch { return true; } }), true);
    await direct.locator("#child-link").click();
    await direct.getByRole("heading", { name: "Linked child page" }).waitFor();
    await direct.close();
    record(`${width}px direct URL sandbox and descendant HTML link`);
    if (width > 768) {
      await page.locator(`[data-tab-id=${JSON.stringify(tabId)}]`).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Open in window", exact: true }).click();
      await page.locator('[role="group"]').filter({ has: iframe }).waitFor();
      await page.screenshot({ path: join(harness.artifacts, "preview-window.png"), fullPage: true });
      await page.getByRole("button", { name: "Close window", exact: true }).click();
      await page.locator(`[data-tab-id=${JSON.stringify(tabId)}]`).waitFor();
      await page.frameLocator('iframe[title="HTML preview"]').locator("#refresh-proof").waitFor();
      record("desktop pop-out and re-dock");
    } else {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      record("390px no outer horizontal overflow");
    }
    await context.close();
  }
} catch (error) {
  process.exitCode = 1; results.push({ passed: false, error: String(error), stack: error.stack }); console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(harness.artifacts, "failure.png"), fullPage: true });
} finally {
  await harness.browser.close(); await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ results, diagnostics, sandbox: harness.sandbox }, null, 2));
  console.log(`Artifacts: ${harness.artifacts}`);
}
