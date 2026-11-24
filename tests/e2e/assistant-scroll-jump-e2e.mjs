/**
 * The PPM Assistant's chat must not move the reader around the end of a turn. Reported on 0.26.31:
 * "it does not follow, that is fine, but it jerks back up above the message I just sent". The
 * person who reported it types mostly into the Assistant, whose list is not a plain chat: cards are
 * placed among the messages by time, a wake turn PPM starts and the Assistant answers `[no reply]`
 * folds into one line, a waiting card folds once answered, and older cards load as history reaches
 * back. Every one of those is exercised here around the end of the reader's own turn.
 *
 * Runs against the isolated stack of `chat-scroll-jump-e2e.mjs` (scratch PPM_HOME, one scripted
 * provider, Vite). Each run: send a working turn that creates a report card halfway through (and,
 * on odd runs, answers a waiting card), let it end, then have PPM start a wake turn that answers
 * `[no reply]` and folds. Every frame's offsets and the sent prompt's place are sampled.
 *
 *   PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs node tests/e2e/assistant-scroll-jump-e2e.mjs
 *
 * PPM_SCROLL_PHONE=1 runs at phone size. PPM_SCROLL_READING=1 has the reader scroll up mid-answer
 * (the view rightly stops following; what must hold is the place being read). PPM_SCROLL_CLOCK_SKEW_MS
 * moves the browser's clock against the server's (message times come from the browser, card times
 * from the server). PPM_SCROLL_RUNS sets the number of turns (default 4).
 *
 * Last, the temporary `[scroll-jump]` log is checked on the same page: a jump made by code is
 * recorded with its stack, reaches the session trace, and carries no message text.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { bootProject, closeAllTabs, instantInstrumentation, sleep, until } from "./fixtures/new-chat-instant-helpers.mjs";

const PROJECT = "ppm-scroll";
const RUNS = Number(process.env.PPM_SCROLL_RUNS ?? 4);
const PHONE = process.env.PPM_SCROLL_PHONE === "1";
const READING = process.env.PPM_SCROLL_READING === "1";
const SKEW_MS = Number(process.env.PPM_SCROLL_CLOCK_SKEW_MS ?? 0);
/** PPM_SCROLL_SHOTS=<dir>: the first run's view while reading and after the turn, for before/after pictures. */
const SHOTS = process.env.PPM_SCROLL_SHOTS ?? "";
const WIDTH = Number(process.env.PPM_SCROLL_WIDTH ?? 1280);
const SHOT_PREFIX = PHONE ? "assistant-phone-390" : `assistant-desktop-${WIDTH}`;
const AT_BOTTOM_PX = 80;
const SHIFT_TOLERANCE_PX = 30;
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/chat-scroll-jump-server.ts" });
const OUT = join(harness.artifacts, "assistant-scroll-jump");
await mkdir(OUT, { recursive: true });

/** The browser's clock, moved by `skew` ms against the server's. */
function skewClock(skew) {
  if (!skew) return;
  const Real = Date;
  class Skewed extends Real {
    constructor(...args) { if (args.length === 0) super(Real.now() + skew); else super(...args); }
    static now() { return Real.now() + skew; }
  }
  Skewed.parse = Real.parse;
  Skewed.UTC = Real.UTC;
  globalThis.Date = Skewed;
}

/** The Assistant's scroller: the only chat list on the page once every tab is closed. */
const SCROLLER = `(() => { const all = [...document.querySelectorAll(".chat-scroll-fade")]; return all.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? null; })()`;

const api = async (path, init) => {
  const res = await fetch(`${harness.api}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body;
};
const serverTurns = async () => (await api("/__scroll-test/state")).turns;
const turnsEnded = async () => (await serverTurns()).filter((t) => t.ended).length;

async function startSampling(page, prompt) {
  await page.evaluate(({ scroller, prompt }) => {
    const probe = window.__assistantScroll = { frames: [], marks: {}, sampling: true };
    const find = new Function(`return ${scroller}`);
    const tick = () => {
      if (!probe.sampling) return;
      const el = find();
      if (el) {
        const rows = [...el.querySelectorAll("[data-msg-id]")];
        const promptRow = rows.slice(-12).reverse().find((r) => (r.textContent ?? "").includes(prompt));
        probe.frames.push({
          t: performance.now(), top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight,
          dist: el.scrollHeight - el.scrollTop - el.clientHeight, rows: rows.length,
          trailing: !!el.querySelector("[data-chat-trailing]"),
          promptTop: promptRow ? Math.round(promptRow.getBoundingClientRect().top - el.getBoundingClientRect().top) : null,
          items: el.querySelectorAll("[data-timeline-item]").length,
        });
      }
      next();
    };
    // Measured after the frame is painted (a task queued from the frame's callback), not inside
    // it: reading layout from requestAnimationFrame forces a layout before the ResizeObserver
    // callbacks run, and records a state the reading anchor corrects before anything is drawn.
    const next = () => requestAnimationFrame(() => setTimeout(tick, 0));
    next();
  }, { scroller: SCROLLER, prompt });
}
const mark = (page, name) => page.evaluate((name) => { window.__assistantScroll.marks[name] = performance.now(); }, name);
const stopSampling = (page) => page.evaluate(() => { const p = window.__assistantScroll; p.sampling = false; return { frames: p.frames, marks: p.marks }; });
const jumpCount = (page) => page.evaluate(() => (window.__ppmScrollJumps ?? []).length);

async function readerScrollBy(page, dy) {
  if (PHONE) {
    // A finger sends no wheel; the offsets it writes, step by step, are what the page sees.
    for (let i = 0; i < Math.ceil(Math.abs(dy) / 100); i++) {
      await page.evaluate(({ scroller, d }) => { new Function(`return ${scroller}`)().scrollTop += d; }, { scroller: SCROLLER, d: Math.sign(dy) * 100 });
      await sleep(16);
    }
    return;
  }
  const box = await page.evaluate((scroller) => { const r = new Function(`return ${scroller}`)().getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, SCROLLER);
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < Math.ceil(Math.abs(dy) / 100); i++) { await page.mouse.wheel(0, Math.sign(dy) * 100); await sleep(30); }
}

async function send(page, text) {
  const box = page.locator("textarea:visible").first();
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function waitTurnEnded(page, before) {
  await until("the turn to end on the server", async () => (await turnsEnded()) > before, { timeout: 120000, interval: 100 });
  await until("the thinking line to go", () => page.evaluate((s) => !new Function(`return ${s}`)()?.querySelector("[data-chat-trailing]"), SCROLLER), { timeout: 30000 });
}

async function openAssistant(page, sessionId) {
  await page.evaluate(async (sessionId) => {
    const { openAssistant } = await import("/components/assistant/open-assistant.ts");
    openAssistant(sessionId ? { sessionId, providerId: "claude" } : { providerId: "claude" });
  }, sessionId);
  await page.locator("textarea:visible").first().waitFor({ timeout: 30000 });
}

let page = null;
try {
  const created = await fetch(`${harness.api}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }) });
  if (!created.ok) throw new Error(`Could not register the project: ${created.status} ${await created.text()}`);
  const context = PHONE
    ? await harness.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    : await harness.browser.newContext({ viewport: { width: WIDTH, height: WIDTH >= 1440 ? 900 : 860 } });
  await context.addInitScript(skewClock, SKEW_MS);
  await context.addInitScript(instantInstrumentation, { api: harness.api, blockStorage: false });
  page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/ws\/extensions|ERR_CONNECTION_REFUSED|status of 40[34]/.test(m.text())) console.log(`  console.error: ${m.text().slice(0, 300)}`); });

  await bootProject(page, harness.web, PROJECT);
  await closeAllTabs(page);
  await openAssistant(page, null);
  for (let i = 1; i <= 3; i++) {
    const before = await turnsEnded();
    await send(page, `seed ${i}`);
    await waitTurnEnded(page, before);
    await sleep(300);
  }
  const sessionId = (await serverTurns())[0]?.sessionId;
  check(!!sessionId, "the Assistant chat has a session", String(sessionId));

  // A long Assistant chat: older exchanges, more than one page of older cards across the same
  // stretch of time, and two cards that wait on the user.
  const seeded = await api(`/__scroll-test/seed?session=${sessionId}&n=40`, { method: "POST" });
  await api("/__scroll-test/cards/old?n=90&spanMs=2700000", { method: "POST" });
  await api("/__scroll-test/cards/waiting", { method: "POST" });
  await api("/__scroll-test/cards/waiting", { method: "POST" });
  console.log(`  history holds ${seeded.total} messages; reloading`);
  await sleep(1000);
  await bootProject(page, harness.web, PROJECT, { reload: true });
  await openAssistant(page, sessionId);
  await until("the newest page of history", () => page.evaluate((s) => (new Function(`return ${s}`)()?.querySelectorAll("[data-msg-id]").length ?? 0) >= 30, SCROLLER), { timeout: 30000 });
  await sleep(2000);
  const start = await page.evaluate((s) => { const el = new Function(`return ${s}`)(); return { top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight, items: el.querySelectorAll("[data-timeline-item]").length }; }, SCROLLER);
  console.log(`  opened: ${JSON.stringify(start)} phone=${PHONE} reading=${READING} skewMs=${SKEW_MS}`);
  check(start.sh > start.ch * 1.5, "the Assistant chat is taller than its view", JSON.stringify(start));
  check(start.items > 0, "cards are drawn among the messages", JSON.stringify(start));

  const results = [];
  for (let run = 1; run <= RUNS; run++) {
    const prompt = `arun-${run}-x`;
    const jumpsBefore = await jumpCount(page);
    await startSampling(page, prompt);
    const before = await turnsEnded();
    await send(page, `long ${prompt} deltas=${600 + (run % 3) * 400} card-mid${run % 2 ? " answer-mid" : " answer-end"}`);
    /** Scrolls up the list ignored: the view was back at the bottom a moment later. */
    let eaten = 0;
    if (READING) {
      await until("the answer to be streaming", async () => ((await serverTurns()).at(-1)?.yielded ?? 0) > 400, { timeout: 60000, interval: 50 });
      // While the answer grows, use-stick-to-bottom ignores a scroll that lands in a frame whose
      // content changed size, and pulls the view back down: scroll again until the view stays up.
      for (let attempt = 0; attempt < 6; attempt++) {
        await readerScrollBy(page, -[200, 350, 500, 650][run % 4]);
        await sleep(250);
        // Twice, apart: a single read can land in the frame where the content grew and the
        // follow has not caught up yet, which looks like a view that left the bottom.
        const away = async () => (await page.evaluate((s) => { const el = new Function(`return ${s}`)(); return el.scrollHeight - el.scrollTop - el.clientHeight; }, SCROLLER)) > 150;
        if (await away() && (await sleep(150), await away())) break;
        eaten++;
      }
      if (SHOTS && run === 1) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${SHOT_PREFIX}-1-reading.png`) }); }
    }
    await waitTurnEnded(page, before);
    await mark(page, "userTurnEnded");
    // A wake turn soon after, as the hub sends news: answered `[no reply]`, it folds to one line.
    await sleep(300 + (run % 3) * 400);
    await mark(page, "wakeSent");
    const wake = await api(`/__scroll-test/wake?session=${sessionId}`, { method: "POST" });
    await waitTurnEnded(page, before + 1);
    await sleep(2500);
    if (SHOTS && run === 1) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${SHOT_PREFIX}-2-after-turn.png`) }); }
    const trace = await stopSampling(page);
    const jumps = (await jumpCount(page)) - jumpsBefore;

    const frames = trace.frames;
    const endIdx = frames.findLastIndex((f) => f.trailing && f.t < trace.marks.wakeSent);
    const end = frames[endIdx];
    const last = frames.at(-1);
    const after = frames.slice(endIdx);
    const topDrop = end ? Math.round(end.top - Math.min(...after.map((f) => f.top))) : null;
    const promptShift = end?.promptTop != null && last?.promptTop != null ? last.promptTop - end.promptTop : null;
    const promptWasInView = end?.promptTop != null && end.promptTop <= end.ch;
    const viewAbovePrompt = promptWasInView && last?.promptTop != null && last.promptTop > last.ch;
    // A card or a folded wake line drawn ABOVE the message just sent: the frame its item lands in
    // is the frame the prompt is pushed down by it. Both are newer than the prompt, so their place
    // is below it; one placed above was compared with a time the browser stamped by its own clock.
    let placedAbovePrompt = 0;
    for (let i = 1; i < frames.length; i++) {
      const [a, b] = [frames[i - 1], frames[i]];
      if (b.items > a.items && a.promptTop != null && b.promptTop != null && b.promptTop - a.promptTop > 20) placedAbovePrompt++;
    }
    let ok;
    if (placedAbovePrompt > 0) ok = false;
    else if (READING) ok = promptShift !== null && Math.abs(promptShift) <= SHIFT_TOLERANCE_PX && !viewAbovePrompt;
    else ok = last && last.dist <= AT_BOTTOM_PX && !viewAbovePrompt;
    const items = `${end?.items}->${last?.items}`;
    console.log(`  run ${run}: ok=${ok} dist=${Math.round(last?.dist ?? -1)} topAtEnd=${Math.round(end?.top ?? -1)} topDropAfterEnd=${topDrop} promptTop ${end?.promptTop} -> ${last?.promptTop} shift=${promptShift}${viewAbovePrompt ? " VIEW-ABOVE-PROMPT" : ""} rows ${end?.rows}->${last?.rows} timelineItems ${items} wake=${JSON.stringify(wake.result?.status ?? wake.result)} scrollJumpRecords=${jumps}${READING ? ` readerScrollsIgnored=${eaten}` : ""} itemsPlacedAbovePrompt=${placedAbovePrompt}`);
    results.push({ run, ok, topDrop, promptShift, viewAbovePrompt, jumps, placedAbovePrompt });
    if (!ok || jumps > 0) {
      const recent = await page.evaluate((n) => (window.__ppmScrollJumps ?? []).slice(-n), Math.max(jumps, 1));
      await writeFile(join(OUT, `run-${run}-trace.json`), JSON.stringify({ marks: trace.marks, frames: frames.filter((f, i, a) => i === 0 || f.top !== a[i - 1].top || f.sh !== a[i - 1].sh || f.rows !== a[i - 1].rows || f.items !== a[i - 1].items || f.trailing !== a[i - 1].trailing), scrollJumps: recent }, null, 2));
      await page.screenshot({ path: join(OUT, `run-${run}.png`) });
      console.log(`    trace written: run-${run}-trace.json`);
    }
    // Every run starts at the bottom.
    await page.evaluate((s) => { const el = new Function(`return ${s}`)(); el.scrollTop = el.scrollHeight; }, SCROLLER);
    await sleep(500);
  }
  const bad = results.filter((r) => !r.ok);
  check(bad.length === 0, `${READING ? "the place being read holds" : "the view stays at the bottom, not above the sent message"} through the turn's end and a folded wake turn (${RUNS - bad.length}/${RUNS})`,
    bad.map((r) => `run ${r.run}: shift ${r.promptShift}px, top dropped ${r.topDrop}px${r.viewAbovePrompt ? ", view above the prompt" : ""}${r.placedAbovePrompt ? `, ${r.placedAbovePrompt} item(s) drawn above the message just sent` : ""}`).join("; "));

  // The temporary log, on this page: a jump made by code is recorded with where it came from,
  // reaches the session trace, and carries no message text.
  const recordsBefore = await jumpCount(page);
  await page.evaluate((s) => { const el = new Function(`return ${s}`)(); el.scrollTop = el.scrollTop - 400; }, SCROLLER);
  await sleep(300);
  const record = await page.evaluate(() => (window.__ppmScrollJumps ?? []).at(-1) ?? null);
  check((await jumpCount(page)) > recordsBefore && record?.write?.kind === "scrollTop=" && record.write.stack.length > 0,
    "a jump made by code is recorded with the write and its stack", JSON.stringify(record?.write ?? null));
  check(record?.after?.surface === "assistant" && record.drop >= 390, "the record names the Assistant and the size of the jump", JSON.stringify({ surface: record?.after?.surface, drop: record?.drop }));
  check(typeof record?.clockSkewMs === "number" && Math.abs(record.clockSkewMs - SKEW_MS) <= 1500,
    "the record carries how far the browser's clock is from the server's", `measured ${record?.clockSkewMs} ms, set ${SKEW_MS} ms`);
  const stored = await until("the record in the session trace", async () => {
    const { rows } = await api("/__scroll-test/scroll-jumps");
    return rows.length > 0 ? rows : null;
  }, { timeout: 30000, interval: 500 });
  const leaked = stored.filter((r) => /arun-|Older answer|older question|Which build|finished item|thought-/.test(r.payload_json));
  check(stored.length > 0 && leaked.length === 0, "the records reach session-trace.db and hold no message text", `${stored.length} row(s), ${leaked.length} with text`);
  await writeFile(join(OUT, "scroll-jump-rows.json"), JSON.stringify(stored, null, 2));
  await context.close();
} catch (error) {
  await page?.screenshot({ path: join(OUT, "failure.png") }).catch(() => {});
  console.log(`FAIL harness — ${error?.stack ?? error}`);
  failures++;
} finally {
  await harness.browser?.close().catch(() => {});
  await harness.cleanup();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
