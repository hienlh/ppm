// Feature-introduction e2e, part 2: putting the question off on three days leaves the feature off
// and marked NEW in Settings → Tools, where it can still be turned on (c); several screens open at
// once count one skip (g); and a switch already set counts as the answer — saved through Settings
// before any device asked, set from the step's own Settings link, or written with no route seeing
// it while a device shows the step (d).
import assert from "node:assert/strict";
import {
  allSwitches, assertNotAsked, closeSettings, featureStep, gotoLoaded, INTRO_TOOLS, openPage, openTools, seedInUse,
  startInstall, stepButton, switchStates, toolSwitch, tourDismissed,
} from "./feature-intros-helpers.mjs";

const ID = "session-tools-2026-11";

export async function runLaterSteps(ctx) {
  const { kit } = ctx;
  const record = async (install) => (await install.state()).featureIntros[ID] ?? { answer: null, skips: 0 };
  const skipsAre = (install, n) => kit.until(`${n} skip(s) recorded`, async () => (await record(install)).skips === n, 10000, 150);

  // ── c: Later ×3 over three app opens → off and NEW in Settings → Tools → on there → NEW gone ──
  await kit.scenario("c later three times", async () => {
    const install = await startInstall(ctx, "c-later-three-times");
    try {
      await seedInUse(install);
      const { page } = await openPage(ctx, install, { init: tourDismissed });
      ctx.current = page;

      // Open 1: Later. A refetch in the same open (any device's change) neither brings it back nor skips again.
      await featureStep(page).waitFor({ timeout: 20000 });
      await stepButton(page, "Later").click();
      await featureStep(page).waitFor({ state: "detached", timeout: 10000 });
      await skipsAre(install, 1);
      await page.evaluate(() => window.dispatchEvent(new Event("feature-intros:changed")));
      await assertNotAsked(page, 1500);
      assert.equal((await record(install)).skips, 1, "one skip for the first open");
      await kit.shot(page, "c1-later-once");

      // Two reloads with the step left alone: a reload records nothing by itself.
      for (let n = 0; n < 2; n++) {
        await gotoLoaded(page);
        await featureStep(page).waitFor({ timeout: 20000 });
      }
      await page.waitForTimeout(1000);
      assert.equal((await record(install)).skips, 1, "reloading without answering records no skip");
      await kit.shot(page, "c2-asked-again-after-reload");
      // Closed again the same day: within the window it is not counted.
      await stepButton(page, "Close, ask me later").click();
      await featureStep(page).waitFor({ state: "detached", timeout: 10000 });
      await page.waitForTimeout(1000);
      assert.equal((await record(install)).skips, 1, "a second close within 12 hours is not counted");

      // Open 2, a day later: the X. Open 3, another day later: Escape, the last allowed skip.
      await install.post("/__intro-test/later-day", { id: ID });
      await gotoLoaded(page);
      await featureStep(page).waitFor({ timeout: 20000 });
      await stepButton(page, "Close, ask me later").click();
      await skipsAre(install, 2);
      await install.post("/__intro-test/later-day", { id: ID });
      await gotoLoaded(page);
      await featureStep(page).waitFor({ timeout: 20000 });
      await page.keyboard.press("Escape");
      await featureStep(page).waitFor({ state: "detached", timeout: 10000 });
      await skipsAre(install, 3);
      const settled = await record(install);
      assert.equal(settled.answer, "off");
      assert.equal(settled.via, "skips");
      assert.deepEqual(await install.state().then((s) => s.ppmTools), {}, "three skips write no switch: off by default");
      assert.deepEqual((await install.view()).newInSettings, [ID]);

      await gotoLoaded(page);
      await assertNotAsked(page);
      await openTools(page);
      await page.locator("[data-new-tool]").first().waitFor({ timeout: 10000 });
      assert.deepEqual((await page.locator("[data-new-tool]").evaluateAll((els) => els.map((e) => e.getAttribute("data-new-tool")))).sort(), [...INTRO_TOOLS].sort());
      assert.deepEqual(await switchStates(page), allSwitches(false), "the six switches show off");
      await toolSwitch(page, "search_sessions").scrollIntoViewIfNeeded();
      await kit.shot(page, "c3-settings-tools-new-marker");

      for (const tool of INTRO_TOOLS) {
        await toolSwitch(page, tool).click();
        await kit.until(`${tool} saved on`, async () => (await install.state()).ppmTools[tool] === true, 10000, 150);
      }
      assert.deepEqual((await install.state()).ppmTools, allSwitches(true));
      assert.deepEqual(await switchStates(page), allSwitches(true));
      await kit.shot(page, "c4-turned-on-in-settings");
      assert.deepEqual((await install.view()).newInSettings, [], "the visit counted as seen");
      await closeSettings(page);
      await openTools(page);
      await page.waitForTimeout(1000);
      assert.equal(await page.locator("[data-new-tool]").count(), 0, "no NEW marker on the next visit");
      await kit.shot(page, "c5-settings-new-marker-gone");
      kit.record("c: Later, the X and Escape on three days (plain reloads, a same-open refetch and a second close the same day recording nothing) leave the feature off and NEW in Settings → Tools, where turning the six on works and the marker clears", { record: await record(install) });
    } finally { await install.stop(); }
  });

  // ── g: several screens open at once: one "Later" closes the question on all of them, one skip ──
  await kit.scenario("g several screens put off once", async () => {
    const install = await startInstall(ctx, "g-several-screens");
    try {
      await seedInUse(install);
      const first = await openPage(ctx, install, { init: tourDismissed });
      const second = await openPage(ctx, install, { init: tourDismissed });
      await featureStep(first.page).waitFor({ timeout: 20000 });
      await featureStep(second.page).waitFor({ timeout: 20000 });
      ctx.current = first.page;
      await stepButton(first.page, "Later").click();
      await skipsAre(install, 1);
      ctx.current = second.page;
      await featureStep(second.page).waitFor({ state: "detached", timeout: 10000 });
      await kit.shot(second.page, "g1-other-screen-closed-by-later");
      // Both reopened the same day: closing it again (here with Escape on the second screen) closes the
      // first one too, and the sitting still counts one skip.
      for (const { page } of [first, second]) {
        await gotoLoaded(page);
        await featureStep(page).waitFor({ timeout: 20000 });
      }
      await featureStep(second.page).focus();
      await second.page.keyboard.press("Escape");
      await featureStep(second.page).waitFor({ state: "detached", timeout: 10000 });
      await featureStep(first.page).waitFor({ state: "detached", timeout: 10000 });
      await first.page.waitForTimeout(1000);
      assert.deepEqual(await record(install).then((r) => [r.answer, r.skips]), [null, 1], "one skip for the whole sitting");
      kit.record("g: Later on one screen closes the question on another without a skip of its own, and closing it again the same day still counts one skip");
      await first.context.close(); await second.context.close();
    } finally { await install.stop(); }
  });

  // ── d1: a switch saved in Settings before any device asked: never asked ──
  await kit.scenario("d pre-set in settings", async () => {
    const install = await startInstall(ctx, "d1-preset-in-settings");
    try {
      await seedInUse(install);
      // Exactly what flipping the switch in Settings → Tools sends.
      await install.put("/api/settings/ai", { ppm_tools: { search_sessions: true } });
      const expected = { ...allSwitches(false), search_sessions: true };
      assert.deepEqual((await install.state()).ppmTools, expected, "siblings written at their state, none flipped");
      const { page } = await openPage(ctx, install);
      ctx.current = page;
      await assertNotAsked(page);
      await gotoLoaded(page);
      await assertNotAsked(page);
      await kit.shot(page, "d1-preset-never-asked");
      assert.deepEqual(await record(install).then((r) => [r.answer, r.via]), ["on", "settings"]);
      kit.record("d1: a switch saved in Settings → Tools before the step was shown counts as the answer: never asked, the other five stay off");
    } finally { await install.stop(); }
  });

  // ── d2: the step's own "Settings → Tools" link: deciding there is answering ──
  await kit.scenario("d settings link", async () => {
    const install = await startInstall(ctx, "d2-settings-link");
    try {
      await seedInUse(install);
      const { page } = await openPage(ctx, install, { init: tourDismissed });
      ctx.current = page;
      await featureStep(page).waitFor({ timeout: 20000 });
      await stepButton(page, "Change single tools in Settings → Tools").click();
      await featureStep(page).waitFor({ state: "detached", timeout: 10000 });
      await toolSwitch(page, "create_session").waitFor({ timeout: 15000 });
      assert.deepEqual(await switchStates(page), allSwitches(false), "off before any answer");
      await toolSwitch(page, "create_session").click();
      await kit.until("create_session saved on", async () => (await install.state()).ppmTools.create_session === true, 10000, 150);
      await kit.shot(page, "d2-decided-in-settings-from-the-step");
      assert.deepEqual((await install.state()).ppmTools, { ...allSwitches(false), create_session: true });
      const r = await record(install);
      assert.deepEqual([r.answer, r.via, r.skips], ["on", "settings", 0], "answered in Settings, no skip for leaving the step");
      await gotoLoaded(page);
      await assertNotAsked(page);
      kit.record("d2: the step's Settings link hides it without a skip, and one switch set there settles the question");
    } finally { await install.stop(); }
  });

  // ── d3: a switch written with no route seeing it; the next load records it and closes the step elsewhere ──
  await kit.scenario("d raw switch closes other devices", async () => {
    const install = await startInstall(ctx, "d3-raw-switch");
    try {
      await seedInUse(install);
      const first = await openPage(ctx, install, { init: tourDismissed });
      ctx.current = first.page;
      await featureStep(first.page).waitFor({ timeout: 20000 });
      await install.post("/__intro-test/raw-switch", { tool: "read_session_turns", on: false });
      // A second device opening the app is what reads the switch and records the answer.
      const second = await openPage(ctx, install, { init: tourDismissed });
      await assertNotAsked(second.page, 1000);
      await featureStep(first.page).waitFor({ state: "detached", timeout: 10000 });
      await kit.shot(first.page, "d3-first-device-closed-by-recorded-switch");
      const r = await record(install);
      assert.deepEqual([r.answer, r.via, r.skips], ["off", "settings", 0]);
      kit.record("d3: a switch set outside Settings is recorded as the answer on the next load, and the step open on another device closes");
      await first.context.close(); await second.context.close();
    } finally { await install.stop(); }
  });
}
