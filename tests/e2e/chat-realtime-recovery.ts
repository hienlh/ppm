// bun tests/e2e/chat-realtime-recovery.ts, then open the printed URL in a browser.
// Uses the real React hook with fake transports: no backend, accounts or API calls.
const build = await Bun.build({
  entrypoints: ["tests/e2e/fixtures/chat-realtime.tsx"], target: "browser",
  define: { "import.meta.env.DEV": "false" },
});
if (!build.success) throw new Error(build.logs.join("\n"));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (new URL(request.url).pathname === "/fixture.js") return new Response(build.outputs[0]);
  return new Response('<!doctype html><div id="root"></div><script src="/fixture.js"></script>',
    { headers: { "Content-Type": "text/html" } });
}});
console.log(`Open ${server.url} — window.realtime.result reports PASS or FAIL.`);
