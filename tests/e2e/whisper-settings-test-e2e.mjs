// Settings → Voice Input → "Try it", against a real Whisper on this host: the bundled sample, the
// compare-with-the-CPU button, and a recording from Chromium's fake microphone, on a phone (390)
// and a desktop (1440). Screenshots of each step go to PPM_WHISPER_SHOTS.
//
// Needs a scratch PPM_HOME that already holds an installed Whisper, which
// tests/e2e/whisper-gpu-e2e.ts leaves behind with PPM_WHISPER_GPU_KEEP_HOME=1 (on a host with an
// NVIDIA card it is the CUDA build, so the GPU steps run too):
//
//   bun tests/e2e/whisper-gpu-e2e.ts                     # with PPM_WHISPER_GPU_KEEP_HOME=1
//   bun run vite build --config vite.config.ts           # dist/web
//   PPM_WHISPER_HOME=<kept home> PPM_WHISPER_SHOTS=<dir> PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs \
//     PPM_PLAYWRIGHT_CHANNEL=chrome node tests/e2e/whisper-settings-test-e2e.mjs
//
// The server is the voice e2e fixture (tests/e2e/fixtures/voice-message-server.ts): its own
// HOME, a random port, a scripted chat provider. Nothing reads the real ~/.ppm.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DESKTOP, PHONE, freePort, gotoApp, tourDismissed, until } from "./fixtures/voice-message-helpers.mjs";

const ppmHome = process.env.PPM_WHISPER_HOME;
const shots = resolve(process.env.PPM_WHISPER_SHOTS ?? join(tmpdir(), "whisper-settings-test-shots"));
const webDir = resolve(process.env.PPM_WHISPER_WEB_DIR ?? "dist/web");
if (!ppmHome || !existsSync(join(ppmHome, "whisper"))) throw new Error("PPM_WHISPER_HOME must name a scratch PPM_HOME with Whisper installed");
if (existsSync(join(ppmHome, "ppm.db"))) throw new Error("PPM_WHISPER_HOME must hold no ppm.db (the fixture starts from an empty install)");
mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), "ppm-whisper-test-e2e-"));
const home = join(root, "home"), projects = join(root, "projects");
for (const d of [home, projects, join(projects, "alpha")]) mkdirSync(d, { recursive: true });
const port = await freePort();
const web = `http://127.0.0.1:${port}`;
const server = spawn("bun", ["tests/e2e/fixtures/voice-message-server.ts"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env, PPM_HOME: ppmHome, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
    PPM_HTML_TEST_PORT: String(port), PPM_VOICE_WEB_DIR: webDir, PPM_VOICE_PROJECTS: projects,
    PPM_VOICE_MODE: "web", PPM_VOICE_FEATURE: "on", PPM_FIXTURE_LEAVE_INTROS: "voice-messages-2026-11",
  },
});
let log = "";
server.stdout.on("data", (s) => { log += s; });
server.stderr.on("data", (s) => { log += s; });

const pw = await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE ?? "playwright").href);
const channel = process.env.PPM_PLAYWRIGHT_CHANNEL;
const browser = await pw.chromium.launch({
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  ...(channel ? { channel } : {}),
});

/** Opens Settings → Voice Input and returns the test panel (inside the Settings window on a desktop). */
async function openPanel(device, phone) {
  const context = await browser.newContext({ ...device, serviceWorkers: "block", permissions: ["microphone"] });
  await context.addInitScript(tourDismissed);
  const page = await context.newPage();
  await gotoApp(page, `${web}/project/alpha?openSettings=voice`);
  const scope = phone ? page : page.locator("[data-window-layer]");
  const panel = scope.getByTestId("whisper-test").first();
  await panel.waitFor({ timeout: 30000 });
  return { context, page, panel };
}

/** A phone shot is the screen; a desktop shot is the Settings window holding the panel. */
async function shot(page, panel, phone, name) {
  await panel.evaluate((el, top) => el.scrollIntoView({ block: top ? "start" : "center" }), phone);
  await page.waitForTimeout(300);
  const file = join(shots, `${phone ? "phone" : "desktop"}-${name}.png`);
  if (phone) {
    await page.screenshot({ path: file });
  } else {
    const win = await panel.evaluateHandle((el) => {
      let node = el;
      while (node.parentElement && !node.parentElement.hasAttribute("data-window-layer")) node = node.parentElement;
      return node;
    });
    await win.asElement().screenshot({ path: file });
  }
}

try {
  await until("fixture healthy", async () => server.exitCode === null && (await fetch(`${web}/api/health`)).ok, 90000, 300);
  const status = (await (await fetch(`${web}/api/speech/status`)).json()).data;
  const gpuHost = status.gpu?.backend === "cuda" || status.gpu?.backend === "metal";
  console.log(`Whisper ready=${status.ready}, backend=${status.gpu?.backend}, model=${status.model?.label}`);
  check("Whisper is installed in the scratch home", status.ready === true, status);

  for (const [tag, device, phone] of [["phone", PHONE, true], ["desktop", DESKTOP, false]]) {
    console.log(`\n${tag}`);
    const { context, page, panel } = await openPanel(device, phone);
    const buttons = panel.getByRole("button");
    const heights = await buttons.evaluateAll((els) => els.map((b) => b.getBoundingClientRect().height));
    if (phone) check("every button in the panel is at least 44 px tall on a phone", heights.every((h) => h >= 44), heights);

    await panel.getByRole("button", { name: /Use the sample/ }).click();
    const result = panel.getByTestId("whisper-test-result");
    await result.waitFor({ timeout: 60000 });
    const text = await result.innerText();
    check("the sample comes back as the sentence that was said", /ask not what your country/i.test(text), text);
    check("the result says how long it took", /\d(\.\d+)? s/.test(text), text);
    check("the result names the model", text.includes(status.model.label), text);
    if (gpuHost) check("the result says it ran on the GPU", /GPU — /.test(text), text);
    await shot(page, panel, phone, "05-test-sample");

    if (gpuHost) {
      await panel.getByRole("button", { name: "Compare with the CPU" }).click();
      const compare = panel.getByTestId("whisper-test-compare");
      await compare.waitFor({ timeout: 120000 });
      const line = await compare.innerText();
      check("the compare line gives the CPU time and how much faster the GPU was", /CPU: \d/.test(line) && /faster on the GPU/.test(line), line);
      await shot(page, panel, phone, "06-test-compare");
    }

    if (!phone) {
      await panel.getByRole("button", { name: "Record a test" }).click();
      await panel.getByRole("button", { name: /^Stop/ }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(3000);
      await panel.getByRole("button", { name: /^Stop/ }).click();
      await until("recorded test answered", async () => {
        const t = await panel.getByTestId("whisper-test-result").innerText().catch(() => "");
        return /\d s/.test(t) && !/ask not/i.test(t);
      }, 60000, 300);
      // Chromium's fake microphone is a beep, so there is nothing to transcribe: what is checked
      // is the path — record, convert, run on this host, answer with a time.
      const recorded = await panel.getByTestId("whisper-test-result").innerText();
      check("a recording from the microphone runs through the same test", /\d s/.test(recorded), recorded);
      await shot(page, panel, phone, "07-test-recorded");
    }
    await context.close();
  }

  const leftovers = readdirSync(join(ppmHome, "whisper", "tmp")).filter((f) => f.endsWith(".wav"));
  check("no test audio is left on the host", leftovers.length === 0, leftovers);
} catch (e) {
  failures++;
  console.log(`  FAIL  ${e?.stack ?? e}\n${log.slice(-1500)}`);
} finally {
  await browser.close();
  server.kill();
  await new Promise((r) => server.exitCode === null ? server.once("exit", r) : r());
  rmSync(root, { recursive: true, force: true });
  // The fixture made these in the home it was given, which held none at the start.
  for (const f of readdirSync(ppmHome)) if (/^(ppm|session-trace)\.db/.test(f)) rmSync(join(ppmHome, f), { force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
