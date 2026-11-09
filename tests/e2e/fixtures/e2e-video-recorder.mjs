// Opt-in walkthrough recording for the browser e2e scripts. Off unless PPM_E2E_RECORD_VIDEO names
// a directory; then every browser context the run creates records its pages with Playwright's
// `recordVideo`, the browser is launched with a small `slowMo` (PPM_E2E_SLOWMO, default 150 ms) so
// a person can follow what happens, and at the end each check gets its own clip cut out of its
// page's video:
//
//   <dir>/<suite>-<NN>-<slug>-<desktop|phone>.mp4 / .webm   one per check, in run order
//   <dir>/<suite>-full-<N>-<desktop|phone>.webm              each page's whole recording
//   <dir>/clips.json                                         what each clip shows, PASS/FAIL, offsets
//
// Clips are cut with ffmpeg (PPM_E2E_FFMPEG, else `ffmpeg` on PATH): H.264 .mp4 so they play on
// phones, plus VP8 .webm. Without ffmpeg only the full recordings are kept, and clips.json still
// carries each check's start and end in its full video (a player can seek with `#t=from,to`).
//
// A check's clip runs from the event before it (its scenario's start, or the previous check) to
// a moment after it, on the page that was current when the check was recorded.
import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scenarioFor } from "../demo/demo-scenarios.mjs";

const LEAD_S = 0.5;
const TAIL_S = 1.5;
/** Desktop recordings are scaled to this width; phones are recorded at their own CSS size. */
const DESKTOP_VIDEO_WIDTH = 1280;
const PHONE_MAX_WIDTH = 767;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const pad2 = (n) => String(n).padStart(2, "0");

/** Fallback slug for a check with no entry in demo-scenarios.mjs. */
export function autoSlug(name) {
  return name.toLowerCase().replace(/^scenario\s+/, "").replace(/[^a-z0-9]+/g, "-").split("-").filter(Boolean).slice(0, 6).join("-") || "check";
}

function run(cmd, args) {
  return new Promise((done) => {
    let log = "";
    let child;
    try { child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { done({ code: -1, log: String(e) }); return; }
    child.stdout.on("data", (s) => log += s);
    child.stderr.on("data", (s) => log += s);
    child.on("error", (e) => done({ code: -1, log: String(e) }));
    child.on("exit", (code) => done({ code, log }));
  });
}

/**
 * @param {{ suite: string }} opts `suite` prefixes every file name and picks the captions table.
 * @returns null when recording is off.
 */
export function videoRecorder({ suite }) {
  const dirEnv = process.env.PPM_E2E_RECORD_VIDEO;
  if (!dirEnv) return null;
  const dir = resolve(dirEnv);
  const rawDir = join(dir, "raw");
  const slowMo = Number.parseInt(process.env.PPM_E2E_SLOWMO ?? "150", 10);
  if (!Number.isFinite(slowMo) || slowMo < 0) throw new Error(`PPM_E2E_SLOWMO must be a non-negative integer, got ${process.env.PPM_E2E_SLOWMO}`);
  const contexts = [];
  /** @type {{ page: any, startedAt: number, kind: "desktop" | "phone" }[]} */
  const pages = [];
  const events = [];

  return {
    dir,
    launchOptions: { slowMo },

    /** Wraps `browser.newContext` so every context the run (and its step files) opens records. */
    instrument(browser) {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options = {}) => {
        const viewport = options.viewport ?? { width: 1280, height: 720 };
        const kind = viewport.width <= PHONE_MAX_WIDTH ? "phone" : "desktop";
        const size = kind === "phone"
          ? { width: even(viewport.width), height: even(viewport.height) }
          : { width: DESKTOP_VIDEO_WIDTH, height: even((DESKTOP_VIDEO_WIDTH * viewport.height) / viewport.width) };
        const context = await newContext({ ...options, recordVideo: { dir: rawDir, size } });
        contexts.push(context);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const startedAt = Date.now();
          const page = await newPage();
          pages.push({ page, startedAt, kind });
          return page;
        };
        return context;
      };
    },

    /** The kit's `onEvent`: a scenario started, or a check passed or failed. */
    event: (type, page, detail) => { events.push({ type, page, at: Date.now(), ...detail }); },

    /** Closing a context is what finishes its video files; call this before `browser.close()`. */
    async closeContexts() {
      for (const context of contexts) await context.close().catch(() => { /* already closed */ });
    },

    /** Renames the recordings, cuts one clip per check and writes clips.json; returns a summary line. */
    async finish() {
      await mkdir(dir, { recursive: true });
      const full = [];
      for (const [i, entry] of pages.entries()) {
        const video = entry.page.video();
        if (!video) continue;
        const target = join(dir, `${suite}-full-${i + 1}-${entry.kind}.webm`);
        await rename(await video.path(), target);
        entry.file = target;
        full.push({ file: `${suite}-full-${i + 1}-${entry.kind}.webm`, kind: entry.kind });
      }
      if ((await readdir(rawDir).catch(() => [])).length === 0) await rm(rawDir, { recursive: true, force: true });

      const ffmpeg = process.env.PPM_E2E_FFMPEG || "ffmpeg";
      const hasFfmpeg = (await run(ffmpeg, ["-hide_banner", "-version"])).code === 0;
      const clips = [];
      const checks = events.filter((e) => e.type === "check");
      for (const [n, check] of checks.entries()) {
        // The page the check was recorded on; a check made with no page (an API-only one) shows
        // the page that was open at that moment.
        const entry = pages.find((p) => p.page === check.page)
          ?? [...pages].reverse().find((p) => p.startedAt <= check.at && p.file);
        const caption = scenarioFor(suite, check.name);
        const slug = caption?.slug ?? autoSlug(check.name);
        const base = `${suite}-${pad2(n + 1)}-${slug}-${entry?.kind ?? "desktop"}`;
        const clip = { n: n + 1, name: check.name, passed: check.passed, slug, kind: entry?.kind ?? "desktop", base };
        if (entry?.file) {
          const previous = events[events.indexOf(check) - 1];
          const fromAt = Math.max(entry.startedAt, previous?.at ?? entry.startedAt);
          clip.source = full.find((f) => entry.file.endsWith(f.file))?.file;
          clip.from = Math.max(0, (fromAt - entry.startedAt) / 1000 - LEAD_S);
          clip.to = (check.at - entry.startedAt) / 1000 + TAIL_S;
          if (hasFfmpeg) {
            // Seeking after `-i` decodes from the start: slower, but exact on any recording.
            const cut = ["-hide_banner", "-loglevel", "error", "-y", "-i", entry.file, "-ss", clip.from.toFixed(2), "-t", (clip.to - clip.from).toFixed(2), "-an"];
            const mp4 = await run(ffmpeg, [...cut, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(dir, `${base}.mp4`)]);
            if (mp4.code === 0) clip.mp4 = `${base}.mp4`; else console.log(`NOTE video: mp4 for ${base} failed: ${mp4.log.slice(-400)}`);
            const webm = await run(ffmpeg, [...cut, "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1M", join(dir, `${base}.webm`)]);
            if (webm.code === 0) clip.webm = `${base}.webm`; else console.log(`NOTE video: webm for ${base} failed: ${webm.log.slice(-400)}`);
          }
        }
        clips.push(clip);
      }
      await writeFile(join(dir, "clips.json"), JSON.stringify({ suite, recordedAt: new Date().toISOString(), slowMo, ffmpeg: hasFfmpeg, full, clips }, null, 2));
      const cut = clips.filter((c) => c.mp4 || c.webm).length;
      return `video: ${full.length} recordings, ${cut}/${clips.length} clips cut${hasFfmpeg ? "" : " (no ffmpeg: full recordings + offsets only)"}; in ${dir}`;
    },
  };
}
