// End-to-end check of files on report cards, against the Assistant fixture and the fake Telegram:
//   1. A manager's report naming a clip outside its project is refused until the folder is listed in
//      Settings → PPM Assistant → Manager chats → Files on cards; `.env` is refused whatever.
//   2. Listed, the report puts the clip (79 MB by default), a picture and a PDF on the card.
//   3. Telegram: the card lists the files with a link to the PPM viewer; each file follows as a
//      document replying to the card; the clip over 50 MB arrives as a two-pass compressed copy whose
//      caption says what it was compressed from.
//   4. The card in PPM (1440 and 390): one row per file, standard button heights; Play opens the
//      viewer, which plays the original in the browser's own player: plays, seeks, pauses.
//   5. On a 390 px phone the Telegram link (`/card-file/<id>`) opens the viewer directly; one tap on
//      the video changes play/pause at most once.
//   6. The File Explorer plays the same clip in the browser's own player.
//
// Usage:
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_CARD_FILES_SHOTS=<dir> \
//   [PPM_CARD_FILES_CLIP=<an mp4 over 50 MB>] node tests/e2e/assistant-card-files-e2e.mjs
//
// Playwright comes from PPM_PLAYWRIGHT_MODULE (preset in the ppm-e2e-chromium image).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild, until } from "./assistant-telegram/harness.mjs";
import { loopKit } from "./assistant-manager-loop/loop-kit.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-card-files-e2e-"));
const shotsDir = resolve(process.env.PPM_CARD_FILES_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), alpha = join(sandbox, "alpha");
await Promise.all([shotsDir, logs, ppm, home, alpha, join(alpha, "out"), join(alpha, "docs")].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (name.endsWith(".png")) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
const clip = resolve(process.env.PPM_CARD_FILES_CLIP ?? "D:/Photos/TotNghiep-UIT-261126-capcut/capcut-graduation-RheeMey-video-9x16.mp4");
assert(existsSync(clip), `no clip at ${clip}`);
const clipMb = (statSync(clip).size / 1024 / 1024).toFixed(1);
const OWNER = 1001;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`PASS ${name}`); };

/** A plain PNG with a darker band. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const band = y > h * 0.7;
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) { row[1 + x * 3] = band ? r / 2 : r; row[2 + x * 3] = band ? g / 2 : g; row[3 + x * 3] = band ? b / 2 : b; }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/** A one-page PDF saying `text`, with a correct cross-reference table. */
function pdf(text) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 24 Tf 72 760 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

const onboardingDone = () => {
  if (window.top !== window) return;
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
};

await writeFile(join(alpha, "README.md"), "# Alpha\n");
await writeFile(join(alpha, "out", "poster.png"), png(900, 1600, [99, 102, 241]));
await writeFile(join(alpha, "docs", "brief.pdf"), pdf("Graduation clip brief"));
await writeFile(join(alpha, ".env"), "TOKEN=never-sent\n");
{
  const git = (...args) => execFileSync("git", args, { cwd: alpha, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", "README.md");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");
}

let fake, backend, browser;
let failure = null;
try {
  const f = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: join(logs, "fake-telegram.log"), ready: /FAKE_TELEGRAM (\{.*\})/ });
  fake = f.child;
  const fakeInfo = JSON.parse((await f.ready)[1]);
  const port = await freePort();
  const web = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
    PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
    PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
    PPM_ASSISTANT_MANAGER_LOOP: "1",
    PPM_ASSISTANT_FAKE_TELEGRAM: "1", PPM_TELEGRAM_API_BASE: fakeInfo.api, PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: fakeInfo.token,
    PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify([[String(OWNER), String(OWNER), "Phone"]]),
    PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "200", PPM_ASSISTANT_FIXTURE_TG_DELAY_SCALE: "0.05",
  };
  delete env.PPM_ALLOW_PROD_DB;
  delete env.PPM_ASSISTANT_FIXTURE_RESUME;
  const b = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], { env, log: join(logs, "fixture.log"), ready: /Assistant fixture ready/ });
  backend = b.child;
  await b.ready;
  console.log(`fixture server pid=${backend.pid} port=${port}; fake telegram pid=${fake.pid}`);
  const fx = fixtureApi(web);
  const tg = phone(fakeInfo.control);
  await fx.post("/api/projects", { name: "alpha", path: alpha });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);
  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(OWNER) });
  const settings = async () => (await fx.api("/api/assistant/settings")).data.settings;
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...(await settings()), timezone: "UTC", digest: { enabled: false, time: "08:00" } }) });
  const aChat = (await fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: "Alpha lead" })).data.id;
  await fx.api("/api/assistant/managers/alpha", { method: "PUT", body: JSON.stringify({ sessionId: aChat }) });

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
  });
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await desk.addInitScript(onboardingDone);
  const page = await desk.newPage();
  const k = loopKit({ web, fx, tg, page, shotsDir, owner: OWNER, record: (id, name) => ok(`setup ${id}: ${name}`) });
  const report = async (label, args) => {
    await k.managerTurn("alpha", aChat, label, [{ session: "report_to_assistant", args }], `Report: ${args.title}`);
    const [rec] = await k.answered(label, 1);
    await k.idle(aChat);
    return rec;
  };

  // 1. Outside the project, refused until its folder is listed; .env refused whatever.
  const TITLE = "Graduation clip is ready";
  const files = [clip, "out/poster.png", "docs/brief.pdf"];
  const outside = await report("f-outside", { kind: "done", title: TITLE, files });
  assert.equal(outside.isError, true, "a clip outside the project is refused");
  assert.match(outside.text, /Files on cards/, "the refusal says where to allow the folder");
  const secret = await report("f-env", { kind: "done", title: "Env", files: [".env"] });
  assert.equal(secret.isError, true);
  assert.match(secret.text, /environment file/);
  ok("a clip outside the project is refused (naming Settings → Files on cards); .env is refused");
  const saved = await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...(await settings()), report_file_dirs: [dirname(clip)] }) });
  assert.deepEqual(saved.data.settings.report_file_dirs, [dirname(clip)]);

  // 2. Listed: the card carries the three files.
  const filed = await report("f-ok", { kind: "done", title: TITLE, body: "The 9:16 cut, the poster and the brief.", files });
  assert.equal(filed.isError, false, filed.text);
  const card = await k.cardOf("done", TITLE);
  assert.deepEqual(card.payload.files.map((x) => x.kind), ["video", "image", "pdf"]);
  assert.equal(card.payload.files[0].size, statSync(clip).size);
  ok(`the folder listed, the card carries the ${clipMb} MB clip, a picture and a PDF (copied into PPM's store)`);

  // 3. Telegram.
  const cardMsg = await tg.waitFor(OWNER, "the card", (m) => m.text.includes(TITLE) && m.text.includes("3 files"), 30000);
  const link = /href="[^"]*?(\/card-file\/[0-9a-f]{32})"/.exec(cardMsg.html ?? "")?.[1];
  assert.ok(link, "each file on the card links to its PPM viewer");
  const docs = await until("the picture and the PDF as documents", async () => {
    const d = (await tg.sent(OWNER)).filter((m) => m.file?.method === "sendDocument" && m.reply_to === cardMsg.message_id);
    return d.length >= 2 ? d : null;
  }, 60000);
  assert.ok(docs.some((d) => d.file.filename === "poster.png") && docs.some((d) => d.file.filename === "brief.pdf"));
  assert.ok(!(await tg.sent(OWNER)).some((m) => m.photo), "no picture went by sendPhoto");
  console.log("waiting for the two-pass compression of the clip…");
  const compressed = await until("the compressed clip", async () => (await tg.sent(OWNER)).find((m) => m.file && /compressed from/.test(m.text)), 15 * 60_000, 2000);
  assert.equal(compressed.file.method, "sendDocument");
  assert.equal(compressed.reply_to, cardMsg.message_id);
  assert.ok(compressed.file.bytes <= 50 * 1024 * 1024, `the copy fits (${compressed.file.bytes})`);
  assert.match(compressed.text, new RegExp(`compressed from ${clipMb} MB`));
  ok(`Telegram: card lists the files with viewer links; picture and PDF as documents replying to it; the clip as a ${(compressed.file.bytes / 1048576).toFixed(1)} MB two-pass copy "compressed from ${clipMb} MB"`);

  // The smooth copy is made in the background from the moment the card exists.
  console.log("waiting for the smooth copy…");
  const smoothNow = async () => (await fx.api(`/api/card-files/${card.payload.files[0].id}/info`)).data.smooth;
  await until("smooth copy ready", async () => (await smoothNow()) === "ready", 15 * 60_000, 3000);
  ok("the smooth copy (~4 Mbit/s, same resolution) was made in the background");

  const heights = (loc, sel = "[data-card-file-open], [data-card-file-download]") =>
    loc.evaluate((el, s) => [...el.querySelectorAll(s)].map((b) => Math.round(b.getBoundingClientRect().height)).filter((h) => h > 0), sel);
  const videoIn = (pg) => pg.locator("[data-card-file-viewer] [data-testid=native-video] video");
  /** Plays, seeks to 30 s and pauses the viewer's video; checks which copy it is. */
  const play = async (pg, label, copy) => {
    const video = videoIn(pg);
    await video.waitFor({ timeout: 15000 });
    await until(`${label}: the ${copy} copy`, async () => (await video.getAttribute("src"))?.includes("variant=smooth") === (copy === "smooth"), 15000, 100);
    const attrs = await video.evaluate((v) => ({ controls: v.controls, inline: v.playsInline, preload: v.preload }));
    assert.deepEqual(attrs, { controls: true, inline: true, preload: "metadata" }, `${label}: the browser's own player`);
    await video.evaluate((v) => v.play());
    await until(`${label}: plays`, () => video.evaluate((v) => !v.paused && v.currentTime > 1), 30000, 200);
    await video.evaluate((v) => { v.currentTime = 30; });
    await until(`${label}: seeked to 30 s`, () => video.evaluate((v) => v.currentTime >= 30 && v.readyState >= 3), 30000, 200);
    await video.evaluate((v) => v.pause());
    assert.equal(await video.evaluate((v) => v.paused), true, `${label}: pauses`);
    return video;
  };
  const toggleHeights = (pg) => heights(pg.locator("[data-quality-toggle]:visible").first(), "[data-quality]");

  // 4. The card in PPM, desktop: Original by default, Smooth on request.
  await page.goto(`${web}/project/alpha/assistant`);
  const rows = page.locator("[data-card-files]:visible").first();
  await rows.waitFor({ timeout: 30000 });
  await rows.scrollIntoViewIfNeeded();
  assert.ok((await heights(rows)).every((h) => h === 28), `desktop buttons are 28px (${await heights(rows)})`);
  await page.waitForTimeout(500);
  await rows.screenshot({ path: join(shotsDir, "1440-card-files.png") });
  await page.screenshot({ path: join(shotsDir, "1440-assistant-with-card.png") });
  await rows.locator('[data-card-file="video"] [data-card-file-open]').click();
  await play(page, "1440 original", "original");
  assert.ok((await toggleHeights(page)).every((h) => h === 28), `1440: Original / Smooth is 28px (${await toggleHeights(page)})`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotsDir, "1440-viewer-original.png") });
  await page.locator('[data-quality-toggle] [data-quality="smooth"]').click();
  await play(page, "1440 smooth", "smooth");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotsDir, "1440-viewer-smooth.png") });
  // The choice is this device's: put it back for the rest of the run.
  await page.locator('[data-quality-toggle] [data-quality="original"]').click();
  await page.locator("[data-card-file-close]").click();
  ok("1440: card rows 28 px; the viewer opens on Original, Smooth switches copy; both play, seek to 30 s and pause; Original / Smooth is 28 px");

  // 5. A 390 px phone opening the Telegram link: Smooth by default, Original on request.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phoneCtx.addInitScript(onboardingDone);
  const mob = await phoneCtx.newPage();
  await mob.goto(`${web}/`);
  await mob.evaluate((t) => localStorage.setItem("ppm-auth-token", t), await page.evaluate(() => localStorage.getItem("ppm-auth-token") ?? ""));
  await mob.goto(`${web}${link}`);
  const mobVideo = await play(mob, "390 smooth", "smooth");
  assert.ok((await toggleHeights(mob)).every((h) => h === 26), `390: Original / Smooth is 26px (${await toggleHeights(mob)})`);
  // One tap on the picture: at most one play/pause change (the old player toggled on every tap).
  await mobVideo.evaluate((v) => { window.__changes = 0; v.addEventListener("play", () => window.__changes++); v.addEventListener("pause", () => window.__changes++); });
  const box = await mobVideo.boundingBox();
  await mob.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 3);
  await mob.waitForTimeout(800);
  const changes = await mob.evaluate(() => window.__changes);
  assert.ok(changes <= 1, `one tap changed play/pause ${changes} times`);
  await mob.screenshot({ path: join(shotsDir, "390-viewer-smooth-from-telegram-link.png") });
  await mob.locator('[data-quality-toggle] [data-quality="original"]').tap();
  await play(mob, "390 original", "original");
  await mob.waitForTimeout(300);
  await mob.screenshot({ path: join(shotsDir, "390-viewer-original.png") });
  assert.equal(await mob.evaluate(() => localStorage.getItem("ppm-video-quality")), "original", "the phone remembers its choice");
  await mob.locator('[data-quality-toggle] [data-quality="smooth"]').tap();
  await mob.locator("[data-card-file-close]").tap();
  await mob.goto(`${web}/project/alpha/assistant`);
  const mobRows = mob.locator("[data-card-files]:visible").first();
  await mobRows.waitFor({ timeout: 30000 });
  await mobRows.scrollIntoViewIfNeeded();
  assert.ok((await heights(mobRows)).every((h) => h === 26), `phone buttons are 26px (${await heights(mobRows)})`);
  await mob.waitForTimeout(500);
  await mob.screenshot({ path: join(shotsDir, "390-assistant-card-files.png") });
  await mobRows.locator('[data-card-file="image"] [data-card-file-open]').tap();
  await mob.locator("[data-card-file-viewer=image] img").waitFor({ timeout: 15000 });
  await mob.waitForTimeout(400);
  await mob.screenshot({ path: join(shotsDir, "390-viewer-picture.png") });
  await mob.locator("[data-card-file-close]").tap();
  ok(`390: the Telegram link opens the viewer on Smooth, Original switches; both play, seek, pause; one tap = ${changes} play/pause change; the choice is remembered; buttons 26 px`);

  // 6. The File Explorer: Original in the browser's own player, Smooth through the live transcode.
  const name = clip.split(/[\\/]/).pop();
  const explorerVideo = async (pg, label, copy) => {
    const pane = pg.locator(`[data-video-preview="${copy}"]:visible`).first();
    await pane.waitFor({ timeout: 60000 });
    const video = pane.locator("video").first();
    if (copy === "smooth") await until(`${label}: transcode`, async () => /quality=smooth/.test(await video.evaluate((v) => v.currentSrc)), 30000, 200);
    else assert.equal(await pane.locator("[data-testid=native-video]").count(), 1, `${label}: the browser's own player`);
    if (copy === "original") await video.evaluate((v) => v.play());
    await until(`${label}: plays`, () => video.evaluate((v) => !v.paused && v.videoWidth > 0 && v.currentTime > 1), 60000, 300);
    await video.evaluate((v) => v.pause());
    assert.equal(await video.evaluate((v) => v.paused), true, `${label}: pauses`);
  };
  // Phone: starts on Smooth (the choice made above).
  await mob.goto(`${web}/files?path=${encodeURIComponent(clip)}`);
  const entry = mob.getByText(name, { exact: true }).first();
  await entry.waitFor({ timeout: 30000 });
  await entry.tap();
  await explorerVideo(mob, "390 explorer smooth", "smooth");
  await mob.waitForTimeout(300);
  await mob.screenshot({ path: join(shotsDir, "390-explorer-smooth.png") });
  await mob.locator('[data-quality-toggle]:visible [data-quality="original"]').first().tap();
  await explorerVideo(mob, "390 explorer original", "original");
  await mob.waitForTimeout(300);
  await mob.screenshot({ path: join(shotsDir, "390-explorer-original.png") });
  // Desktop: starts on Original.
  await page.goto(`${web}/files?path=${encodeURIComponent(clip)}`);
  const deskEntry = page.getByText(name, { exact: true }).first();
  await deskEntry.waitFor({ timeout: 30000 });
  await deskEntry.dblclick();
  await explorerVideo(page, "1440 explorer original", "original");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotsDir, "1440-explorer-original.png") });
  await page.locator('[data-quality-toggle]:visible [data-quality="smooth"]').first().click();
  await explorerVideo(page, "1440 explorer smooth", "smooth");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotsDir, "1440-explorer-smooth.png") });
  ok("File Explorer at 390 and 1440: Original plays in the browser's own player, Smooth plays through the ~4 Mbit/s transcode");
  // The Settings section where the folder is listed.
  await page.goto(`${web}/?openSettings=assistant`);
  await page.locator('[data-testid="assistant-settings-tab-managers"]:visible').first().click();
  const section = page.locator('[data-testid="assistant-report-files"]:visible').first();
  await section.waitFor({ timeout: 30000 });
  await section.scrollIntoViewIfNeeded();
  assert.match(await section.locator("textarea").inputValue(), new RegExp(dirname(clip).replace(/[\\]/g, "\\\\")));
  await section.screenshot({ path: join(shotsDir, "1440-settings-files-on-cards.png") });
  ok("Settings → PPM Assistant → Manager chats → Files on cards lists the clip's folder");
} catch (e) {
  failure = e;
  console.error(`FAIL ${e?.stack ?? e}`);
  for (const [i, ctx] of (browser?.contexts() ?? []).entries()) await ctx.pages()[0]?.screenshot({ path: join(shotsDir, `failure-${i}.png`) }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  for (const child of [backend, fake]) {
    if (!child?.pid) continue;
    try { process.kill(child.pid); console.log(`stopped pid ${child.pid}`); } catch { /* already gone */ }
  }
  console.log(`\n${checks.length} checks passed; shots in ${shotsDir}; logs in ${logs}`);
}
if (failure) process.exit(1);
