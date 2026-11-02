import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The design CSP in WebKit, Chromium and Firefox: a page served under it in a
// `sandbox="allow-scripts"` frame, as the canvas and the HTML preview frame theirs, must load
// its stylesheet, image and script and fetch its own files, and be refused a fetch outside its
// prefix. WebKit is why this exists: it matches a scheme-less source against nothing in a
// frame with an opaque origin (`design-csp.ts`), which no string assertion can show.
// The files come from a real server, not `route.fulfill`: WebKit checks `connect-src` a second
// time in its network process, and a fulfilled route never reaches that check, so it passes
// the very policy this test exists to refuse.
// Run with Node: PPM_PLAYWRIGHT_MODULE=<playwright/index.mjs> node tests/e2e/design-csp-engines-e2e.mjs

const PREFIX = "/api/design-preview/content/tok/";
const design = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head>
<body><h1>Design</h1><img src="pixel.png"><script src="app.js"></script>
<script>
  const tryFetch = (url) => fetch(url).then((r) => r.status, () => "refused");
  addEventListener("load", async () => parent.postMessage({
    color: getComputedStyle(document.querySelector("h1")).color,
    imageWidth: document.querySelector("img").naturalWidth,
    script: window.appRan === true,
    ownFetch: await tryFetch("styles.css"),
    outsideFetch: await tryFetch("/outside"),
  }, "*"));
</script></body></html>`;
// A 2x2 PNG.
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg==", "base64");
const files = {
  "/": ["text/html", `<!doctype html><script>addEventListener("message", (e) => { window.result = e.data; });</script>
<iframe sandbox="allow-scripts" src="${PREFIX}index.html"></iframe>`],
  [`${PREFIX}index.html`]: ["text/html", design],
  [`${PREFIX}styles.css`]: ["text/css", "h1 { color: rgb(255, 0, 0); }"],
  [`${PREFIX}pixel.png`]: ["image/png", pixel],
  [`${PREFIX}app.js`]: ["text/javascript", "window.appRan = true;"],
  // Readable cross-origin like the design's own files, so only the policy can refuse it.
  "/outside": ["text/plain", "outside the design's prefix"],
};

let csp = "";
const server = createServer((req, res) => {
  const file = files[new URL(req.url, "http://localhost").pathname];
  if (!file) return res.writeHead(404).end();
  // The frame's origin is opaque, so its fetches are cross-origin; the preview route answers `null`.
  res.writeHead(200, { "Content-Type": file[0], "Access-Control-Allow-Origin": "null",
    ...(file[1] === design ? { "Content-Security-Policy": csp } : {}) });
  res.end(file[1]);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
csp = execFileSync("bun", ["-p", `require("./src/services/design/preview/design-csp.ts").buildDesignCsp(${JSON.stringify(`${origin.slice(7)}${PREFIX}`)})`], {
  encoding: "utf8", env: { ...process.env, PPM_HOME: mkdtempSync(join(tmpdir(), "ppm-csp-")) },
}).trim();

const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
const playwright = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
try {
  for (const engine of ["webkit", "chromium", "firefox"]) {
    const browser = await playwright[engine].launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/`);
      const result = await (await page.waitForFunction(() => window.result)).jsonValue();
      assert.deepEqual(result, { color: "rgb(255, 0, 0)", imageWidth: 2, script: true, ownFetch: 200, outsideFetch: "refused" },
        `${engine} ${browser.version()}`);
      console.log(`PASS ${engine} ${browser.version()}: the page loads its own files, and fetches nothing outside them`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
