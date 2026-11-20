// Voice messages, end to end on the production Vite bundle: the composer's recording, the review
// with a picture and typed text, the edit and the one message sent, the bubble after a reload,
// learning from the edit, review off, a failed clean-up, the feature off, Settings → Voice Input,
// the Telegram bridge's voice messages (scenario E, through the fake Bot API), and self-learning:
// Settings' learned words with Undo/Restore (L), and on Telegram the Fixed/timing lines, the answer
// while voice is off, and an audio file (T).
//
// Nothing real runs: Whisper is a fake whisper-cli in a scratch PPM_HOME (it sleeps 2 s and prints one
// Vietnamese line), Claude Haiku is the fixture's scripted completeOnce, the microphone is Chromium's
// fake device, and the chat provider is scripted. Each install is a fresh fixture server with its own
// PPM_HOME, port and projects folder (tests/e2e/fixtures/voice-message-server.ts).
//
// Run it in the capped e2e image (tests/e2e/docker/Dockerfile), with the worktree read-only and a
// scratch web build and screenshot folder mounted:
//
//   docker run --rm --cpus=4 --memory=3g --ulimit core=0 -v <worktree>:/app:ro -v ppm-e2e-nm:/app/node_modules \
//     -v <scratch-web>:/web -v <screenshots>:/out -w /app -e IS_SANDBOX=1 \
//     -e PPM_VOICE_WEB_DIR=/web -e PPM_VOICE_SHOTS=/out ppm-e2e-chromium:latest \
//     sh -c 'bun install --frozen-lockfile && node tests/e2e/voice-message-e2e.mjs'
//
// PPM_VOICE_WEB_DIR keeps the bundle (built on the first run, reused after); PPM_VOICE_SHOTS receives
// the screenshots, results.json and the fixtures' logs. PPM_PLAYWRIGHT_MODULE / _EXECUTABLE / _CHANNEL
// pick Playwright, as the other e2e scripts do.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { current, makeMedia, run, startFixture, until } from "./fixtures/voice-message-helpers.mjs";
import { runWebScenarios } from "./fixtures/voice-message-steps-web.mjs";
import { runTelegramScenario } from "./fixtures/voice-message-steps-telegram.mjs";
import { runIntroScenario } from "./fixtures/voice-message-steps-intro.mjs";
import { runSelfLearningTelegramScenarios, runSelfLearningWebScenarios } from "./fixtures/voice-message-steps-self-learning.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-voice-e2e-"));
const shots = resolve(process.env.PPM_VOICE_SHOTS ?? join(sandbox, "shots"));
await mkdir(shots, { recursive: true });
const webDir = resolve(process.env.PPM_VOICE_WEB_DIR ?? join(sandbox, "web"));
const started = Date.now();
const results = [];
const failures = [];

const kit = {
  until,
  /** A check that passed, with what it observed. */
  record(name, detail = {}) {
    results.push({ name, passed: true, ...detail });
    console.log(`PASS ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
  },
  /** One scenario: a failure is recorded and the run goes on to the next one. */
  async scenario(label, fn) {
    try {
      await fn();
    } catch (e) {
      const message = String(e?.stack ?? e);
      failures.push({ scenario: label, error: message });
      results.push({ name: `scenario ${label}`, passed: false, error: message });
      console.log(`FAIL scenario ${label}: ${message}`);
      // The page as the scenario left it, so a failure can be read from the picture as well as the log.
      try { await current.page?.screenshot({ path: join(shots, `FAIL-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`) }); } catch { /* page already gone */ }
    }
  },
};

/** A fake Bot API process (tests/e2e/fixtures/fake-telegram-server.ts), read for its URLs and token. */
function startFakeTelegram() {
  return new Promise((resolveStart, reject) => {
    const child = spawn("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`fake Telegram did not start: ${out.slice(-800)}`)), 30000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const m = /FAKE_TELEGRAM (\{[^\n]*\})/.exec(out);
      if (m) { clearTimeout(timer); resolveStart({ child, info: JSON.parse(m[1]) }); }
    });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`fake Telegram exited ${code}: ${out.slice(-800)}`)); });
  });
}

let browser;
try {
  if (!existsSync(join(webDir, "index.html"))) {
    await writeFile(join(shots, "vite.log"), await run("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir, "--emptyOutDir"]));
  }
  if (!existsSync(join(webDir, "index.html"))) throw new Error(`No web bundle in ${webDir}`);
  const media = await makeMedia(join(sandbox, "media"));

  const pw = await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE ?? "playwright").href);
  const executablePath = process.env.PPM_PLAYWRIGHT_EXECUTABLE;
  const channel = process.env.PPM_PLAYWRIGHT_CHANNEL;
  // Chromium's fake camera and microphone: a steady beep is recorded as the voice.
  browser = await pw.chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    ...(executablePath ? { executablePath } : channel ? { channel } : {}),
  });

  // The web install: the feature on, scenarios A–D and the Settings pane.
  await kit.scenario("install web: startup", async () => {
    const install = await startFixture({ sandbox, artifacts: shots, webDir, name: "web", mode: "web", feature: "on", kit });
    try {
      await runWebScenarios({ kit, browser, install, shots, media });
    } finally {
      await install.stop();
    }
  });

  // An install whose voice question is still open: the tour's step on a phone, then Turn on.
  await kit.scenario("install intro", async () => {
    const install = await startFixture({ sandbox, artifacts: shots, webDir, name: "intro", mode: "web", feature: "ask", kit });
    try {
      await runIntroScenario({ kit, browser, install, shots });
    } finally {
      await install.stop();
    }
  });

  // An install that has had self-learning on for a while: the Settings pane's learned words (L).
  await kit.scenario("install learn: startup", async () => {
    const install = await startFixture({
      sandbox, artifacts: shots, webDir, name: "learn", mode: "web", feature: "on", kit, env: { PPM_VOICE_SELF_LEARNING: "seed" },
    });
    try {
      await runSelfLearningWebScenarios({ kit, browser, install, shots });
    } finally {
      await install.stop();
    }
  });

  // The Telegram install: the Assistant's bot against the fake Bot API, scenario E.
  await kit.scenario("install telegram: startup", async () => {
    const fake = await startFakeTelegram();
    try {
      const { api, control, token } = fake.info;
      const install = await startFixture({
        sandbox, artifacts: shots, webDir, name: "telegram", mode: "telegram", feature: "on", kit,
        env: {
          PPM_TELEGRAM_API_BASE: api,
          PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: token,
          PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify([["777", "777", "Victor"]]),
          PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "300",
          PPM_VOICE_SELF_LEARNING: "seed",
        },
      });
      try {
        const ogg = readFileSync(media.ogg).toString("base64");
        await runTelegramScenario({ kit, install, control, ogg });
        await runSelfLearningTelegramScenarios({ kit, browser, install, control, ogg, shots });
      } finally {
        await install.stop();
      }
    } finally {
      fake.child.kill("SIGTERM");
    }
  });
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  failures.push({ scenario: "setup", error: String(error.stack ?? error) });
} finally {
  await browser?.close();
  await writeFile(join(shots, "results.json"), JSON.stringify(results, null, 2));
  const passed = results.filter((r) => r.passed).length;
  console.log(`${passed} passed, ${results.length - passed} failed in ${Math.round((Date.now() - started) / 1000)} s; screenshots and logs in ${shots}`);
  if (failures.length) {
    process.exitCode = 1;
    console.log(`FAILED scenarios: ${failures.map((f) => f.scenario).join(", ")}`);
  }
}
