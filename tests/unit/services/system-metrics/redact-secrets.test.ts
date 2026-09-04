import { describe, test, expect } from "bun:test";
import { redactSecrets } from "../../../../src/services/redact-secrets.ts";
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
