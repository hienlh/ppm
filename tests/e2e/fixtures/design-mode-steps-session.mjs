import assert from "node:assert/strict";
import {
  apiJson, canvasLoad, canvasSelector, designComposer, genOf, providerCalls, readDesign, sendFromComposer, showCanvas,
  toolbar, until, waitCanvasReady,
} from "./design-mode-helpers.mjs";
import { focusTab, tabsOf } from "./design-mode-steps-export.mjs";
import { tabMetadata } from "./design-mode-steps-canvas.mjs";

/**
 * The design session stays a design session, the ordinary chat is unchanged, and the canvas
 * survives being moved and having its token die.
 */

/** Phone: switching panes keeps the one chat socket, and the bar's controls are thumb-sized. */
export async function stepMobilePanes(ctx) {
  const opened = () => ctx.page.evaluate((sid) => window.__e2e.chatSockets.filter((p) => p.endsWith(`/chat/${sid}`)).length, ctx.sessionId);
  const before = await opened();
  assert.ok(before >= 1, "the design chat has a socket");
  for (let i = 0; i < 2; i++) { await designComposer(ctx); await showCanvas(ctx); }
  assert.equal(await opened(), before, "no socket was reopened by switching panes");
  const bar = ctx.page.getByRole("navigation", { name: "Design view" });
  for (const name of ["Canvas", "Chat", "More"]) {
    const box = await bar.getByRole("button", { name }).boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `${name} is ${box.width}x${box.height}`);
    assert.ok(box.y > ctx.page.viewportSize().height * 2 / 3, `${name} sits in the thumb zone`);
  }
  assert.equal(await ctx.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal overflow");
  ctx.record("phone: Canvas/Chat keeps one chat socket; bar controls are 44px in the thumb zone");
}

/** An ordinary chat creates its session without a design slug and titles its tab from it. */
export async function stepNormalChat(ctx) {
  const bodies = [];
  const onRequest = (req) => { if (req.method() === "POST" && /\/chat\/sessions$/.test(new URL(req.url()).pathname)) bodies.push(req.postDataJSON()); };
  ctx.page.on("request", onRequest);
  ctx.plainTabId = await ctx.page.evaluate(async (projectName) => (await import("/stores/panel-store.ts")).usePanelStore.getState()
    .openTab({ type: "chat", title: "Chat", projectId: projectName, closable: true, metadata: { projectName } }), ctx.projectName);
  const calls = (await providerCalls(ctx)).length;
  const title = `Plain chat hello ${ctx.width}`;
  await ctx.page.locator('textarea[placeholder="Ask anything..."]:visible').first().waitFor();
  await sendFromComposer(ctx.page, title);
  const call = await until("the plain chat's turn", async () => { const c = (await providerCalls(ctx))[calls]; return c?.done && c; });
  ctx.page.off("request", onRequest);
  assert.equal(bodies.length, 1);
  assert.equal("designSlug" in bodies[0], false, `no designSlug: ${JSON.stringify(bodies[0])}`);
  assert.equal(call.designSession, false);
  assert.equal(call.designSlug, null);
  await until("the tab title to follow the session", async () => (await tabsOf(ctx)).find((t) => t.id === ctx.plainTabId)?.title === title);
  ctx.plainSessionTitle = title;
  await focusTab(ctx, ctx.tabId);
  await waitCanvasReady(ctx);
  ctx.record("a normal chat sends no designSlug and its tab follows the session title");
}

export async function stepDesignModeHolds(ctx) {
  const tabsBefore = (await tabsOf(ctx)).length;
  const original = ctx.sessionId;
  await designComposer(ctx);
  const bubble = ctx.page.locator("div:visible").filter({ hasText: /^Build the deck \[\[design:build\]\]/ }).last();
  await bubble.hover();
  await ctx.page.locator('button[aria-label="Fork"]:visible').first().click();
  const meta = await until("the fork in the design tab", async () => { const m = await tabMetadata(ctx); return m.sessionId !== original && m; });
  assert.equal((await tabsOf(ctx)).length, tabsBefore, "the fork opened no other tab");
  assert.equal((await apiJson(ctx, `/__design-test/session/${meta.sessionId}`)).body.designSlug, ctx.slug, "the fork is a design session");
  ctx.sessionId = meta.sessionId;
  ctx.record("a fork inside the design tab stays in the design tab");

  await ctx.page.getByRole("button", { name: "History", exact: true }).locator("visible=true").first().click();
  const rows = ctx.page.locator('[data-onboarding="chat-history-session"]:visible');
  await rows.first().waitFor();
  const titles = await rows.allTextContents();
  const listed = (await apiJson(ctx, `/api/project/${encodeURIComponent(ctx.projectName)}/chat/sessions?limit=200&offset=0`)).body.data.sessions;
  const mine = listed.filter((x) => x.designSlug === ctx.slug);
  assert.ok(listed.some((x) => !x.designSlug), "other sessions exist to be filtered out");
  assert.equal(titles.length, mine.length, `design history: ${titles}`);
  assert.ok(mine.every((x) => titles.some((t) => t.includes(x.title))), `design history: ${titles}`);
  assert.ok(!titles.some((t) => t.includes(ctx.plainSessionTitle)), "the ordinary chat is not listed");
  await ctx.page.getByRole("button", { name: "History", exact: true }).locator("visible=true").first().click();
  ctx.record("the embedded history lists only this design's sessions", { sessions: titles.length });

  if (!ctx.mobile) {
    await focusTab(ctx, ctx.plainTabId);
    await ctx.page.evaluate(async () => {
      const s = (await import("/stores/settings-store.ts")).useSettingsStore.getState();
      if (s.sidebarCollapsed) s.toggleSidebar();
      s.setSidebarActiveTab("history");
    });
    // The list was fetched when the sidebar first mounted, before these sessions existed.
    await ctx.page.locator('button[title="Refresh"]:visible').first().click();
    await ctx.page.locator("button:visible").filter({ hasText: "Build the deck" }).first().click();
    await until("the design tab to take focus", () => ctx.page.evaluate(async (id) => Object.values((await import("/stores/panel-store.ts")).usePanelStore.getState().panels).some((p) => p.activeTabId === id), ctx.tabId));
    assert.equal((await tabsOf(ctx)).length, tabsBefore, "no duplicate chat tab");
    ctx.record("opening the design session from sidebar history focuses the design tab");
  }

  await focusTab(ctx, ctx.tabId);
  await showCanvas(ctx);
  await until("the design URL", () => new URL(ctx.page.url()).pathname.endsWith(`/design/${ctx.slug}`));
  // A reload starts the page's records afresh; keep what the last document saw.
  ctx.fileChanged = [...(ctx.fileChanged ?? []), ...await ctx.page.evaluate(() => window.__e2e.fileChanged)];
  await ctx.page.reload();
  await ctx.page.locator(`${canvasSelector(ctx)}:visible`).waitFor({ timeout: 30000 });
  await waitCanvasReady(ctx, genOf(await readDesign(ctx)), 30000);
  ctx.record("reloading restores the design tab from /design/<slug>");
}

/** Desktop: a split reparents the iframe; the replay restores scroll, picker and pins. */
export async function stepSplitAndExpiry(ctx) {
  let frame = await waitCanvasReady(ctx);
  await frame.evaluate(() => window.scrollTo(0, 600));
  await until("the scroll to be reported", () => ctx.page.evaluate(() => window.__e2e.bridge.some((m) => m.type === "scroll" && m.data?.y === 600)));
  await ctx.page.locator('button[aria-label="Select element"]:visible').click();
  const pins = await ctx.page.locator('button[aria-label^="Comment "]:visible').count();
  // The iframe keeps its src when reparented: the same nonce says `ready` a second time.
  const { nonce } = await canvasLoad(ctx);
  const readies = () => ctx.page.evaluate((n) => window.__e2e.bridge.filter((m) => m.type === "ready" && m.nonce === n).length, nonce);
  const readyBefore = await readies();
  const split = await ctx.page.evaluate(async (tabId) => {
    const s = (await import("/stores/panel-store.ts")).usePanelStore.getState();
    const panel = Object.values(s.panels).find((p) => p.tabs.some((t) => t.id === tabId));
    return s.splitPanel("right", tabId, panel.id);
  }, ctx.tabId);
  assert.equal(split, true, "the panel split");
  const started = Date.now();
  await until("the reparented frame to say ready", async () => (await readies()) > readyBefore
    || (await canvasLoad(ctx)).nonce !== nonce, { timeout: 3000 });
  frame = await waitCanvasReady(ctx, null, 3000);
  await until("the scroll to come back", () => frame.evaluate(() => Math.round(scrollY) === 600), { timeout: 3000 });
  assert.equal(await ctx.page.locator('button[aria-label="Select element"]:visible').getAttribute("aria-pressed"), "true");
  assert.equal(await ctx.page.locator('button[aria-label^="Comment "]:visible').count(), pins, "pins are back");
  ctx.record("a split reloads the iframe and restores scroll, picker and pins", { recoveredMs: Date.now() - started, pins });
  await ctx.page.locator('button[aria-label="Select element"]:visible').click();

  const load = await canvasLoad(ctx);
  assert.equal((await apiJson(ctx, `/__design-test/token/${load.token}/expire`, { method: "POST" })).status, 200);
  await toolbar(ctx, "Reload canvas");
  await until("a re-minted token", async () => (await canvasLoad(ctx)).token !== load.token);
  await waitCanvasReady(ctx);
  assert.ok(await ctx.page.evaluate(() => window.__e2e.bridge.some((m) => m.type === "expired")), "the expired page reported itself");
  ctx.record("an invalidated token shows the expired page, which re-mints and reloads");
}

/** Only providers that carry design instructions are offered for a new design. */
export async function stepNewDesignDialog(ctx) {
  await ctx.page.evaluate(async (projectName) => (await import("/lib/design/design-ui-events.ts")).requestNewDesign(projectName), ctx.projectName);
  const dialog = ctx.mobile ? ctx.page.locator("div.rounded-t-2xl.bg-popover").filter({ hasText: "New design" }) : ctx.page.getByRole("dialog", { name: "New design" });
  const select = dialog.locator("select");
  await select.waitFor();
  const options = await select.locator("option").allTextContents();
  assert.deepEqual(options, ["Design test AI"], `providers offered: ${options}`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  ctx.record("New Design offers only design-capable providers");
}
