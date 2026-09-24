import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  apiJson, canvasSelector, frameClick, canvasLoad, designFile, genOf, history, readDesign, sendDesignTurn,
  settleSnapshots, toolbar, until, waitCanvasReady, writeDesign,
} from "./design-mode-helpers.mjs";

/** Chat to files to live canvas, the canvas's security boundary, and snapshots with restore. */

async function createDesign(ctx, title, kind = "slides") {
  const res = await apiJson(ctx, `/api/project/${encodeURIComponent(ctx.projectName)}/designs`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, kind }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.slug;
}

export async function tabMetadata(ctx) {
  return ctx.page.evaluate(async (tabId) => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    const tab = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.id === tabId);
    return tab ? JSON.parse(JSON.stringify(tab.metadata ?? {})) : null;
  }, ctx.tabId);
}

export async function openDesign(ctx) {
  ctx.tabId = await ctx.page.evaluate(async ({ projectName, slug }) => {
    const { openDesignTab } = await import("/lib/design/open-design-tab.ts");
    return openDesignTab({ projectName, slug });
  }, { projectName: ctx.projectName, slug: ctx.slug });
  await ctx.page.locator(`${canvasSelector(ctx)}:visible`).waitFor({ timeout: 30000 });
  return waitCanvasReady(ctx, genOf(await readDesign(ctx)), 30000);
}

export async function stepChatToCanvas(ctx) {
  ctx.designTitle = `Q3 deck ${ctx.width}`;
  ctx.slug = await createDesign(ctx, ctx.designTitle);
  ctx.otherSlug = await createDesign(ctx, `Other ${ctx.width}`, "page");
  ctx.designDir = join(ctx.harness.project, "designs", ctx.slug);
  await openDesign(ctx);

  const call = await sendDesignTurn(ctx, "Build the deck [[design:build]]");
  const doneAt = Date.now();
  const built = await readDesign(ctx);
  ctx.builtHtml = built;
  const frame = await waitCanvasReady(ctx, genOf(built), 5000);
  const shownAfter = Date.now() - doneAt;
  assert.equal(await frame.locator("h1").textContent(), "Quarterly review");
  const unlabelled = await frame.evaluate(() => [...document.querySelectorAll("*")]
    .filter((el) => !el.localName.startsWith("ppm-") && !el.hasAttribute("data-ppm-id")).map((el) => el.localName));
  assert.deepEqual(unlabelled, [], "every source element carries data-ppm-id");
  ctx.record("chat writes files and the canvas shows them", { shownAfterMs: shownAfter });

  assert.equal(call.step, "build");
  assert.equal(call.permissionMode, "acceptEdits");
  assert.equal(call.designSession, true);
  assert.equal(call.designSlug, ctx.slug);
  ctx.sessionId = call.sessionId;
  const stored = (await apiJson(ctx, `/__design-test/session/${call.sessionId}`)).body;
  assert.deepEqual(stored, { designSlug: ctx.slug, permissionMode: "acceptEdits" });
  assert.equal((await tabMetadata(ctx)).sessionId, call.sessionId);
  ctx.record("design turn runs with acceptEdits and the design flag", stored);

  assert.ok(existsSync(designFile(ctx, ".design/.gitignore")), ".design/.gitignore exists");
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ctx.harness.project, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(`designs/${ctx.slug}/index.html`), "the design itself is visible to git");
  assert.ok(!status.stdout.includes(".design/"), `git status lists no .design/: ${status.stdout}`);
  ctx.record(".design/ is git-ignored");
}

async function issueCount(ctx) {
  const badge = ctx.page.locator('button[aria-label$="canvas issue"]:visible, button[aria-label$="canvas issues"]:visible');
  if (!(await badge.count())) return 0;
  return Number(/^(\d+)/.exec(await badge.first().getAttribute("aria-label"))?.[1] ?? 0);
}

export async function stepCanvasSecurity(ctx) {
  const load = await canvasLoad(ctx);
  const res = await fetch(`${ctx.harness.api}${load.url.pathname}${load.url.search}`);
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  const source = /(?:^|; )connect-src (\S+)$/m.exec(csp.split("; ").find((d) => d.startsWith("connect-src")) ?? "")?.[1];
  assert.ok(source && source.endsWith(`/api/design-preview/content/${load.token}/`), `connect-src is own-source: ${csp}`);
  const expected = (await apiJson(ctx, `/__design-test/csp?source=${encodeURIComponent(source)}`)).body;
  assert.equal(csp, expected.canvas, "the canvas CSP is the builder's output");
  assert.ok(csp.includes("'unsafe-eval'") && !csp.includes("allow-modals"));
  assert.equal(res.headers.get("access-control-allow-origin"), "null");
  ctx.canvasCsp = csp;
  ctx.record("canvas CSP equals the builder, connect-src own-source");

  const frame = await waitCanvasReady(ctx);
  const before = await issueCount(ctx);
  const blocked = await frame.evaluate(async () => {
    try { await fetch("https://example.com/"); return false; } catch { return true; }
  });
  assert.equal(blocked, true, "a foreign fetch fails");
  await until("the issues badge to count the CSP block", async () => (await issueCount(ctx)) > before);
  ctx.record("in-frame foreign fetch is blocked and reported", { issues: await issueCount(ctx) });

  const url = frame.url();
  const reported = await ctx.page.evaluate(() => window.__e2e.bridge.filter((m) => m.type === "navigate-blocked").length);
  await frameClick(ctx, "#ext-link");
  await until("navigate-blocked", () => ctx.page.evaluate((n) => window.__e2e.bridge.filter((m) => m.type === "navigate-blocked").length > n, reported));
  const last = await ctx.page.evaluate(() => window.__e2e.bridge.filter((m) => m.type === "navigate-blocked").at(-1).data);
  assert.equal(last.href, "https://example.com/");
  assert.equal(frame.url(), url, "the frame did not navigate");
  assert.equal(await frame.locator("h1").textContent(), "Quarterly review");
  ctx.record("external link click does not navigate and posts navigate-blocked");

  const issues = await issueCount(ctx);
  await frame.evaluate(() => {
    const nonce = new URLSearchParams(location.search).get("n");
    const msg = { ppm: "design-bridge", v: 1, type: "issue", kind: "error", message: "forged" };
    parent.postMessage({ ...msg, nonce: "A".repeat(22) }, "*");
    parent.postMessage({ ...msg, nonce }, "*");
  });
  await until("the right-nonce message to land", async () => (await issueCount(ctx)) === issues + 1);
  assert.equal(await issueCount(ctx), issues + 1, "the wrong-nonce message was ignored");
  ctx.record("a message with the wrong nonce is ignored");

  const other = load.url.pathname.replace(`/${ctx.slug}/`, `/${ctx.otherSlug}/`);
  assert.equal((await fetch(`${ctx.harness.api}${other}`)).status, 403, "the token cannot read another design");
  const info = async () => (await apiJson(ctx, `/__design-test/token/${load.token}`)).body;
  const start = await info();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await fetch(`${ctx.harness.api}${load.url.pathname}`)).status, 200);
  assert.equal((await info()).idleExpires, start.idleExpires, "an unauthenticated GET does not extend the token");
  ctx.record("token is per design and not extended by reads");
}

async function openHistory(ctx) {
  await toolbar(ctx, "Version history");
  await ctx.page.getByText("Version history", { exact: true }).locator("visible=true").first().waitFor();
}

async function closeHistory(ctx) {
  await ctx.page.locator('button[aria-label="Close history"]:visible').click();
}

const turnRows = (ctx) => ctx.page.getByText("After an AI turn", { exact: true }).locator("visible=true");

export async function stepHistory(ctx) {
  await settleSnapshots(ctx);
  assert.equal((await history(ctx)).filter((s) => s.reason === "turn").length, 1);
  await openHistory(ctx);
  await until("one turn row", async () => (await turnRows(ctx).count()) === 1);
  // A phone shows History as a sheet over the whole screen, which the chat cannot be reached under.
  await closeHistory(ctx);
  await sendDesignTurn(ctx, "Nothing to change [[design:noop]]");
  await settleSnapshots(ctx);
  assert.equal((await history(ctx)).filter((s) => s.reason === "turn").length, 1, "a no-op turn adds no snapshot");
  ctx.record("one turn snapshot; a no-op turn adds none");

  const edited = ctx.builtHtml.replace("<h2>Highlights</h2>", "<h2>Scratch edit</h2>");
  await writeDesign(ctx, edited);
  await waitCanvasReady(ctx, genOf(edited));
  await openHistory(ctx);
  await until("one turn row", async () => (await turnRows(ctx).count()) === 1);
  const events = await ctx.page.evaluate(() => window.__e2e.historyEvents);
  await turnRows(ctx).first().locator("xpath=../..").getByRole("button", { name: "Restore this version" }).click();
  await ctx.page.getByRole("button", { name: "Restore", exact: true }).click();
  await until("the restored bytes", async () => (await readDesign(ctx)) === ctx.builtHtml);
  await waitCanvasReady(ctx, genOf(ctx.builtHtml));
  await ctx.page.getByText("Before a restore", { exact: true }).locator("visible=true").first().waitFor();
  assert.ok(await ctx.page.evaluate((n) => window.__e2e.historyEvents > n, events), "History refreshed from design:history_changed");
  await closeHistory(ctx);
  ctx.record("restore round-trips bytes and History follows design events");
}

/** Last step of a run: nothing under .design/ ever reached the page as a file change. */
export async function stepNoDotDesignEvents(ctx) {
  const paths = [...(ctx.fileChanged ?? []), ...await ctx.page.evaluate(() => window.__e2e.fileChanged)];
  assert.ok(paths.length > 0, "file:changed events were observed at all");
  assert.deepEqual(paths.filter((p) => p.includes(".design")), [], "no file:changed for .design/");
  ctx.record("no file:changed event for .design/", { fileChanged: paths.length });
}

