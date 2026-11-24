/**
 * The real thing end to end: PPM's egress guard, a real Chrome behind it, a viewer receiving
 * pictures, typing Vietnamese into a page served on localhost, and the guard refusing PPM's own
 * port. Skipped on a host with no Chrome or Edge. Every Chrome it starts is stopped by the host
 * and checked gone by pid.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDbPragmas, runMigrations, setDb } from "../../src/services/db.service.ts";
import { configService } from "../../src/services/config.service.ts";
import { parseWebBrowserSettings } from "../../src/shared/web-browser-settings.ts";
import { findBrowsers } from "../../src/services/web-browser/chrome-locate.ts";
import { webBrowserHost } from "../../src/services/web-browser/browser-host.ts";
import { viewerHub, type Viewer } from "../../src/services/web-browser/viewer-hub.ts";
import { registerPpmOwnPort } from "../../src/services/web-browser/ppm-own-ports.ts";
import { decodeBinaryFrame } from "../../src/shared/web-browser-binary-frames.ts";
import type { WebBrowserServerMessage } from "../../src/shared/web-browser-protocol.ts";

const hasBrowser = (await findBrowsers()).length > 0;
let dir = "";
let db: Database | null = null;
let page: ReturnType<typeof Bun.serve> | null = null;
let fakePpm: ReturnType<typeof Bun.serve> | null = null;
const received: WebBrowserServerMessage[] = [];
let pictures = 0;
let chromePid = 0;

const viewer: Viewer = {
  id: "test-viewer",
  send: (m) => { received.push(m); },
  sendBinary: (b) => {
    const f = decodeBinaryFrame(b);
    if (f?.kind === 1) {
      pictures++;
      void viewerHub.onMessage(viewer, { type: "frame.ack", seq: f.seq });
    }
  },
};

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await Bun.sleep(100);
  }
  throw new Error("timed out");
}

async function pageValue(expr: string): Promise<unknown> {
  const tab = webBrowserHost.tabs!.get(webBrowserHost.activeTabId!)!;
  const r = await webBrowserHost.cdp!.send<{ result: { value: unknown } }>("Runtime.evaluate", { expression: expr, returnByValue: true }, tab.sessionId);
  return r.result.value;
}

describe.skipIf(!hasBrowser)("PPM's browser with a real Chrome", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ppm-web-browser-it-"));
    process.env.PPM_HOME = dir;
    db = new Database(join(dir, "ppm.db"));
    applyDbPragmas(db);
    runMigrations(db);
    setDb(db);
    configService.load();
    configService.set("web_browser", { ...parseWebBrowserSettings({}), enabled: true });
    page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<input id=q autofocus><p id=t>hello</p>", { headers: { "content-type": "text/html" } }) });
    fakePpm = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("PPM") });
    registerPpmOwnPort(Number(fakePpm.port));
    await webBrowserHost.ensureStarted();
    chromePid = webBrowserHost.chrome!.pid;
    viewerHub.add(viewer);
    await viewerHub.onMessage(viewer, { type: "viewport", cssWidth: 800, cssHeight: 600, dpr: 1, mobile: false });
  }, 60_000);

  afterAll(async () => {
    await webBrowserHost.stop();
    page?.stop(true);
    fakePpm?.stop(true);
    db?.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }, 30_000);

  it("runs behind the guard and streams pictures to the viewer", async () => {
    expect(webBrowserHost.state).toBe("running");
    await viewerHub.onMessage(viewer, { type: "navigate", url: `http://localhost:${page!.port}/` });
    await until(async () => (await pageValue("document.getElementById('t')?.textContent")) === "hello");
    await until(() => pictures > 0);
  }, 30_000);

  it("types Vietnamese through IME composition and text", async () => {
    await pageValue("document.getElementById('q').focus()");
    await viewerHub.onMessage(viewer, { type: "compose", text: "thờ", selStart: 3, selEnd: 3 });
    await viewerHub.onMessage(viewer, { type: "text", text: "thời tiết Hà Nội" });
    await until(async () => (await pageValue("document.getElementById('q').value")) === "thời tiết Hà Nội");
  }, 20_000);

  it("refuses PPM's own port and file://", async () => {
    received.length = 0;
    await viewerHub.onMessage(viewer, { type: "navigate", url: `http://127.0.0.1:${fakePpm!.port}/` });
    await until(() => received.some((m) => m.type === "blocked" && m.reason === "own-port"));
    await viewerHub.onMessage(viewer, { type: "navigate", url: "file:///C:/Windows/win.ini" });
    await until(() => received.some((m) => m.type === "blocked" && m.reason === "scheme"));
  }, 20_000);

  it("stops Chrome and leaves no process behind", async () => {
    await webBrowserHost.stop();
    expect(webBrowserHost.state).toBe("stopped");
    let alive = true;
    try { process.kill(chromePid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 30_000);
});
