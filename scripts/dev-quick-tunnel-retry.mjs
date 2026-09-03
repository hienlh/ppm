// Open a cloudflared quick tunnel to a local dev port, retrying when Cloudflare's quick-tunnel
// API rate-limits the request (HTTP 429 / error 1015). Prints the public URL once issued and
// keeps the tunnel process alive until this script is stopped.
//
//   bun scripts/dev-quick-tunnel-retry.mjs 5174
import { spawn } from "node:child_process";

const port = process.argv[2] || "5173";
const bin = process.env.CLOUDFLARED || "cloudflared";
const maxAttempts = Number(process.env.TUNNEL_ATTEMPTS || 15);
const backoffMs = Number(process.env.TUNNEL_BACKOFF_MS || 60_000);

function attempt() {
  return new Promise((resolve) => {
    const proc = spawn(bin, ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.url) proc.kill();
      resolve({ ...result, proc });
    };
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) settle({ url: m[0] });
      else if (/429|error code: 1015|Too Many Requests/.test(buf)) settle({ rateLimited: true });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", () => settle({ exited: true }));
    const timer = setTimeout(() => settle({ timeout: true }), 30_000);
  });
}

for (let i = 1; i <= maxAttempts; i++) {
  const r = await attempt();
  if (r.url) {
    console.log(`TUNNEL_URL ${r.url}`);
    // Keep the tunnel alive; exit when cloudflared dies so the caller notices.
    await new Promise((res) => r.proc.on("exit", res));
    console.log("tunnel process exited");
    process.exit(1);
  }
  console.log(`attempt ${i}/${maxAttempts} failed (${r.rateLimited ? "rate-limited 429" : r.timeout ? "timeout" : "exited"}); retry in ${backoffMs / 1000}s`);
  await new Promise((res) => setTimeout(res, backoffMs));
}
console.log("GAVE UP");
process.exit(1);
