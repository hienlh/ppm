/**
 * Diagnostic: compare the wire signature (User-Agent + headers) that the `claude`
 * binary sends to api.anthropic.com across different spawn modes.
 *
 * WHY: From 2026-06-15 Anthropic bills "programmatic" (Agent SDK / claude -p /
 * third-party apps) from a separate credit pool, while "interactive" Claude Code
 * keeps drawing from the subscription. The classification signal is the request
 * the client sends — primarily User-Agent and metadata headers. This script
 * captures those headers per mode so we can see whether interactive vs headless
 * are actually distinguishable at the wire level.
 *
 * NOTE: This only compares the request SIGNATURE. It does NOT prove which billing
 * bucket gets charged — that can only be confirmed in the Anthropic Console usage
 * page on/after 2026-06-15. Today (pre-15) everything still bills to subscription.
 *
 * The proxy short-circuits with 401 (never forwards) → no tokens are spent and no
 * valid auth is required. Secrets in captured headers are redacted.
 *
 * Run:  bun verify-billing-signature.ts
 * Then follow the printed instructions to also capture the INTERACTIVE signature.
 */

const PORT = 8899;
const PROXY_URL = `http://localhost:${PORT}`;
const IS_WIN = process.platform === "win32";

// Headers most likely to carry the interactive-vs-programmatic classification signal.
const HIGHLIGHT = [
  "user-agent",
  "x-app",
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "x-stainless-runtime",
  "x-stainless-package-version",
  "x-stainless-helper-method",
  "x-stainless-os",
  "x-stainless-lang",
];
const SECRET = ["authorization", "x-api-key", "cookie"];

interface Capture { label: string; method: string; path: string; headers: Record<string, string>; }
const captures: Capture[] = [];
let currentLabel = "(unlabeled)";

function redact(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET.includes(k.toLowerCase()) ? `<redacted len=${v.length} prefix=${v.slice(0, 8)}...>` : v;
  }
  return out;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = redact(Object.fromEntries(req.headers.entries()));
    // Only record the main inference call; ignore oauth/telemetry pings noise but still log path.
    captures.push({ label: currentLabel, method: req.method, path: url.pathname, headers });
    return new Response(
      JSON.stringify({ type: "error", error: { type: "authentication_error", message: "proxy-capture: stop here" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  },
});
console.log(`[proxy] listening on ${PROXY_URL}\n`);

const env = { ...process.env, ANTHROPIC_BASE_URL: PROXY_URL } as Record<string, string>;

/** Run an async fn but never block longer than ms. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

// ── Mode 1: `claude -p` (headless print) ──
async function runClaudePrint() {
  currentLabel = "claude -p (headless)";
  console.log(`[run] ${currentLabel} ...`);
  try {
    const proc = Bun.spawn(["claude", "-p", "say hi"], { env, stdout: "pipe", stderr: "pipe" });
    const t = setTimeout(() => proc.kill(), 8000);
    await proc.exited;
    clearTimeout(t);
  } catch (e) {
    console.warn(`[run] ${currentLabel} spawn failed:`, (e as Error).message);
  }
}

// ── Mode 2: Agent SDK query() — exactly what PPM uses ──
async function runSdkQuery() {
  currentLabel = "SDK query() (headless)";
  console.log(`[run] ${currentLabel} ...`);
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const q = query({
      prompt: "say hi",
      options: {
        cwd: process.cwd(),
        env,
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        ...(IS_WIN && { executable: "node" as const }),
      } as any,
    });
    await withTimeout(
      (async () => { for await (const _ of q) break; })(),
      8000,
    );
  } catch (e) {
    console.warn(`[run] ${currentLabel} failed:`, (e as Error).message);
  }
}

function dump(label: string) {
  const rows = captures.filter((c) => c.label === label);
  console.log(`\n===== ${label} =====`);
  if (rows.length === 0) { console.log("  (no requests captured — client may have errored before calling, or `claude` not on PATH)"); return; }
  for (const r of rows) {
    console.log(`  ${r.method} ${r.path}`);
    for (const h of HIGHLIGHT) if (r.headers[h] !== undefined) console.log(`    ${h}: ${r.headers[h]}`);
  }
}

await runClaudePrint();
await runSdkQuery();

dump("claude -p (headless)");
dump("SDK query() (headless)");

console.log(`\n----------------------------------------------------------------`);
console.log(`Now capture the INTERACTIVE signature. In a SEPARATE terminal run:`);
console.log(IS_WIN
  ? `  $env:ANTHROPIC_BASE_URL="${PROXY_URL}"; claude`
  : `  ANTHROPIC_BASE_URL="${PROXY_URL}" claude`);
console.log(`Type "say hi" + Enter. It will error (expected) — we only need the headers.`);
console.log(`This window stays open 90s to capture it, then prints the diff...\n`);

currentLabel = "interactive TUI";
await new Promise((r) => setTimeout(r, 90_000));
dump("interactive TUI");

// ── Diff the User-Agent across modes (the key classification field) ──
console.log(`\n===== User-Agent comparison =====`);
for (const label of ["claude -p (headless)", "SDK query() (headless)", "interactive TUI"]) {
  const ua = captures.find((c) => c.label === label)?.headers["user-agent"] ?? "(none)";
  console.log(`  ${label.padEnd(26)} → ${ua}`);
}
console.log(`\nIf interactive UA/headers are IDENTICAL to headless → no technical basis to`);
console.log(`differentiate; PPM cannot present as interactive. If DIFFERENT → there is a`);
console.log(`wire-level difference (still ToS-grey to exploit; confirm bucket in Console`);
console.log(`on/after 2026-06-15 before relying on it).`);

server.stop();
process.exit(0);
