// Voice messages, the feature-introduction step on a phone: an install with a chat (so the step
// comes at once, without the basic tour) is asked about voice messages, and Turn on switches them on
// in the server's voice settings.
import assert from "node:assert/strict";
import { current, gotoApp, PHONE, PROJECT, shotName } from "./voice-message-helpers.mjs";
import { join } from "node:path";

/** The step's panel, named after the introduction's title. */
const introStep = (page) => page.getByRole("dialog", { name: "Voice messages" });

export async function runIntroScenario({ kit, browser, install, shots }) {
  // A chat makes the install "in use", which is what asks the question at once.
  await install.api(`/api/project/${PROJECT}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Earlier chat" }) });
  const before = (await install.api("/api/speech/voice-settings")).data;
  assert.notEqual(before.enabled, true, "voice messages start unanswered, so off");

  const context = await browser.newContext({ ...PHONE, serviceWorkers: "block" });
  const page = await context.newPage();
  current.page = page;
  try {
    await gotoApp(page, `${install.web}/project/${PROJECT}`);
    await introStep(page).waitFor({ timeout: 30000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, shotName("phone", "00-feature-intro-voice")) });

    await introStep(page).getByRole("button", { name: "Turn on", exact: true }).click();
    await introStep(page).waitFor({ state: "detached", timeout: 10000 });
    const after = (await install.api("/api/speech/voice-settings")).data;
    assert.equal(after.enabled, true, "Turn on writes voice_message.enabled");
    const intro = (await install.api("/api/feature-intros")).data;
    assert.ok(!intro.pending?.some?.((i) => i.id === "voice-messages-2026-11"), "the question is no longer pending");
    kit.record("intro: an install in use is asked about voice messages on a phone, and Turn on switches them on");
  } finally {
    await context.close();
  }
}
