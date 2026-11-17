/**
 * Double-clicking a floating window's edge or corner stretches it to the window layer's edge
 * (macOS behaviour), checked in a real browser against disposable API/Vite instances from the
 * HTML preview harness — never the running PPM.
 *
 * For each case the window is put back to the same starting rect, its edge strip
 * (`[data-resize-handle]`) is double-clicked with the real mouse, and the window's on-screen
 * rect is measured against the layer's (`[data-window-layer]`) before and after: bottom, right,
 * left, top, a corner, and Alt + an edge on each axis. Then a resize drag still resizes, and a
 * reload brings the stretched rect back.
 *
 *   docker run --rm --name ppm-task-window-edge --cpus=4 --memory=3g --ulimit core=0 \
 *     -v <repo>:/app:ro -v ppm-e2e-nm:/app/node_modules -v <out>:/out -w /app ppm-e2e-chromium:latest \
 *     sh -c 'bun install --frozen-lockfile && EDGE_OUT=/out node tests/e2e/window-edge-double-click-e2e.mjs'
 *
 * EDGE_OUT gets before/after screenshots and, with EDGE_VIDEO=1, a 1440x900 WebM walkthrough
 * (a drawn cursor and a caption per step, since a headless recording shows neither).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";

const OUT = process.env.EDGE_OUT || "/out";
const VIDEO = process.env.EDGE_VIDEO === "1";
const VIEW = { width: 1440, height: 900 };
const START = { x: 360, y: 180, w: 620, h: 400 };
const PAUSE = VIDEO ? 900 : 350; // the window animates over 150 ms; the video wants time to read
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const results = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  results.push({ ok, label, detail });
  if (!ok) failures++;
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const harness = await createHtmlPreviewHarness();
await mkdir(OUT, { recursive: true });
let context;
try {
  context = await harness.browser.newContext({
    viewport: VIEW,
    ...(VIDEO ? { recordVideo: { dir: join(OUT, "raw"), size: VIEW } } : {}),
  });
  await context.addInitScript(({ api }) => {
    // The guided tour's card sits fixed over the bottom-right corner, where the se strip is.
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null,
      currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
    // The dev bundle opens its sockets on 8081, which may be another PPM on this machine.
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(input, protocols) {
        const url = new URL(String(input), location.href);
        if (url.hostname === "127.0.0.1" && url.port === "8081") url.port = new URL(api).port;
        super(url.href, protocols);
      }
    };
  }, { api: harness.api });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(harness.web, { waitUntil: "load", timeout: 180000 });
  await page.waitForSelector("[data-window-layer]", { timeout: 120000 });
  await sleep(2500);

  // ---------------------------------------------------------------- page helpers
  /** A drawn cursor and a caption: a headless recording shows neither the pointer nor intent. */
  const overlay = () => page.evaluate(() => {
    if (document.getElementById("e2e-cursor")) return;
    const cursor = Object.assign(document.createElement("div"), { id: "e2e-cursor" });
    Object.assign(cursor.style, { position: "fixed", left: "0", top: "0", width: "14px", height: "14px", margin: "-7px 0 0 -7px",
      borderRadius: "50%", background: "rgba(255,80,60,.9)", border: "2px solid #fff", boxShadow: "0 0 0 1px #000",
      pointerEvents: "none", zIndex: "2147483647", transition: "transform 120ms" });
    const caption = Object.assign(document.createElement("div"), { id: "e2e-caption" });
    Object.assign(caption.style, { position: "fixed", right: "24px", bottom: "44px", padding: "10px 16px", borderRadius: "8px",
      background: "rgba(10,10,10,.82)", color: "#fff", font: "600 20px system-ui, sans-serif", pointerEvents: "none", zIndex: "2147483646" });
    document.body.append(cursor, caption);
    addEventListener("mousemove", (e) => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; }, true);
    addEventListener("dblclick", () => { cursor.style.transform = "scale(2.2)"; setTimeout(() => { cursor.style.transform = ""; }, 260); }, true);
  });
  const caption = (text) => page.evaluate((t) => { const el = document.getElementById("e2e-caption"); if (el) el.textContent = t; }, text);

  const openWindow = () => page.evaluate(async (rect) => {
    const { useWindowStore } = await import("/components/floating-window/window-store.ts");
    const s = useWindowStore.getState();
    const existing = Object.values(s.windows).find((w) => w.kind === "settings");
    if (existing) return existing.id;
    return s.open("settings", undefined, rect);
  }, START);
  const setRect = (id, rect) => page.evaluate(async ({ id, rect }) => {
    const { useWindowStore } = await import("/components/floating-window/window-store.ts");
    useWindowStore.getState().resize(id, rect);
  }, { id, rect });
  /** The window's rect on screen and in the store, both relative to the layer, plus the layer. */
  const measure = (id) => page.evaluate(async (id) => {
    const { useWindowStore } = await import("/components/floating-window/window-store.ts");
    const layer = document.querySelector("[data-window-layer]").getBoundingClientRect();
    const el = document.querySelector('[aria-roledescription="window"]').getBoundingClientRect();
    const st = useWindowStore.getState();
    const saved = JSON.parse(localStorage.getItem("ppm-windows") || "[]");
    const savedWin = (Array.isArray(saved) ? saved : saved.windows ?? []).find?.((w) => w.id === id);
    return {
      layer: { x: layer.x, y: layer.y, w: layer.width, h: layer.height, bottom: layer.bottom, right: layer.right },
      dom: { x: Math.round(el.x - layer.x), y: Math.round(el.y - layer.y), w: Math.round(el.width), h: Math.round(el.height) },
      store: st.windows[id]?.rect,
      bounds: st.bounds,
      saved: savedWin?.rect ?? null,
      viewport: { w: innerWidth, h: innerHeight },
    };
  }, id);
  const handleCenter = (handle) => page.evaluate((h) => {
    const r = document.querySelector(`[data-resize-handle="${h}"]`).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, handle);

  await overlay();
  const id = await openWindow();
  await page.waitForSelector('[aria-roledescription="window"] [data-resize-handle="se"]', { timeout: 60000 });
  await sleep(800);

  const first = await measure(id);
  const B = first.bounds;
  console.log(`layer ${JSON.stringify(first.layer)} bounds ${JSON.stringify(B)} viewport ${JSON.stringify(first.viewport)}`);
  check(first.layer.x > 0, "the layer starts right of the nav rail", `left=${first.layer.x}`);
  check(first.layer.bottom < first.viewport.h, "the layer stops above the status bar", `bottom=${first.layer.bottom} of ${first.viewport.h}`);
  check(near(first.layer.w, B.w) && near(first.layer.h, B.h), "store bounds match the layer box", `${B.w}x${B.h}`);

  // Every strip must be what the pointer hits at its centre, i.e. on the window's border,
  // half of it over the content. Settings stacks its panes at z-10; before the body was
  // isolated that covered the inner half of the strips and the left one was dead there.
  const covered = await page.evaluate(() => [...document.querySelectorAll("[data-resize-handle]")].flatMap((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === el ? [] : [`${el.dataset.resizeHandle}→${hit?.tagName}.${String(hit?.className).slice(0, 40)}`];
  }));
  check(covered.length === 0, "the pointer reaches every edge and corner strip at its centre", covered.join(", "));

  const right = (r) => r.x + r.w, bottom = (r) => r.y + r.h;
  const S = START;
  const cases = [
    { handle: "s", label: "Nháy đúp cạnh dưới", expect: { x: S.x, y: S.y, w: S.w, h: B.h - S.y } },
    { handle: "e", label: "Nháy đúp cạnh phải", expect: { x: S.x, y: S.y, w: B.w - S.x, h: S.h } },
    { handle: "w", label: "Nháy đúp cạnh trái", expect: { x: 0, y: S.y, w: right(S), h: S.h } },
    { handle: "n", label: "Nháy đúp cạnh trên", expect: { x: S.x, y: 0, w: S.w, h: bottom(S) } },
    { handle: "se", label: "Nháy đúp góc dưới-phải", expect: { x: S.x, y: S.y, w: B.w - S.x, h: B.h - S.y } },
    { handle: "nw", label: "Nháy đúp góc trên-trái", expect: { x: 0, y: 0, w: right(S), h: bottom(S) } },
    { handle: "e", alt: true, label: "Alt + nháy đúp cạnh phải", expect: { x: 0, y: S.y, w: B.w, h: S.h } },
    { handle: "s", alt: true, label: "Alt + nháy đúp cạnh dưới", expect: { x: S.x, y: 0, w: S.w, h: B.h } },
  ];

  let step = 0;
  for (const c of cases) {
    step++;
    await caption("Kích thước ban đầu");
    await setRect(id, START);
    await sleep(PAUSE);
    const before = await measure(id);
    check(JSON.stringify(before.dom) === JSON.stringify(START), `${c.handle}${c.alt ? "+alt" : ""}: starts at the same rect`, JSON.stringify(before.dom));
    const at = await handleCenter(c.handle);
    await page.mouse.move(at.x - 60, at.y - 40, { steps: 4 });
    await page.mouse.move(at.x, at.y, { steps: VIDEO ? 14 : 2 });
    await caption(c.label);
    await page.screenshot({ path: join(OUT, `${String(step).padStart(2, "0")}-${c.handle}${c.alt ? "-alt" : ""}-before.png`) });
    if (c.alt) await page.keyboard.down("Alt");
    await page.mouse.dblclick(at.x, at.y);
    if (c.alt) await page.keyboard.up("Alt");
    await sleep(PAUSE);
    const after = await measure(id);
    await page.screenshot({ path: join(OUT, `${String(step).padStart(2, "0")}-${c.handle}${c.alt ? "-alt" : ""}-after.png`) });
    const ok = ["x", "y", "w", "h"].every((k) => near(after.dom[k], c.expect[k]));
    check(ok, `${c.label} (${c.handle}${c.alt ? "+alt" : ""})`, `before ${JSON.stringify(before.dom)} after ${JSON.stringify(after.dom)} expected ${JSON.stringify(c.expect)}`);
    check(JSON.stringify(after.store) === JSON.stringify(after.dom), `${c.handle}${c.alt ? "+alt" : ""}: store holds the drawn rect`, JSON.stringify(after.store));
    check(JSON.stringify(after.saved) === JSON.stringify(after.dom), `${c.handle}${c.alt ? "+alt" : ""}: saved for restore`, JSON.stringify(after.saved));
    check(after.dom.x >= 0 && after.dom.y >= 0 && right(after.dom) <= B.w && bottom(after.dom) <= B.h,
      `${c.handle}${c.alt ? "+alt" : ""}: stays inside the layer`);
  }

  // A resize drag still resizes the window by the distance dragged.
  await caption("Kéo góc để đổi kích thước vẫn như cũ");
  await setRect(id, START);
  await sleep(PAUSE);
  const se = await handleCenter("se");
  await page.mouse.move(se.x, se.y, { steps: 4 });
  await page.mouse.down();
  await page.mouse.move(se.x + 120, se.y + 90, { steps: VIDEO ? 20 : 6 });
  await page.mouse.up();
  await sleep(PAUSE);
  const dragged = await measure(id);
  check(near(dragged.dom.w, START.w + 120, 2) && near(dragged.dom.h, START.h + 90, 2) && dragged.dom.x === START.x && dragged.dom.y === START.y,
    "a resize drag still resizes by the distance dragged", JSON.stringify(dragged.dom));

  // A stretched rect survives a reload.
  await caption("Giãn cạnh phải rồi tải lại trang");
  const e = await handleCenter("e");
  await page.mouse.move(e.x, e.y, { steps: VIDEO ? 10 : 2 });
  await page.mouse.dblclick(e.x, e.y);
  await sleep(PAUSE);
  const beforeReload = await measure(id);
  check(near(right(beforeReload.dom), B.w), "right edge stretched before the reload", JSON.stringify(beforeReload.dom));
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector('[aria-roledescription="window"] [data-resize-handle="se"]', { timeout: 120000 });
  await sleep(1500);
  await overlay();
  await caption("Sau khi tải lại: kích thước vẫn giữ");
  const afterReload = await measure(id);
  check(JSON.stringify(afterReload.dom) === JSON.stringify(beforeReload.dom), "the stretched rect comes back after a reload",
    `before ${JSON.stringify(beforeReload.dom)} after ${JSON.stringify(afterReload.dom)}`);
  await page.screenshot({ path: join(OUT, "99-after-reload.png") });
  await sleep(VIDEO ? 1500 : 100);

  const video = page.video();
  await context.close();
  context = null;
  if (video) {
    await video.saveAs(join(OUT, "window-edge-double-click.webm"));
    console.log(`video ${join(OUT, "window-edge-double-click.webm")}`);
  }
} catch (error) {
  console.log(`FAIL harness — ${error?.stack || error}`);
  failures++;
} finally {
  if (context) await context.close().catch(() => {});
  await writeFile(join(OUT, "results.json"), JSON.stringify({ failures, results }, null, 2)).catch(() => {});
  await harness.browser.close().catch(() => {});
  await harness.cleanup();
}
console.log(`\n${results.filter((r) => r.ok).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
