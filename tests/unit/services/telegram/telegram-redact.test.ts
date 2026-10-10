import { describe, expect, it } from "bun:test";
import { redactForTelegram, redactSecretsForTelegram } from "../../../../src/services/telegram/telegram-html-format.ts";

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
  "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe("redactSecretsForTelegram", () => {
  it("hides a whole private key and says how many things it hid", () => {
    const { text, hidden } = redactSecretsForTelegram(`key:\n${PEM}\ndone`);
    expect(text).toBe("key:\n-----BEGIN RSA PRIVATE KEY-----[REDACTED]\ndone");
    expect(hidden).toBe(1);
  });

  it("hides a key that was cut off before its end line", () => {
    const cut = PEM.split("\n").slice(0, 2).join("\n");
    expect(redactForTelegram(`here ${cut}`)).toBe("here -----BEGIN RSA PRIVATE KEY-----[REDACTED]");
  });

  it("hides AWS, Stripe, Slack and Google keys", () => {
    const secrets = [
      "AKIAIOSFODNN7EXAMPLE",
      "ASIAIOSFODNN7EXAMPLE",
      `sk_live_${"a".repeat(24)}`,
      `rk_live_${"b".repeat(24)}`,
      `pk_live_${"c".repeat(24)}`,
      `xoxb-${"1".repeat(12)}-${"d".repeat(24)}`,
      `xoxp-${"2".repeat(12)}-abc`,
      `AIza${"e".repeat(35)}`,
    ];
    const { text, hidden } = redactSecretsForTelegram(secrets.join(" and "));
    for (const s of secrets) expect(text).not.toContain(s);
    expect(hidden).toBe(secrets.length);
  });

  it("hides a password in a connection string, in its query and in its userinfo", () => {
    const out = redactForTelegram([
      "Server=db;Database=app;User Id=sa;Pwd=hunter2;",
      "postgres://app:s3cret@db:5432/app",
      "mysql://db/app?password=s3cret&ssl=true",
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ].join("\n"));
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("wJalrXUtnFEMI");
    expect(out).toContain("Pwd=[REDACTED]");
    expect(out).toContain("postgres://app:[REDACTED]@db:5432/app");
  });

  it("keeps PPM's own tunnel and Tailscale links as they are", () => {
    const text = "Open https://quiet-river-bend-42.trycloudflare.com/assistant?session=claude/abc or https://ppm.tail1234.ts.net/";
    expect(redactSecretsForTelegram(text)).toEqual({ text, hidden: 0 });
  });

  it("still hides the Logs window's secrets, and leaves home paths, emails and chat ids", () => {
    const token = `123456789:AA${"x".repeat(33)}`;
    const out = redactForTelegram(`bot ${token} key sk-ant-${"y".repeat(30)} /home/dev a@b.co 53952680-0b07-4c1e-9d3a-1b2c3d4e5f60`);
    expect(out).toContain("123456789:[REDACTED]");
    expect(out).not.toContain("sk-ant-");
    expect(out).toContain("/home/dev a@b.co 53952680-0b07-4c1e-9d3a-1b2c3d4e5f60");
  });

  it("finds nothing more to hide the second time", () => {
    const once = redactForTelegram(`${PEM}\nAKIAIOSFODNN7EXAMPLE password=abc https://a-b.trycloudflare.com`);
    expect(redactSecretsForTelegram(once)).toEqual({ text: once, hidden: 0 });
  });
});
