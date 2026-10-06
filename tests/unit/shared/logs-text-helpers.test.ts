/**
 * The small text rules behind Logs: what a bug report takes out before it leaves the machine,
 * which copies of a line count as one pattern for the AI, and how a browser is named.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_REDACT, redactedKinds, redactLogText } from "../../../src/shared/log-redact.ts";
import { logFingerprint, normalizeLogMessage } from "../../../src/shared/log-fingerprint.ts";
import { describeUserAgent, userAgentSummary, userAgentTag } from "../../../src/shared/user-agent-label.ts";

describe("redactLogText", () => {
  const text = "open /home/dev/Projects/velox/a.ts for dev@example.com in 53952680-0b07-4a2c-9d1e-0123456789ab via https://bright-fox-tree.trycloudflare.com";

  it("takes out home paths, emails and chat ids by default, and always the tunnel address", () => {
    expect(redactLogText(text, DEFAULT_REDACT)).toBe(
      "open ~/Projects/velox/a.ts for <email> in 53952680 via https://<tunnel>.trycloudflare.com",
    );
  });

  it("leaves what is switched off, but never the tunnel", () => {
    expect(redactLogText(text, { home: false, email: false, chats: false })).toBe(
      "open /home/dev/Projects/velox/a.ts for dev@example.com in 53952680-0b07-4a2c-9d1e-0123456789ab via https://<tunnel>.trycloudflare.com",
    );
  });

  it("replaces project names as whole words only", () => {
    const out = redactLogText("velox and velox-api and develox", { home: false, email: false, chats: false, projects: ["velox"] });
    expect(out).toBe("<project> and velox-api and develox");
  });

  it("covers macOS and Windows home folders", () => {
    expect(redactLogText("/Users/anna/x and C:\\Users\\anna\\y", DEFAULT_REDACT)).toBe("~/x and ~\\y");
  });

  it("covers a Windows home folder as a logged object writes it, and with forward slashes", () => {
    const logged = JSON.stringify({ cwd: "C:\\Users\\anna\\x" }); // {"cwd":"C:\\Users\\anna\\x"}
    expect(redactLogText(`${logged} and C:/Users/anna/y`, DEFAULT_REDACT)).toBe(`${JSON.stringify({ cwd: "~\\x" })} and ~/y`);
  });

  // What a process prints to its own stderr reaches ppm.log unredacted, and the write-time rules
  // key on a name, so these arrive here as they were printed.
  it("always takes out secrets, whatever the switches say", () => {
    const off = { home: false, email: false, chats: false };
    const cases: Array<[string, string]> = [
      ["key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 refused", "key [REDACTED] refused"],
      ["OpenAI: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "OpenAI: [REDACTED]"],
      ["push https://ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789@github.com/o/r", "push https://[REDACTED]@github.com/o/r"],
      ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz failed", "[REDACTED] failed"],
      ["id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "id [REDACTED]"],
      [
        "TypeError: fetch failed for https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe",
        "TypeError: fetch failed for https://api.telegram.org/bot123456789:[REDACTED]/getMe",
      ],
      ["connect postgres://admin:S3cr3t@db:5432/app failed", "connect postgres://admin:[REDACTED]@db:5432/app failed"],
      ["GET /ws/global?token=3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c&v=2", "GET /ws/global?token=[REDACTED]&v=2"],
      ["callback?code=4/0AY0e-g7abc&state=xyz123", "callback?code=[REDACTED]&state=[REDACTED]"],
      ["Authorization: Basic dXNlcjpwYXNz", "Authorization: [REDACTED]"],
      ['{"authorization":"Bearer 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"}', '{"authorization":"[REDACTED]"}'],
      ["sent Bearer 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c upstream", "sent Bearer [REDACTED] upstream"],
      ["Cookie: sid=abc123; theme=dark", "Cookie: [REDACTED]"],
      ['{"access_token":"at-123","refresh_token":"rt-456"}', '{"access_token":"[REDACTED]","refresh_token":"[REDACTED]"}'],
      ["  Token: 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c", "  Token: [REDACTED]"],
      ["PGPASSWORD=hunter2 psql", "PGPASSWORD=[REDACTED] psql"],
    ];
    for (const [input, out] of cases) expect(redactLogText(input, off)).toBe(out);
    expect(redactLogText("sent Bearer abcdefghijkl", off, true)).toBe("sent Bearer \u0001[REDACTED]\u0002");
  });

  it("leaves ordinary text alone, and what the write-time redactor took out as it was", () => {
    const off = { home: false, email: false, chats: false };
    for (const text of [
      "process exited with code 1",
      'spawn failed: {"code":"ENOENT","errno":-2}',
      "usage input_tokens: 1234 max_tokens=4096",
      "Basic authentication failed",
      "Cookie: missing, using the header",
      "GET /api/project/x/files?path=src/a.ts&line=3 200",
      "task-1234567890abcdefghijklmnop done",
      "Bearer [REDACTED] and token=[REDACTED] and Token: [REDACTED]",
    ]) expect(redactLogText(text, off)).toBe(text);
  });

  it("marks what it replaced for the preview", () => {
    expect(redactLogText("dev@example.com", DEFAULT_REDACT, true)).toBe("\u0001<email>\u0002");
  });

  it("names what it took out", () => {
    expect(redactedKinds(DEFAULT_REDACT)).toEqual(["secrets", "home paths", "emails", "chat ids"]);
    expect(redactedKinds({ home: false, email: false, chats: false, projects: ["x"] })).toEqual(["secrets", "project names"]);
  });
});

describe("logFingerprint", () => {
  const base = { src: "ai" as const, tag: "chat", lv: "error" as const };

  it("gives copies of one event the same fingerprint", () => {
    const a = logFingerprint({ ...base, msg: "session=53952680-0b07-4a2c-9d1e-0123456789ab turn failed after 1532ms: \"Rate limited\" (toolu_01ABC)" });
    const b = logFingerprint({ ...base, msg: "session=11112222-0b07-4a2c-9d1e-0123456789ab turn failed after 87ms: \"Overloaded\" (toolu_99XYZ)" });
    expect(a).toBe(b);
  });

  it("keeps different events, levels and tags apart", () => {
    const a = logFingerprint({ ...base, msg: "turn failed" });
    expect(logFingerprint({ ...base, msg: "turn started" })).not.toBe(a);
    expect(logFingerprint({ ...base, lv: "warn", msg: "turn failed" })).not.toBe(a);
    expect(logFingerprint({ ...base, tag: "sdk", msg: "turn failed" })).not.toBe(a);
  });

  it("treats short ids with digits in them as one placeholder", () => {
    expect(normalizeLogMessage("account a1 refresh failed: 401")).toBe(normalizeLogMessage("account b22 refresh failed: 500"));
  });

  it("counts FATAL with ERROR", () => {
    expect(logFingerprint({ ...base, lv: "fatal", msg: "x" })).toBe(logFingerprint({ ...base, msg: "x" }));
  });

  it("takes paths, urls and numbers out of the message", () => {
    expect(normalizeLogMessage("read /home/dev/a/b.ts from https://x.io/y in 12.5s (3 tries)")).toBe("read <path> from <url> in <n> (<n> tries)");
  });
});

describe("user agent names", () => {
  const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
  const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const IOS_EDGE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/131.0.2903.70 Mobile/15E148 Safari/605.1.15";
  const WIN_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
  const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

  it("names the browser, its major version and the system", () => {
    expect(userAgentSummary(MAC_CHROME)).toBe("Chrome 154 on macOS");
    expect(userAgentSummary(IOS_SAFARI)).toBe("Safari 18 on iOS");
    expect(userAgentSummary(IOS_EDGE)).toBe("Edge 131 on iOS");
    expect(userAgentSummary(WIN_EDGE)).toBe("Edge 131 on Windows");
    expect(userAgentSummary(LINUX_FIREFOX)).toBe("Firefox 140 on Linux");
  });

  it("makes a short tag for the tag column", () => {
    expect(userAgentTag(MAC_CHROME)).toBe("Chrome·Mac");
    expect(userAgentTag(IOS_SAFARI)).toBe("Safari·iOS");
    expect(userAgentTag("curl/8.0")).toBe("Browser");
  });

  it("does not guess at what it cannot read", () => {
    expect(describeUserAgent(undefined)).toEqual({ browser: "Browser", version: null, os: "Unknown OS" });
  });
});
