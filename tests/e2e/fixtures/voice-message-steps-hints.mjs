// The browser scenarios for a fresh install, where each surface sends Whisper's text as heard with
// hints (`PPM_VOICE_TRANSCRIPT_FIX=hints`): no Haiku call, the transcript in the box and the bubble
// is Whisper's own, the message the AI receives carries the server's hints block after it, and
// Settings → Voice Input sets the chat box and Telegram apart.
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  PHONE, PROJECT, RAW_TRANSCRIPT, micButton, openChat, sendButton, settle, shotName, stopButton, transcriptBox, until, voicePart,
} from "./voice-message-helpers.mjs";

const HINTS_END = "\n</ppm-voice-hints-v1>";

export async function recordVoice(page, seconds = 3) {
  await micButton(page).click();
  await page.locator("[data-voice-recording]").waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(seconds * 1000);
}

/** Opens Settings → Voice Input, the way a person does on that device. */
export async function openVoiceSettings(page, phone) {
  if (phone) await page.mouse.click(24, 822);
  await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: /^Voice Input/ }).first().click();
  await page.getByTestId("voice-transcript-fix").first().waitFor({ timeout: 15000 });
}

export async function runHintsScenarios(ctx) {
  const { kit, browser, install, shots } = ctx;
  const shot = (page, device, step) => page.screenshot({ path: join(shots, shotName(device, step)) });

  await kit.scenario("H as heard with hints: no Haiku, the AI gets the misheard words", async () => {
    await install.api("/api/speech/voice-settings", { method: "PUT", body: JSON.stringify({ project: PROJECT, projectWords: ["Hono"] }) });
    const view = (await install.api(`/api/speech/voice-settings?project=${PROJECT}`)).data;
    assert.deepEqual(view.transcriptFix, { composer: "hints", telegram: "hints" }, "a fresh install sends both as heard");
    const haikuBefore = (await install.haikuCalls()).length;
    const { page, errors } = await openChat({ browser, web: install.web, install, title: "Hints" });
    await recordVoice(page, 3);
    await stopButton(page).click();
    await transcriptBox(page).waitFor({ timeout: 60000 });
    await until("Whisper's own text in the box", async () => (await transcriptBox(page).inputValue()) === RAW_TRANSCRIPT, 60000);
    await settle(page, 600);
    await shot(page, "desktop", "07-hints-review");
    const before = (await install.turns()).length;
    await sendButton(page).click();
    await until("the message reaches the provider", async () => (await install.turns()).length > before, 30000);
    const message = (await install.turns()).slice(before)[0].message;
    assert.ok(message.endsWith(HINTS_END), `the hints block closes the message: ${JSON.stringify(message.slice(-160))}`);
    const data = JSON.parse(message.slice(message.lastIndexOf("Hints (JSON): ") + "Hints (JSON): ".length, -HINTS_END.length));
    assert.deepEqual(data.close, ["Hono"], "the project word said as two syllables is named");
    assert.ok(message.includes(`${RAW_TRANSCRIPT}\n\n<ppm-voice-hints-v1>`), "the transcript is Whisper's own, right before the hints");
    assert.equal((await install.haikuCalls()).length, haikuBefore, "no Haiku call for the message");
    // The bubble shows the transcript, never the hints.
    await voicePart(page).first().waitFor({ timeout: 30000 });
    const bubble = await voicePart(page).first().innerText();
    assert.ok(bubble.includes("hô nô") && !bubble.includes("ppm-voice-hints") && !bubble.includes("Hints (JSON)"), `bubble: ${bubble}`);
    await settle(page, 400);
    await shot(page, "desktop", "08-hints-bubble");
    assert.deepEqual(errors, [], "no page errors");
    kit.record("H: sent as heard with no Haiku call; the AI got {close:[Hono]}; the bubble shows only the transcript", { close: data.close });
    await page.context().close();
  });

  await kit.scenario("H Settings → Voice Input sets the chat box and Telegram apart (desktop)", async () => {
    const { page } = await openChat({ browser, web: install.web, install, title: "Hints settings" });
    await openVoiceSettings(page, false);
    await settle(page, 500);
    await shot(page, "desktop", "09-settings-transcript-fix");
    await page.locator('[data-surface="telegram"][data-choice="haiku"]').first().click();
    await until("Telegram set to Haiku", async () =>
      (await install.api("/api/speech/voice-settings")).data.transcriptFix.telegram === "haiku", 15000);
    const fix = (await install.api("/api/speech/voice-settings")).data.transcriptFix;
    assert.deepEqual(fix, { composer: "hints", telegram: "haiku" }, "only Telegram changed");
    // With one surface on Haiku, the Vietnamese-fixes switch that belongs to the clean-up appears.
    await page.getByText("Fix Vietnamese words by context").first().waitFor({ timeout: 10000 });
    await settle(page, 400);
    await shot(page, "desktop", "10-settings-telegram-haiku");
    await page.locator('[data-surface="telegram"][data-choice="hints"]').first().click();
    await until("Telegram back to hints", async () =>
      (await install.api("/api/speech/voice-settings")).data.transcriptFix.telegram === "hints", 15000);
    kit.record("H: Settings saves each surface's choice apart");
    await page.context().close();
  });

  await kit.scenario("H Settings → Voice Input (phone)", async () => {
    const { page } = await openChat({ browser, web: install.web, install, device: PHONE, title: "Hints settings phone" });
    await openVoiceSettings(page, true);
    const box = await page.locator('[data-surface="composer"][data-choice="hints"]').filter({ visible: true }).first().boundingBox();
    assert.ok(box && box.height >= 44, `a choice is a 44 px touch target on a phone: ${JSON.stringify(box)}`);
    await page.getByTestId("voice-transcript-fix").filter({ visible: true }).first().scrollIntoViewIfNeeded();
    await settle(page, 500);
    await shot(page, "phone", "09-settings-transcript-fix");
    kit.record("H: the choices fit a 390 px phone with 44 px targets", { height: box.height });
    await page.context().close();
  });
}
