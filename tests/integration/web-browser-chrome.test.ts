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
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
    page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/alert") return html("<script>setTimeout(() => alert('hi from page'), 50)</script>");
      if (path === "/file") return new Response("report body", { headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename*=UTF-8''b%C3%A1o%20c%C3%A1o.pdf" } });
      if (path === "/upload") return html("<input type=file id=f style='position:fixed;inset:0;width:100%;height:100%'>");
      return html("<input id=q autofocus><p id=t>hello</p>");
    } });
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

  it("shows a page's alert with its origin, and closes it when answered", async () => {
    received.length = 0;
    await viewerHub.onMessage(viewer, { type: "navigate", url: `http://localhost:${page!.port}/alert` });
    await until(() => received.some((m) => m.type === "dialog"));
    const d = received.find((m) => m.type === "dialog") as Extract<WebBrowserServerMessage, { type: "dialog" }>;
    expect(d).toMatchObject({ kind: "alert", message: "hi from page", origin: `http://localhost:${page!.port}` });
    await viewerHub.onMessage(viewer, { type: "dialog.answer", id: d.id, accept: true });
    await until(() => received.some((m) => m.type === "dialog.closed" && m.id === d.id));
  }, 20_000);

  it("copies the selection from an isolated world", async () => {
    await viewerHub.onMessage(viewer, { type: "navigate", url: `http://localhost:${page!.port}/` });
    await until(async () => (await pageValue("!!document.getElementById('q')")) === true);
    await pageValue("(() => { const q = document.getElementById('q'); q.value = 'Xin chào Hà Nội'; q.focus(); q.setSelectionRange(9, 15); })()");
    received.length = 0;
    await viewerHub.onMessage(viewer, { type: "clipboard.copyRequest" });
    await until(() => received.some((m) => m.type === "clipboard.copy"));
    expect(received.find((m) => m.type === "clipboard.copy")).toEqual({ type: "clipboard.copy", text: "Hà Nội" });
  }, 20_000);

  it("keeps downloads on the host and hands them out by a one-use ticket", async () => {
    const { mintDownloadTicket, spendDownloadTicket } = await import("../../src/services/web-browser/download-manager.ts");
    received.length = 0;
    await viewerHub.onMessage(viewer, { type: "navigate", url: `http://localhost:${page!.port}/file` });
    await until(() => received.some((m) => m.type === "download" && m.state === "done"));
    const d = received.find((m) => m.type === "download" && m.state === "done") as Extract<WebBrowserServerMessage, { type: "download" }>;
    expect(d.name).toBe("báo cáo.pdf");
    const ticket = mintDownloadTicket(d.id)!;
    const file = spendDownloadTicket(ticket)!;
    expect(await Bun.file(file.path).text()).toBe("report body");
    expect(spendDownloadTicket(ticket)).toBeNull();
  }, 20_000);

  it("hands a file the viewer picked to the page's file input", async () => {
    const { saveUpload } = await import("../../src/services/web-browser/upload-store.ts");
    const id = await saveUpload(new Response("hello").body!, "ghi chú.txt");
    received.length = 0;
    await viewerHub.onMessage(viewer, { type: "navigate", url: `http://localhost:${page!.port}/upload` });
    await until(async () => (await pageValue("!!document.getElementById('f')")) === true);
    await viewerHub.onMessage(viewer, { type: "pointer", xFrac: 0.5, yFrac: 0.5, button: "left", down: true });
    await viewerHub.onMessage(viewer, { type: "pointer", xFrac: 0.5, yFrac: 0.5, button: "left", down: false });
    await until(() => received.some((m) => m.type === "fileChooser"));
    const c = received.find((m) => m.type === "fileChooser") as Extract<WebBrowserServerMessage, { type: "fileChooser" }>;
    await viewerHub.onMessage(viewer, { type: "file.choose", chooserId: c.chooserId, uploadIds: [id] });
    await until(async () => (await pageValue("document.getElementById('f').files[0]?.name")) === "ghi chú.txt");
  }, 20_000);

  it("opens a popup as a new tab and shows it", async () => {
    const before = webBrowserHost.activeTabId;
    const tab = webBrowserHost.tabs!.get(before!)!;
    await webBrowserHost.cdp!.send("Runtime.evaluate", { expression: `window.open('http://localhost:${page!.port}/')`, userGesture: true }, tab.sessionId);
    await until(() => webBrowserHost.activeTabId !== before && webBrowserHost.tabs!.count === 2);
  }, 20_000);

  it("stops Chrome and leaves no process behind", async () => {
    await webBrowserHost.stop();
    expect(webBrowserHost.state).toBe("stopped");
    let alive = true;
    try { process.kill(chromePid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 30_000);
});
