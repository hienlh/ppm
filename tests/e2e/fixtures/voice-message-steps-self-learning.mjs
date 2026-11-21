// Voice self-learning in the voice-message e2e: Settings → Voice Input's self-learning group on a
// desktop and a phone (the prompt preview, the learned words, Undo and Restore), and on Telegram the
// card's "Fixed" and timing lines, the plain answer while voice messages are off with its button,
// and an audio file read like a voice note. The install is seeded with a week of learned words
// (PPM_VOICE_SELF_LEARNING=seed in voice-message-server.ts); Telegram messages are drawn from what the
// fake Bot API holds, so a screenshot shows exactly the HTML the bridge sent.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DESKTOP, openChat, PHONE, until } from "./voice-message-helpers.mjs";
import { TG_CHAT } from "./voice-message-steps-telegram.mjs";

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The bot's messages drawn as a phone shows them: each with the HTML the bridge sent (Telegram's own
 * tags — b, i, s, blockquote — render the same in a browser) and its buttons under it.
 */
function telegramFrame(messages, title) {
  const bubbles = messages.map((m) => {
    const rows = (m.reply_markup?.inline_keyboard ?? []).map((row) => `<div class="row">${row.map((b) => `<span class="btn">${esc(b.text)}</span>`).join("")}</div>`).join("");
    return `<div class="msg"><div class="text">${m.html ?? esc(m.text)}</div>${rows ? `<div class="kb">${rows}</div>` : ""}</div>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    body{margin:0;background:#0e1621;font:15px/1.45 system-ui,"Segoe UI",Arial,sans-serif;color:#e9edef;display:flex;justify-content:center}
    .phone{width:100%;max-width:520px;min-height:100vh;background:#0e1621;border-left:1px solid #1f2c3a;border-right:1px solid #1f2c3a}
    .bar{position:sticky;top:0;background:#17212b;padding:14px 16px;font-weight:600}
    .bar small{display:block;font-weight:400;color:#7f91a4;font-size:12px}
    .list{padding:12px;display:flex;flex-direction:column;gap:10px}
    .msg{max-width:88%;border-radius:12px;padding:8px 11px;white-space:pre-wrap;word-wrap:break-word;background:#182533;align-self:flex-start}
    blockquote{margin:6px 0;padding:4px 10px;border-left:3px solid #6ab3f3;background:rgba(106,179,243,.08);border-radius:4px}
    s{color:#e88b8b} b{font-weight:600} i{color:#c3ccd6}
    .kb{margin-top:8px;display:flex;flex-direction:column;gap:4px}.row{display:flex;gap:4px}
    .btn{flex:1;text-align:center;background:#2b3a4a;border-radius:8px;padding:8px 4px;font-size:13.5px}
  </style><div class="phone"><div class="bar">${esc(title)}<small>Telegram · drawn from the fake Bot API (the bridge's own HTML)</small></div><div class="list">${bubbles}</div></div>`;
}

const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function openVoiceSettings(browser, install, device) {
  const { page } = await openChat({ browser, web: install.web, install, device, title: `Self-learning ${device === PHONE ? "phone" : "desktop"}` });
  if (device === PHONE) await page.mouse.click(24, 822);
  await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: /^Voice Input/ }).filter({ visible: true }).first().click();
  await page.locator("[data-voice-learned-list]").waitFor({ timeout: 20000 });
  return page;
}

/** Scrolls the learned list into view inside whatever pane holds it, then shoots the visible screen. */
async function shootList(page, path) {
  await page.locator("[data-voice-prompt-preview]").scrollIntoViewIfNeeded();
  await settle(page, 500);
  await page.screenshot({ path });
}

export async function runSelfLearningWebScenarios({ kit, browser, install, shots }) {
  for (const [label, device] of [["desktop-1440", DESKTOP], ["phone-390", PHONE]]) {
    await kit.scenario(`L Settings self-learning (${label})`, async () => {
      const page = await openVoiceSettings(browser, install, device);
      const selfLearning = page.getByRole("switch", { name: /Learn your words by itself/ });
      assert.equal(await selfLearning.getAttribute("aria-checked"), "true", "self-learning shows on");
      const preview = await page.locator("[data-voice-prompt-preview]").innerText();
      assert.match(preview, /PPM/, "Whisper's prompt carries the learned term");
      assert.doesNotMatch(preview, /ra lệnh/, "a learned Vietnamese phrase is not in Whisper's prompt");
      const list = page.locator("[data-voice-learned-list]");
      for (const word of ["PPM", "Hono", "ra lệnh"]) assert.ok(await list.getByText(word, { exact: true }).count(), `${word} is listed`);
      await shootList(page, join(shots, `self-learning-settings-${label}.png`));
      kit.record(`L: the learned words and Whisper's prompt are shown (${label})`);

      if (device === DESKTOP) {
        // Undo moves the word to Undone; Restore brings it back. Both round-trip through the server.
        await list.getByRole("button", { name: "Undo learned word PPM", exact: true }).click();
        await until("PPM left the learned list", async () => (await list.getByText("PPM", { exact: true }).count()) === 0, 15000, 200);
        await list.getByRole("button", { name: /^Undone · 2$/ }).click();
        await list.getByText("PPM", { exact: true }).waitFor({ timeout: 10000 });
        await shootList(page, join(shots, `self-learning-undone-${label}.png`));
        const saved = await install.api("/api/speech/voice-settings?project=alpha");
        assert.ok(saved.data.projectBlocked.some((b) => b.word === "PPM"), "the server holds PPM as undone");
        await list.getByRole("button", { name: "Restore" }).first().click();
        await until("PPM is learned again", async () =>
          (await install.api("/api/speech/voice-settings?project=alpha")).data.projectLearned.some((l) => l.word === "PPM" && l.source === "cleanup" && l.hits === 3), 15000, 300);
        kit.record("L: Undo moved PPM to Undone on the server, Restore brought it back with its source and count");
      }
      await page.context().close();
    });
  }
}

export async function runSelfLearningTelegramScenarios({ kit, browser, install, control, ogg, shots }) {
  const post = (path, body) => fetch(control + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => { const j = await r.json(); assert.ok(r.ok, `${path}: ${JSON.stringify(j)}`); return j; });
  const sent = async () => (await (await fetch(`${control}/chat?id=${TG_CHAT}`)).json()).sent;
  const buttons = (m) => (m.reply_markup?.inline_keyboard ?? []).flat();
  const drawn = [];

  /** Draws the bot's messages from `from` on as the phone shows them, at both widths. */
  async function draw(from, name, title) {
    const messages = (await sent()).slice(from);
    const html = telegramFrame(messages, title);
    const file = join(shots, `${name}.html`);
    await writeFile(file, html);
    for (const [label, viewport] of [["phone-390", { width: 390, height: 844 }], ["desktop-1440", { width: 1440, height: 900 }]]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: label.startsWith("phone") ? 2 : 1 });
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.screenshot({ path: join(shots, `${name}-${label}.png`), fullPage: true });
      await context.close();
    }
    drawn.push(name);
  }

  await kit.scenario("T1 the card says what the clean-up fixed and how long each step took", async () => {
    const from = (await sent()).length;
    await post("/voice", { chatId: TG_CHAT, userId: TG_CHAT, duration: 2, mime: "audio/ogg", bytesBase64: ogg });
    const card = await until("a review card", async () => (await sent()).slice(from).find((m) => buttons(m).some((b) => b.text === "Send")), 60000, 200);
    assert.match(card.html ?? "", /Fixed: <s>/, "the card lists the fixes");
    assert.match(card.text, /Whisper \d+\.\d s · Haiku \d+\.\d s/, "the card times both steps");
    await draw(from, "telegram-card-fixed-timing", "PPM Assistant · voice card");
    await post("/press", { chatId: TG_CHAT, userId: TG_CHAT, messageId: card.message_id, data: buttons(card).find((b) => b.text === "Send").callback_data });
    kit.record("T1: the review card shows Fixed and the Whisper/Haiku times");
  });

  await kit.scenario("T2 voice messages off: said plainly, and the button turns them on", async () => {
    await install.test("/voice-enabled", { enabled: false });
    const from = (await sent()).length;
    await post("/voice", { chatId: TG_CHAT, userId: TG_CHAT, duration: 2, mime: "audio/ogg", bytesBase64: ogg });
    const reply = await until("the voice-off reply", async () => (await sent()).slice(from).find((m) => m.text.includes("Voice messages are turned off")), 30000, 200);
    assert.ok(!reply.text.includes("text and photos only"), "not the generic reply");
    const button = buttons(reply).find((b) => b.text === "Turn on voice messages");
    assert.ok(button, "the reply offers the switch (Whisper is installed in this fixture)");
    await draw(from, "telegram-voice-off", "PPM Assistant · voice off");
    await post("/press", { chatId: TG_CHAT, userId: TG_CHAT, messageId: reply.message_id, data: button.callback_data });
    await until("voice messages are on", async () => (await (await fetch(`${install.web}/__voice-test/voice-state`)).json()).enabled === true, 15000, 200);
    kit.record("T2: the off reply named the switch, and its button turned voice messages on");
  });

  await kit.scenario("T3 an audio file is read like a voice note", async () => {
    const from = (await sent()).length;
    const before = (await install.turns()).length;
    await post("/audio", { chatId: TG_CHAT, userId: TG_CHAT, duration: 4, mime: "audio/ogg", fileName: "memo.ogg", bytesBase64: ogg });
    const card = await until("the audio's review card", async () => (await sent()).slice(from).find((m) => buttons(m).some((b) => b.text === "Send")), 60000, 200);
    assert.ok(card.history[0]?.startsWith("🎵 Audio file — transcribing…"), `the status says it is an audio file: ${card.history[0]}`);
    await post("/press", { chatId: TG_CHAT, userId: TG_CHAT, messageId: card.message_id, data: buttons(card).find((b) => b.text === "Send").callback_data });
    await until("the audio reached the Assistant", async () => (await install.turns()).length > before, 60000);
    const message = (await install.turns()).slice(before)[0].message;
    assert.match(message, /telegram-audio\.ogg\]/, "stored under its own name and extension");
    await draw(from, "telegram-audio-file", "PPM Assistant · audio file");
    kit.record("T3: the audio file was transcribed, reviewed and sent with its own stored copy");
  });

  return drawn;
}
