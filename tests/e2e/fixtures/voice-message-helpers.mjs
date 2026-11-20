// Helpers for the voice-message e2e (tests/e2e/voice-message-e2e.mjs): a fake whisper-cli in a
// scratch PPM_HOME, one isolated fixture server per install, the media the scenarios need (a PNG,
// an Ogg voice note) made with ffmpeg, and the browser's chat and screenshot helpers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

/** The voice intro's id, as FEATURE_INTROS names it; the driver keeps the startup from answering it. */
export const VOICE_INTRO_ID = "voice-messages-2026-11";
export const PROJECT = "alpha";
/** Recorded by the fake whisper-cli; the Vietnamese line PPM receives before any clean-up. */
export const RAW_TRANSCRIPT = "ok giờ em sửa cái hô nô middleware cho bun xơ vờ đi";
export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
export const DESKTOP = { viewport: { width: 1440, height: 900 } };

/** Which of the browser's two voice sets a shot belongs to, for its file name. */
export const shotName = (device, step) => `${device}-${step}.png`;

export async function freePort() {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  return port;
}

export function run(cmd, args) {
  return new Promise((done, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (s) => { log += s; });
    child.stderr.on("data", (s) => { log += s; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? done(log) : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log.slice(-800)}`))));
  });
}

/**
 * The fake whisper.cpp install PPM looks for under `<PPM_HOME>/whisper`: a `whisper-cli` that sleeps
 * for the seconds in `whisper/delay-seconds` (so the processing state can be seen) and prints one
 * fixed Vietnamese line, plus the two model files `getWhisperStatus()` checks for.
 */
export async function installFakeWhisper(ppmHome, delaySeconds = 2) {
  const whisper = join(ppmHome, "whisper");
  const bin = join(whisper, "bin"), models = join(whisper, "models");
  await mkdir(bin, { recursive: true });
  await mkdir(models, { recursive: true });
  const cli = join(bin, "whisper-cli");
  await writeFile(cli, [
    "#!/bin/sh",
    "# Stand-in for whisper.cpp's whisper-cli: waits as the test asks, then prints one fixed line.",
    'D=$(dirname "$0")',
    'if [ -f "$D/../delay-seconds" ]; then sleep "$(cat "$D/../delay-seconds")"; fi',
    `echo "${RAW_TRANSCRIPT}"`,
    "",
  ].join("\n"), "utf8");
  await chmod(cli, 0o755);
  await writeFile(join(whisper, "delay-seconds"), String(delaySeconds), "utf8");
  // Empty model files: whisper is never loaded, the stand-in only has to exist for `ready`.
  await writeFile(join(models, "ggml-large-v3-turbo-q5_0.bin"), "");
  await writeFile(join(models, "ggml-silero-v5.1.2.bin"), "");
  return { delayFile: join(whisper, "delay-seconds") };
}

/** Makes the two media files the scenarios attach: a PNG picture and a two-second Ogg Opus voice note. */
export async function makeMedia(dir) {
  await mkdir(dir, { recursive: true });
  const png = join(dir, "screen.png"), ogg = join(dir, "voice.ogg");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x3b82f6:s=320x200", "-frames:v", "1", png]);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", ogg]);
  return { png, ogg };
}

/**
 * One fixture server with its own PPM_HOME, port and projects folder; `stop()` ends it and keeps its
 * log. `feature` is the voice intro's answer: "on", "off", or "" for not asked.
 */
export async function startFixture({ sandbox, artifacts, webDir, name, mode = "web", feature = "on", env = {}, kit }) {
  const root = join(sandbox, name);
  const ppm = join(root, "ppm"), home = join(root, "home"), projects = join(root, "projects");
  await Promise.all([ppm, home, projects, join(projects, PROJECT)].map((p) => mkdir(p, { recursive: true })));
  await installFakeWhisper(ppm, 2);
  const port = await freePort();
  const web = `http://127.0.0.1:${port}`;
  const fixtureEnv = {
    ...process.env,
    PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
    PPM_VOICE_WEB_DIR: webDir, PPM_VOICE_PROJECTS: projects, PPM_VOICE_MODE: mode, PPM_VOICE_FEATURE: feature,
    // The voice question is answered by the fixture itself, so the startup must leave it alone.
    PPM_FIXTURE_LEAVE_INTROS: VOICE_INTRO_ID,
    ...env,
  };
  delete fixtureEnv.PPM_ALLOW_PROD_DB;
  const child = spawn("bun", ["tests/e2e/fixtures/voice-message-server.ts"], { env: fixtureEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (s) => { log += s; });
  child.stderr.on("data", (s) => { log += s; });
  const exited = new Promise((r) => child.on("exit", r));
  try {
    await kit.until(`${name} fixture healthy`, async () => child.exitCode === null && (await fetch(`${web}/api/health`)).ok, 90000, 300);
  } catch (e) {
    throw new Error(`${e.message}\n${log.slice(-2000)}`);
  }

  async function api(path, init = {}) {
    const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
    const body = await response.json();
    assert(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  const test = (path, body) => fetch(`${web}/__voice-test${path}`, body === undefined
    ? { headers: { Connection: "close" } }
    : { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) })
    .then((r) => r.json());
  return {
    name, web, ppm, root, api, test,
    /** Every message PPM sent the scripted provider, oldest first. */
    turns: async () => (await test("/turns")).turns,
    haikuCalls: async () => (await test("/haiku-calls")).calls,
    async stop() {
      if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
      if (child.exitCode === null) child.kill("SIGKILL");
      await writeFile(join(artifacts, `server-${name}.log`), log);
    },
  };
}

/** The tour is put away on this device, so the only panel on screen is the chat. */
export function tourDismissed() {
  if (window.top !== window) return;
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
}

/** Shows one chat alone in the project's workspace (the layout `sendInChat` writes) and opens it. */
/** The page showing the page most recently opened, for a failure's screenshot. */
export const current = { page: null };

/**
 * A new chat in the project, opened on its own page by its URL (the route the phone e2e uses on
 * every device). Each page has a fresh browser context: its own storage, the microphone granted to
 * this origin only.
 */
export async function openChat({ browser, web, install, device = DESKTOP, title = "Voice test" }) {
  const created = await install.api(`/api/project/${PROJECT}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title }) });
  const chat = { id: created.data.id, title };
  const context = await browser.newContext({ ...device, serviceWorkers: "block", permissions: ["microphone"] });
  await context.grantPermissions(["microphone"], { origin: web });
  await context.addInitScript(tourDismissed);
  const page = await context.newPage();
  current.page = page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await gotoApp(page, `${web}/project/${PROJECT}/chat/claude/${chat.id}`);
  await composer(page).waitFor({ timeout: 30000 });
  return { chat, page, context, errors };
}

/** Navigates and waits for the app's own feature-intro request, as the intro e2e does. */
export async function gotoApp(page, url) {
  const asked = page.waitForResponse((r) => r.url().endsWith("/api/feature-intros") && r.request().method() === "GET", { timeout: 60000 }).catch(() => null);
  if (url) await page.goto(url); else await page.reload();
  await asked;
}

/** The visible composer: two textareas share the label, one per layout. */
export const composer = (page) => page.locator('textarea[aria-label="Message"]:visible').first();
export const micButton = (page) => page.getByRole("button", { name: "Record a voice message", exact: true });
export const stopButton = (page) => page.getByRole("button", { name: "Stop recording", exact: true });
export const sendButton = (page) => page.getByRole("button", { name: "Send message", exact: true });
export const transcriptBox = (page) => page.getByRole("textbox", { name: "Voice message transcript", exact: true });
export const voicePart = (page) => page.locator("[data-voice-part]");

/** Polls `fn` until it returns a truthy value or the time runs out. */
export async function until(label, fn, timeout = 30000, every = 150) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)})`);
}

/** Pause for a visible state to settle before a screenshot (animations, the toast's slide-in). */
export const settle = (page, ms = 400) => page.waitForTimeout(ms);
