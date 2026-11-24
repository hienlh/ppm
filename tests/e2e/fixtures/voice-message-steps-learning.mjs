// Self-learning from the chat's own reading (on the "hints" install): the scripted AI opens each
// answer with "Hiểu là: hô nô → Hono"; the chat draws that as "AI hiểu: …" above the answer, three
// such messages teach Hono (marked "chat"), the fourth message's hints name it, and Settings lists
// it with Undo, which puts it on the undone list.
import assert from "node:assert/strict";
import { join } from "node:path";
import { PHONE, PROJECT, RAW_TRANSCRIPT, openChat, sendButton, settle, shotName, stopButton, transcriptBox, until } from "./voice-message-helpers.mjs";
import { openVoiceSettings, recordVoice } from "./voice-message-steps-hints.mjs";

const READING = "Hiểu là: hô nô → Hono";
const ANSWER = `${READING}\nĐã rõ, em sửa middleware Hono.`;

export async function runChatLearningScenarios(ctx) {
  const { kit, browser, install, shots } = ctx;
  const shot = (page, device, step) => page.screenshot({ path: join(shots, shotName(device, step)) });
  const learned = async () => (await install.api(`/api/speech/voice-settings?project=${PROJECT}`)).data.projectLearned;

  /** Records one voice message, waits for Whisper, sends it, and waits for the scripted answer. */
  async function sendVoice(page) {
    const before = (await install.turns()).length;
    await recordVoice(page, 2);
    await stopButton(page).click();
    await until("Whisper's text in the box", async () => (await transcriptBox(page).inputValue()) === RAW_TRANSCRIPT, 60000);
    await sendButton(page).click();
    await until("the message reaches the provider", async () => (await install.turns()).length > before, 30000);
    return (await install.turns()).at(-1).message;
  }

  await kit.scenario("L2 the chat's reading is shown, and learned after three messages", async () => {
    // Nothing typed for the project, so Hono can only come from the chat's reading.
    await install.api("/api/speech/voice-settings", { method: "PUT", body: JSON.stringify({ selfLearning: true, project: PROJECT, projectWords: [] }) });
    await install.test("/reply", { text: ANSWER });
    const { page, errors } = await openChat({ browser, web: install.web, install, title: "Learning" });
    for (let i = 1; i <= 3; i++) {
      await sendVoice(page);
      await until(`answer ${i} drawn`, async () => (await page.locator("[data-voice-understood]").count()) >= i, 30000);
      if (i < 3) assert.equal((await learned()).length, 0, `nothing learned after ${i} message(s)`);
    }
    const line = await page.locator("[data-voice-understood]").first().innerText();
    assert.equal(line.replace(/\s+/g, " ").trim(), "AI hiểu: hô nô → Hono", `the line: ${line}`);
    const answerText = await page.locator("[data-voice-understood]").first().locator("xpath=..").innerText();
    assert.ok(!answerText.includes("Hiểu là"), "the raw line is not repeated as answer text");
    await until("Hono learned", async () => (await learned()).some((l) => l.word === "Hono"), 15000);
    const word = (await learned()).find((l) => l.word === "Hono");
    assert.deepEqual({ from: word.from, source: word.source, hits: word.hits }, { from: "hô nô", source: "chat", hits: 3 });
    await settle(page, 500);
    await shot(page, "desktop", "11-chat-ai-understood");

    // The fourth message carries the learned pair to the AI.
    const fourth = await sendVoice(page);
    const json = JSON.parse(fourth.slice(fourth.lastIndexOf("Hints (JSON): ") + "Hints (JSON): ".length, fourth.lastIndexOf("\n</ppm-voice-hints-v1>")));
    assert.deepEqual(json.misheard, [{ heard: "hô nô", meant: "Hono" }], "the learned pair rides on the next message");
    assert.deepEqual(errors, [], "no page errors");
    kit.record("L2: AI hiểu drawn above each answer; Hono learned from the chat after 3 messages; the 4th message's hints name it", { hits: word.hits });
    await page.context().close();
  });

  await kit.scenario("L2 the chat's reading on a phone", async () => {
    const { page } = await openChat({ browser, web: install.web, install, device: PHONE, title: "Learning phone" });
    await sendVoice(page);
    await page.locator("[data-voice-understood]").filter({ visible: true }).first().waitFor({ timeout: 30000 });
    await settle(page, 500);
    await shot(page, "phone", "11-chat-ai-understood");
    kit.record("L2: the AI hiểu line on a 390 px phone");
    await page.context().close();
  });

  await kit.scenario("L2 Settings lists the word as chat-taught, with Undo", async () => {
    // The phone first: the desktop pass ends by undoing the word.
    for (const [device, phone] of [["phone", true], ["desktop", false]]) {
      const { page } = await openChat({ browser, web: install.web, install, ...(phone ? { device: PHONE } : {}), title: `Learned ${device}` });
      await openVoiceSettings(page, phone);
      const toggle = page.getByText("Learn from how the AI read your words").filter({ visible: true }).first();
      await toggle.waitFor({ timeout: 15000 });
      const row = page.locator("li").filter({ hasText: "Hono" }).filter({ hasText: "chat · " }).filter({ visible: true }).first();
      try {
        await row.waitFor({ timeout: 15000 });
      } catch (e) {
        await shot(page, device, "FAIL-12-settings-learned");
        const items = await page.locator("li").allInnerTexts();
        throw new Error(`no chat-taught Hono row; list items: ${JSON.stringify(items.slice(0, 40))}`);
      }
      await row.scrollIntoViewIfNeeded();
      await settle(page, 500);
      await shot(page, device, "12-settings-learned-from-chat");
      if (!phone) {
        await row.getByRole("button", { name: "Undo learned word Hono" }).click();
        await until("Hono undone", async () => !(await learned()).some((l) => l.word === "Hono"), 15000);
        const blocked = (await install.api(`/api/speech/voice-settings?project=${PROJECT}`)).data.projectBlocked;
        assert.ok(blocked.some((b) => b.word === "Hono" && b.source === "chat"), "undone onto the blocked list");
      }
      await page.context().close();
    }
    kit.record("L2: Settings shows Hono as chat · 3× with Undo, and Undo blocks it");
  });
}
