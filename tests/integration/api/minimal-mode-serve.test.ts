/**
 * Minimal mode through the real `__serve__` process. `minimal-mode.test.ts` goes through
 * `app.request`, which never reaches `Bun.serve`'s own fetch handler — and that handler once
 * answered every disabled HTTP route with plain text before Hono could send its JSON error,
 * so the browser showed "Server error (HTTP 403)" instead of the reason.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmRetrying } from "../../helpers/rm-retrying";

const home = mkdtempSync(join(tmpdir(), "ppm-minimal-serve-"));
const logFile = join(home, "serve.log");
let proc: ReturnType<typeof Bun.spawn> | undefined;
let base = "";

beforeAll(async () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  // Without these the child would notify the live service manager (see supervisor-resilience).
  const { INVOCATION_ID: _invocation, NOTIFY_SOCKET: _socket, ...inherited } = process.env;
  const logFd = openSync(logFile, "a");
  proc = Bun.spawn({
    cmd: [process.execPath, resolve(import.meta.dir, "../../../src/server/index.ts"), "__serve__", String(port), "127.0.0.1", "--minimal"],
    stdio: ["ignore", logFd, logFd],
    env: {
      ...inherited, NODE_ENV: "test", PPM_HOME: home, HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
    },
  });
  // The child has its own copy; ours left open would stop Windows deleting `home`.
  closeSync(logFd);
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not listening yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`minimal server did not start:\n${readFileSync(logFile, "utf-8").slice(-2000)}`);
}, 30_000);

afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  await rmRetrying(home);
});

describe("minimal mode on the real server", () => {
  test("a disabled HTTP route answers with the JSON error", async () => {
    const res = await fetch(`${base}/api/db/connections`);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).error).toContain("minimal mode");
  });

  test("a disabled socket is refused before authentication, a chat socket is not", async () => {
    const terminal = await fetch(`${base}/ws/project/demo/terminal/1`);
    expect(terminal.status).toBe(403);
    expect(await terminal.text()).toBe("Unavailable in minimal mode");
    // No token: reaching the auth check is what proves the minimal guard let it through.
    expect((await fetch(`${base}/ws/project/demo/chat/s1`)).status).toBe(401);
  });
});
