// Visual + behavioural check for the login screen's theme mode support.
//
// Captures the unauthenticated login screen with a stored light theme, a stored
// dark theme, and no stored preference at all (OS-driven), and asserts the
// decorative dot grid actually inverts with the mode instead of staying white.
//
// Run (backend + vite up; ports overridable):
//   bun tests/e2e/login-theme-mode-visual.mjs
//
// Env:
//   PPM_E2E_WEB=http://localhost:5174   vite origin
//   CHROME_PATH=...                     Chrome executable

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const REPO = process.cwd();
const WEB = process.env.PPM_E2E_WEB ?? "http://localhost:5174";
const TOKEN_KEY = "ppm-auth-token";
const SETTINGS_KEY = "ppm-settings";
const CDP_PORT = 9377;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = join(REPO, "plans", "260902-1227-login-light-mode", "visuals");

const log = (...a) => console.log(...a);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method) {
        this.handlers.get(m.method)?.(m.params);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`${r.exceptionDetails.text} :: ${expression.slice(0, 140)}`);
    }
    return r.result.value;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(`!!(${expression})`)) return true;
    } catch {}
    await Bun.sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Pull the dot colour out of the grid's background-image and return its mean
 * channel value on a 0..1 scale.
 *
 * Chrome serialises a `color-mix()` result as `color(srgb r g b / a)` with 0..1
 * channels, while the gradient's own transparent stop serialises as
 * `rgba(0, 0, 0, 0)`. Matching plain `rgba(` therefore reads the wrong stop and
 * reports black whatever the theme, so the `color(srgb ...)` form is tried first
 * and fully-transparent stops are skipped.
 */
function dotLuminance(layer) {
  const srgb = layer.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/);
  if (srgb) {
    return (parseFloat(srgb[1]) + parseFloat(srgb[2]) + parseFloat(srgb[3])) / 3;
  }
  for (const m of layer.matchAll(/rgba?\(([^)]+)\)/g)) {
    const n = m[1].split(",").map((v) => parseFloat(v));
    if (n.length === 4 && n[3] === 0) continue; // transparent gradient stop
    return (n[0] + n[1] + n[2]) / 3 / 255;
  }
  return null;
}

/**
 * Centre-click an element for real. Radix opens menus on pointerdown, which a
 * synthetic HTMLElement.click() never produces.
 */
async function clickAt(cdp, x, y) {
  const base = { x, y, button: "left", clickCount: 1, buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await Bun.sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
}

async function centreOf(cdp, expression, label) {
  const box = await cdp.evaluate(`(() => {
    const el = ${expression};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  })()`);
  if (!box) throw new Error(`no element for ${label}`);
  return box;
}

const LOGIN_READY =
  `[...document.querySelectorAll("h1")].some(h => /unlock your workspace/i.test(h.textContent||""))`;

/** Read back what the browser actually computed, not what we hoped it would. */
const PROBE = `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const dots = [...document.querySelectorAll("div.pointer-events-none.absolute.inset-0")]
    .map(d => getComputedStyle(d).backgroundImage)
    .filter(s => s.includes("radial-gradient"));
  const btn = document.querySelector('button[aria-label^="Appearance"]');
  const h1 = [...document.querySelectorAll("h1")].find(h => /unlock/i.test(h.textContent||""));
  let size = null;
  if (btn) { const r = btn.getBoundingClientRect(); size = [Math.round(r.width), Math.round(r.height)]; }
  return {
    htmlClass: root.className,
    bgSolid: cs.getPropertyValue("--bg-solid").trim(),
    text: cs.getPropertyValue("--text").trim(),
    h1Color: h1 ? getComputedStyle(h1).color : null,
    dotLayers: dots,
    appearanceLabel: btn ? btn.getAttribute("aria-label") : null,
    appearanceSize: size,
  };
})()`;

const main = async () => {
  await mkdir(OUT, { recursive: true });

  const profile = join(tmpdir(), `ppm-login-visual-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1280,900",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--force-device-scale-factor=2",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let wsUrl;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json`, {
        signal: AbortSignal.timeout(1500),
      });
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
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

  const failures = [];
  const expect = (cond, msg) => {
    if (!cond) {
      failures.push(msg);
      log(`  FAIL ${msg}`);
    } else {
      log(`  ok   ${msg}`);
    }
  };

  // stored: what goes into localStorage. osDark: what the OS reports.
  const CASES = [
    { name: "stored-light", stored: "light", osDark: true, expectClass: "light" },
    { name: "stored-dark", stored: "dark", osDark: false, expectClass: "dark" },
    { name: "fresh-os-light", stored: null, osDark: false, expectClass: "light" },
    { name: "fresh-os-dark", stored: null, osDark: true, expectClass: "dark" },
  ];

  try {
    for (const c of CASES) {
      log(`\n=== ${c.name} (stored=${c.stored ?? "none"}, os=${c.osDark ? "dark" : "light"}) ===`);
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: c.osDark ? "dark" : "light" }],
      });

      // Land on the origin so localStorage is writable, then seed and reload.
      await cdp.send("Page.navigate", { url: WEB });
      await Bun.sleep(1200);
      const seed = c.stored
        ? `localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, JSON.stringify({ themeStyle: "aurora", themeMode: ${JSON.stringify(c.stored)} }));`
        : "";
      await cdp.evaluate(`(() => {
        localStorage.removeItem(${JSON.stringify(TOKEN_KEY)});
        localStorage.removeItem(${JSON.stringify(SETTINGS_KEY)});
        ${seed}
        return true;
      })()`);
      await cdp.send("Page.navigate", { url: WEB });
      await waitFor(cdp, LOGIN_READY, "login screen");
      await Bun.sleep(900);

      const p = await cdp.evaluate(PROBE);
      log(`  html="${p.htmlClass}" --bg-solid=${p.bgSolid} --text=${p.text}`);
      log(`  dots: ${p.dotLayers.join(" | ") || "(none)"}`);

      expect(p.htmlClass.includes(c.expectClass), `<html> carries "${c.expectClass}"`);
      const opposite = c.expectClass === "light" ? "dark" : "light";
      expect(!p.htmlClass.includes(opposite), "<html> does not also carry the opposite class");

      // The dot grid must not be a fixed white: in light mode its colour has to
      // be dark, or the texture is invisible against a pale backdrop.
      const dotLayer = p.dotLayers.find((s) => s.includes("1px"));
      expect(!!dotLayer, "dot-grid layer present");
      if (dotLayer) {
        const lum = dotLuminance(dotLayer);
        expect(lum !== null, "dot colour is parseable");
        if (lum !== null) {
          log(`  dot luminance=${lum.toFixed(3)} (0=black, 1=white)`);
          expect(
            c.expectClass === "light" ? lum < 0.5 : lum > 0.5,
            "dot colour follows the mode (light => dark dots, dark => light dots)",
          );
        }
      }

      expect(p.appearanceLabel !== null, "appearance menu is present pre-auth");
      if (p.appearanceSize) {
        expect(
          p.appearanceSize[0] >= 44 && p.appearanceSize[1] >= 44,
          `appearance trigger is >=44px touch target (got ${p.appearanceSize.join("x")})`,
        );
      }

      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(join(OUT, `login-${c.name}.png`), Buffer.from(shot.data, "base64"));
    }

    // The menu itself must offer all three modes and switch live.
    log(`\n=== appearance menu interaction ===`);
    const trigger = await centreOf(
      cdp,
      `document.querySelector('button[aria-label^="Appearance"]')`,
      "appearance trigger",
    );
    await clickAt(cdp, trigger[0], trigger[1]);
    await Bun.sleep(700);
    const items = await cdp.evaluate(
      `[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].map(e => e.textContent.trim())`,
    );
    log(`  items: ${JSON.stringify(items)}`);
    expect(
      ["Light", "Dark", "System"].every((l) => items.includes(l)),
      "menu offers Light/Dark/System",
    );

    const shotMenu = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(OUT, "login-appearance-menu.png"), Buffer.from(shotMenu.data, "base64"));

    // Pick Light from the menu while the OS says dark — proves the pick wins.
    const before = await cdp.evaluate("document.documentElement.className");
    const lightItem = await centreOf(
      cdp,
      `[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].find(e => e.textContent.trim() === "Light")`,
      "Light menu item",
    );
    await clickAt(cdp, lightItem[0], lightItem[1]);
    await Bun.sleep(900);
    const after = await cdp.evaluate("document.documentElement.className");
    log(`  html: "${before}" -> "${after}"`);
    expect(after.includes("light"), "picking Light repaints immediately");
    const persisted = await cdp.evaluate(
      `JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}) || "{}").themeMode`,
    );
    expect(persisted === "light", `pick persisted to localStorage (got ${persisted})`);

    const shotAfter = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(OUT, "login-after-pick-light.png"), Buffer.from(shotAfter.data, "base64"));

    // Mobile pass: the trigger is absolutely positioned, so it has to stay on
    // screen and clear of the card at a phone width.
    log(`\n=== mobile 390x844 (light) ===`);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    // Clear the pick made above so this really exercises a fresh client.
    await cdp.evaluate(`(() => {
      localStorage.removeItem(${JSON.stringify(TOKEN_KEY)});
      localStorage.removeItem(${JSON.stringify(SETTINGS_KEY)});
      return true;
    })()`);
    await cdp.send("Page.navigate", { url: WEB });
    await waitFor(cdp, LOGIN_READY, "login screen (mobile)");
    await Bun.sleep(900);

    const m = await cdp.evaluate(`(() => {
      const btn = document.querySelector('button[aria-label^="Appearance"]');
      const card = [...document.querySelectorAll("form")][0];
      if (!btn) return null;
      const b = btn.getBoundingClientRect();
      const c = card ? card.getBoundingClientRect() : null;
      return {
        btn: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
        inViewport: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
        overlapsForm: c ? !(b.bottom < c.top || b.top > c.bottom || b.right < c.left || b.left > c.right) : false,
        htmlClass: document.documentElement.className,
      };
    })()`);
    log(`  ${JSON.stringify(m)}`);
    expect(m !== null, "appearance trigger renders on mobile");
    if (m) {
      expect(m.inViewport, "trigger sits fully inside the mobile viewport");
      expect(!m.overlapsForm, "trigger does not overlap the login form");
      expect(m.btn[2] >= 44 && m.btn[3] >= 44, `trigger keeps its 44px target (got ${m.btn[2]}x${m.btn[3]})`);
      expect(m.htmlClass.includes("light"), "mobile fresh client follows a light OS");
    }
    const shotMobile = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(OUT, "login-mobile-light.png"), Buffer.from(shotMobile.data, "base64"));

    log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`);
    for (const f of failures) log(` - ${f}`);
    log(`screenshots -> ${OUT}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    try {
      chrome.kill();
    } catch {}
  }
};

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
