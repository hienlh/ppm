import type { Command } from "commander";
import { C, run } from "./chat-cmd-request.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { LONG_REQUEST_TIMEOUT_MS } from "../utils/request-progress.ts";
import type { InstallJobState, WhisperStatus } from "../../services/speech-to-text/whisper-install.service.ts";

/**
 * `ppm speech`: speech to text for the chat mic (Whisper on the host), through the routes
 * Settings → Voice calls. An install runs inside PPM; this command starts it, then follows its
 * progress until it ends, for at most ten minutes — after that PPM is still installing, and
 * `ppm speech status` says how far it got.
 */

const POLL_MS = 2_000;
const PROGRESS_EVERY_MS = 15_000;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

function describeJob(job: InstallJobState): string {
  const size = job.totalBytes > 0 ? ` ${mb(job.receivedBytes)} / ${mb(job.totalBytes)}` : "";
  return `${job.phase}${size}`;
}

function printStatus(s: WhisperStatus): void {
  console.log(`Ready:   ${s.ready ? "yes" : "no"}`);
  console.log(`Binary:  ${s.binary ? `${s.binary.path} (${s.binary.source})` : "(none)"}`);
  console.log(`Model:   ${s.model ? `${s.model.id} — ${s.model.label}` : "(none)"}`);
  if (s.install && !s.install.done) console.log(`Install: ${describeJob(s.install)}`);
  else if (s.install?.error) console.log(`Install: failed — ${s.install.error}`);
  if (!s.installable) console.log(`${C.yellow}PPM cannot install Whisper on this machine.${C.reset}${s.installHint ? ` ${s.installHint}` : ""}`);
  console.log(`Models:  ${s.models.map((m) => m.id).join(", ")}`);
}

/** Follows the install PPM is running until it ends or the time runs out; throws on a failure. */
async function followInstall(): Promise<WhisperStatus> {
  const started = Date.now();
  let lastLine = 0;
  for (;;) {
    const status = await ppmApiRequest<WhisperStatus>("GET", "/speech/status");
    const job = status.install;
    if (!job || job.done) {
      if (job?.error) throw new Error(`Install failed: ${job.error}`);
      return status;
    }
    if (Date.now() - lastLine >= PROGRESS_EVERY_MS) {
      lastLine = Date.now();
      console.error(`… ${describeJob(job)} (${Math.round((Date.now() - started) / 1000)}s)`);
    }
    if (Date.now() - started > LONG_REQUEST_TIMEOUT_MS) {
      throw new Error("Still installing after ten minutes; PPM keeps going in the background. Check with `ppm speech status`.");
    }
    await Bun.sleep(POLL_MS);
  }
}

export function registerSpeechCommands(program: Command): void {
  const speech = program.command("speech").description("Speech to text for the chat mic (Whisper on this machine)");

  speech
    .command("status")
    .description("Show whether Whisper is installed, which model, and any install in progress")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const status = await ppmApiRequest<WhisperStatus>("GET", "/speech/status");
      if (opts.json) console.log(JSON.stringify(status, null, 2));
      else printStatus(status);
    })());

  speech
    .command("install")
    .description("Download Whisper and a model (may take minutes); waits until it is done")
    .option("--model <id>", "Which model (see `ppm speech status`); PPM's default when left out")
    .action((opts: { model?: string }) => run(async () => {
      await ppmApiRequest("POST", "/speech/install", opts.model ? { model: opts.model } : {});
      console.log(`${C.dim}Installing...${C.reset}`);
      const status = await followInstall();
      console.log(`${C.green}✓${C.reset} Speech to text is ${status.ready ? "ready" : "installed"}${status.model ? ` (${status.model.id})` : ""}.`);
    })());

  speech
    .command("remove")
    .description("Remove the Whisper build and models PPM installed")
    .action(() => run(async () => {
      await ppmApiRequest("POST", "/speech/uninstall", {});
      console.log(`${C.green}✓${C.reset} Removed the Whisper build and models PPM installed.`);
    })());
}
