// Shared plumbing for tests/e2e/tab-popout-pip-e2e.mjs — CDP client over the BROWSER
// endpoint (flattened sessions, because a Document Picture-in-Picture window is its own
// page target), headed-Chrome launcher, OS screenshot with a CDP fallback, and the page
// helpers injected before app boot.
//
// Kept separate from the scenario file so the scenarios read as a story.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// CDP client — one browser WebSocket, one sessionId per attached target
// ---------------------------------------------------------------------------
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set(); // fn(msg)
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
        }
        return;
      }
      for (const fn of this.listeners) fn(m);
    });
  }

  static async connect(port, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let info = null;
    while (Date.now() < deadline) {
      try {
        info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch {
        await sleep(300);
      }
    }
    if (!info) throw new Error(`no CDP endpoint on ${port}`);
    const ws = await new Promise((res, rej) => {
      const sock = new WebSocket(info.webSocketDebuggerUrl);
      sock.addEventListener("open", () => res(sock));
      sock.addEventListener("error", rej);
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, timeoutMs);
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Wait for one event, optionally scoped to a session. */
  once(method, sessionId, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const off = this.on((m) => {
        if (m.method !== method) return;
        if (sessionId && m.sessionId !== sessionId) return;
        off();
        resolve(m.params);
      });
      setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
  }

  async targets() {
    return (await this.send("Target.getTargets")).targetInfos;
  }

  /** Attach and turn on the domains every scenario needs, dialogs auto-accepted:
   *  the app arms a beforeunload handler, and an unanswered native dialog blocks the
   *  whole renderer — including Runtime.evaluate — with no other symptom than a hang. */
  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Page.enable", {}, sessionId).catch(() => {});
    await this.send("Runtime.enable", {}, sessionId).catch(() => {});
    await this.send("DOM.enable", {}, sessionId).catch(() => {});
    this.on((m) => {
      if (m.method === "Page.javascriptDialogOpening" && m.sessionId === sessionId) {
        this.send("Page.handleJavaScriptDialog", { accept: true }, sessionId).catch(() => {});
      }
    });
    return sessionId;
  }

  async evalJs(sessionId, expression, timeoutMs = 30000) {
    // Raw top-level await is invalid outside replMode — wrap so call sites can await.
    const wrapped = `(async () => { return (${expression}); })()`;
    const r = await this.send(
      "Runtime.evaluate",
      { expression: wrapped, returnByValue: true, awaitPromise: true },
      sessionId,
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(`${desc} :: ${String(expression).slice(0, 200)}`);
    }
    return r.result.value;
  }

  /** Trusted mouse click at viewport coordinates — the ONLY kind that carries the
   *  transient activation `documentPictureInPicture.requestWindow()` demands. */
  async click(sessionId, x, y, button = "left") {
    const base = { x, y, button, clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, sessionId);
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, sessionId);
  }

  async typeText(sessionId, text) {
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch }, sessionId);
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, sessionId);
      await sleep(12);
    }
  }

  async pressKey(sessionId, { key, code, vk, text, modifiers = 0 }) {
    const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.send(
      "Input.dispatchKeyEvent",
      { type: text ? "keyDown" : "rawKeyDown", ...common, ...(text ? { text, unmodifiedText: text } : {}) },
      sessionId,
    );
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, sessionId);
  }

  async enter(sessionId) {
    await this.pressKey(sessionId, { key: "Enter", code: "Enter", vk: 13, text: "\r" });
  }
}

// ---------------------------------------------------------------------------
// Chrome — HEADED, always: Document PiP does not exist in headless.
// ---------------------------------------------------------------------------
export async function launchChrome({ chromePath, cdpPort, profileDir, url }) {
  await mkdir(profileDir, { recursive: true });
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1600,1000",
      "--window-position=0,0",
      url,
    ],
    { stdio: "ignore", detached: false },
  );
  return child;
}

// ---------------------------------------------------------------------------
// Screenshots: whole-desktop GDI first (the PiP window is a separate always-on-top
// OS window no page capture can see), CDP per-target as the documented fallback.
// ---------------------------------------------------------------------------
const PS_CAPTURE = (out) => `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
$g.Dispose()
$nonBlack=0
for($x=0;$x -lt $b.Width;$x+=97){for($y=0;$y -lt $b.Height;$y+=89){$p=$bmp.GetPixel($x,$y); if($p.R -gt 8 -or $p.G -gt 8 -or $p.B -gt 8){$nonBlack++}}}
if($nonBlack -lt 5){$bmp.Dispose(); Write-Output 'black'} else {$bmp.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); Write-Output 'ok'}
`;

/** Try an OS-level capture. Returns "os" on success, else null (caller falls back). */
export async function osScreenshot(outPath) {
  const res = await new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_CAPTURE(outPath.replace(/\\/g, "/"))], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => resolve({ out: out.trim(), err: err.trim() }));
    p.on("error", (e) => resolve({ out: "", err: String(e) }));
  });
  return res.out === "ok" ? "os" : null;
}

/** CDP capture of one target into a file. */
export async function cdpScreenshot(cdp, sessionId, outPath) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(outPath, Buffer.from(r.data, "base64"));
}

// ---------------------------------------------------------------------------
// Page helpers — installed via Page.addScriptToEvaluateOnNewDocument, so they exist
// before the app boots and can count every WebSocket the app ever opens.
// ---------------------------------------------------------------------------
export function pageInitScript(token, { deletePipApi = false } = {}) {
  return `
(() => {
  try { localStorage.setItem("ppm-auth-token", ${JSON.stringify(token)}); } catch {}
  ${deletePipApi ? "try { delete window.documentPictureInPicture; } catch {}" : ""}
  const E = (window.__e2e = { wsUrls: [], terminalWsCount: 0 });

  // Count every socket the app opens: a terminal that silently reconnects opens a
  // second /terminal/ socket, which is the only observable trace of a lost PTY.
  const NativeWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    try {
      E.wsUrls.push(String(url));
      if (String(url).includes("/terminal/")) E.terminalWsCount++;
    } catch {}
    return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
  }
  PatchedWS.prototype = NativeWS.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) PatchedWS[k] = NativeWS[k];
  window.WebSocket = PatchedWS;

  // --- React fiber walk to the live xterm Terminal owned by a tab wrapper ---
  E.fiberOf = (el) => {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    return k ? el[k] : null;
  };
  E.findTerminal = (wrapper) => {
    const container = wrapper.querySelector(".xterm")?.parentElement;
    if (!container) return null;
    let f = E.fiberOf(container);
    for (let depth = 0; f && depth < 40; depth++, f = f.return) {
      let hook = f.memoizedState;
      for (let i = 0; hook && i < 200; i++, hook = hook.next) {
        const cur = hook.memoizedState && hook.memoizedState.current;
        if (cur && typeof cur.getSelection === "function" && cur.buffer && typeof cur.rows === "number") return cur;
      }
    }
    return null;
  };
  E.termText = (wrapper, lastN = 200) => {
    const term = E.findTerminal(wrapper);
    if (!term) return null;
    const buf = term.buffer.active;
    const out = [];
    for (let i = Math.max(0, buf.length - lastN); i < buf.length; i++) {
      out.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return out.join("\\n");
  };
  E.findEditor = (wrapper) => {
    const m = window.monaco;
    if (!m) return null;
    return m.editor.getEditors().find((e) => wrapper.contains(e.getDomNode())) ?? null;
  };
})();
`;
}
