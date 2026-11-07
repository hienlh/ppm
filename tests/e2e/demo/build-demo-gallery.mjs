// Builds the walkthrough gallery: one self-contained index.html (no CDN, relative links, works
// on a phone) over a demo folder laid out as
//
//   <root>/turn-refs/        PPM_TURN_REFS_ARTIFACTS of a recorded session-turn-refs-e2e run
//   <root>/session-collab/   PPM_COLLAB_ARTIFACTS of a recorded session-collab-e2e run
//     results.json, *.png, e2e-run.log (optional), videos/clips.json + clips (see
//     fixtures/e2e-video-recorder.mjs)
//   <root>/live/             anything else to show: videos and images, captioned by an optional
//                            live/captions.json  [{ "file", "title", "desc", "pass" }]
//
//   node tests/e2e/demo/build-demo-gallery.mjs <root>
//
// Re-run it whenever the folder changes; it only reads the folder and rewrites <root>/index.html.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SUITES, scenarioFor } from "./demo-scenarios.mjs";

const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** A relative URL to a file under the root, each path segment encoded. */
const href = (...parts) => parts.join("/").split("/").map(encodeURIComponent).join("/");

async function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^﻿/, ""));
  } catch (e) {
    console.warn(`skipping ${path}: ${e.message}`);
    return null;
  }
}

const listFiles = async (dir) => (existsSync(dir) ? (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name).sort() : []);

function badge(pass) {
  if (pass === true) return '<span class="badge pass">PASS</span>';
  if (pass === false) return '<span class="badge fail">FAIL</span>';
  return "";
}

function videoTag(sources, fragment = "") {
  if (!sources.length) return "";
  const type = (f) => (extname(f).toLowerCase() === ".webm" ? "video/webm" : "video/mp4");
  return `<video controls preload="metadata" playsinline>${sources.map((s) => `<source src="${s}${fragment}" type="${type(s)}">`).join("")}Trình duyệt không phát được video này.</video>`;
}

function shotsTag(urls) {
  if (!urls.length) return "";
  return `<div class="shots">${urls.map((u) => `<a href="${u}" class="shot" data-zoom><img src="${u}" loading="lazy" alt=""></a>`).join("")}</div>`;
}

function card({ title, desc, pass, video, shots, note }) {
  return `<article class="card">
  <header><h3>${esc(title)}</h3>${badge(pass)}</header>
  ${desc ? `<p>${esc(desc)}</p>` : ""}
  ${video ?? ""}
  ${shotsTag(shots ?? [])}
  ${note ? `<p class="note">${esc(note)}</p>` : ""}
</article>`;
}

/** One suite's section, or null when its folder is missing. */
async function suiteSection(root, suiteId) {
  const suite = SUITES[suiteId];
  const dir = join(root, suite.dir);
  if (!existsSync(dir)) return null;
  const results = (await readJson(join(dir, "results.json"))) ?? [];
  const clipsDoc = await readJson(join(dir, "videos", "clips.json"));
  const pngs = (await listFiles(dir)).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()));
  const used = new Set();
  const shotUrls = (names) => names.map((n) => `${n}.png`).filter((f) => pngs.includes(f)).map((f) => { used.add(f); return href(suite.dir, f); });

  // The checks in run order: from the recording when there is one, else from results.json.
  const checks = clipsDoc?.clips ?? results.map((r) => ({ name: r.name, passed: r.passed }));
  const cards = checks.map((check) => {
    const caption = scenarioFor(suiteId, check.name);
    const sources = [check.mp4, check.webm].filter(Boolean).map((f) => href(suite.dir, "videos", f));
    let video = videoTag(sources);
    if (!video && check.source && Number.isFinite(check.from)) {
      // No cut clip (no ffmpeg at record time): play the check's span of the full recording.
      video = videoTag([href(suite.dir, "videos", check.source)], `#t=${check.from.toFixed(1)},${check.to.toFixed(1)}`);
    }
    const failShots = check.passed === false && check.name.startsWith("scenario ")
      ? pngs.filter((f) => f.startsWith(`FAIL-${check.name.slice("scenario ".length).replace(/[^a-z0-9]+/gi, "-")}`))
      : [];
    failShots.forEach((f) => used.add(f));
    return card({
      title: caption?.title ?? check.name,
      desc: caption?.desc,
      pass: check.passed,
      video,
      shots: [...shotUrls(caption?.shots ?? []), ...failShots.map((f) => href(suite.dir, f))],
      note: `Kiểm tra: ${check.name}`,
    });
  });
  const extra = pngs.filter((f) => !used.has(f));
  const passed = checks.filter((c) => c.passed).length;
  const runLog = existsSync(join(dir, "e2e-run.log")) ? await readFile(join(dir, "e2e-run.log"), "utf8") : "";
  const summary = /\d+ passed, \d+ failed in \d+ s/.exec(runLog)?.[0];
  const meta = [
    `${passed}/${checks.length} kiểm tra đạt`,
    summary ? `lần chạy: ${summary}` : null,
    clipsDoc ? `ghi hình ${new Date(clipsDoc.recordedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}, chậm lại ${clipsDoc.slowMo} ms mỗi thao tác để dễ theo dõi` : null,
  ].filter(Boolean).join(" · ");
  const full = (clipsDoc?.full ?? []).map((f) => `<a href="${href(suite.dir, "videos", f.file)}">${esc(f.file)}</a>`).join(", ");
  return `<section id="${esc(suite.dir)}">
  <h2>${esc(suite.group)}</h2>
  <p class="intro">${esc(suite.intro)}</p>
  <p class="meta">${esc(meta)}</p>
  <div class="grid">${cards.join("\n")}</div>
  ${extra.length ? `<details><summary>Ảnh khác (${extra.length})</summary>${shotsTag(extra.map((f) => href(suite.dir, f)))}</details>` : ""}
  ${full ? `<p class="meta">Video đầy đủ cả lần chạy: ${full}</p>` : ""}
</section>`;
}

async function liveSection(root) {
  const dir = join(root, "live");
  const files = (await listFiles(dir)).filter((f) => VIDEO_EXT.has(extname(f).toLowerCase()) || IMAGE_EXT.has(extname(f).toLowerCase()));
  const captions = (await readJson(join(dir, "captions.json"))) ?? [];
  const valid = Array.isArray(captions) ? captions.filter((c) => c && typeof c.file === "string") : [];
  // A .webm of the same name under live/webm/ is offered as a second source.
  const webms = new Set(await listFiles(join(dir, "webm")));
  const media = (f) => {
    if (!VIDEO_EXT.has(extname(f).toLowerCase())) return { video: "", shots: [href("live", f)] };
    const webm = `${f.slice(0, -extname(f).length)}.webm`;
    return { video: videoTag([href("live", f), ...(webm !== f && webms.has(webm) ? [href("live", "webm", webm)] : [])]), shots: [] };
  };
  const cards = valid.filter((c) => files.includes(c.file)).map((c) => card({ title: c.title ?? c.file, desc: c.desc, pass: typeof c.pass === "boolean" ? c.pass : undefined, ...media(c.file) }));
  const captioned = new Set(valid.map((c) => c.file));
  for (const f of files.filter((f) => !captioned.has(f))) cards.push(card({ title: f, ...media(f) }));
  const body = cards.length
    ? `<div class="grid">${cards.join("\n")}</div>`
    : '<p class="empty">Chưa có nội dung. Phần này sẽ được bổ sung bằng video và ảnh chụp khi thử với Claude thật.</p>';
  return `<section id="live">
  <h2>Thử thật với Claude</h2>
  <p class="intro">Các tính năng trên, chạy với Claude thật thay vì kịch bản dựng sẵn.</p>
  ${body}
</section>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#5b6472;--line:#dde1e6;--pass:#137333;--fail:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1f2227;--text:#e8eaed;--muted:#9aa1ab;--line:#33373e;--pass:#5bd17a;--fail:#ff8a80}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:1200px;margin:0 auto;padding:16px}h1{font-size:1.5rem;margin:.5rem 0}h2{font-size:1.25rem;margin:2rem 0 .25rem;padding-top:.5rem;border-top:1px solid var(--line)}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:.75rem 0}nav a{padding:10px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:inherit;text-decoration:none;min-height:44px;display:inline-flex;align-items:center}
.intro{margin:.25rem 0}.meta,.note{color:var(--muted);font-size:.875rem}.empty{padding:16px;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr));gap:16px;margin-top:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;min-width:0}
.card header{display:flex;gap:8px;align-items:flex-start;justify-content:space-between}.card h3{font-size:1.05rem;margin:0}.card p{margin:0}
.badge{flex:none;font-size:.75rem;font-weight:700;padding:2px 8px;border-radius:6px;color:#fff}.pass{background:var(--pass)}.fail{background:var(--fail)}
video{width:100%;max-height:70vh;background:#000;border-radius:8px}
.shots{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}.shot{flex:none}.shot img{height:120px;border-radius:6px;border:1px solid var(--line);display:block}
.speed{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:.9rem}.speed button{min-height:44px;min-width:56px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font:inherit;cursor:pointer}.speed button[aria-pressed="true"]{border-color:var(--text);font-weight:700}
details{margin-top:12px}summary{cursor:pointer;min-height:44px;display:flex;align-items:center}
#zoom{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;padding:12px;z-index:10;cursor:zoom-out}
#zoom.open{display:flex}#zoom img{max-width:100%;max-height:100%;object-fit:contain}`;

const SCRIPT = `
const speeds=document.querySelectorAll("[data-speed]");
const setSpeed=(r)=>{document.querySelectorAll("video").forEach((v)=>{v.defaultPlaybackRate=r;v.playbackRate=r;});speeds.forEach((b)=>b.setAttribute("aria-pressed",String(Number(b.dataset.speed)===r)));};
speeds.forEach((b)=>b.addEventListener("click",()=>setSpeed(Number(b.dataset.speed))));
document.addEventListener("loadedmetadata",(e)=>{const on=document.querySelector('[data-speed][aria-pressed="true"]');if(on&&e.target.tagName==="VIDEO")e.target.playbackRate=Number(on.dataset.speed);},true);
const zoom=document.getElementById("zoom"),img=zoom.querySelector("img");
document.addEventListener("click",(e)=>{const a=e.target.closest("a[data-zoom]");if(!a)return;e.preventDefault();img.src=a.getAttribute("href");zoom.classList.add("open");});
zoom.addEventListener("click",()=>{zoom.classList.remove("open");img.removeAttribute("src");});
document.addEventListener("keydown",(e)=>{if(e.key==="Escape")zoom.click();});`;

export async function buildGallery(root) {
  const sections = [];
  const nav = [];
  for (const id of ["turn-refs", "collab"]) {
    const html = await suiteSection(root, id);
    if (!html) continue;
    sections.push(html);
    nav.push(`<a href="#${esc(SUITES[id].dir)}">${esc(SUITES[id].group)}</a>`);
  }
  sections.push(await liveSection(root));
  nav.push('<a href="#live">Thử thật với Claude</a>');
  const page = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PPM: thẻ lượt và session nhắn tin cho nhau</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>PPM: thẻ lượt và session nhắn tin cho nhau</h1>
<p class="intro">Mỗi thẻ là một bước kiểm tra tự động: video ghi lại màn hình khi bước đó chạy, kèm ảnh chụp (bấm để phóng to). PASS nghĩa là lần chạy đó đã kiểm tra và thấy đúng như mô tả. Ứng dụng chạy ở tốc độ thật nên nhiều đoạn chỉ vài giây; chọn 0.5× để xem chậm lại.</p>
<nav>${nav.join("")}</nav>
<div class="speed">Tốc độ xem video: <button type="button" data-speed="0.5" aria-pressed="false">0.5×</button><button type="button" data-speed="1" aria-pressed="true">1×</button></div>
${sections.join("\n")}
</main>
<div id="zoom" role="dialog" aria-label="Ảnh phóng to"><img alt=""></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
  await writeFile(join(root, "index.html"), page);
  return join(root, "index.html");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node tests/e2e/demo/build-demo-gallery.mjs <demo folder>");
    process.exit(2);
  }
  const root = resolve(arg);
  if (!existsSync(root)) {
    console.error(`no such folder: ${root}`);
    process.exit(2);
  }
  console.log(`wrote ${await buildGallery(root)}`);
}
