// The tour's "PPM has new features" part, end to end, on the production Vite bundle. Every
// scenario gets a fresh install of its own (tests/e2e/fixtures/feature-intros-server.ts: an empty
// PPM_HOME, nothing answered, one scripted provider whose turn lists the session tools PPM handed
// it). Covers a new install (basic tour first, then Turn on, checked in the settings API and in a
// chat's tools/list), an install with a chat (the step at once, no basic-tour offer, Turn off),
// Later on three days and the NEW marker in Settings → Tools, several screens counting one skip, a
// switch already set counting as the answer, the phone's bottom sheet, and an answer on one device
// closing the step on another. No live credentials, no real PPM data.
//
// Run it in the capped e2e image (Chromium, Node 20 and playwright-core; see tests/e2e/docker/):
//
//   docker run --rm --cpus=4 --memory=6g -v <repo>:/app:ro -v ppm-e2e-nm:/app/node_modules \
//     -v <out>:/out -v <scratch-web>:/web -w /app -e IS_SANDBOX=1 \
//     -e PPM_INTRO_ARTIFACTS=/out -e PPM_INTRO_WEB_DIR=/web ppm-e2e-chromium:latest \
//     sh -c 'bun install --frozen-lockfile && node tests/e2e/feature-intros-e2e.mjs'
//
// From PowerShell keep the `sh -c` body free of double quotes, or mount a script and run that.
// PPM_INTRO_WEB_DIR=<dir> keeps the bundle there (built on the first run, reused after);
// PPM_INTRO_ARTIFACTS=<dir> keeps the screenshots and the fixture logs.
// PPM_E2E_RECORD_VIDEO=<dir> also records a walkthrough video, one clip per check
// (fixtures/e2e-video-recorder.mjs). PPM_PLAYWRIGHT_MODULE / _EXECUTABLE / _CHANNEL pick Playwright.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createKit } from "./fixtures/session-turn-refs-helpers.mjs";
import { runAnswerSteps } from "./fixtures/feature-intros-steps-answer.mjs";
import { runLaterSteps } from "./fixtures/feature-intros-steps-later.mjs";
import { videoRecorder } from "./fixtures/e2e-video-recorder.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-intros-e2e-"));
const artifacts = process.env.PPM_INTRO_ARTIFACTS ? resolve(process.env.PPM_INTRO_ARTIFACTS) : join(sandbox, "artifacts");
await mkdir(artifacts, { recursive: true });

async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

const webDir = process.env.PPM_INTRO_WEB_DIR ? resolve(process.env.PPM_INTRO_WEB_DIR) : join(sandbox, "web");
if (!existsSync(join(webDir, "index.html"))) {
  await writeFile(join(artifacts, "vite.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}
if (!existsSync(join(webDir, "index.html"))) throw new Error(`No web bundle in ${webDir}`);

let browser;
const recorder = videoRecorder({ suite: "feature-intros" });
const ctx = { sandbox, artifacts, webDir, current: null };
const kit = ctx.kit = createKit({ web: "", artifacts, currentPage: () => ctx.current, onEvent: recorder?.event });
const { results, failures } = kit;
const started = Date.now();

try {
  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  const executablePath = process.env.PPM_PLAYWRIGHT_EXECUTABLE;
  const channel = process.env.PPM_PLAYWRIGHT_CHANNEL;
  browser = ctx.browser = await pw.chromium.launch({ headless: true, ...recorder?.launchOptions, ...(executablePath ? { executablePath } : channel ? { channel } : {}) });
  recorder?.instrument(browser);

  await runAnswerSteps(ctx);
  await runLaterSteps(ctx);

  if (failures.length) {
    process.exitCode = 1;
    console.log(`FAILED scenarios: ${failures.map((f) => f.scenario).join(", ")}`);
  }
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
  try { await ctx.current?.screenshot({ path: join(artifacts, "failure.png") }); } catch { /* page gone */ }
} finally {
  await recorder?.closeContexts();
  await browser?.close();
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  if (recorder) {
    try { console.log(await recorder.finish()); } catch (e) { console.log(`NOTE video: ${e?.stack ?? e}`); }
  }
  console.log(`${results.filter((r) => r.passed).length} passed, ${failures.length} failed in ${Math.round((Date.now() - started) / 1000)} s; artifacts in ${artifacts}`);
}
