/**
 * The per-request log line: its level, and what it must never contain.
 *
 * The level is decided by what happened (a change, a read, a refused credential, a server
 * error) — and a 5xx carries the error message its response did, which route handlers
 * otherwise turn into a JSON body and log nowhere.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accessLog, accessLogLevel, describeRequestTarget, SLOW_REQUEST_MS,
} from "../../../src/server/middleware/access-log.ts";
import { installFileLogSink, setLogLevel, _resetLoggerForTests } from "../../../src/services/logger.ts";
import { STDIO_IS_LOG_ENV } from "../../../src/services/log-rotate.ts";

describe("level", () => {
  it("is decided by what happened", () => {
    expect(accessLogLevel("POST", "/api/projects", 200, 12)).toBe("info");
    expect(accessLogLevel("DELETE", "/api/fs/entry", 204, 3)).toBe("info");
    expect(accessLogLevel("GET", "/api/projects", 200, 3)).toBe("debug");
    expect(accessLogLevel("GET", "/api/projects", 404, 3)).toBe("debug");
    expect(accessLogLevel("POST", "/api/projects", 409, 3)).toBe("warn");
    expect(accessLogLevel("GET", "/api/settings", 401, 1)).toBe("warn");
    expect(accessLogLevel("GET", "/api/settings", 403, 1)).toBe("warn");
    expect(accessLogLevel("GET", "/api/files", 500, 1)).toBe("error");
    expect(accessLogLevel("GET", "/api/files", 200, SLOW_REQUEST_MS)).toBe("warn");
  });

  it("keeps the UI's own background sync out of INFO", () => {
    expect(accessLogLevel("POST", "/api/trace", 200, 2)).toBe("debug");
    expect(accessLogLevel("PUT", "/api/settings/ui-prefs", 200, 2)).toBe("debug");
    expect(accessLogLevel("PUT", "/api/project/ppm/workspace", 200, 2)).toBe("debug");
    expect(accessLogLevel("PUT", "/api/project/ppm/chat/drafts/abc", 200, 2)).toBe("debug");
    expect(accessLogLevel("PUT", "/api/project/ppm/git/commit-draft", 200, 2)).toBe("debug");
    expect(accessLogLevel("POST", "/api/project/ppm/chat/prewarm", 200, 2)).toBe("debug");
    expect(accessLogLevel("POST", "/api/system/resources/stream/s1/ping", 200, 2)).toBe("debug");
    expect(accessLogLevel("POST", "/api/accounts/pick", 200, 2)).toBe("debug");
    expect(accessLogLevel("POST", "/api/codex-accounts/pick", 200, 2)).toBe("debug");
    // …but not a failure of one.
    expect(accessLogLevel("PUT", "/api/project/ppm/workspace", 500, 2)).toBe("error");
  });
});

describe("request target", () => {
  it("replaces credential-like query values and keeps the rest", () => {
    const t = describeRequestTarget(new URL("http://x/api/project/p/files/raw?path=src/a.ts&token=abc&dl_token=def"));
    expect(t).toBe("/api/project/p/files/raw?path=src/a.ts&token=[REDACTED]&dl_token=[REDACTED]");
  });

  it("drops an OAuth code and state", () => {
    const t = describeRequestTarget(new URL("http://x/api/mcp-auth/callback?code=c0de&state=st4te"));
    expect(t).not.toContain("c0de");
    expect(t).not.toContain("st4te");
  });

  it("cuts the capability token out of a preview or export path", () => {
    expect(describeRequestTarget(new URL("http://x/api/html-preview/content/secrettoken/index.html")))
      .toBe("/api/html-preview/content/[token]/index.html");
    expect(describeRequestTarget(new URL("http://x/api/design-preview/content/t0k/")))
      .toBe("/api/design-preview/content/[token]/");
    expect(describeRequestTarget(new URL("http://x/api/db/grid-export/ticket123")))
      .toBe("/api/db/grid-export/[token]");
    expect(describeRequestTarget(new URL("http://x/api/remote-desktop/whep/Zm9vYmFyYmF6")))
      .toBe("/api/remote-desktop/whep/[token]");
  });
});

describe("middleware", () => {
  let dir: string;
  let logPath: string;
  let uninstall = () => {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ppm-access-log-"));
    logPath = join(dir, "ppm.log");
    _resetLoggerForTests();
    process.env[STDIO_IS_LOG_ENV] = "1"; // no echo
    uninstall = installFileLogSink({ echo: "console", path: logPath });
  });

  afterEach(() => {
    uninstall();
    delete process.env[STDIO_IS_LOG_ENV];
    _resetLoggerForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  const app = () => {
    const a = new Hono();
    a.use("*", accessLog);
    a.post("/api/projects", (c) => c.json({ ok: true }));
    a.get("/api/projects", (c) => c.json({ ok: true }));
    a.post("/api/git/commit", (c) => c.json({ ok: false, error: "nothing to commit" }, 500));
    a.post("/api/git/branch", (c) => c.json({ ok: false, error: "branch already exists" }, 409));
    a.post("/api/git/checkout", (c) => c.json({ ok: false, error: `no branch named ${c.req.query("name")}` }, 409));
    a.get("/api/settings", (c) => c.json({ ok: false, error: "Unauthorized" }, 401));
    a.get("/api/throws", () => { throw new Error("kaboom"); });
    // What src/server/index.ts installs: Hono's default handler without its console.error.
    a.onError((_e, c) => c.text("Internal Server Error", 500));
    return a;
  };
  const lines = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trimEnd().split("\n").filter(Boolean) : []);

  it("logs a change at INFO and leaves a read out at the default level", async () => {
    await app().request("/api/projects", { method: "POST" });
    await app().request("/api/projects");
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/\[INFO\] \[http\] POST \/api\/projects 200 \d+ms$/);
  });

  it("logs a read once DEBUG is on", async () => {
    setLogLevel("debug");
    await app().request("/api/projects");
    expect(lines().some((l) => /\[DEBUG\] \[http\] GET \/api\/projects 200/.test(l))).toBe(true);
  });

  it("puts a 5xx's own error message on the line", async () => {
    await app().request("/api/git/commit", { method: "POST" });
    expect(lines()[0]).toMatch(/\[ERROR\] \[http\] POST \/api\/git\/commit 500 \d+ms — nothing to commit$/);
  });

  it("puts a 4xx's error message on the line, so a fault turned into a 409 still says what failed", async () => {
    await app().request("/api/git/branch", { method: "POST" });
    expect(lines()[0]).toMatch(/\[WARN\] \[http\] POST \/api\/git\/branch 409 \d+ms — branch already exists$/);
  });

  it("writes the query string without its credentials", async () => {
    // `code` and `state` are an OAuth callback's: nothing but the access log's own redaction
    // removes them (`redactSecrets` knows `token=`, not these).
    await app().request("/api/projects?code=c0de&state=st4te&path=src/a.ts", { method: "POST" });
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("POST /api/projects?code=[REDACTED]&state=[REDACTED]&path=src/a.ts 200");
    expect(out[0]).not.toContain("c0de");
    expect(out[0]).not.toContain("st4te");
  });

  // A decoded `%0A` that reached the file as a newline would start a record of the caller's
  // choosing, and this line is written for requests that never signed in.
  const FORGED = "[2026-10-06T00:00:00.000Z] [ERROR] [auth] forged";

  it("keeps a decoded query string on the request's own line", async () => {
    const res = await app().request(`/api/settings?q=${encodeURIComponent(`x\r\n${FORGED}\u001b[2J`)}`);
    expect(res.status).toBe(401);
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(`[WARN] [http] GET /api/settings?q=x\\r\\n${FORGED}\\u001b[2J 401`);
  });

  it("keeps an error message that quotes input on the request's own line", async () => {
    await app().request(`/api/git/checkout?name=${encodeURIComponent(`main\n${FORGED}`)}`, { method: "POST" });
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/\[WARN\] \[http\] POST \/api\/git\/checkout\?name=main\\n\[2026-10-06T00:00:00\.000Z\] \[ERROR\] \[auth\] forged 409 \d+ms — no branch named main\\n\[2026-10-06T00:00:00\.000Z\] \[ERROR\] \[auth\] forged$/);
  });

  it("logs a thrown error once, on the request's line, with its stack", async () => {
    const res = await app().request("/api/throws");
    expect(res.status).toBe(500);
    const text = readFileSync(logPath, "utf8");
    expect(text).toMatch(/\[ERROR\] \[http\] GET \/api\/throws 500 \d+ms — Error: kaboom\n\s+at /);
    expect(text.match(/\[ERROR\]/g)).toHaveLength(1);
  });
});
