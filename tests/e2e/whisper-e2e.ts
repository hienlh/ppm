/**
 * Drives the real Whisper install and a real transcription.
 *
 * Not a `bun test` file: it downloads ~70 MB (whisper.cpp build + the smallest
 * model + the VAD model) and spawns the binary, which is exactly the part unit
 * tests cannot establish — they prove the wiring against a fake HTTP server.
 *
 *   bun tests/e2e/whisper-e2e.ts
 *
 * Everything lands in a throwaway PPM_HOME and is deleted afterwards, so a real
 * install in `~/.ppm/whisper` is untouched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-whisper-e2e-"));

const { getWhisperStatus, startWhisperInstall } = await import(
  "../../src/services/speech-to-text/whisper-install.service.ts"
);
const { transcribeWav } = await import("../../src/services/speech-to-text/whisper-transcribe.service.ts");

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

try {
  console.log(`PPM_HOME=${process.env.PPM_HOME}`);

  const before = getWhisperStatus();
  check("starts uninstalled", !before.ready, before);
  check("platform is installable", before.installable, before);

  console.log("\ninstalling (base model)…");
  const job = startWhisperInstall("base-q5_1");
  let lastPhase = "";
  while (!job.done) {
    if (job.phase !== lastPhase) {
      lastPhase = job.phase;
      process.stdout.write(`  phase: ${job.phase}\n`);
    }
    await Bun.sleep(200);
  }
  check("install finished without error", job.error === null, job.error);

  const after = getWhisperStatus();
  check("status is ready", after.ready, after);
  check("model is the one asked for", after.model?.id === "base-q5_1", after.model);

  console.log("\ntranscribing samples/jfk.wav…");
  const res = await fetch("https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav");
  const wav = new Uint8Array(await res.arrayBuffer());
  const out = await transcribeWav(wav, "en");
  console.log(`  -> "${out.text}" (${out.ms}ms)`);
  check("transcript contains the sentence", /ask not what your country/i.test(out.text), out.text);

  // 6 seconds of silence. Without the VAD model whisper invents a sentence here
  // ("Hãy subscribe cho kênh …"), which is the whole reason it is installed.
  console.log("\ntranscribing silence…");
  const silence = silentWav(6);
  const quiet = await transcribeWav(silence, "vi");
  console.log(`  -> "${quiet.text}" (${quiet.ms}ms)`);
  check("silence transcribes to nothing", quiet.text === "", quiet.text);
} finally {
  rmSync(process.env.PPM_HOME!, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

/** 16 kHz mono 16-bit WAV of pure silence. */
function silentWav(seconds: number): Uint8Array {
  const rate = 16_000;
  const samples = rate * seconds;
  const buf = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buf);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Uint8Array(buf);
}
