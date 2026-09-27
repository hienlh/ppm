import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { until } from "./fixtures/design-mode-helpers.mjs";

// Settings → Design in a real Chrome, at a desktop and a phone viewport, against the
// disposable design-mode fixture server (isolated PPM_HOME and home folder, scripted
// providers, no network): the install suggestion shows while no skill is named, typing `/`
// lists the skill installed in the sandbox home, picking it inserts `/pretty-ui`, the
// mention resolves for the design provider, Save persists it, and a reload shows it again.
// Run with Node + Bun and Playwright (PPM_PLAYWRIGHT_MODULE, PPM_PLAYWRIGHT_CHANNEL=chrome).

const PROJECT = "design-settings-e2e";
const SKILL = "pretty-ui";
const VIEWPORTS = [
  { width: 1366, height: 900, mobile: false },
  { width: 390, height: 844, mobile: true },
];

async function openDesignSettings(page) {
  await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  await page.evaluate(async (name) => {
    const projects = (await import("/stores/project-store.ts")).useProjectStore;
    await projects.getState().fetchProjects();
    projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
    (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
    (await import("/components/settings/open-settings.ts")).openSettings("design");
  }, PROJECT);
  const box = page.locator('textarea[aria-label="Design instructions"]:visible').first();
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
      let box = await openDesignSettings(page);
      await dismissFirstSteps(page);
      await page.getByText("No design skill installed").waitFor();
      assert.ok(await page.getByText("uipro init --ai claude --global").isVisible(), "the upstream install command is shown");
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
