import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { pageInstrumentation } from "./fixtures/design-mode-page-instrumentation.mjs";
import { canvasSelector, genOf, until, waitCanvasReady } from "./fixtures/design-mode-helpers.mjs";
import {
  INVALID_TITLE, openReviewer, openThread, panel, pinComment, reply, showList, waitForDesign, waitForInvalid, waitForReply,
} from "./fixtures/design-share-reviewer-page.mjs";

// A design share link end to end, against a disposable real server (isolated PPM_HOME, sign-in
// on, scripted providers) and the real reviewer page build:
// - the owner (1440x900) creates a link with a custom expiry in the Share dialog and copies it;
// - reviewer A (390x844, touch) and reviewer B (1440x900), each in their own browser context,
//   open it, give their names, pin a comment each and reply to each other; A sees B's reply
//   only by polling;
// - the owner sees both threads on the canvas without reloading and replies; B sees the reply;
// - with sign-in off the dialog says so and the links stop opening, and open again after;
// - the owner revokes the link and both reviewers land on the invalid page;
// - the server restarts on the same PPM_HOME and a second link still opens with its comments.
// Screenshots: PPM_SHARE_SCREENS (default: the harness artifacts folder), named e2e-*.png.

const TOKEN = "threads-e2e-token";
const PROJECT = "share-e2e";
const TITLE = "Launch page";
const TZ = "Asia/Saigon";
const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Launch</title></head><body><main style="padding:48px;font:18px/1.5 sans-serif">'
  + '<h1 style="font-size:40px">Ship faster with Acme</h1><p class="lead">Everything your team needs, in one place.</p>'
  + '<a class="cta" href="#" style="display:inline-block;padding:12px 20px;background:#0a7">Start free</a></main></body></html>\n';

/** The share page is its own build; rebuilt every run so a stale one is never what is tested. */
async function buildSharePage() {
  const build = spawn(process.env.PPM_BUN || "bun", ["x", "vite", "build", "--config", "vite.share.config.ts", "--logLevel", "warn"],
    { cwd: process.cwd(), stdio: "inherit", windowsHide: true });
  const code = await new Promise((done, reject) => { build.on("exit", done); build.on("error", reject); });
  assert.equal(code, 0, "the share page build failed");
}

await buildSharePage();
const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/design-threads-server.ts" });
const screens = process.env.PPM_SHARE_SCREENS || harness.artifacts;
const results = [];
const record = (name) => { results.push(name); console.log(`PASS ${name}`); };
const api = async (path, init = {}) => {
  const res = await fetch(`${harness.api}${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const contexts = [];
let owner;

/** `YYYY-MM-DD` of `days` from now in the owner's timezone, and the end of that day as a timestamp. */
function customDay(days) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + days * 86_400_000));
  return { value: parts, endsAt: new Date(`${parts}T23:59:59.999+07:00`).getTime() };
}

async function openOwner() {
  const context = await harness.browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: TZ });
  contexts.push(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: harness.web });
  await context.addInitScript(pageInstrumentation, { api: harness.api });
  await context.addInitScript((token) => { if (window.top === window) localStorage.setItem("ppm-auth-token", token); }, TOKEN);
  const page = await context.newPage();
  await page.goto(harness.web);
  await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  return page;
}

async function openShareDialog(page) {
  await page.locator('button[aria-label="Share for review"]:visible').first().click();
  const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("share-dialog") });
  await dialog.waitFor();
  return dialog;
}

const linkRow = (dialog, label) => dialog.getByTestId("share-link-row").filter({ hasText: label });

/** Creates a link through the dialog and answers its id and copied URL. */
async function createLink(page, dialog, label, expiry) {
  await dialog.getByTestId("share-address-none").waitFor();
  await dialog.locator("#share-new-label").fill(label);
  await dialog.getByRole("radio", { name: expiry.preset }).click();
  if (expiry.date) await dialog.locator("#share-new-date").fill(expiry.date);
  await dialog.getByTestId("share-create").click();
  const row = linkRow(dialog, label);
  await row.waitFor();
  const id = await row.getAttribute("data-link-id");
  await row.getByRole("button", { name: "Copy link" }).click();
  await page.locator("[data-sonner-toast]").filter({ hasText: "Link copied" }).first().waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, (await row.getByTestId("share-link-url").textContent()).trim(), "the copied URL is the one shown");
  return { id, row, url: copied, path: new URL(copied).pathname };
}

try {
  await mkdir(screens, { recursive: true });
  const designs = join(harness.project, "designs");
  await mkdir(designs, { recursive: true });
  assert.equal((await api("/api/projects", { method: "POST", body: JSON.stringify({ path: harness.project, name: PROJECT }) })).status, 201);
  const made = await api(`/api/project/${PROJECT}/designs`, { method: "POST", body: JSON.stringify({ title: TITLE, kind: "page" }) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const slug = made.body.data.slug;
  await writeFile(join(designs, slug, "index.html"), HTML);

  // --- Owner: create a link with a custom expiry, copy it; then a second link.
  owner = await openOwner();
  await owner.evaluate(async ({ name, slug }) => {
    const projects = (await import("/stores/project-store.ts")).useProjectStore;
    await projects.getState().fetchProjects();
    projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
    (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
    (await import("/stores/settings-store.ts")).useSettingsStore.setState({ designWindows: false });
    (await import("/lib/design/open-design-tab.ts")).openDesignTab({ projectName: name, slug });
  }, { name: PROJECT, slug });
  const ownerCtx = { page: owner, mobile: false, designTitle: TITLE, harness };
  await owner.locator(`${canvasSelector(ownerCtx)}:visible`).waitFor({ timeout: 30000 });
  await waitCanvasReady(ownerCtx, genOf(HTML), 30000);

  let dialog = await openShareDialog(owner);
  const day = customDay(3);
  await dialog.locator("#share-new-label").fill("Client review");
  await dialog.getByRole("radio", { name: "Custom" }).click();
  await dialog.locator("#share-new-date").fill(day.value);
  await owner.screenshot({ path: join(screens, "e2e-owner-01-share-dialog-custom-expiry.png") });
  const first = await createLink(owner, dialog, "Client review", { preset: "Custom", date: day.value });
  assert.equal(new URL(first.url).origin, harness.web, "with no public address the link is this PPM's own address");
  const listed = (await api(`/api/project/${PROJECT}/designs/${slug}/shares`)).body.data.links;
  assert.equal(listed.find((l) => l.id === first.id).expiresAt, day.endsAt, "the link closes at the end of the chosen day");
  const second = await createLink(owner, dialog, "Second client", { preset: "7 days" });
  assert.notEqual(second.path, first.path);
  await owner.screenshot({ path: join(screens, "e2e-owner-02-links-created.png") });
  record("owner creates a link with a custom expiry in the Share dialog and copies its address");
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await owner.locator('button[aria-label="Comments"]:visible').first().click();
  const ownerPanel = owner.locator("div.bg-panel", { hasText: "Comments" }).last();
  await ownerPanel.waitFor();

  // --- Reviewers open the copied link on the server itself (one origin, as in production).
  const guestUrl = `${harness.api}${first.path}`;
  const a = await openReviewer(harness.browser, guestUrl, { mobile: true });
  const b = await openReviewer(harness.browser, guestUrl, { mobile: false });
  contexts.push(a.context, b.context);
  await Promise.all([waitForDesign(a, TITLE), waitForDesign(b, TITLE)]);
  await a.page.getByText(/^Shared version from .* · Link expires on /).waitFor();
  await a.page.screenshot({ path: join(screens, "e2e-reviewer-a-phone-01-open.png") });
  // The reviewer page is not PPM: no service worker, no app bundle, and no PPM API answers it.
  assert.deepEqual(await a.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
  assert.deepEqual(a.requests.filter((p) => p.startsWith("/assets/index-")), []);
  assert.equal(await a.page.evaluate(async () => (await fetch("/api/projects")).status), 401);
  record("both reviewers open the link; the phone loads no PPM app code and no PPM API answers it");

  await pinComment(a, "h1", { name: "Ann", body: "Make the headline shorter" });
  await a.page.screenshot({ path: join(screens, "e2e-reviewer-a-phone-02-thread.png") });
  await pinComment(b, "p.lead", { name: "Bob", body: "The subtitle needs a number" });
  const pinnedAt = Date.now();
  record("reviewer A (phone, two taps) and reviewer B (desktop) each pin a comment under their names");

  // The owner's canvas has been open all along: both threads arrive without a reload.
  await ownerPanel.getByText("Ann · via Client review").first().waitFor({ timeout: 15000 });
  await ownerPanel.getByText("Bob · via Client review").first().waitFor({ timeout: Math.max(1000, 15000 - (Date.now() - pinnedAt)) });
  const arrived = Date.now() - pinnedAt;
  await owner.screenshot({ path: join(screens, "e2e-owner-03-canvas-both-threads.png") });
  record(`the owner's open canvas shows both reviewers' threads ${(arrived / 1000).toFixed(1)} s after the second was posted`);

  await reply(b, "Make the headline shorter", "Agreed, five words at most");
  await reply(a, "The subtitle needs a number", "Maybe the team count?");
  // A wrote nothing since B replied, so only the 10 s poll can bring B's reply.
  await openThread(a, "Make the headline shorter");
  await waitForReply(a, "Agreed, five words at most");
  const byline = await panel(a).getByRole("list", { name: "Replies" }).textContent();
  assert.ok(byline.includes("Bob"), `B's reply carries B's name: ${byline}`);
  const small = await panel(a).evaluate((root) => [...root.querySelectorAll("button, textarea")]
    .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height < 44).map((el) => el.textContent || el.getAttribute("aria-label")));
  assert.deepEqual(small, [], `phone targets under 44px: ${small}`);
  await a.page.screenshot({ path: join(screens, "e2e-reviewer-a-phone-03-sees-b-reply.png") });
  await b.page.screenshot({ path: join(screens, "e2e-reviewer-b-desktop-01-thread.png") });
  record("the reviewers reply to each other; A sees B's reply by polling, with B's name");

  // --- Owner: reply on the canvas, in the thread both reviewers wrote in.
  await ownerPanel.locator("button", { hasText: "Make the headline shorter" }).first().click();
  const thread = owner.locator('[data-testid="comment-thread"]:visible');
  await thread.getByText("Agreed, five words at most").waitFor();
  await thread.locator('textarea[aria-label="Reply"]').fill("Shortened to four words");
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  await thread.getByText("Shortened to four words").waitFor();
  await owner.screenshot({ path: join(screens, "e2e-owner-04-replied.png") });
  // B has this thread open (B replied in it); the owner's reply comes in on B's next poll.
  await waitForReply(b, "Shortened to four words");
  assert.ok((await panel(b).getByRole("list", { name: "Replies" }).textContent()).includes("Owner"), "the owner's reply carries the Owner badge");
  record("the owner replies on the canvas and the reviewer gets it, with the Owner badge");

  // --- Re-pin while A's page is open: A's next poll shows the reload bar; after it, the new version.
  const NEWER_HEADLINE = "Ship faster with Acme, today";
  await writeFile(join(designs, slug, "index.html"), HTML.replace("Ship faster with Acme", NEWER_HEADLINE));
  dialog = await openShareDialog(owner);
  const repinRow = linkRow(dialog, "Client review");
  await repinRow.getByRole("button", { name: "More actions for Client review" }).click();
  await repinRow.getByRole("group", { name: "Link actions" }).getByRole("button", { name: "Update to latest version" }).click();
  await repinRow.getByTestId("share-repin-preview").getByText("index.html").waitFor();
  const pinnedBefore = listed.find((l) => l.id === first.id).snapshotId;
  await repinRow.getByRole("button", { name: "Update to latest", exact: true }).click();
  await until("the link to move to the new version", async () =>
    (await api(`/api/project/${PROJECT}/designs/${slug}/shares`)).body.data.links.find((l) => l.id === first.id).snapshotId !== pinnedBefore);
  await dialog.getByRole("button", { name: "Close" }).first().click();
  const updated = a.page.getByRole("status").filter({ hasText: "This design was updated." });
  await updated.waitFor({ timeout: 25000 });
  const reloadButton = updated.getByRole("button", { name: "Reload" });
  const box = await reloadButton.boundingBox();
  assert.ok(box && box.height >= 44 && box.width >= 44, `the Reload button is a 44px target: ${JSON.stringify(box)}`);
  assert.equal(await a.page.frameLocator('iframe[title^="Shared design:"]').locator("h1").textContent(), "Ship faster with Acme",
    "until it reloads, the page keeps showing the version it loaded");
  await a.page.screenshot({ path: join(screens, "e2e-reviewer-repin-bar.png") });
  await reloadButton.click();
  await waitForDesign(a, TITLE);
  await until("the reloaded page to show the new version", async () =>
    (await a.page.frameLocator('iframe[title^="Shared design:"]').locator("h1").textContent()) === NEWER_HEADLINE);
  assert.equal(await a.page.getByText("This design was updated.").count(), 0, "the bar is gone after the reload");
  await (await showList(a)).getByText("Make the headline shorter").waitFor();
  await a.page.screenshot({ path: join(screens, "e2e-reviewer-repin-after-reload.png") });
  record("the owner re-pins while a reviewer's page is open; it shows the reload bar, and after reloading the new version");

  // --- Sign-in off: nothing can be shared and the links pause; on again, they open.
  const secondUrl = `${harness.api}${second.path}`;
  const guestKey = randomBytes(32).toString("base64url");
  const { versionId } = (await (await fetch(`${secondUrl}/info`)).json()).data;
  const posted = await fetch(`${secondUrl}/comments`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-PPM-Request": "1", "X-PPM-Guest-Key": guestKey },
    body: JSON.stringify({ name: "Cleo", body: "Second link: is the button green on purpose?", versionId, anchor: {
      file: "index.html", ppmId: null, gen: null, tag: "a", cssPath: "a.cta", quote: { exact: "Start free", prefix: "", suffix: "" } } }),
  });
  assert.equal(posted.status, 201, await posted.text());
  assert.equal((await (await fetch(`${harness.api}/__threads-test/sign-in/off`, { method: "POST" })).json()).enabled, false);
  dialog = await openShareDialog(owner);
  const notice = dialog.getByTestId("share-address-signin-off");
  await notice.waitFor();
  assert.ok((await notice.textContent()).includes("Turn on PPM sign-in first"));
  await notice.getByRole("button", { name: "Open General" }).waitFor();
  const create = dialog.getByTestId("share-create");
  assert.equal(await create.isDisabled(), true, "Create is disabled");
  assert.equal((await create.textContent()).trim(), "Turn on PPM sign-in first");
  assert.equal(await dialog.getByTestId("share-new-link").count(), 0, "no new-link form while sign-in is off");
  await until("the second link to read as paused", async () =>
    (await linkRow(dialog, "Second client").getByTestId("share-link-status").textContent()) === "Paused: sign-in is off");
  await owner.screenshot({ path: join(screens, "e2e-owner-05-signin-off.png") });
  const paused = await openReviewer(harness.browser, secondUrl, { mobile: true });
  contexts.push(paused.context);
  await waitForInvalid(paused, 10000);
  await paused.page.screenshot({ path: join(screens, "e2e-reviewer-signin-off-invalid.png") });
  assert.equal((await (await fetch(`${harness.api}/__threads-test/sign-in/on`, { method: "POST" })).json()).enabled, true);
  await paused.page.reload();
  await waitForDesign(paused, TITLE);
  await dialog.getByRole("button", { name: "Close" }).first().click();
  record("with sign-in off the dialog says to turn it on, Create is disabled, links read Paused and do not open");

  // --- Revoke: both reviewers end on the invalid page.
  dialog = await openShareDialog(owner);
  const row = linkRow(dialog, "Client review");
  await row.getByRole("button", { name: "More actions for Client review" }).click();
  await row.getByRole("group", { name: "Link actions" }).getByRole("button", { name: "Revoke", exact: true }).click();
  await row.getByTestId("share-row-panel").getByText("Revoking is final").waitFor();
  await owner.screenshot({ path: join(screens, "e2e-owner-06-revoke-confirm.png") });
  await row.getByRole("button", { name: "Revoke link" }).click();
  await until("the link to read Revoked", async () => (await row.getByTestId("share-link-status").textContent()) === "Revoked");
  // Their open pages find out on the next poll; a fresh load gets the server's own page.
  await Promise.all([waitForInvalid(a), waitForInvalid(b)]);
  await a.page.screenshot({ path: join(screens, "e2e-reviewer-a-phone-04-revoked.png") });
  await b.page.screenshot({ path: join(screens, "e2e-reviewer-b-desktop-02-revoked.png") });
  for (const rv of [a, b]) {
    const res = await rv.page.reload();
    assert.equal(res.status(), 404);
    await rv.page.getByRole("heading", { name: INVALID_TITLE }).waitFor();
  }
  await dialog.getByRole("button", { name: "Close" }).first().click();
  record("the owner revokes the link and both reviewers get the invalid page");

  // --- Restart on the same PPM_HOME: the second link still opens, with its comment.
  await harness.restartBackend();
  const after = await openReviewer(harness.browser, secondUrl, { mobile: false });
  contexts.push(after.context);
  await waitForDesign(after, TITLE);
  const afterList = await showList(after);
  await afterList.getByText("Second link: is the button green on purpose?").waitFor();
  assert.ok((await afterList.textContent()).includes("Cleo"));
  await after.page.screenshot({ path: join(screens, "e2e-restart-second-link-with-comments.png") });
  assert.equal((await fetch(guestUrl)).status, 404, "the revoked link stays revoked after the restart");
  const relisted = (await api(`/api/project/${PROJECT}/designs/${slug}/shares`)).body.data.links;
  assert.equal(relisted.find((l) => l.id === second.id).path, second.path, "the same address after the restart");
  record("after a restart the second link opens at the same address with its comment; the revoked one stays closed");

  for (const rv of [a, b, paused, after]) assert.deepEqual(rv.errors, [], "no page errors on the reviewer page");
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  await owner?.screenshot({ path: join(screens, "e2e-failure-owner.png") }).catch(() => {});
  for (const [i, c] of contexts.entries()) {
    for (const p of c.pages()) await p.screenshot({ path: join(screens, `e2e-failure-context-${i}.png`) }).catch(() => {});
  }
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await harness.browser.close();
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ results, sandbox: harness.sandbox }, null, 2));
  console.log(`${results.length} passed${process.exitCode ? ", then FAILED" : ""}. Artifacts: ${harness.artifacts}`);
}
