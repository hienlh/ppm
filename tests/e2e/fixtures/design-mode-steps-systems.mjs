import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { apiJson, overlay, settleSnapshots, until } from "./design-mode-helpers.mjs";
import { tabsOf } from "./design-mode-steps-export.mjs";

/**
 * Per-app design systems (phase 15): declaring an app in Settings → Design, the New Design
 * dialog's app picker and "Set up first / Skip" step, the showcase tab and its auto-sent
 * brief, the sidebar's "Design systems" group, the stale reminder after a real git change,
 * and the skip path never asking twice.
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

/** Opens the New Design dialog, picks `appLabel`, fills a title, and clicks Create. */
async function openNewDesignFor(ctx, appLabel, title) {
  await ctx.page.evaluate(async (projectName) => (await import("/lib/design/design-ui-events.ts")).requestNewDesign(projectName), ctx.projectName);
  const dialog = overlay(ctx, "New design");
  await dialog.waitFor();
  await dialog.locator('input[placeholder="e.g. Pricing page"]').fill(title);
  // The app picker only appears once its own (async) systems fetch resolves; the provider
  // picker's fetch runs at the same time, so the very first paint may show just the latter.
  await until("the app picker to appear", async () => (await dialog.locator("select").count()) >= 2);
  await dialog.locator("select").first().selectOption({ label: appLabel });
  await dialog.getByRole("button", { name: "Create" }).click();
  return dialog;
}

async function activeTabId(ctx) {
  return ctx.page.evaluate(async () => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    return Object.values(usePanelStore.getState().panels).map((p) => p.activeTabId);
  });
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

  const dialog = await openNewDesignFor(ctx, label, "App home");
  const setupNote = dialog.getByText(new RegExp(`Set up "${label}"'s design system first\\?`));
  await setupNote.waitFor({ timeout: 10000 });
  await dialog.getByRole("button", { name: /Set up design system first/ }).click();
  await dialog.waitFor({ state: "detached", timeout: 10000 });
  ctx.record("New Design's app picker offers a declared app, and offers to set it up first");

  const showcaseSlug = `system-${appId}`;
  await until("the showcase tab to exist and be focused", async () => {
    const tabs = await tabsOf(ctx);
    const showcase = tabs.find((t) => t.metadata?.designSlug === showcaseSlug);
    if (!showcase) return false;
    return (await activeTabId(ctx)).includes(showcase.id);
  });
  ctx.record("Set up first opens and focuses the app's showcase tab");

  await until("the scripted provider to finish the setup turn", async () => {
    const calls = (await apiJson(ctx, "/__design-test/calls")).body;
    return calls.some((c) => c.designSlug === showcaseSlug && c.done);
  });
  const appApi = `/api/project/${encodeURIComponent(ctx.projectName)}/designs/systems/${appId}`;
  await until("the app's files to land on disk", async () => {
    const res = await apiJson(ctx, appApi);
    return res.body?.data?.hasDesignMd === true && res.body?.data?.hasTokensCss === true;
  });
  // builtFrom is recorded from the same debounced hook as the turn snapshot: force it now
  // rather than padding every check below with the debounce's own 2s.
  await settleSnapshots(ctx);
  await until("builtFrom to be recorded for the showcase's app", async () => {
    const res = await apiJson(ctx, appApi);
    return !!res.body?.data?.builtFrom;
  });
  ctx.record("set up first auto-sends the brief; the scripted provider writes the app's design system");

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
  // Exact text: a substring match on the label would also catch the ordinary design "App home".
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

  // Skip path: a second, mobile app (its own folder and repo too) never asks again once skipped.
  const mobileLabel = `Mobile app ${ctx.width}`;
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

  const skipDialog = await openNewDesignFor(ctx, mobileLabel, "Onboarding screen");
  await skipDialog.getByText(new RegExp(`Set up "${mobileLabel}"'s design system first\\?`)).waitFor({ timeout: 10000 });
  await skipDialog.getByRole("button", { name: "Skip for now" }).click();
  await skipDialog.waitFor({ state: "detached", timeout: 10000 });

  const before = (await tabsOf(ctx)).length;
  await openNewDesignFor(ctx, mobileLabel, "Second screen");
  await until("the design to be created with no setup offer in the way", async () => (await tabsOf(ctx)).length > before);
  assert.equal(await ctx.page.getByText(/design system first\?/).count(), 0, "skipping once is remembered; it is not asked again");
  ctx.record("Skip is remembered per app and the offer is not repeated");
}
