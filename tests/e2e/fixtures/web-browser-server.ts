/**
 * Isolated real-route server for the web browser e2e (`tests/e2e/web-browser-e2e.mjs`): a scratch
 * PPM_HOME, PPM auth ON with a fixed token (the browser refuses to run without it), the browser
 * turned on, a real Chrome behind the real egress guard, and a second little server on another
 * port with the pages the test visits — PPM's own port is blocked from the browser by design.
 * Never use __serve__.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE, realHomePath = process.env.PPM_HTML_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !profile || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`)) {
  throw new Error("Refusing the production home or PPM directory");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
export const E2E_TOKEN = "web-browser-e2e-token";
// Chrome refuses DevTools under a sandboxed USERPROFILE; it gets the real one (chrome-process.ts).
process.env.PPM_WEB_BROWSER_CHROME_USERPROFILE = realHomePath;

const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { enabled: true, token: E2E_TOKEN });
configService.set("host", "127.0.0.1");
configService.set("port", port);
const { parseWebBrowserSettings } = await import("../../../src/shared/web-browser-settings");
configService.set("web_browser", { ...parseWebBrowserSettings({}), enabled: true });
await (await import("./answer-feature-intros")).answerFeatureIntrosAtStartup();

const html = (body: string) => new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });
const pages = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/news") {
      return html(`<title>Tin tức thử</title><style>body{font-family:sans-serif;margin:0}header{background:#c62828;color:#fff;padding:12px 16px;font-size:22px;font-weight:700}
        main{padding:16px}h1{font-size:26px}figure{height:180px;background:#ddd;margin:0 0 12px}input{font-size:18px;padding:8px;width:min(420px,90%)}</style>
        <header>Báo thử PPM</header><main><input id=q placeholder="Tìm kiếm trên trang"><h1>Không khí lạnh tràn về, Hà Nội xuống 14 độ C</h1>
        <figure></figure><p>Từ đêm nay, các tỉnh phía Bắc chuyển rét, có nơi dưới 10 độ; ban ngày trời hửng nắng.</p>
        <p>${"Đoạn tin thử để trang có chiều dài. ".repeat(40)}</p></main>`);
    }
    return html("<title>Trang trống</title><p>ok</p>");
  },
});

const { app } = await import("../../../src/server/index");
const { webBrowserWebSocket } = await import("../../../src/server/ws/web-browser");
const { checkWebBrowserAccess } = await import("../../../src/services/web-browser/web-browser-access");
const { webBrowserHost } = await import("../../../src/services/web-browser/browser-host");

async function testRoute(req: Request, path: string): Promise<Response> {
  if (path === "/__wb-test/info") return Response.json({ pages: `http://127.0.0.1:${pages.port}` });
  if (path === "/__wb-test/eval" && req.method === "POST") {
    const { expression } = await req.json() as { expression: string };
    const tab = webBrowserHost.activeTabId ? webBrowserHost.tabs?.get(webBrowserHost.activeTabId) : undefined;
    if (!tab || !webBrowserHost.cdp) return Response.json({ value: null, error: "no tab" });
    const r = await webBrowserHost.cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }, tab.sessionId);
    return Response.json({ value: r.result.value ?? null, url: tab.url });
  }
  if (path === "/__html-test/shutdown" && req.method === "POST") {
    setTimeout(async () => { await webBrowserHost.stop(); pages.stop(true); process.exit(0); }, 10);
    return Response.json({ ok: true });
  }
  return Response.json({ error: "unknown test route" }, { status: 404 });
}

const server = Bun.serve<{ type: string }>({
  port, hostname: "127.0.0.1",
  async fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__wb-test/") || url.pathname.startsWith("/__html-test/")) return testRoute(req, url.pathname);
    if (url.pathname === "/ws/web-browser") {
      if (url.searchParams.get("token") !== E2E_TOKEN) return new Response("Unauthorized", { status: 401 });
      const refusal = checkWebBrowserAccess(req);
      if (refusal) return new Response(refusal.message, { status: refusal.status });
      return instance.upgrade(req, { data: { type: "web-browser" } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req, instance);
  },
  websocket: {
    open: (ws) => webBrowserWebSocket.open(ws as never),
    message: (ws, msg) => { void webBrowserWebSocket.message(ws as never, msg as never).catch(() => {}); },
    close: (ws) => webBrowserWebSocket.close(ws as never),
  },
});
process.on("exit", () => webBrowserHost.killNow());
console.log(`web-browser fixture on ${server.port}, pages on ${pages.port}`);
