import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { pageInstrumentation } from "./fixtures/design-mode-page-instrumentation.mjs";
import { buildHostileDocx } from "./fixtures/build-hostile-docx.mjs";

// An AI reply holding raw HTML that would run script, navigate or restyle PPM's page, rendered
// in real Chromium against a disposable server (isolated PPM_HOME, sign-in on, scripted reply).
// The sign-in token sits in localStorage as it does for a real user; no payload may read it,
// fire a request, move the page or paint over it — live, and again from history after a reload.
// Ordinary Markdown in the same reply must still render. Screenshots: PPM_SANITIZE_SCREENS.

const TOKEN = "threads-e2e-token";
const PROJECT = "sanitize-e2e";
const STEAL = "localStorage.getItem('ppm-auth-token')";
const REPLY = [
  "Reviewer said:",
  `<iframe id="pwn-iframe" srcdoc="<script>parent.__pwned='iframe:'+parent.${STEAL}</script>"></iframe>`,
  `<img id="pwn-img" src="missing.png" onerror="window.__pwned='img:'+${STEAL}">`,
  `<a id="pwn-a" href="javascript:window.__pwned='a:'+${STEAL}">click me</a>`,
  `<svg onload="window.__pwned='svg'"><circle r="5"/></svg>`,
  `<form id="pwn-form" action="/__pwn/form"><input name="q"><button id="pwn-btn">Go</button></form>`,
  `<object data="data:text/html,<script>parent.__pwned='object'</script>"></object>`,
  `<embed src="data:text/html,<script>parent.__pwned='embed'</script>">`,
  `<meta http-equiv="refresh" content="1;url=/__pwn/meta">`,
  `<base href="https://evil.test/">`,
  `<style>body{background:rgb(255,0,0)!important}</style>`,
  `<details open ontoggle="window.__pwned='details'"><summary>toggle</summary>x</details>`,
  `<div id="pwn-overlay" class="fixed inset-0 z-50 bg-red-500" style="position:fixed;inset:0">FAKE SIGN IN</div>`,
  "",
  "Still rendered: **bold**, <kbd>Ctrl</kbd>, H<sub>2</sub>O, x<sup>2</sup> and $$e^{i\\pi}+1=0$$",
  "",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "",
  "- [x] done\n- [ ] todo",
  "",
  "<details><summary>More</summary>\n\nHidden **text**\n\n</details>",
  "",
  "```ts\nconst answer: number = 42;\n```",
  "",
  "[site](https://example.com)",
].join("\n");

const replyFile = join(process.env.TEMP || "/tmp", `ppm-sanitize-reply-${process.pid}.md`);
await writeFile(replyFile, REPLY);
process.env.PPM_SANITIZE_REPLY_FILE = replyFile;
const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/markdown-sanitize-server.ts" });
const screens = process.env.PPM_SANITIZE_SCREENS || harness.artifacts;
const results = [];
const record = (name) => { results.push(name); console.log(`PASS ${name}`); };
const api = async (path, init = {}) => {
  const res = await fetch(`${harness.api}${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function newTokenPage() {
  const context = await harness.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(pageInstrumentation, { api: harness.api });
  await context.addInitScript((token) => { if (window.top === window) localStorage.setItem("ppm-auth-token", token); }, TOKEN);
  const p = await context.newPage();
  const leaks = [];
  p.on("request", (r) => { if (/__pwn|evil\.test/.test(r.url())) leaks.push(r.url()); });
  p.on("dialog", (d) => { if (d.type() === "beforeunload") { void d.accept(); return; } leaks.push(`dialog:${d.message()}`); void d.dismiss(); });
  await p.goto(harness.web);
  await p.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  await p.evaluate(async (name) => {
    const projects = (await import("/stores/project-store.ts")).useProjectStore;
    await projects.getState().fetchProjects();
    projects.getState().setActiveProject(projects.getState().projects.find((pr) => pr.name === name));
    (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
  }, PROJECT);
  return { context, page: p, leaks };
}

async function mermaidCheck() {
  const { context, page: p, leaks } = await newTokenPage();
  page = p;
  const diagram = [
    "Here is the flow:", "", "```mermaid", "flowchart TD",
    '  A["Start"] --> B["Node B"]',
    "  click B href \"javascript:window.__pwnedMermaid=localStorage.getItem('ppm-auth-token')\"",
    "```",
  ].join("\n");
  await writeFile(replyFile, diagram);
  await p.evaluate(async (name) => (await import("/stores/panel-store.ts")).usePanelStore.getState().openTab({ type: "chat", title: "Chat", projectId: name, closable: true, metadata: { projectName: name } }), PROJECT);
  await p.locator('textarea[placeholder="Ask anything..."]:visible').first().fill("[[sanitize-reply]] draw it");
  await p.locator('button[aria-label="Send message"]:visible, button[aria-label="Send"]:visible').first().click();
  const svg = p.locator(".mermaid-diagram svg").first();
  await svg.waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  const link = p.locator(".mermaid-diagram a").first();
  if (await link.count()) {
    const box = await link.boundingBox();
    if (box) await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await p.waitForTimeout(600);
  }
  const state = await p.evaluate(() => ({
    pwned: window.__pwnedMermaid ?? null,
    jsLinks: [...document.querySelectorAll(".mermaid-diagram a")].map((a) => a.getAttribute("href") ?? a.getAttribute("xlink:href")).filter((u) => /^\s*javascript:/i.test(u ?? "")).length,
    svgs: document.querySelectorAll(".mermaid-diagram svg").length,
    nodes: document.querySelectorAll(".mermaid-diagram .node").length,
  }));
  assert.equal(state.pwned, null, "mermaid: node click ran nothing");
  assert.equal(state.jsLinks, 0, "mermaid: no javascript: link left in the SVG");
  assert.ok(state.svgs >= 1 && state.nodes >= 2, "mermaid: a plain flowchart still renders as an SVG");
  assert.deepEqual(leaks, [], "mermaid: no request from the diagram");
  await p.screenshot({ path: join(screens, "markdown-sanitize-mermaid.png") });
  record("mermaid: a click href javascript: runs nothing, a plain flowchart still draws");
  await context.close();
}

async function docxCheck() {
  const buf = await buildHostileDocx("javascript:window.__pwnedDocx=localStorage.getItem('ppm-auth-token')", "https://example.com/docs");
  await writeFile(join(harness.project, "report.docx"), buf);
  const { context, page: p, leaks } = await newTokenPage();
  page = p;
  await p.evaluate(async (name) => (await import("/stores/tab-store.ts")).useTabStore.getState().openTab({ type: "editor", title: "report.docx", projectId: name, closable: true, metadata: { projectName: name, filePath: "report.docx" } }), PROJECT);
  const preview = p.locator(".docx-preview");
  await preview.waitFor({ timeout: 30000 });
  await p.waitForTimeout(800);
  const state = await p.evaluate(() => {
    const root = document.querySelector(".docx-preview");
    return {
      heading: root?.querySelector("h1")?.textContent,
      bold: root?.querySelector("strong")?.textContent,
      jsLinks: [...root.querySelectorAll("a")].map((a) => a.getAttribute("href")).filter((u) => /^\s*javascript:/i.test(u ?? "")).length,
      okLink: root?.querySelector("a[href='https://example.com/docs']")?.textContent,
      clickText: [...root.querySelectorAll("a")].map((a) => a.textContent).join(","),
    };
  });
  assert.equal(state.heading, "Quarterly report", "docx: heading rendered");
  assert.equal(state.bold, "bold", "docx: bold rendered");
  assert.equal(state.jsLinks, 0, "docx: no javascript: link survived");
  assert.equal(state.okLink, "example site", "docx: external link kept");
  assert.ok(state.clickText.includes("click me"), "docx: the dropped link's text is still shown");
  // Click where the hostile link's text sits; it must do nothing.
  await preview.getByText("click me").click();
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => window.__pwnedDocx ?? null), null, "docx: clicking the former javascript: link ran nothing");
  assert.equal(await p.evaluate(() => localStorage.getItem("ppm-auth-token")), TOKEN, "docx: token still present");
  assert.deepEqual(leaks, [], "docx: no request from the document");
  await p.screenshot({ path: join(screens, "markdown-sanitize-docx.png") });
  record("docx: a javascript: hyperlink is inert, formatting and external links intact");
  await context.close();
}

let page;
try {
  await mkdir(screens, { recursive: true });
  assert.equal((await api("/api/projects", { method: "POST", body: JSON.stringify({ path: harness.project, name: PROJECT }) })).status, 201);
  const context = await harness.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(pageInstrumentation, { api: harness.api });
  await context.addInitScript((token) => { if (window.top === window) localStorage.setItem("ppm-auth-token", token); }, TOKEN);
  page = await context.newPage();
  const leaks = [];
  page.on("request", (r) => { if (/__pwn|evil\.test/.test(r.url())) leaks.push(r.url()); });
  page.on("dialog", (d) => {
    if (d.type() === "beforeunload") { void d.accept(); return; } // the app's own leave guard
    leaks.push(`dialog:${d.message()}`); void d.dismiss();
  });
  await page.goto(harness.web);
  await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  await page.evaluate(async (name) => {
    const projects = (await import("/stores/project-store.ts")).useProjectStore;
    await projects.getState().fetchProjects();
    projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
    (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
    (await import("/stores/panel-store.ts")).usePanelStore.getState().openTab({ type: "chat", title: "Chat", projectId: name, closable: true, metadata: { projectName: name } });
  }, PROJECT);
  await page.locator('textarea[placeholder="Ask anything..."]:visible').first().fill("[[sanitize-reply]] show me");
  await page.locator('button[aria-label="Send message"]:visible, button[aria-label="Send"]:visible').first().click();

  const inert = async (label) => {
    const reply = page.locator(".markdown-content", { hasText: "Reviewer said:" }).last();
    await reply.waitFor({ timeout: 30000 });
    await reply.locator(".shiki-block").waitFor({ timeout: 15000 });
    await page.waitForTimeout(2500); // past the meta refresh's 1 s and any image error
    const state = await reply.evaluate((root) => ({
      // The code block's own Copy button and its icon are PPM's, not the reply's.
      forbidden: [...root.querySelectorAll("iframe,script,object,embed,form,svg,style,meta,base,button")]
        .filter((el) => !el.closest(".code-actions")).map((el) => el.outerHTML.slice(0, 80)),
      handlers: [...root.querySelectorAll("*")].flatMap((el) => el.getAttributeNames().filter((a) => a.startsWith("on"))),
      badHrefs: [...root.querySelectorAll("[href],[src]")].map((el) => el.getAttribute("href") ?? el.getAttribute("src")).filter((u) => /^\s*(javascript|data|vbscript):/i.test(u)),
      overlay: !!root.querySelector("[class*='fixed'], [style*='fixed']"),
      headInjected: document.querySelectorAll("head meta[http-equiv], head base, base").length,
      pwned: window.__pwned ?? null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      baseURI: document.baseURI,
      ordinary: {
        bold: root.querySelector("strong")?.textContent, kbd: root.querySelector("kbd")?.textContent,
        katex: root.querySelectorAll(".katex math").length, table: root.querySelectorAll("table td").length,
        tasks: root.querySelectorAll("li.task-list-item > input[type=checkbox][disabled]").length,
        details: [...root.querySelectorAll("details summary")].map((el) => el.textContent).join(","), code: root.querySelectorAll(".shiki-block span[style]").length,
        link: root.querySelector("a[href='https://example.com']")?.getAttribute("rel"),
      },
    }));
    assert.deepEqual(state.forbidden, [], `${label}: no dangerous element`);
    assert.deepEqual(state.handlers, [], `${label}: no event handler attribute`);
    assert.deepEqual(state.badHrefs, [], `${label}: no script URL`);
    assert.equal(state.overlay, false, `${label}: nothing laid over the app`);
    assert.equal(state.headInjected, 0, `${label}: nothing hoisted into <head>`);
    assert.equal(state.pwned, null, `${label}: no payload script ran`);
    assert.notEqual(state.bodyBg, "rgb(255, 0, 0)", `${label}: page not restyled`);
    assert.ok(state.baseURI.startsWith(harness.web), `${label}: base URL untouched`);
    assert.ok(page.url().startsWith(harness.web) && !page.url().includes("__pwn"), `${label}: page not navigated away`);
    assert.deepEqual(leaks, [], `${label}: no request or dialog from a payload`);
    assert.deepEqual(state.ordinary, { bold: "bold", kbd: "Ctrl", katex: 1, table: 2, tasks: 2, details: "toggle,More", code: state.ordinary.code, link: "noopener noreferrer" });
    assert.ok(state.ordinary.code > 1, `${label}: code block highlighted`);
    // The link that used to be javascript: is now inert even when clicked.
    await reply.getByText("click me").click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__pwned ?? null), null, `${label}: clicked link ran nothing`);
    assert.equal(await page.evaluate(() => localStorage.getItem("ppm-auth-token")), TOKEN, "token still there to be stolen");
    await reply.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screens, `markdown-sanitize-${label}.png`) });
    record(`${label}: every payload renders inert, ordinary Markdown still renders`);
  };
  await inert("live");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  await inert("reload");
  await context.close();

  // A Mermaid diagram is text the AI wrote, so a `click … href "javascript:…"` must not run and
  // a plain flowchart must still draw as an SVG. (securityLevel: "strict" in markdown-code-block.)
  await mermaidCheck();

  // The .docx preview: mammoth does not sanitise, so a javascript: hyperlink in a document used
  // to be one click from reading the token. It must now be inert, with the formatting intact.
  await docxCheck();
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  await page?.screenshot({ path: join(screens, "markdown-sanitize-failure.png") }).catch(() => {});
} finally {
  await harness.browser.close();
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ results, sandbox: harness.sandbox }, null, 2));
  console.log(`Artifacts: ${harness.artifacts}`);
}
