// E2E proof for the upload-collision-race fix + the upload progress panel. Style follows
// tests/e2e/os-explorer-window.mjs (hand-rolled CDP client over system Chrome, no puppeteer).
//
// Run against an already-running isolated stack:
//   PPM_E2E_API_PORT=8084 PPM_E2E_WEB_PORT=5184 bun tests/e2e/os-explorer-upload-collisions.mjs
// Both default to 8084/5184 if unset. Reads the dev auth token from ppm.dev.db (read-only,
// never printed). Screenshots and fixtures paths are also overridable via env for reruns.
//
// Exits non-zero if any scenario fails.

import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const API_PORT = process.env.PPM_E2E_API_PORT || "8084";
const WEB_PORT = process.env.PPM_E2E_WEB_PORT || "5184";
const ORIGIN = `http://localhost:${WEB_PORT}`;
const CDP_PORT = Number(process.env.PPM_E2E_CDP_PORT || 9346);
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const FIXTURE_DIR = process.env.PPM_E2E_FIXTURES || join(tmpdir(), "ppm-upload-e2e");
const VISUALS_DIR = process.env.PPM_E2E_VISUALS || "C:\\Users\\PC\\ppm\\plans\\260903-0009-os-file-explorer-window\\visuals";
const PROFILE_DIR = join(tmpdir(), `ppm-e2e-upload-${Date.now()}`);

const db = new Database(join(homedir(), ".ppm", "ppm.dev.db"), { readonly: true });
const TOKEN = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
db.close();

const results = []; // { name, pass, detail }
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
async function scenario(name, fn) {
  try {
    await fn();
    if (!results.some((r) => r.name === name)) record(name, true);
  } catch (e) {
    record(name, false, e?.message || String(e));
  }
}

// ── CDP client: request/response + event subscription (same shape as os-explorer-window.mjs) ──
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      } else if (m.method) {
        const set = this.listeners.get(m.method);
        if (set) for (const fn of set) fn(m.params);
      }
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, timeoutMs);
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }
  async evalJs(expression, timeoutMs = 30000) {
    const wrapped = `(async () => { return (${expression}); })()`;
    const r = await this.send("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(desc + " :: " + expression.slice(0, 300));
    }
    return r.result.value;
  }
}

async function openTab() {
  const t = await (await fetch(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = await new Promise((res, rej) => {
    const sock = new WebSocket(t.webSocketDebuggerUrl);
    sock.addEventListener("open", () => res(sock));
    sock.addEventListener("error", rej);
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  cdp.on("Page.javascriptDialogOpening", () => {
    cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });
  return { cdp, targetId: t.id };
}
async function closeTab(targetId) {
  try {
    await fetch(`http://localhost:${CDP_PORT}/json/close/${targetId}`);
  } catch {}
}

async function reloadPage(cdp) {
  await cdp.send("Page.reload");
  await Bun.sleep(1500);
  await cdp.send("Runtime.enable").catch(() => {});
  await Bun.sleep(1200);
  for (let i = 0; i < 8; i++) {
    try {
      await cdp.evalJs("1+1", 3000);
      await Bun.sleep(800);
      return;
    } catch {
      await cdp.send("Runtime.enable").catch(() => {});
      await Bun.sleep(1000);
    }
  }
  throw new Error("Runtime.evaluate never recovered after Page.reload");
}

async function navigateAndAuth(cdp, path = "/") {
  await cdp.send("Page.navigate", { url: ORIGIN + path });
  await Bun.sleep(1800);
  await cdp.evalJs(`localStorage.setItem("ppm-auth-token", ${JSON.stringify(TOKEN)})`);
  await reloadPage(cdp);
}

async function screenshot(cdp, name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(VISUALS_DIR, name), Buffer.from(r.data, "base64"));
}

async function openExplorerAt(cdp, path) {
  await cdp.evalJs(
    `(await import('/components/floating-window/window-store.ts')).useWindowStore.getState().open("explorer", { path: ${JSON.stringify(path)} })`,
  );
  await Bun.sleep(1500);
}

function fx(...parts) {
  return join(FIXTURE_DIR, ...parts);
}

async function setupFixtures() {
  await rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(FIXTURE_DIR, { recursive: true });
  await Bun.write(fx("existing-alpha.bin"), new Uint8Array(64 * 1024).fill(1));
  await Bun.write(fx("existing-beta.bin"), new Uint8Array(64 * 1024).fill(2));
}

/** Dispatches a synthetic OS `Files` drop of `files` (each `{name, size}`) onto the explorer
 *  list background. Mirrors a real native-Explorer-window-onto-PPM drag. */
async function dropFiles(cdp, files) {
  return cdp.evalJs(`(() => {
    const el = document.querySelector('[data-testid="explorer-list"]');
    if (!el) return false;
    const dt = new DataTransfer();
    for (const f of ${JSON.stringify(files)}) dt.items.add(new File([new Uint8Array(f.size)], f.name));
    for (const type of ["dragenter","dragover","drop"]) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return true;
  })()`);
}

async function uploadNetworkEvents(cdp) {
  return cdp.evalJs(`JSON.stringify(window.__ppmE2eUploadEvents || [])`).then(JSON.parse);
}

/** Installs a lightweight XHR wrapper that records every /api/fs/upload attempt's final
 *  status, since CDP's Network domain does not reliably surface XHR responses for same-origin
 *  requests fired from a data: / about:blank-derived execution context in headless mode. */
async function installUploadObserver(cdp) {
  await cdp.evalJs(`(() => {
    window.__ppmE2eUploadEvents = [];
    const OrigXhr = window.XMLHttpRequest;
    const orig = OrigXhr.prototype.open;
    OrigXhr.prototype.open = function (method, url, ...rest) {
      if (typeof url === "string" && url.includes("/api/fs/upload")) {
        this.addEventListener("loadend", () => {
          window.__ppmE2eUploadEvents.push({ method, url, status: this.status });
        });
      }
      return orig.call(this, method, url, ...rest);
    };
    return true;
  })()`);
}

/** This is a full real PPM dev session (real chat history, real project tree) — plain
 *  `document.body.textContent.includes(...)` checks are unsafe, some unrelated panel can
 *  legitimately contain the same words. Every check below is scoped to an actual
 *  `[role="dialog"]` element instead. */
async function dialogText(cdp) {
  return cdp.evalJs(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const last = dialogs[dialogs.length - 1];
    return last ? last.textContent : null;
  })()`);
}
async function dialogCount(cdp) {
  return cdp.evalJs(`document.querySelectorAll('[role="dialog"]').length`);
}

async function waitForCondition(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

let chromeProc = null;

async function main() {
  await setupFixtures();
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(VISUALS_DIR, { recursive: true });

  const chrome = (chromeProc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--window-size=1440,900",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  ));

  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        await (await fetch(`http://localhost:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) })).json();
        break;
      } catch {}
      await Bun.sleep(300);
    }

    const { cdp, targetId } = await openTab();
    await navigateAndAuth(cdp);
    await installUploadObserver(cdp);
    await openExplorerAt(cdp, FIXTURE_DIR);

    await scenario("fresh drop: 2 brand-new files → 2×201, no collision dialog", async () => {
      await dropFiles(cdp, [{ name: "fresh-one.bin", size: 32 * 1024 }, { name: "fresh-two.bin", size: 32 * 1024 }]);
      const done = await waitForCondition(async () => {
        const events = await uploadNetworkEvents(cdp);
        return events.filter((e) => e.status === 201).length >= 2;
      }, 8000);
      if (!done) throw new Error("did not observe 2×201 in time");
      if ((await dialogCount(cdp)) !== 0) throw new Error("collision dialog appeared for brand-new files");
      if (!existsSync(fx("fresh-one.bin")) || !existsSync(fx("fresh-two.bin"))) {
        throw new Error("uploaded files missing on disk");
      }
    });
    await screenshot(cdp, "upload-dialog-desktop-panel.png");

    await scenario("collision drop: one dialog at a time, Apply to all + Replace resolves both", async () => {
      await cdp.evalJs(`window.__ppmE2eUploadEvents = []`);
      // Both names already exist on disk (see setupFixtures) — every job collides.
      await dropFiles(cdp, [
        { name: "existing-alpha.bin", size: 48 * 1024 },
        { name: "existing-beta.bin", size: 48 * 1024 },
      ]);
      const dialogUp = await waitForCondition(
        async () => (await dialogText(cdp))?.includes("already exists") ?? false,
        5000,
      );
      if (!dialogUp) throw new Error("collision dialog never appeared");

      // Exactly one dialog on screen — the bug this fixes let a second concurrent request
      // silently replace the first one's slot instead of queuing behind it.
      const count = await dialogCount(cdp);
      if (count !== 1) throw new Error(`expected exactly 1 dialog, saw ${count}`);

      // "…and 1 more" — the queued second collision is visible in the copy.
      const mentionsRemaining = (await dialogText(cdp))?.includes("1 more") ?? false;
      if (!mentionsRemaining) throw new Error("dialog text does not mention the queued second collision");

      const checked = await cdp.evalJs(`(() => {
        const box = document.querySelector('input[type="checkbox"]');
        if (!box) return false;
        box.click();
        return box.checked;
      })()`);
      if (!checked) throw new Error("Apply to all checkbox not found/checkable");
    });
    await screenshot(cdp, "upload-dialog-collision-apply-to-all.png");

    await scenario("Replace after Apply to all closes the dialog and re-uploads both", async () => {
      const clicked = await cdp.evalJs(`(() => {
        const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Replace');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!clicked) throw new Error('"Replace" button not found');

      const dialogGone = await waitForCondition(async () => (await dialogCount(cdp)) === 0, 5000);
      if (!dialogGone) throw new Error("dialog never closed — apply-to-all did not resolve the queued collision");

      const panelDone = await waitForCondition(async () => {
        const text = await cdp.evalJs(`document.querySelector('[data-testid="upload-progress-panel"]')?.textContent ?? ""`);
        return /2\s*\/\s*2 uploaded/.test(text);
      }, 8000);
      if (!panelDone) throw new Error('panel never reported "2/2 uploaded"');
    });
    await screenshot(cdp, "upload-dialog-panel-done.png");

    await scenario("cancel mid-upload of a large file → row shows cancelled, no tmp file left", async () => {
      await cdp.evalJs(`window.__ppmE2eUploadEvents = []`);
      const LARGE_NAME = "large-cancel-me.bin";
      const LARGE_BYTES = 50 * 1024 * 1024;
      await dropFiles(cdp, [{ name: LARGE_NAME, size: LARGE_BYTES }]);
      // A brief window while the row is still uploading, before the Cancel click below —
      // captures the desktop panel mid-upload with its per-row Cancel button visible.
      await screenshot(cdp, "upload-dialog-desktop-panel-mid-upload.png");

      // Click the row's Cancel button as soon as it renders, before the upload can finish.
      const clicked = await waitForCondition(async () => {
        return cdp.evalJs(`(() => {
          const btn = document.querySelector('button[aria-label="Cancel ${LARGE_NAME}"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
      }, 4000, 50);
      if (!clicked) throw new Error("never found a Cancel button for the large upload before it settled");

      const cancelledRow = await waitForCondition(async () => {
        return cdp.evalJs(`(() => {
          const rows = [...document.querySelectorAll('[data-testid="upload-row"]')];
          return rows.some((r) => r.dataset.state === 'cancelled' && r.textContent.includes('${LARGE_NAME}'));
        })()`);
      }, 8000);
      if (!cancelledRow) throw new Error("row never reached the cancelled state");

      const tmpPath = fx(`${LARGE_NAME}.ppm-upload-tmp`);
      // Give the server a moment to notice the aborted stream and run its own cleanup.
      await Bun.sleep(500);
      if (existsSync(tmpPath)) throw new Error("leftover .ppm-upload-tmp file after cancel");
      if (existsSync(fx(LARGE_NAME))) throw new Error("cancelled upload still produced a full file");
    });
    await screenshot(cdp, "upload-dialog-cancelled-row.png");

// ── mobile: pill + sheet ──
    const { cdp: mc, targetId: mobileTarget } = await openTab();
    await mc.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await mc.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await navigateAndAuth(mc);
    await installUploadObserver(mc);

    // The mobile explorer sheet only renders (and mounts `[data-testid="explorer-list"]`) once
    // actually opened — patching the store's path alone leaves it unmounted, same as
    // os-explorer-window.mjs's mobile flow.
    await mc.evalJs(`window.dispatchEvent(new CustomEvent("open-command-palette"))`);
    await Bun.sleep(500);
    // This is a real, long-lived dev session — the palette's fuzzy search also surfaces
    // chat/task history that happens to *mention* "Open File Explorer" in a snippet, so a
    // plain substring match on a whole button's text can click the wrong result. Matching the
    // command's own label `<span>` exactly avoids that.
    await mc.evalJs(`(() => {
      const els = [...document.querySelectorAll("button")];
      const hit = els.find((e) => {
        const label = e.querySelector("span");
        return label && label.textContent.trim() === "Open File Explorer";
      });
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    await Bun.sleep(1200);
    await mc.evalJs(`(async () => {
      const { useExplorerStore } = await import('/components/os-explorer/explorer-store.ts');
      const { MOBILE_EXPLORER_WINDOW_ID } = await import('/components/os-explorer/use-explorer-open-state.ts');
      useExplorerStore.getState().patch(MOBILE_EXPLORER_WINDOW_ID, { path: ${JSON.stringify(FIXTURE_DIR)} });
    })()`);
    await Bun.sleep(900);

    await scenario("mobile: upload pill + sheet appear during an upload", async () => {
      await dropFiles(mc, [{ name: "mobile-fresh.bin", size: 32 * 1024 }]);
      const pillUp = await waitForCondition(
        async () => mc.evalJs(`!!document.querySelector('[data-testid="upload-progress-pill"]')`),
        5000,
      );
      if (!pillUp) throw new Error("mobile upload pill never appeared");
      await mc.evalJs(`document.querySelector('[data-testid="upload-progress-pill"]').click()`);
      await Bun.sleep(400);
      const sheetUp = await mc.evalJs(`!!document.querySelector('[data-testid="upload-batch-card"]')`);
      if (!sheetUp) throw new Error("mobile sheet did not show the batch card");
    });
    await screenshot(mc, "upload-dialog-mobile-sheet.png");
    await closeTab(mobileTarget);

    await closeTab(targetId);
  } finally {
    chrome.kill();
  }
}

const watchdog = new Promise((_, reject) =>
  setTimeout(() => reject(new Error("global watchdog: harness exceeded 5 minutes")), 5 * 60 * 1000),
);

Promise.race([main(), watchdog])
  .catch((e) => {
    console.error("HARNESS ERROR:", e);
    results.push({ name: "harness", pass: false, detail: String(e) });
    chromeProc?.kill();
  })
  .finally(async () => {
    console.log("\n═══ SUMMARY ═══");
    const pass = results.filter((r) => r.pass).length;
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? " — " + r.detail : ""}`);
    console.log(`\n${pass}/${results.length} passed`);
    await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
    process.exit(results.some((r) => !r.pass) ? 1 : 0);
  });
