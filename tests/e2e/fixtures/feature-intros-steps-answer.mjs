// Feature-introduction e2e, part 1: a new install meets the step after its basic tour and turns
// the feature on (a); an install in use meets it at once, without the tour, and turns it off (b);
// the phone's bottom sheet (e); and an answer on one device closing the step on another (f).
import assert from "node:assert/strict";
import {
  addProject, allSwitches, assertNotAsked, featureStep, gotoLoaded, INTRO_TOOLS, newChat, openPage, seedInUse, sendInChat,
  startInstall, stepButton, tourDismissed, tourOffer, tourStatus,
} from "./feature-intros-helpers.mjs";

export async function runAnswerSteps(ctx) {
  const { kit } = ctx;
  const intro = async (install) => (await install.state()).featureIntros["session-tools-2026-11"];

  // ── a: new install — basic tour first, then the feature step; Turn on reaches a chat ──
  await kit.scenario("a new install", async () => {
    const install = await startInstall(ctx, "a-new-install");
    try {
      // `ppm init` adds the repositories it finds: a project, but no chat yet.
      await addProject(install);
      const view = await install.view();
      assert.equal(view.isExistingUser, false, "a project alone is a new install");
      assert.equal(view.pending.length, 1);
      const { page } = await openPage(ctx, install);
      ctx.current = page;
      await page.getByRole("button", { name: "Start guided tour" }).waitFor({ timeout: 20000 });
      await assertNotAsked(page);
      await kit.shot(page, "a1-new-install-basic-tour-first");

      await page.getByRole("button", { name: "Maybe later" }).click();
      await featureStep(page).waitFor({ timeout: 10000 });
      assert.equal(await tourStatus(page), "dismissed");
      assert(await featureStep(page).evaluate((el) => el.contains(document.activeElement)), "focus moved into the step");
      await kit.shot(page, "a2-feature-step-after-tour");

      await stepButton(page, "Turn on").click();
      await featureStep(page).waitFor({ state: "detached", timeout: 10000 });
      await kit.shot(page, "a3-turned-on-step-closed");
      const state = await install.state();
      assert.deepEqual(state.ppmTools, allSwitches(true), "all six switches written on");
      assert.deepEqual((await install.api("/api/settings/ai")).data.ppm_tools, allSwitches(true), "the settings API agrees");
      assert.equal((await intro(install)).answer, "on");
      assert.equal((await intro(install)).via, "tour");

      const chat = await newChat(install, "Tool check");
      await sendInChat(page, install, chat, "Which session tools do you have?");
      const turn = await kit.until("the chat's turn listed its tools", async () => (await install.turns()).find((t) => t.sessionId === chat.id), 30000, 200);
      assert.deepEqual(turn.tools, [...INTRO_TOOLS].sort(), `tools/list: ${JSON.stringify(turn)}`);
      assert(turn.statuses.length === 2 && turn.statuses.every((s) => s === 200), `both endpoints listed: ${JSON.stringify(turn)}`);
      await page.getByText("Session tools handed to this turn").first().waitFor({ timeout: 15000 });
      await kit.shot(page, "a4-chat-tools-list-has-the-six");

      await gotoLoaded(page);
      await assertNotAsked(page);
      kit.record("a: a new install (a project, no chat) sees the basic tour first, the feature step right after it is put away, and Turn on writes the six switches that a new chat's tools/list then shows", { tools: turn.tools });
    } finally { await install.stop(); }
  });

  // ── b: an install in use — the step comes at once, the tour does not start; Turn off ──
  await kit.scenario("b existing install", async () => {
    const install = await startInstall(ctx, "b-existing-install");
    try {
      await seedInUse(install);
      const { page } = await openPage(ctx, install);
      ctx.current = page;
      await featureStep(page).waitFor({ timeout: 20000 });
      assert.equal(await tourOffer(page).count(), 0, "the basic tour is not offered over it");
      assert(["unseen", null].includes(await tourStatus(page)), `the tour did not start (${await tourStatus(page)})`);
      assert(await featureStep(page).evaluate((el) => el.contains(document.activeElement)), "focus moved into the step");
      await kit.shot(page, "b1-existing-install-step-at-once");

      await stepButton(page, "Turn off").click();
      await featureStep(page).waitFor({ state: "detached", timeout: 10000 });
      await page.waitForTimeout(1000);
      assert.equal(await tourOffer(page).count(), 0, "no basic-tour offer once the question is answered either");
      assert(["unseen", null].includes(await tourStatus(page)), "answering did not start the tour");
      await kit.shot(page, "b2-turned-off-no-tour-offer");
      assert.deepEqual((await install.state()).ppmTools, allSwitches(false), "all six switches written off");
      assert.equal((await intro(install)).answer, "off");

      const chat = await newChat(install, "Tool check");
      await sendInChat(page, install, chat, "Which session tools do you have?");
      const turn = await kit.until("the chat's turn ran", async () => (await install.turns()).find((t) => t.sessionId === chat.id), 30000, 200);
      assert.deepEqual(turn.tools, [], `no session tools handed to the turn: ${JSON.stringify(turn)}`);
      await page.getByText("No session tools were handed to this turn.").first().waitFor({ timeout: 15000 });
      assert.equal(await tourOffer(page).count(), 0, "still no basic-tour offer after a reload");
      await kit.shot(page, "b3-chat-has-no-session-tools");
      kit.record("b: an install with a chat gets the feature step at once with no basic-tour offer before or after, and Turn off leaves a new chat with none of the six tools");
    } finally { await install.stop(); }
  });

  // ── e + f: the phone's bottom sheet; an answer on the phone closes the desktop's step ──
  await kit.scenario("e f phone and second device", async () => {
    const install = await startInstall(ctx, "ef-two-devices");
    try {
      await seedInUse(install);
      const desktop = await openPage(ctx, install, { init: tourDismissed });
      const phone = await openPage(ctx, install, { phone: true, init: tourDismissed });
      await featureStep(desktop.page).waitFor({ timeout: 20000 });
      ctx.current = phone.page;
      await featureStep(phone.page).waitFor({ timeout: 20000 });
      for (const name of ["Turn on", "Turn off", "Later"]) {
        const box = await stepButton(phone.page, name).boundingBox();
        assert(box && box.height >= 44 && box.y >= 0 && box.y + box.height <= 844, `${name} is a 44px target on screen (${JSON.stringify(box)})`);
      }
      const sheet = await featureStep(phone.page).boundingBox();
      assert(sheet.y + sheet.height >= 844 - 120 && sheet.y > 844 / 4, `the step sits in a bottom sheet (${JSON.stringify(sheet)})`);
      await kit.shot(phone.page, "e1-phone-bottom-sheet");
      kit.record("e: on a 390x844 phone the step is a bottom sheet with 44px Turn on / Turn off / Later", { sheet });

      await stepButton(phone.page, "Turn on").tap();
      await featureStep(phone.page).waitFor({ state: "detached", timeout: 10000 });
      ctx.current = desktop.page;
      await featureStep(desktop.page).waitFor({ state: "detached", timeout: 10000 });
      await kit.shot(desktop.page, "f1-desktop-closed-by-phone-answer");
      const record = await intro(install);
      assert.equal(record.answer, "on");
      assert.equal(record.skips, 0, "the desktop recorded no skip when its step closed");
      kit.record("f: Turn on tapped on the phone closes the open step on the desktop, with no skip recorded there");
      await desktop.context.close(); await phone.context.close();
    } finally { await install.stop(); }
  });
}
