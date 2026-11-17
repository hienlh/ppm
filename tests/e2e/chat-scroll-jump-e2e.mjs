/**
 * The chat must still sit at its bottom after a turn ends, when the reader followed the reply down
 * and never scrolled. Reported against 0.26.9: "now and then I send a line, it answers, and then it
 * jerks back to an earlier message".
 *
 * Runs against an isolated stack (scratch PPM_HOME, one scripted mock provider, Vite): builds a
 * transcript longer than the viewport, then sends working turns (thinking, tool calls, Markdown)
 * one after another without touching the scroll position, and reads how far from the bottom the
 * view sits once each turn has ended and settled. Every write to the scroller's position is logged
 * with its stack, and every frame's offsets are sampled, so a failing run names who moved it.
 *
 *   docker run --rm --name ppm-task-scroll-jump --cpus=4 --memory=3g --ulimit core=0 \
 *     -v <repo>:/app:ro -v ppm-e2e-nm:/app/node_modules -v <out>:/out -w /app -e IS_SANDBOX=1 \
 *     -e PPM_HTML_PREVIEW_ARTIFACTS=/out ppm-e2e-chromium:latest \
 *     sh -c 'bun install --frozen-lockfile && node tests/e2e/chat-scroll-jump-e2e.mjs'
 *
 * What fails is the chat socket dropping while a turn runs (a tunnel blip; the live log shows
 * thousands of code-1006 closes): on reconnect the server replays the turn so far, and the page
 * takes the answer it was showing off the list before the rebuilt one reaches the screen. For that
 * gap the list ends with the reader's own message, so the view sits on "the previous message".
 * Measured as `answerGoneMs`: how long the answer, once drawn, was missing from under its prompt.
 *
 * PPM_SCROLL_RUNS sets how many turns are measured (default 12). PPM_SCROLL_VARIANT picks them:
 * - `replay` (default): the socket drops while the turn pauses with most of its answer drawn;
 * - `end-reconnect`: it drops 0/10/100/1000 events before the turn's end (real timing, flaky);
 * - controls that pass on the current code: `long` (no drop), `idle-reconnect`, `midturn-reconnect`
 *   (over 10,000 events, truncated replay), `bgbar`/`bgbar-after` (a bar above the transcript
 *   going away at the end), `tasks`/`tasks-last` (Claude's task list hiding itself), `away`
 *   (another tab active while the turn ends), `noisy`.
 * PPM_SCROLL_OLDER=<n> makes the chat long (older pages above the newest one); PPM_SCROLL_DPR sets
 * the device pixel ratio (1.25 for a Windows display at 125%).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { bootProject, closeAllTabs, instantInstrumentation, openChatTab, sleep, until } from "./fixtures/new-chat-instant-helpers.mjs";

const PROJECT = "ppm-scroll";
const RUNS = Number(process.env.PPM_SCROLL_RUNS ?? 12);
const VARIANT = process.env.PPM_SCROLL_VARIANT ?? "replay";
/** Further from the bottom than this after a turn has settled is the bug: the view moved up. */
const AT_BOTTOM_PX = 80;
/** Longer than three frames with the answer gone from under its prompt is visible to a reader. */
const ANSWER_GONE_TOLERANCE_MS = 50;
/** A streamed answer is drawn in at least this many steps (flushes are ~100 ms apart). */
const MIN_DRAW_STEPS = 4;
/** Variants that drop the chat socket mid-run. */
const DROPS_SOCKET = new Set(["replay", "end-reconnect", "midturn-reconnect", "idle-reconnect"]);
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/chat-scroll-jump-server.ts" });
const OUT = join(harness.artifacts, "chat-scroll-jump");
await mkdir(OUT, { recursive: true });

/** Installed in every document: logs writes to the chat scroller's position, with their stacks. */
function scrollProbe() {
  if (window.top !== window) return;
  const probe = { writes: [], events: [], frames: [], sampling: false };
  window.__scroll = probe;
  const isChat = (el) => el instanceof Element && el.classList.contains("chat-scroll-fade");
  const stack = () => (new Error().stack || "").split("\n").slice(2, 9).map((l) => l.trim().replace(/https?:\/\/[^/]+/, "").replace(/\?[^:)]*/, "")).join(" < ");
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) {
      if (isChat(this) && probe.sampling) {
        const before = desc.get.call(this);
        desc.set.call(this, v);
        const after = desc.get.call(this);
        if (Math.abs(after - before) > 0.5) probe.writes.push({ t: performance.now(), kind: "scrollTop=", before, asked: v, after, sh: this.scrollHeight, ch: this.clientHeight, stack: stack() });
        return;
      }
      desc.set.call(this, v);
    },
  });
  for (const name of ["scrollTo", "scrollBy"]) {
    const original = Element.prototype[name];
    Element.prototype[name] = function (...args) {
      if (isChat(this) && probe.sampling) {
        const before = desc.get.call(this);
        const r = original.apply(this, args);
        probe.writes.push({ t: performance.now(), kind: name, before, asked: JSON.stringify(args), after: desc.get.call(this), sh: this.scrollHeight, ch: this.clientHeight, stack: stack() });
        return r;
      }
      return original.apply(this, args);
    };
  }
  document.addEventListener("scroll", (e) => {
    if (!probe.sampling || !isChat(e.target)) return;
    const el = e.target;
    probe.events.push({ t: performance.now(), top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight });
  }, true);
}

/**
 * Samples the scroller every frame. `prompt` is text only the run's own message holds: a frame
 * whose last row is that message, once an answer has been drawn under it, is a frame in which
 * the answer was taken away and the reader is looking at their own previous message.
 */
async function sampleFrames(page, tabId, prompt) {
  await page.evaluate(({ root, prompt }) => {
    const probe = window.__scroll;
    probe.writes = []; probe.events = []; probe.frames = []; probe.sampling = true;
    const tick = () => {
      if (!probe.sampling) return;
      const el = document.querySelector(`${root} .chat-scroll-fade`);
      if (el) {
        const trailing = !!el.querySelector("[data-chat-trailing]");
        const rows = el.querySelectorAll("[data-msg-id]");
        const lastIsPrompt = !!rows.length && (rows[rows.length - 1].textContent ?? "").includes(prompt);
        // Only the last few rows: the prompt is near the end whenever it is in the list at all.
        const hasPrompt = [...rows].slice(-4).some((r) => (r.textContent ?? "").includes(prompt));
        // How much of the answer is drawn: grows step by step while it streams.
        const answerLen = hasPrompt && !lastIsPrompt ? (rows[rows.length - 1].textContent ?? "").length : 0;
        probe.frames.push({ t: performance.now(), top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight, dist: el.scrollHeight - el.scrollTop - el.clientHeight, trailing, rows: rows.length, lastIsPrompt, hasPrompt, answerLen });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { root: `[data-tab-pool-id="${tabId}"]`, prompt });
}

/** How long, in all, the run's answer was gone from under its prompt after it had been drawn. */
function answerGoneMs(frames) {
  let shown = false, longest = 0, since = null, at = null;
  for (const f of frames) {
    if (f.hasPrompt && !f.lastIsPrompt) {
      shown = true;
      if (since !== null) { longest = Math.max(longest, f.t - since); since = null; }
    } else if (shown && f.lastIsPrompt && since === null) {
      since = f.t;
      at ??= f.t;
    }
  }
  if (since !== null && frames.length) longest = Math.max(longest, frames[frames.length - 1].t - since);
  return { longest: Math.round(longest), firstAt: at };
}

const stopSampling = (page) => page.evaluate(() => { const p = window.__scroll; p.sampling = false; return { writes: p.writes, events: p.events, frames: p.frames }; });

const distance = (page, tabId) => page.evaluate((root) => {
  const el = document.querySelector(`${root} .chat-scroll-fade`);
  if (!el) return null;
  // The row whose box spans the viewport's top: what the reader is looking at.
  const top = el.getBoundingClientRect().top;
  const rows = [...el.querySelectorAll("[data-msg-id]")];
  const atTop = rows.find((r) => { const b = r.getBoundingClientRect(); return b.bottom > top + 1; });
  return {
    dist: el.scrollHeight - el.scrollTop - el.clientHeight,
    top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight,
    rowAtTop: atTop ? `${rows.indexOf(atTop)}/${rows.length} ${atTop.getAttribute("data-msg-id")}` : null,
  };
}, `[data-tab-pool-id="${tabId}"]`);

const serverTurns = async () => (await (await fetch(`${harness.api}/__scroll-test/state`)).json()).turns;
const turnsEnded = async () => (await serverTurns()).filter((t) => t.ended).length;

/** Chat sockets of the page, so a run can drop them the way a network blip or a sleep would. */
const sockets = new Set();
const dropChatSockets = async () => { for (const ws of [...sockets]) { sockets.delete(ws); await ws.close().catch(() => {}); } };

async function send(page, tabId, text) {
  const box = page.locator(`[data-tab-pool-id="${tabId}"] textarea:visible`).first();
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function waitEnded(page, tabId, before, settleMs) {
  await until("the turn to end on the server", async () => (await turnsEnded()) > before, { timeout: 120000, interval: 100 });
  await until("the trailing thinking line to go", () => page.evaluate((root) => !document.querySelector(`${root} [data-chat-trailing]`), `[data-tab-pool-id="${tabId}"]`), { timeout: 30000 });
  await sleep(settleMs);
}

async function sendAndSettle(page, tabId, text, { settleMs = 1500 } = {}) {
  const before = await turnsEnded();
  await send(page, tabId, text);
  await waitEnded(page, tabId, before, settleMs);
}

/** History reads (`GET …/messages`) the page made since `t`: a refetch replaces every row. */
const historyReads = (log, t) => log.filter((e) => e.at >= t).length;

try {
  const created = await fetch(`${harness.api}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }) });
  if (!created.ok) throw new Error(`Could not register the project: ${created.status} ${await created.text()}`);

  // PPM_SCROLL_DPR: a Windows display at 125% or 150% gives the scroller fractional offsets.
  const context = await harness.browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: Number(process.env.PPM_SCROLL_DPR ?? 1) });
  await context.addInitScript(instantInstrumentation, { api: harness.api, blockStorage: false });
  await context.addInitScript(scrollProbe);
  const page = await context.newPage();
  await page.routeWebSocket(/\/ws\/project\/[^/]+\/chat\//, (ws) => {
    ws.connectToServer();
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
  });
  // Claude's task list for the chat (rebuilt from the transcript on the server): six tasks, all done
  // once the turn has marked them so, which is what makes the list above the transcript hide.
  await context.route((url) => /\/chat\/sessions\/[^/]+\/tasks$/.test(url.pathname), async (route) => {
    const last = (await serverTurns()).at(-1);
    const tasks = last && /tasks/.test(last.message)
      ? Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), subject: `Scroll task ${i + 1}`, status: last.tasksDoneAt || i < 2 ? "completed" : i === 2 ? "in_progress" : "pending" }))
      : [];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: tasks }) });
  });
  const reads = [];
  page.on("request", (req) => { if (req.method() === "GET" && /\/chat\/sessions\/[^/]+\/messages/.test(new URL(req.url()).pathname)) reads.push({ at: Date.now() }); });
  page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/ws\/extensions|ERR_CONNECTION_REFUSED|status of 40[34]/.test(m.text())) console.log(`  console.error: ${m.text().slice(0, 300)}`); });

  await bootProject(page, harness.web, PROJECT);
  await closeAllTabs(page);
  let { tabId } = await openChatTab(page, PROJECT);
  await page.locator(`[data-tab-pool-id="${tabId}"] textarea:visible`).first().waitFor({ timeout: 30000 });

  // A transcript several screens tall, so "the bottom" and "an earlier message" are far apart.
  for (let i = 1; i <= 4; i++) await sendAndSettle(page, tabId, `seed ${i}`, { settleMs: 300 });

  // PPM_SCROLL_OLDER=<n>: a long chat, as one opened after a reload. `n` older exchanges go in
  // front of the session's history and the page reloads, so the chat holds only the newest page
  // (50 messages) with older pages above it — the shape of a real working chat.
  const older = Number(process.env.PPM_SCROLL_OLDER ?? 0);
  if (older > 0) {
    const sessionId = await page.evaluate(async (id) => {
      const { usePanelStore } = await import("/stores/panel-store.ts");
      return Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.id === id)?.metadata?.sessionId ?? null;
    }, tabId);
    const seeded = await (await fetch(`${harness.api}/__scroll-test/seed?session=${sessionId}&n=${older}`, { method: "POST" })).json();
    console.log(`  history now holds ${seeded.total} messages; reloading`);
    await sleep(1500);
    await bootProject(page, harness.web, PROJECT, { reload: true });
    tabId = await until("the chat tab after the reload", () => page.evaluate(async (sid) => {
      const { usePanelStore } = await import("/stores/panel-store.ts");
      return Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.metadata?.sessionId === sid)?.id ?? null;
    }, sessionId), { timeout: 30000 });
    await page.evaluate(async (id) => { const { usePanelStore } = await import("/stores/panel-store.ts"); usePanelStore.getState().setActiveTab(id); }, tabId);
    await page.locator(`[data-tab-pool-id="${tabId}"] textarea:visible`).first().waitFor({ timeout: 30000 });
    await until("the newest page of history", () => page.evaluate((root) => document.querySelectorAll(`${root} [data-msg-id]`).length >= 40, `[data-tab-pool-id="${tabId}"]`), { timeout: 30000 });
    await sleep(1500);
  }
  const seeded = await distance(page, tabId);
  console.log(`  seeded: ${JSON.stringify(seeded)}`);
  check(seeded && seeded.sh > seeded.ch * 1.5, "the seeded transcript is taller than the viewport", JSON.stringify(seeded));
  check(seeded && seeded.dist <= AT_BOTTOM_PX, "the seeded transcript sits at its bottom", JSON.stringify(seeded));

  const results = [];
  for (let run = 1; run <= RUNS; run++) {
    await sampleFrames(page, tabId, `run ${run} deltas=`);
    const runStart = Date.now();
    let extra = "";
    if (VARIANT === "idle-reconnect") {
      // The turn ends normally; then the chat socket drops and comes back while idle, as after a
      // network blip. The greeting finds the history stale and refetches it, replacing every row.
      await sendAndSettle(page, tabId, `long run ${run} deltas=400`, { settleMs: 5600 });
      const dropAt = Date.now();
      await dropChatSockets();
      await until("the history refetch after the reconnect", async () => historyReads(reads, dropAt) > 0, { timeout: 20000 });
      await sleep(2000);
      extra = `refetches=${historyReads(reads, dropAt)}`;
    } else if (VARIANT === "midturn-reconnect") {
      // The socket drops mid-turn once the turn holds more events than the server's replay buffer
      // (10,000): the replay comes back truncated, and the page refetches history when the turn ends.
      const before = await turnsEnded();
      await send(page, tabId, `long run ${run} deltas=12000`);
      await until("the turn to pass 10,500 events", async () => ((await serverTurns()).at(-1)?.yielded ?? 0) > 10500, { timeout: 90000, interval: 100 });
      await dropChatSockets();
      const dropAt = Date.now();
      await waitEnded(page, tabId, before, 2500);
      extra = `refetches=${historyReads(reads, dropAt)}`;
    } else if (VARIANT === "replay") {
      // The default. Most of the answer is on screen when the chat socket drops (a tunnel blip);
      // the page reconnects while the turn still runs, and the server replays the turn so far.
      const before = await turnsEnded();
      await send(page, tabId, `long run ${run} deltas=${[400, 1200, 2400][run % 3]} pause=1800`);
      await until("the turn to pause before its closing paragraph", async () => !!(await serverTurns()).at(-1)?.paused, { timeout: 90000, interval: 20 });
      await sleep(200);
      const dropAt = Date.now();
      await dropChatSockets();
      await waitEnded(page, tabId, before, 2500);
      extra = `refetches=${historyReads(reads, dropAt)}`;
    } else if (VARIANT === "end-reconnect") {
      // The socket drops close to the turn's end (a tunnel blip): the page reconnects and the
      // server either replays the turn so far or, if it ended meanwhile, greets it as idle.
      const before = await turnsEnded();
      const deltas = 2000;
      const left = [0, 10, 100, 1000][run % 4];
      await send(page, tabId, `long run ${run} deltas=${deltas}`);
      // The turn yields `deltas` thinking deltas, ~200 text pieces and 4 tool events.
      await until("the drop point", async () => {
        const t = (await serverTurns()).at(-1);
        return left === 0 ? !!t?.ended : (t?.yielded ?? 0) >= deltas + 150 - left;
      }, { timeout: 90000, interval: 5 });
      const dropAt = Date.now();
      await dropChatSockets();
      await waitEnded(page, tabId, before, 3000);
      extra = `left=${left} refetches=${historyReads(reads, dropAt)}`;
    } else if (VARIANT === "away") {
      // The reader sends, switches to another tab while the answer is written, and comes back once
      // it is done: the turn ends while the chat is parked out of sight (TabPool's display: none).
      const before = await turnsEnded();
      await send(page, tabId, `long run ${run} deltas=${300 + (run % 4) * 150}`);
      await sleep([200, 600, 1200, 2000][run % 4]);
      await page.evaluate(async ({ project }) => {
        const { usePanelStore } = await import("/stores/panel-store.ts");
        window.__awayTab = usePanelStore.getState().openTab({ type: "chat", title: "Other", projectId: project, closable: true, metadata: { projectName: project } });
      }, { project: PROJECT });
      await until("the turn to end on the server", async () => (await turnsEnded()) > before, { timeout: 120000, interval: 100 });
      await sleep(1000);
      await page.evaluate(async (id) => {
        const { usePanelStore } = await import("/stores/panel-store.ts");
        usePanelStore.getState().setActiveTab(id);
      }, tabId);
      await sleep(1500);
      extra = `refetches=${historyReads(reads, runStart)}`;
    } else {
      await sendAndSettle(page, tabId, `${VARIANT} run ${run} deltas=${300 + (run % 4) * 150} after=${[0, 16, 50, 120][run % 4]}`);
      extra = `refetches=${historyReads(reads, runStart)}`;
    }
    const after = await distance(page, tabId);
    const trace = await stopSampling(page);
    // Frames while the turn streamed, past its first half-second: did the view follow the reply?
    const streamed = trace.frames.filter((f) => f.trailing);
    const followedWhileStreaming = streamed.slice(Math.min(30, streamed.length - 1)).every((f) => f.dist <= AT_BOTTOM_PX);
    // The answer that just ended must still be the last thing in the list.
    const lastText = await page.evaluate((root) => [...document.querySelectorAll(`${root} [data-msg-id]`)].at(-1)?.textContent ?? "", `[data-tab-pool-id="${tabId}"]`);
    const answerShown = /the view should stay at the bottom once the turn ends/.test(lastText);
    extra += answerShown ? "" : " ANSWER-MISSING";
    // Once drawn, the answer stays: a list that drops it, even for a moment, puts the reader's
    // own previous message at the bottom of the view — the "jump back" that was reported.
    const gone = answerGoneMs(trace.frames);
    // The answer is drawn as it is written, not once at the end: count the frames, while the turn
    // streamed, in which the drawn answer got longer.
    let growth = 0;
    for (let i = 1; i < trace.frames.length; i++) {
      const [a, b] = [trace.frames[i - 1], trace.frames[i]];
      if (b.trailing && a.answerLen > 0 && b.answerLen > a.answerLen) growth++;
    }
    extra += ` answerGoneMs=${gone.longest} drawnInSteps=${growth}`;
    // Enforced on turns streamed without a drop: after a drop the rest of a turn is short, and the
    // count says more about where the drop fell than about how the answer is drawn.
    const drawnOk = DROPS_SOCKET.has(VARIANT) || growth >= MIN_DRAW_STEPS;
    const ok = after && after.dist <= AT_BOTTOM_PX && answerShown && gone.longest <= ANSWER_GONE_TOLERANCE_MS && drawnOk;
    // The scroller's own height over the run: a bar above or below it coming and going shows here.
    const chs = trace.frames.map((f) => f.ch);
    extra += ` ch=${Math.min(...chs)}..${Math.max(...chs)} maxDist=${Math.max(...trace.frames.map((f) => Math.round(f.dist)))}`;
    results.push({ run, ok, after, followedWhileStreaming, answerGoneMs: gone.longest, drawnInSteps: growth });
    console.log(`  run ${run}: dist=${after?.dist} top=${after?.top} sh=${after?.sh} ch=${after?.ch} rowAtTop=${after?.rowAtTop} followedWhileStreaming=${followedWhileStreaming} ${extra}`);
    if (!ok || gone.longest > 0) {
      // The last frames before and after the turn ended, and every position write meanwhile.
      // Times are relative to the last frame the turn was still streaming in. Frames are kept
      // where something moved (offset, height or row count), with the frame before each.
      const endAt = streamed.length ? streamed[streamed.length - 1].t : 0;
      const rel = (x) => ({ ...x, t: Math.round(x.t - endAt) });
      const moved = trace.frames.filter((f, i, all) => i === 0 || f.top !== all[i - 1].top || f.sh !== all[i - 1].sh || f.ch !== all[i - 1].ch || f.rows !== all[i - 1].rows || f.trailing !== all[i - 1].trailing);
      const around = moved.slice(-400).map(rel);
      const writes = trace.writes.slice(-200).map(rel);
      const events = trace.events.slice(-300).map(rel);
      await writeFile(join(OUT, `run-${run}-trace.json`), JSON.stringify({ after, around, writes, events }, null, 2));
      await page.screenshot({ path: join(OUT, `run-${run}.png`) });
      console.log(`    trace written: run-${run}-trace.json (${around.length} frames, ${writes.length} writes, ${events.length} scroll events)`);
    }
    // Back to the bottom by hand only if this run left the view up, so every run starts alike.
    if (!ok) {
      await page.evaluate((root) => { const el = document.querySelector(`${root} .chat-scroll-fade`); el.scrollTop = el.scrollHeight; }, `[data-tab-pool-id="${tabId}"]`);
      await sleep(400);
    }
  }
  const jumped = results.filter((r) => !r.ok);
  await writeFile(join(OUT, "summary.json"), JSON.stringify(results, null, 2));
  check(jumped.length === 0, `the view stays on the answer, at the bottom, through every turn (${RUNS - jumped.length}/${RUNS})`,
    jumped.map((r) => `run ${r.run}: ${r.after?.dist}px from the bottom, answer gone ${r.answerGoneMs} ms, drawn in ${r.drawnInSteps} steps`).join("; "));
  await context.close();
} catch (error) {
  console.log(`FAIL harness — ${error?.stack ?? error}`);
  failures++;
} finally {
  await harness.browser?.close().catch(() => {});
  await harness.cleanup();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
