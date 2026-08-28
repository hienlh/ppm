// Image overlay — zoom, pan, rotate, flip and gallery navigation in a real browser.
//
// Drives the lightbox the way a user does: opens it from a chat image, then exercises the
// toolbar, the keyboard, and a Ctrl+wheel (what a trackpad pinch sends). Asserts on the
// inline `transform` the hook writes, since that is the actual output of every gesture.
//
// Run (backend + web must be up; defaults match `bun dev`):
//   bun tests/e2e/image-overlay-zoom-pan.mjs
//
// Env overrides:
//   PPM_E2E_WEB_PORT=5174   web port to drive
//   CHROME_PATH=...         Chrome executable
//   PPM_E2E_KEEP=1          leave Chrome open afterwards

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const REPO = process.cwd();
const WEB = `http://localhost:${process.env.PPM_E2E_WEB_PORT ?? "5174"}`;
const WEB_PROJECT = `${WEB}/project/ppm`;
const TOKEN_KEY = "ppm-auth-token";
const CDP_PORT = 9343;
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const KEEP = !!process.env.PPM_E2E_KEEP;
/**
 * Phone pass. Emulation has to be in place before the first navigation: the gesture library
 * reads the platform's touch support once at module load, so a page that started life
 * reporting zero touch points never takes the touch path however it is emulated afterwards.
 */
const MOBILE = !!process.env.PPM_E2E_MOBILE;
/** A point inside the viewer, off-centre so an anchored zoom has something to shift towards. */
const PX = MOBILE ? 250 : 700;
const PY = MOBILE ? 300 : 400;
const VISUALS = join(REPO, "plans", "visuals", "image-overlay");

const log = (...a) => console.log(...a);
const step = (s) => log(`\n${s}`);
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  /** Every call is bounded: a detached target answers nothing, and a bare promise would
   *  leave the run hanging forever instead of failing. */
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 20000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result.value;
  }
  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const path = join(VISUALS, `${name}.png`);
    await writeFile(path, Buffer.from(data, "base64"));
    log(`   screenshot -> ${path}`);
  }
  key(key) {
    return this.send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key.length === 1 ? key : undefined })
      .then(() => this.send("Input.dispatchKeyEvent", { type: "keyUp", key }));
  }
  /** Ctrl+wheel is exactly what a macOS trackpad pinch delivers to the page. */
  pinchWheel(x, y, deltaY) {
    return this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers: 2,
    });
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(`!!(${expression})`)) return true;
    } catch {}
    await Bun.sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The inline transform the hook writes — the ground truth for every gesture. */
const TRANSFORM = `(document.querySelector('.fixed.z-\\\\[100\\\\] img')?.style.transform ?? "")`;
const OVERLAY_IMG = `document.querySelector('.fixed.z-\\\\[100\\\\] img')`;

const clickLabel = (label) => `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find(x => x.getAttribute('aria-label').toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`;

const scaleOf = (transform) => {
  const m = transform.match(/scale\(([-\d.]+),\s*([-\d.]+)\)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};
const rotationOf = (transform) => Number(transform.match(/rotate\(([-\d.]+)deg\)/)?.[1] ?? NaN);
const translateOf = (transform) => {
  const m = transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

const main = async () => {
  await mkdir(VISUALS, { recursive: true });

  const { Database } = await import("bun:sqlite");
  const db = new Database(join(homedir(), ".ppm", "ppm.dev.db"), { readonly: true });
  const token = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
  db.close();

  step("1. Launch headless Chrome");
  const profile = join(tmpdir(), `ppm-overlay-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1440,980", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });

  let wsUrl;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) })).json();
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
    await Bun.sleep(300);
  }
  if (!wsUrl) throw new Error("Chrome CDP never became ready");

  const cdp = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(new Cdp(ws)));
    ws.addEventListener("error", reject);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  if (MOBILE) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }

  try {
    step("2. Authenticate and open the project");
    await cdp.send("Page.navigate", { url: WEB });
    await Bun.sleep(2500);
    await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)}), null`);
    await cdp.send("Page.navigate", { url: WEB_PROJECT });
    await Bun.sleep(9000);
    await waitFor(cdp, `document.querySelector('textarea[placeholder="Ask anything..."]')`, "chat composer", 45000);

    step("3. The transcript exposes a gallery");
    const galleryCount = await cdp.evaluate(
      `document.querySelectorAll('[data-image-gallery] img[data-gallery-item]').length`,
    );
    check("tagged images found in the chat", galleryCount > 0, `${galleryCount} image(s)`);
    if (!galleryCount) throw new Error("no gallery images in this session — cannot drive the overlay");

    step("4. Open the overlay from the first image");
    await cdp.evaluate(`(() => {
      const img = document.querySelector('[data-image-gallery] img[data-gallery-item]');
      img.scrollIntoView({ block: 'center' });
      (img.closest('button') ?? img).click();
      return true;
    })()`);
    await waitFor(cdp, OVERLAY_IMG, "overlay image");
    await Bun.sleep(600);
    const start = await cdp.evaluate(TRANSFORM);
    check("opens at fit", scaleOf(start)?.x === 1 && rotationOf(start) === 0, start);
    await cdp.shot("desktop-01-open");

    step("5. Toolbar zoom");
    check("zoom in clicked", await cdp.evaluate(clickLabel("zoom in")));
    await Bun.sleep(400);
    const zoomed = await cdp.evaluate(TRANSFORM);
    check("scale grew", (scaleOf(zoomed)?.x ?? 0) > 1, zoomed);
    check("readout follows the scale", await cdp.evaluate(
      `[...document.querySelectorAll('.fixed.z-\\\\[100\\\\] button')].some(b => /1[0-9]{2}%/.test(b.innerText))`,
    ));
    check("zoom out clicked", await cdp.evaluate(clickLabel("zoom out")));
    await Bun.sleep(400);

    // Wheel and mouse-drag are pointer-device gestures. Under touch emulation the browser
    // rewrites mouse input as touches, so running them there would test the emulator.
    if (!MOBILE) {
    step("6. Ctrl+wheel — what a trackpad pinch sends");
    await cdp.evaluate(clickLabel("fit to screen"));
    await Bun.sleep(300);
    await cdp.pinchWheel(PX, PY, -240);
    await Bun.sleep(500);
    const pinched = await cdp.evaluate(TRANSFORM);
    // exp(240/300) — asserting the exact step also catches the gesture being applied twice,
    // which a "did it grow?" check would happily pass.
    const expected = Math.exp(240 / 300);
    const got = scaleOf(pinched)?.x ?? 0;
    check("pinch zooms by exactly one step", Math.abs(got - expected) < 0.01,
      `got ${got.toFixed(3)}, expected ${expected.toFixed(3)}`);
    check("zoom is anchored to the pointer, not the centre",
      translateOf(pinched)?.x !== 0 || translateOf(pinched)?.y !== 0,
      `translate ${JSON.stringify(translateOf(pinched))}`);
    const wheelBadge = await cdp.evaluate(
      `[...document.querySelectorAll('.fixed.z-\\\\[100\\\\] button')].map(b => b.innerText).find(t => /%$/.test(t)) ?? ""`,
    );
    check("the readout follows a gesture, not just a button click",
      wheelBadge === `${Math.round(got * 100)}%`, `badge ${wheelBadge}, transform ${Math.round(got * 100)}%`);
    await cdp.shot("desktop-02-pinch-zoom");

    step("6b. A plain mouse wheel also zooms, once");
    await cdp.evaluate(clickLabel("fit to screen"));
    await Bun.sleep(300);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: PX, y: PY, deltaX: 0, deltaY: -100 });
    await Bun.sleep(500);
    const wheeled = scaleOf(await cdp.evaluate(TRANSFORM))?.x ?? 0;
    check("one notch is one step", Math.abs(wheeled - Math.exp(100 / 300)) < 0.01,
      `got ${wheeled.toFixed(3)}, expected ${Math.exp(100 / 300).toFixed(3)}`);

    step("6c. Drag pans a zoomed image");
    const beforeDrag = translateOf(await cdp.evaluate(TRANSFORM));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: PX, y: PY, button: "left", clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: PX - i * 20, y: PY - i * 10, button: "left", buttons: 1 });
      await Bun.sleep(30);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: PX - 120, y: PY - 60, button: "left", clickCount: 1 });
    await Bun.sleep(400);
    const afterDrag = translateOf(await cdp.evaluate(TRANSFORM));
    check("drag moved the image", afterDrag?.x !== beforeDrag?.x || afterDrag?.y !== beforeDrag?.y,
      `${JSON.stringify(beforeDrag)} -> ${JSON.stringify(afterDrag)}`);
    }

    step("7. Fit and actual size");
    await cdp.evaluate(clickLabel("fit to screen"));
    await Bun.sleep(400);
    const fitted = await cdp.evaluate(TRANSFORM);
    check("fit resets scale", scaleOf(fitted)?.x === 1, fitted);
    check("fit recentres", translateOf(fitted)?.x === 0 && translateOf(fitted)?.y === 0, fitted);
    await cdp.evaluate(clickLabel("actual size"));
    await Bun.sleep(400);
    const actual = await cdp.evaluate(TRANSFORM);
    check("actual size changes the scale", scaleOf(actual)?.x !== 1, actual);

    step("8. Rotate re-fits so the whole image stays visible");
    await cdp.evaluate(clickLabel("rotate right"));
    await Bun.sleep(500);
    const rotated = await cdp.evaluate(TRANSFORM);
    check("rotated 90 degrees", rotationOf(rotated) === 90, rotated);
    const fitsAfterRotate = await cdp.evaluate(`(() => {
      const img = ${OVERLAY_IMG};
      const box = img.parentElement.getBoundingClientRect();
      const r = img.getBoundingClientRect();
      return r.width <= box.width + 1 && r.height <= box.height + 1;
    })()`);
    check("rotated image still fits the viewport", fitsAfterRotate);
    await cdp.shot("desktop-03-rotated");

    step("9. Flip");
    await cdp.evaluate(clickLabel("flip horizontally"));
    await Bun.sleep(400);
    const flipped = await cdp.evaluate(TRANSFORM);
    check("horizontal flip negates scaleX", (scaleOf(flipped)?.x ?? 0) < 0, flipped);
    await cdp.evaluate(clickLabel("flip vertically"));
    await Bun.sleep(400);
    const flipped2 = await cdp.evaluate(TRANSFORM);
    check("vertical flip negates scaleY", (scaleOf(flipped2)?.y ?? 0) < 0, flipped2);

    // Start from a clean view: the image is still rotated and flipped from the steps above,
    // where "fit" is legitimately not scale 1 and the scale factors are negative.
    step("10. Keyboard");
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('.fixed.z-\\\\[100\\\\] button')].find(x => x.title === 'Reset view');
      b.click();
      return true;
    })()`);
    await Bun.sleep(400);
    await cdp.key("0");
    await Bun.sleep(400);
    check("0 fits", scaleOf(await cdp.evaluate(TRANSFORM))?.x === 1, await cdp.evaluate(TRANSFORM));
    await cdp.key("+");
    await Bun.sleep(400);
    const plus = await cdp.evaluate(TRANSFORM);
    check("+ zooms in", Math.abs(scaleOf(plus)?.x ?? 0) > 1, plus);
    await cdp.key("r");
    await Bun.sleep(400);
    check("r rotates", rotationOf(await cdp.evaluate(TRANSFORM)) !== 0);

    step("11. Gallery navigation");
    if (galleryCount > 1) {
      const first = await cdp.evaluate(`${OVERLAY_IMG}.src`);
      check("next clicked", await cdp.evaluate(clickLabel("next image")));
      await Bun.sleep(700);
      const second = await cdp.evaluate(`${OVERLAY_IMG}.src`);
      check("a different image is shown", first !== second);
      const afterNav = await cdp.evaluate(TRANSFORM);
      check("view resets for the new image",
        scaleOf(afterNav)?.x === 1 && rotationOf(afterNav) === 0, afterNav);
      const counter = await cdp.evaluate(
        `document.querySelector('.fixed.z-\\\\[100\\\\]').innerText.includes(${JSON.stringify(`2 / ${galleryCount}`)})`,
      );
      check("counter reads the new position", counter === true);
      await cdp.key("ArrowLeft");
      await Bun.sleep(700);
      check("arrow key goes back", await cdp.evaluate(`${OVERLAY_IMG}.src`) === first);
    } else {
      log("   (only one image in this session — navigation not exercised)");
    }

    if (!MOBILE) {
      step("12. Phone checks skipped — rerun with PPM_E2E_MOBILE=1");
      await cdp.key("Escape");
      await Bun.sleep(400);
      check("overlay dismissed", !(await cdp.evaluate(`!!${OVERLAY_IMG}`)));
      return;
    }

    step("12. Phone layout");
    await cdp.shot("mobile-01-toolbar");
    const touchOk = await cdp.evaluate(`(() => {
      const btns = [...document.querySelectorAll('.fixed.z-\\\\[100\\\\] button')];
      const small = btns.filter(b => { const r = b.getBoundingClientRect(); return r.height < 44 || r.width < 40; });
      return { total: btns.length, small: small.length, labels: small.map(b => b.getAttribute('aria-label') ?? b.innerText) };
    })()`);
    check("every control meets the touch target size", touchOk.small === 0,
      `${touchOk.total} buttons, ${touchOk.small} too small ${JSON.stringify(touchOk.labels)}`);
    const inViewport = await cdp.evaluate(`(() => {
      const bar = document.querySelector('.fixed.z-\\\\[100\\\\] .flex-wrap');
      if (!bar) return false;
      const r = bar.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight + 1;
    })()`);
    check("toolbar fits the phone width", inViewport);

    step("12b. Two-finger pinch on the touch screen");
    const beforeTouch = scaleOf(await cdp.evaluate(TRANSFORM))?.x ?? 0;
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], i) => ({ x, y, id: i })),
    });
    await touch("touchStart", [[150, 400], [240, 400]]);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [[150 - i * 12, 400], [240 + i * 12, 400]]);
      await Bun.sleep(40);
    }
    await touch("touchEnd", []);
    await Bun.sleep(600);
    const afterTouch = scaleOf(await cdp.evaluate(TRANSFORM))?.x ?? 0;
    check("spreading two fingers zooms in", afterTouch > beforeTouch,
      `${beforeTouch.toFixed(3)} -> ${afterTouch.toFixed(3)}`);
    const badge = await cdp.evaluate(
      `[...document.querySelectorAll('.fixed.z-\\\\[100\\\\] button')].map(b => b.innerText).find(t => /%$/.test(t)) ?? ""`,
    );
    check("the readout agrees with the transform", badge === `${Math.round(afterTouch * 100)}%`,
      `badge ${badge}, transform ${Math.round(afterTouch * 100)}%`);
    await cdp.shot("mobile-02-pinched");

    step("12c. One finger pans the zoomed image");
    const beforePan = translateOf(await cdp.evaluate(TRANSFORM));
    await touch("touchStart", [[200, 500]]);
    for (let i = 1; i <= 6; i++) {
      await touch("touchMove", [[200 - i * 15, 500 - i * 15]]);
      await Bun.sleep(40);
    }
    await touch("touchEnd", []);
    await Bun.sleep(500);
    const afterPan = translateOf(await cdp.evaluate(TRANSFORM));
    check("one-finger drag moves the image",
      afterPan?.x !== beforePan?.x || afterPan?.y !== beforePan?.y,
      `${JSON.stringify(beforePan)} -> ${JSON.stringify(afterPan)}`);

    step("13. Escape closes");
    await cdp.key("Escape");
    await Bun.sleep(500);
    check("overlay dismissed", !(await cdp.evaluate(`!!${OVERLAY_IMG}`)));
  } finally {
    if (!KEEP) chrome.kill();
  }
};

await main().catch((e) => {
  console.error(`\nFATAL: ${e.message}`);
  results.push({ name: "harness completed", pass: false });
});

const failed = results.filter((r) => !r.pass);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) log(`   FAILED: ${f.name}`);
process.exit(failed.length ? 1 : 0);
