// Session debug dialog — transcript image cleanup, real browser end-to-end.
//
// Seeds a throwaway session whose transcript carries three tool-result images, one of them
// past the API's per-image dimension cap, then drives the Session debug dialog: the audit
// numbers, the oversized warning, and both removal buttons.
//
// The fixture transcript is written into the real project directory (that is where the
// session lister looks) and deleted again in the finally block.
//
// Run (backend + web must be up; defaults match `bun dev`):
//   bun tests/e2e/session-debug-transcript-images.mjs
//
// Env overrides:
//   PPM_E2E_WEB_PORT=5174   web port to drive
//   CHROME_PATH=...         Chrome executable
//   PPM_E2E_KEEP=1          leave Chrome open afterwards

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";

const REPO = process.cwd();
const WEB = `http://localhost:${process.env.PPM_E2E_WEB_PORT ?? "5174"}`;
const PROJECT_NAME = "ppm";
const WEB_PROJECT = `${WEB}/project/${encodeURIComponent(PROJECT_NAME)}`;
const TOKEN_KEY = "ppm-auth-token"; // src/web/lib/api-client.ts
const CDP_PORT = 9341;
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const KEEP = !!process.env.PPM_E2E_KEEP;

const VISUALS = join(REPO, "plans", "260828-0110-chat-inline-tool-images", "visuals", "transcript-images");

const log = (...a) => console.log(...a);
const step = (s) => log(`\n${s}`);
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Base64 for a PNG whose IHDR declares the given size.
 *
 * Only the header is ever read — by the audit, to decide whether the image is past the
 * dimension cap — so the pixel data is filler sized to give the image a realistic weight.
 */
function pngBase64(w, h, payloadBytes) {
  const head = Buffer.alloc(24);
  head.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  const body = createHash("sha256").update(`${w}x${h}`).digest();
  const filler = Buffer.alloc(payloadBytes);
  for (let i = 0; i < payloadBytes; i += body.length) body.copy(filler, i);
  return Buffer.concat([head, filler]).toString("base64");
}

function imageToolResult(sessionId, toolUseId, w, h, bytes) {
  return JSON.stringify({
    parentUuid: null,
    sessionId,
    type: "user",
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: REPO,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64(w, h, bytes) } }],
      }],
    },
  });
}

/**
 * Append three image tool results to the transcript the app already has open.
 *
 * Seeding the open session sidesteps navigating the history list, which has no stable
 * hooks. The original bytes are kept so the transcript can be put back exactly as found.
 */
function seedOpenTranscript(path, sessionId) {
  const before = readFileSync(path);
  const extra = [
    // 2400px is past the cap; the other two sit inside it.
    imageToolResult(sessionId, "e2e-img-over", 2400, 1530, 140_000),
    imageToolResult(sessionId, "e2e-img-a", 1200, 800, 90_000),
    imageToolResult(sessionId, "e2e-img-b", 640, 480, 30_000),
  ];
  const tail = before.length && before[before.length - 1] === 0x0a ? "" : "\n";
  writeFileSync(path, `${before.toString("utf8")}${tail}${extra.join("\n")}\n`);
  return () => writeFileSync(path, before);
}

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------
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
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    return path;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(`!!(${expression})`)) return true;
    } catch {}
    await Bun.sleep(400);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Text of the open dialog or bottom sheet, whichever this viewport rendered. */
const PANEL_TEXT = `(() => {
  const el = document.querySelector('[role="dialog"]');
  return el ? el.innerText : "";
})()`;

const clickByText = (text) => `(() => {
  const btn = [...document.querySelectorAll('[role="dialog"] button')]
    .find(b => b.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
})()`;

const buttonState = (text) => `(() => {
  const btn = [...document.querySelectorAll('[role="dialog"] button')]
    .find(b => b.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
  return btn ? { label: btn.innerText.trim(), disabled: btn.disabled } : null;
})()`;

const main = async () => {
  await mkdir(VISUALS, { recursive: true });

  const { Database } = await import("bun:sqlite");
  const db = new Database(join(homedir(), ".ppm", "ppm.dev.db"), { readonly: true });
  const token = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
  db.close();

  step("1. Launch headless Chrome");
  const profile = join(tmpdir(), `ppm-imgdebug-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,980",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ], { stdio: "ignore" });

  let wsUrl;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) })).json();
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
    await Bun.sleep(400);
  }
  if (!wsUrl) throw new Error("Chrome CDP never became ready");

  const cdp = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(new Cdp(ws)));
    ws.addEventListener("error", reject);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  let restore = () => {};
  try {
    step("2. Authenticate and open the project");
    await cdp.send("Page.navigate", { url: WEB });
    await Bun.sleep(2500);
    await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)}), null`);
    await cdp.send("Page.navigate", { url: WEB_PROJECT });
    await Bun.sleep(9000);
    await waitFor(cdp, `document.querySelector('textarea[placeholder="Ask anything..."]')`, "chat composer", 45000);

    step("3. Read which transcript the open session uses");
    const openDialog = async () => {
      await cdp.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.title === 'Session debug info');
        if (b) b.click();
        return !!b;
      })()`);
      await waitFor(cdp, `document.querySelector('[role="dialog"]')`, "debug dialog");
      await waitFor(cdp, `${PANEL_TEXT}.includes('Transcript images')`, "image section", 20000);
      await Bun.sleep(1200);
      return cdp.evaluate(PANEL_TEXT);
    };
    const closeDialog = async () => {
      await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), null`);
      await Bun.sleep(800);
    };

    const first = await openDialog();
    const jsonlPath = first.match(/JSONL: (.+?\.jsonl)/)?.[1];
    const sessionId = first.match(/SDK Session: ([0-9a-f-]+)/)?.[1];
    check("debug dialog reports a transcript", !!jsonlPath && !!sessionId, jsonlPath ?? "none");
    if (!jsonlPath || !sessionId) throw new Error("cannot locate the open session's transcript");
    log(`   ${jsonlPath}`);
    await closeDialog();

    step("4. Seed three images into it (one past the dimension cap)");
    restore = seedOpenTranscript(jsonlPath, sessionId);
    const baseline = Number(first.match(/(\d+) images? in tool results/)?.[1] ?? 0);
    log(`   transcript already held ${baseline} image(s); expecting ${baseline + 3}`);

    step("5. Reopen the dialog and read the audit");
    const text = await openDialog();
    log(`\n   --- dialog text ---\n${text.split("\n").map((l) => `   | ${l}`).join("\n")}\n`);
    await cdp.shot("desktop-01-audit");

    check("counts the seeded images", new RegExp(`${baseline + 3} images in tool results`).test(text),
      text.match(/\d+ images? in tool results/)?.[0]);
    check("warns about the oversized one", text.includes("wider than 2000px"));
    check("names the largest side", text.includes("2400px"));

    const overBtn = await cdp.evaluate(buttonState("remove oversized"));
    const allBtn = await cdp.evaluate(buttonState("remove all"));
    check("oversized button is enabled and counted", overBtn && !overBtn.disabled && /\(1 · /.test(overBtn.label), overBtn?.label);
    check("remove-all button is enabled and counted",
      allBtn && !allBtn.disabled && new RegExp(`\\(${baseline + 3} · `).test(allBtn.label), allBtn?.label);

    step("6. Remove the oversized image");
    check("clicked remove oversized", await cdp.evaluate(clickByText("remove oversized")));
    await waitFor(cdp, `${PANEL_TEXT}.includes('Removed 1 image')`, "removal confirmation", 20000);
    const afterOver = await cdp.evaluate(PANEL_TEXT);
    await cdp.shot("desktop-02-after-oversized");
    check("warning is gone", !afterOver.includes("wider than 2000px"));
    check("in-cap images survive", new RegExp(`${baseline + 2} images in tool results`).test(afterOver),
      afterOver.match(/\d+ images? in tool results/)?.[0]);
    const overAfter = await cdp.evaluate(buttonState("remove oversized"));
    check("oversized button disables itself", overAfter?.disabled === true, overAfter?.label);

    step("7. Remove the rest");
    check("clicked remove all", await cdp.evaluate(clickByText("remove all")));
    await waitFor(cdp, `${PANEL_TEXT}.includes('No images in tool results')`, "empty state", 20000);
    const afterAll = await cdp.evaluate(PANEL_TEXT);
    await cdp.shot("desktop-03-after-all");
    check("both buttons disabled once clean",
      (await cdp.evaluate(buttonState("remove all")))?.disabled === true
      && (await cdp.evaluate(buttonState("remove oversized")))?.disabled === true);
    check("reports what it freed", new RegExp(`Removed ${baseline + 2} images, freed`).test(afterAll),
      afterAll.match(/Removed .*/)?.[0]);

    // Scoped to tool results on purpose. Claude Code keeps its own image-shaped bookkeeping
    // at the top-level `toolUseResult` field; those records carry no base64 and are not part
    // of an API request, so the service leaves them exactly as the CLI wrote them.
    step("8. The transcript on disk really changed");
    const onDisk = readFileSync(jsonlPath, "utf8");
    let leftInToolResults = 0;
    for (const line of onDisk.split("\n")) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) { for (const c of n) { if (c?.type === "image") leftInToolResults++; else walk(c); } return; }
        for (const v of Object.values(n)) walk(v);
      };
      for (const b of record?.message?.content ?? []) if (b?.type === "tool_result") walk(b.content);
    }
    check("no image blocks left in tool results", leftInToolResults === 0, `${leftInToolResults} remaining`);
    check("placeholders written instead", onDisk.includes("[image · "));

    step("9. Mobile viewport — bottom sheet");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await Bun.sleep(1500);
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.title === 'Session debug info');
      if (b) b.click();
      return !!b;
    })()`);
    await Bun.sleep(2500);
    await cdp.shot("mobile-01-sheet");
    const mobileText = await cdp.evaluate(`(() => {
      const el = document.querySelector('[role="dialog"], [data-bottom-sheet]');
      return el ? el.innerText : document.body.innerText;
    })()`);
    check("section reachable on a phone", mobileText.includes("Transcript images"));
  } finally {
    if (!KEEP) chrome.kill();
    restore();
    log(`\n   transcript restored to its original bytes`);
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
