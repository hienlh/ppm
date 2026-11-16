// Turns the recordings of a ppm-tasks e2e run into one walkthrough: each scene cut out of its
// page's recording (from its caption card to a beat after it ended), drawn on a 1280 × 800 frame
// (a phone recording is centred on it), then joined in scene order into `ppm-tasks-walkthrough.mp4`
// (H.264, plays on phones) beside a `scenes.json` saying what each part shows and where it starts.
// Needs Debian's ffmpeg (PPM_E2E_FFMPEG, else `ffmpeg` on PATH), which the e2e image carries.
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const W = 1280, H = 800, FPS = 25;

function run(cmd, args) {
  return new Promise((done, fail) => {
    let log = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (s) => { log += s; });
    child.stderr.on("data", (s) => { log = (log + s).slice(-4000); });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done(log) : fail(new Error(`${cmd} exited ${code}: ${log.slice(-1500)}`))));
  });
}

export async function cutVideo(scenes, dir) {
  const ffmpeg = process.env.PPM_E2E_FFMPEG ?? "ffmpeg";
  const parts = join(dir, "parts");
  await mkdir(parts, { recursive: true });
  const ordered = scenes.filter((s) => s.file).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const made = [];
  let at = 0;
  for (const [i, s] of ordered.entries()) {
    const out = join(parts, `${String(i + 1).padStart(2, "0")}-${s.id}.mp4`);
    const length = Math.max(1, s.to - s.from);
    await run(ffmpeg, [
      "-y", "-loglevel", "error", "-ss", s.from.toFixed(2), "-i", s.file, "-t", length.toFixed(2),
      "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12,fps=${FPS},format=yuv420p`,
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", out,
    ]);
    made.push({ id: s.id, title: s.title, kind: s.kind, startsAt: Number(at.toFixed(1)), seconds: Number(length.toFixed(1)), file: out });
    at += length;
  }
  if (made.length === 0) throw new Error("no scene was recorded");
  const list = join(parts, "list.txt");
  await writeFile(list, made.map((m) => `file '${m.file.replace(/'/g, "'\\''")}'`).join("\n"));
  const final = join(dir, "ppm-tasks-walkthrough.mp4");
  await run(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", final]);
  await writeFile(join(dir, "scenes.json"), JSON.stringify({ video: "ppm-tasks-walkthrough.mp4", seconds: Number(at.toFixed(1)), scenes: made.map(({ file: _f, ...m }) => m) }, null, 2));
  await rm(list, { force: true });
  console.log(`video: ${final} (${made.length} scenes, ${at.toFixed(0)} s)`);
  return final;
}
