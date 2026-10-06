import { describe, test, expect } from "bun:test";
import { redactSecrets, redactForBugReport } from "../../../../src/services/redact-secrets.ts";
import { sanitizeCommand, COMMAND_MAX_CHARS } from "../../../../src/services/system-metrics/process-rows-builder.ts";

describe("redactSecrets", () => {
  test("covers the six rules the /api/logs/recent route relied on", () => {
    const out = redactSecrets(
      "Token: abc Bearer xyz password: hunter2 api_key=k1 ANTHROPIC_API_KEY=sk-ant-1 secret: s3",
    );
    expect(out).not.toContain("abc");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("k1");
    expect(out).not.toContain("sk-ant-1");
    expect(out).not.toContain("s3");
    expect(out).toContain("ANTHROPIC_API_KEY=[REDACTED]");
  });

  test("argv `key=value` forms are redacted after the key", () => {
    expect(redactSecrets("node x.js --token=abc123 DB_PASSWORD=pw API_KEY=k")).toBe(
      "node x.js --token=[REDACTED] DB_PASSWORD=[REDACTED] API_KEY=[REDACTED]",
    );
  });

  test("argv space form `--token abc` / `--api-key abc` is redacted after the flag", () => {
    const out = redactSecrets("claude --token abc123 --api-key k9 x");
    expect(out).toBe("claude --token [REDACTED] --api_key: [REDACTED] x"); // api-key form is normalised by the older log rule
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("k9");
  });

  test("URL userinfo keeps the user and drops the password", () => {
    expect(redactSecrets('psql "postgres://app:s3cret@db.internal:5432/x"')).toBe('psql "postgres://app:[REDACTED]@db.internal:5432/x"');
    expect(redactSecrets("https://user@host/")).toBe("https://user@host/");
    expect(redactSecrets("https://host:8080/path")).toBe("https://host:8080/path");
  });

  test("Telegram bot token keeps the bot id and drops the secret, in a URL or bare", () => {
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
    expect(redactSecrets(`fetch failed: https://api.telegram.org/bot${token}/getUpdates`))
      .toBe("fetch failed: https://api.telegram.org/bot123456789:[REDACTED]/getUpdates");
    expect(redactSecrets(`token ${token}`)).toBe("token 123456789:[REDACTED]");
    expect(redactSecrets("[2026-10-06T03:06:13.123Z] [INFO] [http] GET /api/x 200 3ms")).toBe("[2026-10-06T03:06:13.123Z] [INFO] [http] GET /api/x 200 3ms");
  });

  test("an ntfy topic quoted in a refusal and a MediaMTX path name are cut out", () => {
    expect(redactSecrets('This access token may not publish to "alerts-x7Kq9" on ntfy.sh (forbidden)'))
      .toBe('This access token may not publish to "[topic]" on ntfy.sh (forbidden)');
    expect(redactSecrets("rtsp://127.0.0.1:8554/s0123456789abcdef0123456789abcdef exited"))
      .toBe("rtsp://127.0.0.1:8554/[stream] exited");
    expect(redactSecrets("session 2f0c1d3e-4b5a-6789-abcd-ef0123456789")).toBe("session 2f0c1d3e-4b5a-6789-abcd-ef0123456789");
  });

  test("a bug report also drops a quick tunnel's hostname, which ppm.log keeps", () => {
    const line = "[INFO] [tunnels] tunnel started for port 5173 → https://brave-otter-12ab.trycloudflare.com Bearer abc";
    expect(redactForBugReport(line)).toBe("[INFO] [tunnels] tunnel started for port 5173 → https://[tunnel].trycloudflare.com Bearer [REDACTED]");
    expect(redactSecrets(line)).toContain("brave-otter-12ab.trycloudflare.com");
  });

  test("leaves ordinary command lines alone", () => {
    const cmd = "C:\\Users\\x\\.bun\\bin\\bun.exe src/server/index.ts --port 8081";
    expect(redactSecrets(cmd)).toBe(cmd);
  });
});

describe("sanitizeCommand", () => {
  test("redacts BEFORE truncating, so a long argv cannot smuggle a secret past the cut", () => {
    const secret = "ANTHROPIC_API_KEY=sk-ant-verysecret";
    const cmd = `${secret} node ${"x".repeat(400)}`;
    const out = sanitizeCommand(cmd, "node");
    expect(out.length).toBeLessThanOrEqual(COMMAND_MAX_CHARS);
    expect(out).not.toContain("verysecret");
    expect(out.startsWith("ANTHROPIC_API_KEY=[REDACTED]")).toBe(true);
  });

  test("null/empty falls back to the name", () => {
    expect(sanitizeCommand(null, "svchost")).toBe("svchost");
    expect(sanitizeCommand("", "svchost")).toBe("svchost");
  });
});
