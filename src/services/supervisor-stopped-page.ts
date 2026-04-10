/**
 * Minimal HTTP server that serves a "stopped" page when the PPM server child is down.
 * Binds to the same port so the tunnel URL still works.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPpmDir } from "./ppm-dir.ts";

function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  try { appendFileSync(resolve(getPpmDir(), "ppm.log"), `[${ts}] [${level}] [stopped-page] ${msg}\n`); } catch {}
}

const STOPPED_HTML = `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PPM - Stopped</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center;
           align-items: center; min-height: 100vh; margin: 0;
           background: #1a1a2e; color: #e0e0e0; }
    .card { text-align: center; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #888; font-size: 0.9rem; }
    .dot { display: inline-block; width: 10px; height: 10px;
           border-radius: 50%; background: #f59e0b; margin-right: 8px; }
  </style>
</head><body>
  <div class="card">
    <h1><span class="dot"></span>PPM Server Stopped</h1>
    <p>The server is stopped but the supervisor is still running.</p>
    <p>Use <code>ppm start</code> or Cloud dashboard to restart.</p>
  </div>
</body></html>`;

let stoppedServer: ReturnType<typeof Bun.serve> | null = null;

export function startStoppedPage(port: number, host: string) {
  if (stoppedServer) return;

  try {
    stoppedServer = Bun.serve({
      port,
      hostname: host,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/health") {
          return new Response(JSON.stringify({ status: "stopped" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(STOPPED_HTML, {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    log("INFO", `Stopped page serving on port ${port}`);
  } catch (e) {
    log("WARN", `Failed to start stopped page: ${e}`);
  }
}

export function stopStoppedPage() {
  if (stoppedServer) {
    stoppedServer.stop();
    stoppedServer = null;
    log("INFO", "Stopped page server shut down");
  }
}
