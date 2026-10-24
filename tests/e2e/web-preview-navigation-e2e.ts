/** Real component + real forward hop; run with PPM_HOME and PPM_PLAYWRIGHT_MODULE. */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { startForwardHop } from "../../src/services/port-forward/forward-hop";
import { allowFramingFrom } from "../../src/services/port-forward/frame-ancestors";

const build = await Bun.build({ entrypoints: ["tests/e2e/fixtures/web-preview-navigation.tsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
assert.ok(build.success, build.logs.map(String).join("\n"));
const bundle = await build.outputs[0]!.text();
const dev = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  if (new URL(req.url).pathname === "/app.js") return new Response(`
    document.querySelector('#spa').onclick = () => history.pushState({}, '', '/lucky?lang=en#rules');
    document.querySelector('#replace').onclick = () => history.replaceState({}, '', '/replaced?lang=vi');
  `, { headers: { "content-type": "text/javascript" } });
  return new Response(gzipSync(`<!doctype html><html><head><title>Preview navigation</title></head><body>
    <h1>Game hub</h1><button id="spa">SPA route</button><button id="replace">Replace route</button>
    <a id="full" href="/full?lang=en">Full navigation</a><script src="/app.js"></script></body></html>`), {
    headers: { "content-type": "text/html", "content-encoding": "gzip", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" },
  });
} });
const hop = startForwardHop(dev.port!);
const forward = `http://127.0.0.1:${hop.port}`;
hop.setPublicUrl(forward);
const ppm = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (new URL(req.url).pathname === "/api/tunnels/frame-ancestors") {
    allowFramingFrom((await req.json()).origin);
    return Response.json({ ok: true, data: {} });
  }
  if (new URL(req.url).pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
  return new Response('<!doctype html><div id="root"></div><script src="/bundle.js"></script>', { headers: { "content-type": "text/html" } });
} });
try {
  const driver = Bun.spawn(["node", "tests/e2e/fixtures/web-preview-navigation-driver.mjs"], {
    env: { ...process.env, PPM_PREVIEW_PARENT: `http://127.0.0.1:${ppm.port}`, PPM_PREVIEW_FORWARD: forward },
    stdout: "inherit", stderr: "inherit", windowsHide: true,
  });
  const timeout = setTimeout(() => driver.kill(), 60_000);
  try { assert.equal(await driver.exited, 0); } finally { clearTimeout(timeout); }
} finally {
  hop.stop();
  dev.stop(true);
  ppm.stop(true);
}
