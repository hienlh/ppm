// Answering the PPM Assistant's cards by voice in PPM's own screen, end to end on the production Vite
// bundle, at 1440 and 390: the mic on a decision and an urgent card in the manager chat's set of
// decisions, on a done card's reply bar, and on a question card's Other field in the Assistant.
//
// The microphone is Chromium's fake device playing a real recording of synthesized speech
// (tests/fixtures/voice/card-reply-synth.ogg, turned into the WAV Chromium reads). Whisper is a fake
// whisper-cli and Claude Haiku the fixture's scripted completeOnce (tests/e2e/fixtures/voice-message-
// server.ts); the chats are scripted. What the manager chat receives is checked: the user-words block
// with the voice part, and nothing to the Assistant. Every mic button is measured against the button
// standard (24px desktop, 22px phone).
//
// Run it in the capped e2e image, worktree read-only, a scratch web build and screenshot folder:
//
//   docker run --rm --cpus=4 --memory=6g --ulimit core=0 -v <worktree>:/app:ro -v ppm-e2e-nm:/app/node_modules \
//     -v <scratch-web>:/web -v <screenshots>:/out -w /app -e IS_SANDBOX=1 \
//     -e PPM_VOICE_WEB_DIR=/web -e PPM_VOICE_SHOTS=/out ppm-e2e-chromium:latest \
//     sh -c 'bun install --frozen-lockfile && node tests/e2e/card-voice-reply-e2e.mjs'
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DESKTOP, PHONE, PROJECT, gotoApp, run, settle, startFixture, tourDismissed, until } from "./fixtures/voice-message-helpers.mjs";

/** The fixture's tidied transcript (Haiku's scripted answer). */
const CLEANED = "OK, giờ em sửa cái hô nô middleware cho Bun.serve đi.";
const VOICE_MARKER = /\[Voice message \(\d+:\d{2}\), transcribed below; the audio needs no opening: /;

const sandbox = await mkdtemp(join(tmpdir(), "ppm-card-voice-e2e-"));
const shots = resolve(process.env.PPM_VOICE_SHOTS ?? join(sandbox, "shots"));
await mkdir(shots, { recursive: true });
const webDir = resolve(process.env.PPM_VOICE_WEB_DIR ?? join(sandbox, "web"));
const started = Date.now();
const results = [];
const failures = [];
const record = (name, detail = {}) => {
  results.push({ name, passed: true, ...detail });
  console.log(`PASS ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
};
let lastPage = null;
async function scenario(label, fn) {
  try { await fn(); } catch (e) {
    const message = String(e?.stack ?? e);
    failures.push({ scenario: label, error: message });
    results.push({ name: `scenario ${label}`, passed: false, error: message });
    console.log(`FAIL scenario ${label}: ${message}`);
    try { await lastPage?.screenshot({ path: join(shots, `FAIL-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`) }); } catch { /* gone */ }
  }
}
const kit = { until };

let browser;
let install;
try {
  if (!existsSync(join(webDir, "index.html"))) {
    await writeFile(join(shots, "vite.log"), await run("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir, "--emptyOutDir"]));
  }
  // Chromium's fake microphone reads WAV: the synthesized-speech fixture, converted once.
  const wav = join(sandbox, "card-reply-synth.wav");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", resolve("tests/fixtures/voice/card-reply-synth.ogg"), "-ar", "48000", "-ac", "1", wav]);

  const pw = await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE ?? "playwright").href);
  const executablePath = process.env.PPM_PLAYWRIGHT_EXECUTABLE;
  browser = await pw.chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--disable-dev-shm-usage"],
    ...(executablePath ? { executablePath } : {}),
  });

  install = await startFixture({ sandbox, artifacts: shots, webDir, name: "cards", mode: "web", feature: "on", kit });
  const test = install.test;
  const created = await install.api(`/api/project/${PROJECT}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Alpha manager" }) });
  const manager = created.data.id;
  await test("/manager", { sessionId: manager });
  const asker = (await install.api(`/api/project/${PROJECT}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Release checklist" }) })).data.id;
  // Each scenario starts with only its own card waiting: one left open by an earlier failure would
  // stand in front of it.
  const card = async (kind, title, extra = {}) => {
    await test("/clear-cards", {});
    return (await test("/card", { kind, title, sessionId: manager, body: "Needs your decision.", ...extra })).card;
  };
  const cardState = async (id) => (await test("/card-state", { id })).card;
  const review = (on) => test("/review", { on });

  /** What reached a chat since `from`, and whether any of it reached the Assistant. */
  const turnsSince = async (from) => (await install.turns()).slice(from);
  async function assertVoiceReachedManager(from, cardId, label) {
    const sent = await until(`${label}: the manager chat got the reply`, async () => {
      const turns = (await turnsSince(from)).filter((t) => t.sessionId === manager && t.message.includes(CLEANED));
      return turns.length ? turns : null;
    }, 60000);
    assert.equal(sent.length, 1, `${label}: exactly one message`);
    const message = sent[0].message;
    assert.match(message, /<ppm-user-words-v1>/, `${label}: inside the user-words block`);
    assert.ok(message.includes(cardId), `${label}: the block names the card`);
    assert.match(message, VOICE_MARKER, `${label}: carries the voice part`);
    const main = (await test("/main")).main?.sessionId ?? null;
    const toAssistant = (await turnsSince(from)).filter((t) => t.sessionId !== manager && t.message.includes(CLEANED));
    assert.equal(toAssistant.length, 0, `${label}: nothing went to the Assistant or another chat (main=${main})`);
    record(`${label}: manager chat got the transcript as a voice message in the user-words block; Assistant got nothing`);
  }

  async function newPage(device) {
    const context = await browser.newContext({ ...device, serviceWorkers: "block", permissions: ["microphone"] });
    await context.grantPermissions(["microphone"], { origin: install.web });
    await context.addInitScript(tourDismissed);
    const page = await context.newPage();
    lastPage = page;
    page.on("pageerror", (e) => console.log(`pageerror: ${e}`));
    return page;
  }
  const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) });

  /** The mic button must keep the button standard: 24px tall on a desktop, 22px on a phone. */
  async function assertMicSize(mic, phone, label) {
    // Brought into view first: the screenshot that follows is of the mic.
    await mic.scrollIntoViewIfNeeded();
    const box = await mic.boundingBox();
    assert.ok(box, `${label}: mic is on screen`);
    const want = phone ? 22 : 24;
    assert.ok(Math.abs(box.height - want) <= 0.5, `${label}: mic is ${want}px tall (got ${box.height})`);
    record(`${label}: mic ${Math.round(box.width)}×${Math.round(box.height)}px`);
  }

  /** Records three seconds of the fake microphone from `mic`, then presses the bar's Stop. */
  async function recordFrom(page, scope, mic, shotName) {
    await mic.click();
    const bar = scope.locator("[data-card-voice-recording]");
    await bar.waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(2500);
    await bar.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, shotName);
    await bar.locator('[data-voice-recording] button[aria-label="Stop recording"]').click();
  }

  async function openManagerChat(device) {
    const page = await newPage(device);
    await gotoApp(page, `${install.web}/project/${PROJECT}/chat/claude/${manager}`);
    await page.locator("[data-manager-waiting-cards]").waitFor({ timeout: 30000 });
    if (device === PHONE) {
      await page.locator("[data-waiting-toggle]").first().click();
      await page.locator("[data-waiting-sheet]").waitFor({ timeout: 10000 });
    }
    return page;
  }

  for (const [device, size] of [[DESKTOP, "1440"], [PHONE, "390"]]) {
    const phone = device === PHONE;

    await scenario(`${size} decision card, review off: spoken and sent at once`, async () => {
      await review(false);
      const c = await card("needs_decision", `Ship option one or two? (${size})`, { payload: { options: [{ id: "one", label: "Option one" }, { id: "two", label: "Option two" }] } });
      const page = await openManagerChat(device);
      const set = page.locator(`[data-decision-card="${c.id}"]`);
      await set.waitFor({ timeout: 30000 });
      const mic = set.locator("[data-card-voice-mic]");
      await mic.waitFor({ timeout: 30000 });
      await assertMicSize(mic, phone, `${size} decision`);
      await settle(page);
      await shot(page, `${size}-1-decision-mic`);
      const from = (await install.turns()).length;
      await recordFrom(page, set, mic, `${size}-2-decision-recording`);
      await assertVoiceReachedManager(from, c.id, `${size} decision`);
      await until(`${size}: card answered`, async () => (await cardState(c.id)).status === "answered", 15000);
      await settle(page, 800);
      await shot(page, `${size}-3-decision-sent`);
      await page.context().close();
    });

    await scenario(`${size} urgent card, review on: the transcript waits in the field, Send this one sends it`, async () => {
      await review(true);
      const c = await card("urgent", `Deploy blocked (${size})`);
      const page = await openManagerChat(device);
      const set = page.locator(`[data-decision-card="${c.id}"]`);
      await set.waitFor({ timeout: 30000 });
      const mic = set.locator("[data-card-voice-mic]");
      await mic.waitFor({ timeout: 30000 });
      await assertMicSize(mic, phone, `${size} urgent`);
      await shot(page, `${size}-4-urgent-mic`);
      const from = (await install.turns()).length;
      await recordFrom(page, set, mic, `${size}-5-urgent-recording`);
      await set.locator("[data-card-held-voice]").waitFor({ timeout: 60000 });
      assert.equal(await set.locator("[data-decision-reply]").inputValue(), CLEANED, `${size}: the transcript is in the field to read`);
      assert.equal((await turnsSince(from)).length, 0, `${size}: nothing sent before Send`);
      await settle(page);
      await shot(page, `${size}-6-urgent-review`);
      record(`${size} urgent: transcript held in the field for review with its recording`);
      await page.locator("[data-decision-send-one]").click();
      await assertVoiceReachedManager(from, c.id, `${size} urgent`);
      await settle(page, 800);
      await shot(page, `${size}-7-urgent-sent`);
      await page.context().close();
    });

    await scenario(`${size} done card in the Assistant: the reply bar's mic`, async () => {
      await review(false);
      const title = `Release notes written (${size})`;
      const c = await card("done", title, { body: "Done." });
      // A done report is not waiting on the user: it sits in the Assistant's stream, and its Reply
      // turns the Assistant's composer into the reply bar.
      const page = await newPage(device);
      await page.goto(`${install.web}/project/${PROJECT}/assistant`);
      const article = page.locator('[data-assistant-card="done"]:visible', { hasText: title }).first();
      await article.waitFor({ timeout: 45000 });
      await article.scrollIntoViewIfNeeded();
      if (phone) {
        // A long press opens the card's menu on a touch screen: a real touch held, through CDP.
        const box = await article.boundingBox();
        const cdp = await page.context().newCDPSession(page);
        const at = [{ x: box.x + 30, y: box.y + 20 }];
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at });
        await page.waitForTimeout(700);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await article.click({ button: "right", position: { x: 30, y: 20 } });
      }
      await page.getByRole("menuitem", { name: "Reply" }).or(page.getByRole("button", { name: "Reply", exact: true })).first().click();
      const bar = page.locator("[data-card-reply-bar]");
      await bar.waitFor({ timeout: 10000 });
      const mic = bar.locator("[data-card-voice-mic]");
      await mic.waitFor({ timeout: 30000 });
      await assertMicSize(mic, phone, `${size} reply bar`);
      await shot(page, `${size}-8-replybar-mic`);
      const from = (await install.turns()).length;
      await recordFrom(page, bar, mic, `${size}-9-replybar-recording`);
      await assertVoiceReachedManager(from, c.id, `${size} reply bar`);
      await settle(page, 800);
      await shot(page, `${size}-10-replybar-sent`);
      await page.context().close();
    });

    await scenario(`${size} question card in the Assistant: the Other field's mic`, async () => {
      await review(true);
      await test("/clear-cards", {});
      const c = (await test("/card", {
        kind: "question", title: "Which branch?", sessionId: asker, body: "",
        payload: { chat: { title: "Release checklist", providerId: "claude" }, questions: [{ id: "q1", question: "Which branch should the release come from?", allowsFreeText: true, options: [{ label: "main" }, { label: "release/0.27" }] }] },
      })).card;
      const page = await newPage(device);
      await page.goto(`${install.web}/project/${PROJECT}/assistant`);
      const form = page.locator(`[data-waiting-card="${c.id}"] [data-card-question-form], [data-assistant-card] [data-card-question-form]`).first();
      await until(`${size}: question card shown`, async () => {
        if (await form.isVisible().catch(() => false)) return true;
        const toggle = page.locator("[data-waiting-toggle], [data-waiting-go]").first();
        if (await toggle.isVisible().catch(() => false)) await toggle.click().catch(() => {});
        return false;
      }, 45000, 1000);
      const mic = form.locator("[data-card-voice-mic]");
      await mic.waitFor({ timeout: 30000 });
      await assertMicSize(mic, phone, `${size} question`);
      await shot(page, `${size}-11-question-mic`);
      await recordFrom(page, form, mic, `${size}-12-question-recording`);
      await until(`${size}: transcript in Other`, async () => (await form.locator("input").last().inputValue()) === CLEANED, 60000);
      await settle(page);
      await shot(page, `${size}-13-question-transcript`);
      record(`${size} question: the transcript fills the Other field (review on, nothing submitted)`);
      assert.equal((await cardState(c.id)).status, "open");
      await page.context().close();
    });
  }
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  failures.push({ scenario: "setup", error: String(error.stack ?? error) });
} finally {
  await browser?.close();
  await install?.stop();
  await writeFile(join(shots, "results.json"), JSON.stringify(results, null, 2));
  const passed = results.filter((r) => r.passed).length;
  console.log(`${passed} passed, ${results.length - passed} failed in ${Math.round((Date.now() - started) / 1000)} s; screenshots in ${shots}`);
  if (failures.length) {
    process.exitCode = 1;
    console.log(`FAILED scenarios: ${failures.map((f) => f.scenario).join(", ")}`);
  }
}
