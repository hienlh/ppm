import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { moreMenu, overlay, toolbar, until, waitCanvasReady } from "./design-mode-helpers.mjs";

/**
 * Every export, checked in the file it produces: ZIP, standalone HTML, the print view and its
 * PDF, and PPTX with real text boxes; then "Hand off to code".
 */

async function exportEntry(ctx, label) {
  if (ctx.mobile) {
    await toolbar(ctx, "Export");
    const sheet = overlay(ctx, "Export");
    return sheet.locator("button, a").filter({ hasText: label }).first();
  }
  await ctx.page.locator('button[aria-label="Export"]:visible').click();
  return ctx.page.getByRole("menuitem", { name: label });
}

async function download(ctx, label) {
  const entry = await exportEntry(ctx, label);
  const [file] = await Promise.all([ctx.page.waitForEvent("download", { timeout: 60000 }), entry.click()]);
  const path = join(ctx.harness.artifacts, `${ctx.width}-${file.suggestedFilename()}`);
  await file.saveAs(path);
  return readFile(path);
}

async function zipOf(bytes) {
  const { default: JSZip } = await import("jszip");
  return JSZip.loadAsync(bytes);
}

/** The view link, once its token is minted: the menu disables it until then. */
async function viewLink(ctx, label) {
  const entry = await exportEntry(ctx, label);
  await until(`the ${label} link`, async () => !!(await entry.getAttribute("href")));
  return entry;
}

export async function stepExports(ctx) {
  await waitCanvasReady(ctx);
  const zip = await zipOf(await download(ctx, "Download ZIP"));
  const names = Object.keys(zip.files);
  assert.ok(names.includes(`${ctx.slug}/index.html`) && names.includes("tokens.css"), names.join(", "));
  assert.deepEqual(names.filter((n) => n.includes(".design")), [], "no .design/ in the ZIP");
  ctx.record("ZIP holds the design and tokens.css, no .design/", { entries: names.length });

  const html = (await download(ctx, "Download HTML file")).toString("utf8");
  const refs = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1])
    .filter((v) => v && !/^(?:data:|https?:|#|mailto:|blob:|javascript:)/i.test(v));
  const local = refs.filter((v) => existsSync(resolve(ctx.designDir, v.split(/[?#]/)[0])));
  assert.deepEqual(local, [], "every local asset that exists was inlined");
  assert.ok(html.includes("data:image/png;base64,"), "the logo is inlined");
  const types = await ctx.page.evaluate(() => window.__e2e.blobTypes);
  assert.ok(types.length >= 2 && types.every((t) => t === "application/octet-stream"), `download blobs: ${types}`);
  ctx.record("standalone HTML inlines its assets; download blobs are octet-stream");

  const printLink = await viewLink(ctx, "Print or save as PDF");
  const [popup] = await Promise.all([ctx.context.waitForEvent("page"), printLink.click()]);
  await popup.waitForLoadState("load");
  const printCsp = (await fetch(`${ctx.harness.api}${new URL(popup.url()).pathname}`)).headers.get("content-security-policy");
  assert.ok(printCsp.includes("allow-modals"), printCsp);
  assert.ok(!ctx.canvasCsp.includes("allow-modals"), "the canvas never gets allow-modals");
  assert.equal(await popup.evaluate(() => window.opener === null), true, "the print tab has no opener");
  const pdf = (await popup.pdf({ preferCSSPageSize: true, printBackground: true })).toString("latin1");
  const pages = (pdf.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  assert.equal(pages, 3, "one PDF page per slide");
  await popup.close();
  ctx.record("print view: allow-modals only there, no opener, a 3-page PDF");

  const pptx = await download(ctx, "Download PowerPoint");
  assert.equal(pptx.subarray(0, 2).toString("latin1"), "PK");
  const deck = await zipOf(pptx);
  for (const n of [1, 2, 3]) assert.ok(deck.files[`ppt/slides/slide${n}.xml`], `slide${n}.xml`);
  const slides = await Promise.all([1, 2, 3].map((n) => deck.files[`ppt/slides/slide${n}.xml`].async("string")));
  assert.ok(slides.some((xml) => xml.includes("<a:t>Quarterly review</a:t>")), "the heading is editable text");
  const notes = overlay(ctx, "PowerPoint approximations");
  await notes.waitFor();
  assert.ok((await notes.textContent()).includes("Arial"), "the approximations name the fonts PowerPoint needs");
  await notes.getByRole("button", { name: "OK" }).click();
  ctx.record("PPTX has three slides and the heading as editable text");
}

export async function stepHandOff(ctx) {
  const before = await tabsOf(ctx);
  const plain = before.find((t) => t.id === ctx.plainTabId);
  assert.ok(plain, "the ordinary chat tab is open");
  await moreMenu(ctx, "Hand off to code");
  const after = await until("a new chat tab", async () => { const tabs = await tabsOf(ctx); return tabs.length === before.length + 1 && tabs; });
  const added = after.find((t) => !before.some((b) => b.id === t.id));
  assert.equal(added.type, "chat");
  assert.equal(added.metadata.designSlug, undefined, "hand-off is not a design chat");
  const draft = await until("the hand-off draft", async () => {
    const value = await ctx.page.locator('textarea[placeholder="Ask anything..."]:visible').first().inputValue();
    return value.includes(`designs/${ctx.slug}/`) && value;
  });
  assert.ok(draft.includes("DESIGN.md") && draft.includes("untrusted"), draft);
  const untouched = (await tabsOf(ctx)).find((t) => t.id === ctx.plainTabId);
  assert.deepEqual(untouched.metadata, plain.metadata, "the existing chat tab is untouched");
  await ctx.page.evaluate(async (id) => (await import("/stores/panel-store.ts")).usePanelStore.getState().closeTab(id), added.id);
  await focusTab(ctx, ctx.tabId);
  ctx.record("hand-off opens a new plain chat with the brief as a draft");
}

export async function tabsOf(ctx) {
  return ctx.page.evaluate(async (projectName) => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    return Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs)
      .filter((t) => t.projectId === projectName || t.metadata?.projectName === projectName)
      .map((t) => JSON.parse(JSON.stringify({ id: t.id, type: t.type, title: t.title, metadata: t.metadata ?? {} })));
  }, ctx.projectName);
}

export async function focusTab(ctx, id) {
  await ctx.page.evaluate(async (tabId) => (await import("/stores/panel-store.ts")).usePanelStore.getState().setActiveTab(tabId), id);
}

