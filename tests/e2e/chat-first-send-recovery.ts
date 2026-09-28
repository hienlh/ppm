// bun tests/e2e/chat-first-send-recovery.ts
// Open localhost:5189/?mode=stall, type and send, then reload. The draft must
// return without another POST. mode=no-ws covers reload after session creation;
// mode=success covers clearing the recovered draft after an explicit resend.
import { readdir } from "node:fs/promises";
const build = await Bun.build({
  entrypoints: ["tests/e2e/fixtures/chat-first-send-recovery.tsx"], target: "browser",
  define: { "import.meta.env.DEV": "false" },
});
if (!build.success) throw new Error(build.logs.join("\n"));
const js = build.outputs.find((output) => output.path.endsWith(".js"))!;
const css = (await readdir("dist/web/assets")).find((name) => /^index-.*\.css$/.test(name));
const server = Bun.serve({ hostname: "127.0.0.1", port: 5189, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture.js") return new Response(js);
  if (path.startsWith("/assets/") && !path.includes("..")) return new Response(Bun.file(`dist/web${path}`));
  return new Response(`<!doctype html><html class="dark"><head><link rel="stylesheet" href="/assets/${css}"></head>
    <body><div id="root" style="height:100vh"></div><script type="module" src="/fixture.js"></script></body></html>`,
    { headers: { "Content-Type": "text/html" } });
}});
console.log(`First-send recovery fixture: ${server.url} (PID ${process.pid})`);
