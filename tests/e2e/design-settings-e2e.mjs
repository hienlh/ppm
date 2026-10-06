import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { until } from "./fixtures/design-mode-helpers.mjs";

// Settings → Design in a real Chrome, at a desktop and a phone viewport, against the
// disposable design-mode fixture server (isolated PPM_HOME and home folder, scripted
// providers): the install suggestion shows while no skill is named, typing `/`
// lists the skill installed in the sandbox home, picking it inserts `/pretty-ui`, the
// mention resolves for the design provider, Save persists it, and a reload shows it again.
// Last, Install puts ui-ux-pro-max in the sandbox home (from the npm registry) and names it.
// Run with Node + Bun and Playwright (PPM_PLAYWRIGHT_MODULE, PPM_PLAYWRIGHT_CHANNEL=chrome).

const PROJECT = "design-settings-e2e";
const SKILL = "pretty-ui";
const VIEWPORTS = [
  { width: 1366, height: 900, mobile: false },
  { width: 390, height: 844, mobile: true },
];

/**
 * Selects the project, then opens Settings → Design: by the gear in the sidebar's Designs
 * header when `viaSidebar`, otherwise directly.
 */
async function openDesignSettings(page, { viaSidebar = false } = {}) {
  await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  await page.evaluate(async ({ name, viaSidebar }) => {
    const projects = (await import("/stores/project-store.ts")).useProjectStore;
    await projects.getState().fetchProjects();
    projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
    (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
    if (viaSidebar) (await import("/stores/settings-store.ts")).useSettingsStore.getState().setSidebarActiveTab("designs");
    else (await import("/components/settings/open-settings.ts")).openSettings("design");
  }, { name: PROJECT, viaSidebar });
  const box = page.locator('textarea[aria-label="Design instructions"]:visible').first();
  if (viaSidebar) {
    assert.equal(await box.count(), 0, "Settings → Design is not open before the gear is used");
    await page.locator('button[aria-label="Design settings"]:visible').click({ timeout: 15000 });
  }
  await box.waitFor({ timeout: 15000 });
  return box;
}

/**
 * A fresh profile gets the first-steps card, which on a phone sits over the Save button.
 * Dismissed the way a user would; the choice is kept in this context's storage.
 */
async function dismissFirstSteps(page) {
  const later = page.getByRole("complementary", { name: "PPM guided tour" }).getByRole("button", { name: "Maybe later" });
  try {
    await later.waitFor({ timeout: 5000 });
    await later.click();
    await later.waitFor({ state: "detached", timeout: 5000 });
  } catch { /* not shown on this run */ }
}

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/design-mode-server.ts" });
const results = [], diagnostics = [];
try {
  // A user-level skill in the sandbox home, found by the same discovery the chat composer uses.
  const skillDir = join(harness.sandbox, "home", ".claude", "skills", SKILL);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${SKILL}\ndescription: Picks palettes and type for a page.\n---\nBody.\n`);
  const created = await fetch(`${harness.api}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }),
  });
  assert.ok(created.ok, `project registration: ${created.status}`);

  for (const { width, height, mobile } of VIEWPORTS) {
    const reset = await fetch(`${harness.api}/api/settings/design`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructions: "" }),
    });
    assert.equal(reset.status, 200);
    const context = await harness.browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") diagnostics.push(`${width}px ${m.text()}`); });
    page.on("pageerror", (e) => diagnostics.push(`${width}px pageerror ${e.message}`));
    const pass = (name) => { results.push({ name: `${width}px ${name}`, passed: true }); console.log(`PASS ${width}px ${name}`); };
    try {
      await page.goto(harness.web);
      // The phone reaches the Designs list through its drawer; the gear there is the same button.
      let box = await openDesignSettings(page, { viaSidebar: !mobile });
      if (!mobile) pass("the gear in the sidebar's Designs header opens Settings → Design");
      await dismissFirstSteps(page);
      await page.getByText("No design skill installed").waitFor();
      const install = page.getByRole("button", { name: "Install ui-ux-pro-max" });
      assert.ok(await install.isVisible(), "the Install button is shown");
      if (mobile) assert.ok((await install.boundingBox()).height >= 44, "Install is a 44px target");
      assert.equal(await page.getByText("uipro init --ai claude --global").isVisible(), false, "the manual commands start folded");
      const card = page.getByRole("region", { name: "Suggested design skill" });
      await card.screenshot({ path: join(harness.artifacts, `design-skill-card-${width}.png`) });
      await card.getByText("Install it yourself instead").click();
      assert.ok(await page.getByText("uipro init --ai claude --global").isVisible(), "the manual commands unfold");
      await card.screenshot({ path: join(harness.artifacts, `design-skill-card-open-${width}.png`) });
      pass("suggests a design skill while none is named");

      await box.click();
      await page.keyboard.type("Use /pret");
      const row = page.locator("button:visible", { hasText: `/${SKILL}` }).first();
      await row.waitFor({ timeout: 10000 });
      await row.click();
      assert.equal(await box.inputValue(), `Use /${SKILL} `);
      pass("typing / lists the installed skill and a pick inserts it");

      const status = page.locator(`li[data-mention="${SKILL}"]`);
      await status.waitFor();
      assert.match(await status.innerText(), new RegExp(`Design test AI: ${SKILL}`));
      await until("the suggestion to go away", async () => !(await page.getByText("No design skill installed").count()));
      pass("the mention resolves for the design provider");

      const save = page.getByRole("button", { name: "Save", exact: true });
      if (mobile) {
        const b = await save.boundingBox();
        assert.ok(b.height >= 44, `Save is ${b.height}px tall`);
      }
      await save.click();
      await page.locator("[data-sonner-toast]").filter({ hasText: "Design instructions saved" }).first().waitFor();
      const stored = await (await fetch(`${harness.api}/api/settings/design`)).json();
      assert.equal(stored.data.instructions, `Use /${SKILL}`);
      pass("Save persists the instructions");

      await page.reload();
      box = await openDesignSettings(page);
      await until("the saved text after reload", async () => (await box.inputValue()) === `Use /${SKILL}`);
      pass("a reload shows the saved instructions");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal overflow");
      await page.screenshot({ path: join(harness.artifacts, `design-settings-${width}.png`), fullPage: true });
    } catch (error) {
      await page.screenshot({ path: join(harness.artifacts, `failure-design-settings-${width}.png`), fullPage: true }).catch(() => {});
      throw new Error(`${width}px: ${error.message}`, { cause: error });
    } finally {
      await context.close();
    }
  }

  // Install, last: once ui-ux-pro-max is in the sandbox home, no viewport shows the suggestion.
  // Downloads the pinned package from the npm registry.
  {
    const { width, height, mobile } = VIEWPORTS[VIEWPORTS.length - 1];
    const reset = await fetch(`${harness.api}/api/settings/design`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructions: "" }),
    });
    assert.equal(reset.status, 200);
    const context = await harness.browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.on("pageerror", (e) => diagnostics.push(`${width}px pageerror ${e.message}`));
    const pass = (name) => { results.push({ name: `${width}px ${name}`, passed: true }); console.log(`PASS ${width}px ${name}`); };
    try {
      await page.goto(harness.web);
      await openDesignSettings(page);
      await dismissFirstSteps(page);
      await page.getByRole("button", { name: "Install ui-ux-pro-max" }).click();
      await page.locator("[data-sonner-toast]").filter({ hasText: "Installed ui-ux-pro-max" }).first().waitFor({ timeout: 60000 });
      const skill = join(harness.sandbox, "home", ".claude", "skills", "ui-ux-pro-max", "SKILL.md");
      assert.match(await readFile(skill, "utf8"), /^---\nname: ui-ux-pro-max\n/);
      const stored = await (await fetch(`${harness.api}/api/settings/design`)).json();
      assert.equal(stored.data.instructions, "Use /ui-ux-pro-max before designing.");
      await until("the suggestion to go away", async () => !(await page.getByText("No design skill installed").count()));
      await page.locator('li[data-mention="ui-ux-pro-max"]').waitFor();
      pass("Install puts the skill in place and names it in the saved instructions");
      await page.screenshot({ path: join(harness.artifacts, `design-settings-installed-${width}.png`), fullPage: true });
    } catch (error) {
      await page.screenshot({ path: join(harness.artifacts, `failure-design-skill-install-${width}.png`), fullPage: true }).catch(() => {});
      throw new Error(`${width}px install: ${error.message}`, { cause: error });
    } finally {
      await context.close();
    }
  }
} catch (error) {
  process.exitCode = 1;
  results.push({ passed: false, error: String(error), stack: error.cause?.stack ?? error.stack });
  console.error(error.message, "\n", error.cause?.stack ?? error.stack);
} finally {
  await harness.browser.close();
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "results.json"), JSON.stringify({ results, diagnostics, sandbox: harness.sandbox }, null, 2));
  console.log(`Artifacts: ${harness.artifacts}`);
  if (diagnostics.length) console.log("Console errors:", diagnostics);
}
