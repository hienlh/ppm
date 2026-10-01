import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { apiJson, overlay, sendDesignTurn, settleSnapshots, until } from "./design-mode-helpers.mjs";
import { focusTab, tabsOf } from "./design-mode-steps-export.mjs";

/**
 * Per-app design systems: declaring an app in Settings → Design, the New Design dialog's app
 * picker (with no "set up first?" step any more — the first design for an app with no system
 * sets it up itself, in its own chat, on its first turn), the showcase page that turn leaves
 * ready, the sidebar's "Design systems" group, and the stale reminder after a real git change.
 */

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(dir) {
  if (git(dir, "init", "-q").status !== 0) return false;
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  return true;
}

function commit(dir, message) {
  git(dir, "add", "-A");
  return git(dir, "commit", "-q", "-m", message);
}

async function closeSettingsWindow(ctx) {
  await ctx.page.evaluate(async () => {
    const { useWindowStore } = await import("/components/floating-window/window-store.ts");
    const win = Object.values(useWindowStore.getState().windows).find((w) => w.kind === "settings");
    if (win) useWindowStore.getState().close(win.id);
  });
}

async function declareApp(ctx, { label, root, platform }) {
  await ctx.page.evaluate(async () => (await import("/components/settings/open-settings.ts")).openSettings("design"));
  await ctx.page.getByText("Apps in this project").waitFor({ timeout: 15000 });
  await ctx.page.getByRole("button", { name: "Add app" }).click();
  const form = overlay(ctx, "Add an app");
  await form.waitFor();
  await form.locator('input[placeholder="e.g. Payroll frontend"]').fill(label);
  if (platform === "mobile") await form.getByRole("radio", { name: "Mobile" }).click();
  await form.locator('input[placeholder="e.g. payroll-fe"]').fill(root);
  await form.getByRole("button", { name: "Save" }).click();
  await form.waitFor({ state: "detached", timeout: 10000 });
  // Mobile keeps the design tab's sidebar around too, which may already show the same label
  // in its own "Design systems" group — any match proves the app was declared.
  await ctx.page.getByText(label, { exact: true }).first().waitFor({ timeout: 10000 });
  if (!ctx.mobile) await closeSettingsWindow(ctx);
}

/**
 * Opens the New Design dialog, picks `appLabel`, fills `title`, and clicks Create. No "set up
 * the design system first?" step exists any more, so this also asserts the dialog never
 * mentioned one before creating — the only thing it offers beyond the title/kind/provider is
 * which app the design belongs to.
 */
async function createDesignFor(ctx, appLabel, title) {
  await ctx.page.evaluate(async (projectName) => (await import("/lib/design/design-ui-events.ts")).requestNewDesign(projectName), ctx.projectName);
  const dialog = overlay(ctx, "New design");
  await dialog.waitFor();
  await dialog.locator('input[placeholder="e.g. Pricing page"]').fill(title);
  // The app picker only appears once its own (async) systems fetch resolves; the provider
  // picker's fetch runs at the same time, so the very first paint may show just the latter.
  await until("the app picker to appear", async () => (await dialog.locator("select").count()) >= 2);
  await dialog.locator("select").first().selectOption({ label: appLabel });
  assert.equal(await dialog.getByText(/design system/i).count(), 0, "no design-system step before Create");
  const before = (await tabsOf(ctx)).length;
  await dialog.getByRole("button", { name: "Create" }).click();
  await dialog.waitFor({ state: "detached", timeout: 10000 });
  await until("a new design tab to open", async () => (await tabsOf(ctx)).length > before);
  const tab = (await tabsOf(ctx)).find((t) => t.title === title && t.metadata?.designSlug);
  assert.ok(tab, `a tab for "${title}" with a design slug`);
  return { tabId: tab.id, slug: tab.metadata.designSlug };
}

export async function stepDesignSystemsPerApp(ctx) {
  // Both viewports share one server and project (only the browser context is per-viewport),
  // so every name here carries the width the way the kit/variants steps already do.
  const label = `Payroll ${ctx.width}`;
  const appId = `payroll-${ctx.width}`;
  const folder = `payroll-fe-${ctx.width}`;
  const appRoot = join(ctx.harness.project, folder);
  await mkdir(appRoot, { recursive: true });
  const hasGit = initRepo(appRoot);
  if (hasGit) {
    await writeFile(join(appRoot, "a.ts"), "export const a = 1;\n");
    commit(appRoot, "init");
  }

  await declareApp(ctx, { label, root: folder, platform: "web" });
  ctx.record("declares a new app in Settings → Design");

  const title = `App home ${ctx.width}`;
  const { tabId, slug } = await createDesignFor(ctx, label, title);
  ctx.record("New Design's app picker offers a declared app, with no setup step in the way");

  // Reassigning the shared ctx fields is safe: this is the suite's last step, nothing after
  // it depends on whichever design earlier steps left focused.
  ctx.designTitle = title;
  ctx.slug = slug;
  ctx.designDir = join(ctx.harness.project, "designs", slug);
  ctx.tabId = tabId;
  await focusTab(ctx, tabId);

  const call = await sendDesignTurn(ctx, "Build the app's home page [[design:build]]");
  assert.equal(call.step, "build");
  assert.equal(call.autoSetupId, appId, "the first turn's instructions carried the auto-setup block for this app");
  ctx.record("the design's own first turn carries the auto-setup block and builds the page in the same turn");

  const appApi = `/api/project/${encodeURIComponent(ctx.projectName)}/designs/systems/${appId}`;
  await until("the app's design-system files to land on disk", async () => {
    const res = await apiJson(ctx, appApi);
    return res.body?.data?.hasDesignMd === true && res.body?.data?.hasTokensCss === true;
  });
  const showcaseManifest = JSON.parse(await readFile(join(ctx.harness.project, "designs", `system-${appId}`, "design.json"), "utf8"));
  assert.equal(showcaseManifest.showcaseFor, appId, "the showcase's folder and manifest were prepared server-side, not by the agent");
  ctx.record("the agent's one turn sets up DESIGN.md/tokens.css/kit, writes the showcase page PPM already prepared, and builds the design");

  // builtFrom is recorded from the same debounced hook as the turn snapshot: force it now
  // rather than padding every check below with the debounce's own 2s.
  await settleSnapshots(ctx);
  await until("builtFrom to be recorded for the app", async () => {
    const res = await apiJson(ctx, appApi);
    return !!res.body?.data?.builtFrom;
  });
  ctx.record("builtFrom is recorded once the design's first turn leaves DESIGN.md in place");

  // A later, ordinary turn on the same design must never see the auto-setup block again.
  const again = await sendDesignTurn(ctx, "Tweak the footer [[design:edit-footer]]");
  assert.equal(again.autoSetupId, null, "a later turn on a design whose system already exists gets no auto-setup block");
  ctx.record("a later turn on the same design never repeats the setup");

  if (!ctx.mobile) {
    await ctx.page.evaluate(async () => {
      const s = (await import("/stores/settings-store.ts")).useSettingsStore.getState();
      if (s.sidebarCollapsed) s.toggleSidebar();
      s.setSidebarActiveTab("designs");
    });
  } else {
    // The drawer's open/closed state is local to app.tsx, not a store: reach it the way a
    // thumb would, through the bottom nav's menu button and the drawer's own Designs tile.
    await ctx.page.locator('button[aria-label="Open menu"]:visible').click();
    await ctx.page.locator('button[data-tabid="designs"]:visible').click();
  }
  await ctx.page.getByText("Design systems", { exact: true }).waitFor({ timeout: 10000 });
  // Exact text: a substring match on the label would also catch the ordinary design's own title.
  const row = ctx.page.locator("button:visible").filter({ has: ctx.page.getByText(label, { exact: true }) }).first();
  await row.waitFor();
  // The file watcher (not this client) reports the agent's writes; it has its own latency,
  // so the row's status catches up rather than being correct on the very next paint.
  await until("the sidebar to report the app as set up", async () => /Ready|Built/.test(await row.innerText()), { timeout: 30000 });
  ctx.record("the sidebar's Design systems group lists the declared app with its status");
  if (ctx.mobile) {
    // The drawer panel covers the backdrop's own left 90vw; click the sliver still exposed.
    await ctx.page.locator('[aria-label="Close drawer"]:visible').click({ position: { x: Math.round(ctx.width * 0.95), y: 40 } });
  }

  if (hasGit) {
    for (let i = 0; i < 20; i++) await writeFile(join(appRoot, `c${i}.tsx`), `export const C${i} = () => null;\n`);
    commit(appRoot, "20 component files");
    await until("the stale endpoint to report the app as may-be-outdated", async () => {
      const res = await apiJson(ctx, `${appApi}/stale`);
      return res.body?.data?.stale === true && res.body?.data?.changedFiles >= 20;
    });
    ctx.record("20 changed UI files in the app's repo makes the stale check report may-be-outdated");
  }

  // A second, mobile app (its own folder and repo too): the same auto-setup runs for it, so
  // the mobile platform is covered too, not only web.
  const mobileLabel = `Mobile app ${ctx.width}`;
  const mobileId = `mobile-app-${ctx.width}`;
  const mobileFolder = `mobile-app-${ctx.width}`;
  const mobileRoot = join(ctx.harness.project, mobileFolder);
  await mkdir(mobileRoot, { recursive: true });
  if (initRepo(mobileRoot)) {
    await writeFile(join(mobileRoot, "App.tsx"), "export default function App() { return null; }\n");
    commit(mobileRoot, "init");
  }
  const created = await apiJson(ctx, `/api/project/${encodeURIComponent(ctx.projectName)}/designs/systems`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: mobileLabel, root: mobileFolder, platform: "mobile" }),
  });
  assert.equal(created.status, 201);

  const mobileTitle = `Onboarding screen ${ctx.width}`;
  const mobileDesign = await createDesignFor(ctx, mobileLabel, mobileTitle);
  ctx.designTitle = mobileTitle;
  ctx.slug = mobileDesign.slug;
  ctx.designDir = join(ctx.harness.project, "designs", mobileDesign.slug);
  ctx.tabId = mobileDesign.tabId;
  await focusTab(ctx, mobileDesign.tabId);
  const mobileCall = await sendDesignTurn(ctx, "Build the onboarding screen [[design:build]]");
  assert.equal(mobileCall.autoSetupId, mobileId, "the mobile app's first design also auto-sets its system up");
  const mobileApi = `/api/project/${encodeURIComponent(ctx.projectName)}/designs/systems/${mobileId}`;
  await until("the mobile app's design-system files to land on disk", async () => {
    const res = await apiJson(ctx, mobileApi);
    return res.body?.data?.hasDesignMd === true;
  });
  ctx.record("a mobile app's first design sets its own design system up the same way");
}
