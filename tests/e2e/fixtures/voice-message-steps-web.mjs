// The browser scenarios of the voice-message e2e (scenarios A–D and the Settings pane), against one
// fixture install with the feature on. Each scenario is recorded by the driver's `kit.scenario`, so a
// failure is listed with its screenshot and the run goes on.
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  DESKTOP, PHONE, RAW_TRANSCRIPT, composer, gotoApp, micButton, openChat, sendButton, settle, shotName, stopButton,
  transcriptBox, until, voicePart,
} from "./voice-message-helpers.mjs";

/** What the typed part of the message says; the picture rides with it. */
export const TYPED = "Sửa lại middleware giúp em nhé";
/** The clean-up's answer in the fixture (the misheard term is left for the user to fix). */
const CLEANED = "OK, giờ em sửa cái hô nô middleware cho Bun.serve đi.";
const EDITED = CLEANED.replace("hô nô", "Hono");
const VOICE_MARKER = /\[Voice message \(\d+:\d{2}\), transcribed below; the audio needs no opening: /;

/** Records for `seconds`, then stops, the way a person does with the mic. */
async function recordVoice(page, seconds = 3) {
  await micButton(page).click();
  await page.locator("[data-voice-recording]").waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(seconds * 1000);
}

export async function runWebScenarios(ctx) {
  const { kit, browser, install, shots, media } = ctx;
  const shot = (page, device, step) => page.screenshot({ path: join(shots, shotName(device, step)) });
  const turnsNow = async () => (await install.turns()).length;

  /** A (desktop, then phone): image + typed text + voice in one composer, edited, sent once. */
  async function reviewFlow(device) {
    const phone = device === "phone";
    const { chat, page, errors } = await openChat({ browser, web: install.web, install, device: phone ? PHONE : DESKTOP, title: `Review ${device}` });
    await composer(page).fill(TYPED);
    // The composer's own picker: the one multi-file input with no `accept` (the avatar pickers take images only).
    await page.locator('input[type="file"][multiple]:not([accept])').first().setInputFiles(media.png);
    await settle(page, 1200);
    // Shot while the recording bar is up: the recording is still going, Stop not yet pressed.
    await recordVoice(page, 3);
    await shot(page, device, "01-recording-bar");
    await stopButton(page).click();
    await page.getByRole("status").filter({ hasText: "Transcribing on this machine" }).first().waitFor({ timeout: 15000 });
    await settle(page, 300);
    await shot(page, device, "02-processing");
    await transcriptBox(page).waitFor({ timeout: 60000 });
    await until("cleaned transcript shown", async () => (await transcriptBox(page).inputValue()) === CLEANED, 60000);
    await settle(page, 600);
    await shot(page, device, "03-review-image-text-voice");
    // The one correction: the misheard product name fixed before sending.
    await transcriptBox(page).fill(EDITED);
    const before = await turnsNow();
    await sendButton(page).click();
    await until("the message reaches the provider", async () => (await turnsNow()) > before, 30000);
    const sent = (await install.turns()).slice(before);
    assert.equal(sent.length, 1, `exactly one message to the provider, got ${sent.length}`);
    const message = sent[0].message;
    const typedAt = message.indexOf(TYPED);
    const markerAt = message.search(VOICE_MARKER);
    assert.ok(typedAt >= 0, "the typed text is in the message");
    assert.ok(markerAt > typedAt, "the voice marker comes after the typed text");
    assert.ok(message.endsWith(EDITED), `the edited transcript is last: ${JSON.stringify(message.slice(-120))}`);
    assert.ok(message.includes("[Attached image") || sent[0].images > 0, "the picture is part of the message");
    kit.record(`${device}: one message to the provider with the picture, the typed text, then the voice marker and the edited transcript last`, {
      imageVia: message.includes("[Attached image") ? "path marker" : "inline data", bytes: message.length,
    });

    // The sent bubble: picture, typed text, audio player and transcript, all under one message.
    await voicePart(page).first().waitFor({ timeout: 30000 });
    await until("audio player in the bubble", async () => (await page.locator("[data-voice-part] audio").count()) > 0, 20000);
    const bubble = await page.evaluate((typed) => {
      const part = document.querySelector("[data-voice-part]");
      let node = part;
      while (node && !node.textContent?.includes(typed)) node = node.parentElement;
      return node ? { text: node.textContent ?? "", images: node.querySelectorAll("img").length, audio: node.querySelectorAll("audio").length } : null;
    }, TYPED);
    assert.ok(bubble, "one message holds the typed text and the voice part");
    assert.ok(bubble.images >= 1, "the sent bubble shows the picture");
    assert.ok(bubble.audio >= 1, "the sent bubble has an audio player");
    assert.ok(bubble.text.includes("Hono"), "the sent bubble shows the edited transcript");
    await settle(page, 500);
    await shot(page, device, "04-sent-bubble");
    kit.record(`${device}: the sent bubble shows the picture, the typed text, an audio player and the transcript`, { images: bubble.images, audio: bubble.audio });

    if (device === "desktop") {
      // The learning: the edit taught a pair, and the toast names the word.
      await until("the learning call reached the clean-up model", async () => (await install.haikuCalls()).some((c) => c.kind === "learn" && c.ok), 30000);
      await page.getByText("Learned: Hono", { exact: true }).waitFor({ timeout: 20000 });
      kit.record("desktop: /voice-learn asked the model and the Learned: Hono toast appeared");
    }

    // Reload: the sent message still draws its voice part from its text.
    await gotoApp(page);
    await voicePart(page).first().waitFor({ timeout: 30000 });
    kit.record(`${device}: after a reload the bubble still renders the voice part`);
    if (errors.length) kit.record(`${device}: page errors during the flow (informational)`, { errors: errors.slice(0, 5) });
    await page.context().close();
    return chat;
  }

  await kit.scenario("A desktop: picture + typed text + voice, review on", () => reviewFlow("desktop"));
  await kit.scenario("A phone: the same flow on a 390x844 phone", () => reviewFlow("phone"));

  // B: review off sends the voice by itself, with nothing else in the message.
  await kit.scenario("B review off: a voice sends itself", async () => {
    await install.api("/api/speech/voice-settings", { method: "PUT", body: JSON.stringify({ reviewBeforeSend: false }) });
    const { page } = await openChat({ browser, web: install.web, install, title: "Review off" });
    const before = await turnsNow();
    await recordVoice(page, 3);
    await stopButton(page).click();
    await until("the voice sent itself", async () => (await turnsNow()) > before, 60000);
    const sent = (await install.turns()).slice(before);
    assert.equal(sent.length, 1, `one message, got ${sent.length}`);
    assert.match(sent[0].message, VOICE_MARKER);
    assert.ok(sent[0].message.endsWith(CLEANED), `the cleaned transcript is sent: ${JSON.stringify(sent[0].message.slice(-100))}`);
    await voicePart(page).first().waitFor({ timeout: 30000 });
    assert.equal(await transcriptBox(page).count(), 0, "no transcript is left waiting for review");
    kit.record("B: with review off the voice went out without pressing Send, nothing else in the message");
    await page.context().close();
  });

  // C: a failed clean-up always waits for review, even with review off.
  await kit.scenario("C clean-up failure with review off: raw transcript waits, not sent", async () => {
    await install.api("/api/speech/voice-settings", { method: "PUT", body: JSON.stringify({ reviewBeforeSend: false }) });
    await install.test("/haiku", { mode: "throw" });
    const { page } = await openChat({ browser, web: install.web, install, title: "Clean-up fails" });
    const before = await turnsNow();
    await recordVoice(page, 3);
    await stopButton(page).click();
    await transcriptBox(page).waitFor({ timeout: 60000 });
    await until("raw transcript shown", async () => (await transcriptBox(page).inputValue()) === RAW_TRANSCRIPT, 60000);
    await page.getByText("Couldn't tidy up", { exact: false }).first().waitFor({ timeout: 10000 });
    await settle(page, 500);
    await shot(page, "desktop", "05-cleanup-failure");
    await page.waitForTimeout(4000);
    assert.equal(await turnsNow(), before, "nothing was sent while the raw transcript waits");
    assert.equal(await sendButton(page).isVisible(), true, "the Send button is there for the user to press");
    kit.record("C: clean-up failure showed the raw transcript and its notice, and did not send", { cleanup: "error" });
    await install.test("/haiku", { mode: "ok" });
    await install.api("/api/speech/voice-settings", { method: "PUT", body: JSON.stringify({ reviewBeforeSend: true }) });
    await page.context().close();
  });

  // F: review off, Send pressed while still transcribing, clean-up fails: the raw transcript must not go.
  await kit.scenario("F review off, Send while transcribing, clean-up fails: raw transcript not sent", async () => {
    await install.api("/api/speech/voice-settings", { method: "PUT", body: JSON.stringify({ reviewBeforeSend: false }) });
    await install.test("/haiku", { mode: "throw" });
    const { page } = await openChat({ browser, web: install.web, install, title: "Send while transcribing" });
    const before = await turnsNow();
    await recordVoice(page, 2);
    await stopButton(page).click();
    // Still transcribing: the status line is up. Press Send (disabled while a voice is in progress) and Enter in the composer.
    await page.getByRole("status").filter({ hasText: "Transcribing on this machine" }).first().waitFor({ timeout: 15000 });
    await sendButton(page).click({ force: true, timeout: 2000 }).catch(() => {});
    await composer(page).click().catch(() => {});
    await page.keyboard.press("Enter");
    // The clean-up has run and failed (the fixture's Haiku throws); only then is "not sent" a fact.
    await until("the clean-up attempt failed", async () => (await install.haikuCalls()).some((c) => c.kind === "cleanup" && !c.ok), 60000);
    await page.waitForTimeout(3000);
    const sentTurns = (await install.turns()).slice(before);
    assert.equal(sentTurns.length, 0, `the raw transcript was sent to the provider although review is on: ${JSON.stringify(sentTurns.map((t) => t.message.slice(-80)))}`);
    // The raw transcript waits in the review box, with the notice, instead of going out.
    await transcriptBox(page).waitFor({ timeout: 10000 });
    assert.equal(await transcriptBox(page).inputValue(), RAW_TRANSCRIPT, "the raw transcript is in the review box");
    kit.record("F: review off, Send pressed while transcribing, clean-up failed: nothing sent, raw transcript waits");
    await install.test("/haiku", { mode: "ok" });
    await install.api("/api/speech/voice-settings", { method: "PUT", body: JSON.stringify({ reviewBeforeSend: true }) });
    await page.context().close();
  });

  // Settings → Voice Input, on desktop and on a phone.
  await kit.scenario("Settings → Voice Input (desktop)", async () => {
    const { page } = await openChat({ browser, web: install.web, install, title: "Settings" });
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    // The category's accessible name also carries its subtitle, so match the label as a prefix.
    await page.getByRole("button", { name: /^Voice Input/ }).first().click();
    await page.getByRole("switch").first().waitFor({ timeout: 15000 });
    await settle(page, 500);
    await shot(page, "desktop", "06-settings-voice-input");
    kit.record("Settings → Voice Input shows the switches on desktop");
    await page.context().close();
  });
  await kit.scenario("Settings → Voice Input (phone)", async () => {
    const { page } = await openChat({ browser, web: install.web, install, device: PHONE, title: "Settings phone" });
    // On a phone Settings sits in the drawer behind the bottom bar's menu (the first icon), which the rail's own button is not.
    await page.mouse.click(24, 822);
    await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: /^Voice Input/ }).first().click();
    await page.getByRole("switch").first().waitFor({ timeout: 15000 });
    await settle(page, 500);
    await shot(page, "phone", "06-settings-voice-input");
    kit.record("Settings → Voice Input shows the switches on a phone");
    await page.context().close();
  });

  // D: feature off keeps the composer's mic from voice messages.
  await kit.scenario("D feature off: no voice chip, no voice mic", async () => {
    await install.api("/api/speech/voice-settings", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    const { page } = await openChat({ browser, web: install.web, install, title: "Feature off" });
    await composer(page).waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    assert.equal(await micButton(page).count(), 0, "no voice-message mic while the feature is off");
    assert.equal(await page.locator("[data-voice-recording]").count(), 0, "no recording bar");
    assert.equal(await page.locator("[data-voice-chip]").count(), 0, "no voice chip");
    kit.record("D: feature off showed no voice-message mic, bar or chip");
    await page.context().close();
  });
}
