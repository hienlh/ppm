import { describe, it, expect } from "bun:test";
import { redactSecrets } from "../../../src/services/memory/memory-redact.ts";

// Every value below is invented for this test; none is a real credential.
const SK_ANT = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789";
const SK_PROJ = "sk-proj-FAKEfake0123456789FAKEfake0123";
const GHP = "ghp_FAKEfakeFAKEfake0123456789FAKEfake01";
const GHO = "gho_FAKEfakeFAKEfake0123456789FAKEfake01";
const GITHUB_PAT = "github_pat_11FAKEFAKE0123456789_FAKEfakeFAKEfakeFAKEfake0123456789";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIn0.FAKEsignatureFAKEsignature01";
const PEM_RSA = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
  "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0123",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const PEM_OPENSSH = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

function expectRedacted(input: string, secret: string, count = 1) {
  const out = redactSecrets(input);
  expect(out.text).not.toContain(secret);
  expect(out.text).toContain("[REDACTED]");
  expect(out.count).toBe(count);
  return out;
}

describe("redactSecrets: API keys", () => {
  it("redacts an Anthropic sk-ant- key in prose", () => {
    const out = expectRedacted(`The key is ${SK_ANT} for staging.`, SK_ANT);
    expect(out.text).toBe("The key is [REDACTED] for staging.");
  });

  it("redacts a plain sk- key", () => {
    expectRedacted(`export OPENAI=${SK_PROJ}`, SK_PROJ);
  });

  it("redacts ghp_, gho_ and github_pat_ tokens", () => {
    expectRedacted(`clone with ${GHP}`, GHP);
    expectRedacted(`oauth ${GHO} here`, GHO);
    expectRedacted(`pat: ${GITHUB_PAT}`, GITHUB_PAT);
  });

  it("does not touch words that merely contain sk-", () => {
    const text = "Run the task-runner on a risk-free branch; ask-me-anything later.";
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });
});

describe("redactSecrets: Bearer tokens and JWTs", () => {
  it("redacts the value after Bearer and keeps the scheme", () => {
    const token = "FAKEbearer0123456789abcdef";
    const out = expectRedacted(`Authorization: Bearer ${token}`, token);
    expect(out.text).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts a bare JWT", () => {
    const out = expectRedacted(`session cookie ${JWT} expired`, JWT);
    expect(out.text).toBe("session cookie [REDACTED] expired");
  });

  it("counts a Bearer JWT once", () => {
    expectRedacted(`curl -H "Authorization: Bearer ${JWT}"`, JWT, 1);
  });
});

describe("redactSecrets: PEM private keys", () => {
  it("redacts a whole RSA private key block", () => {
    const out = expectRedacted(`Key:\n${PEM_RSA}\nDone.`, "MIIEFAKE");
    expect(out.text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out.text).toBe("Key:\n[REDACTED]\nDone.");
  });

  it("redacts an OpenSSH private key block", () => {
    expectRedacted(PEM_OPENSSH, "b3BlbnNzaC1rZXktdjE");
  });

  it("leaves a certificate (not a private key) alone", () => {
    const text = "-----BEGIN CERTIFICATE-----\nMIIBFAKECERT\n-----END CERTIFICATE-----";
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });
});

describe("redactSecrets: assignments", () => {
  it("redacts password= unquoted and keeps the key", () => {
    const out = expectRedacted("password=FakePass123!", "FakePass123!");
    expect(out.text).toBe("password=[REDACTED]");
  });

  it("redacts passwd: with a space after the colon", () => {
    const out = expectRedacted("passwd: hunter2hunter2", "hunter2hunter2");
    expect(out.text).toBe("passwd: [REDACTED]");
  });

  it("redacts a double-quoted token value and keeps the quotes", () => {
    const out = expectRedacted('token = "abcdefgh12345678"', "abcdefgh12345678");
    expect(out.text).toBe('token = "[REDACTED]"');
  });

  it("redacts a single-quoted secret value", () => {
    const out = expectRedacted("secret: 'FAKEsecretVALUE99'", "FAKEsecretVALUE99");
    expect(out.text).toBe("secret: '[REDACTED]'");
  });

  it("redacts api_key and apikey in any case", () => {
    expectRedacted("API_KEY=FAKEapiKEY0001", "FAKEapiKEY0001");
    expectRedacted("apikey: FAKEapiKEY0002", "FAKEapiKEY0002");
  });

  it("redacts a JSON key/value pair", () => {
    const out = expectRedacted('{"client_secret": "FAKEclientSECRET42", "name": "demo"}', "FAKEclientSECRET42");
    expect(out.text).toBe('{"client_secret": "[REDACTED]", "name": "demo"}');
  });

  it("redacts prefixed keys such as GITHUB_TOKEN and a token in a URL query", () => {
    expectRedacted("GITHUB_TOKEN=FAKEgithubTOKEN77", "FAKEgithubTOKEN77");
    expectRedacted("https://example.test/hook?token=FAKEquery12345&x=1", "FAKEquery12345");
  });

  it("does not redact a value shorter than 8 characters", () => {
    for (const text of ["password=abc123", "token: short", 'secret = "1234567"']) {
      expect(redactSecrets(text)).toEqual({ text, count: 0 });
    }
  });

  it("does not redact a quoted value containing spaces", () => {
    const text = 'password: "correct horse battery staple"';
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });

  it("counts a key-shaped value inside an assignment once", () => {
    expectRedacted(`api_key = "${SK_ANT}"`, SK_ANT, 1);
  });
});

describe("redactSecrets: prose and counting", () => {
  it("leaves ordinary prose about tokens and passwords untouched", () => {
    const text = [
      "Rotate the token every month and never share your password with anyone.",
      "The tokenizer splits text into tokens; a secret santa is not a secret key.",
      "Use Bearer authentication over HTTPS. Password resets go through email.",
    ].join("\n");
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });

  it("returns the text unchanged with count 0 when nothing matches", () => {
    expect(redactSecrets("")).toEqual({ text: "", count: 0 });
    expect(redactSecrets("plain notes")).toEqual({ text: "plain notes", count: 0 });
  });

  it("counts every redaction in a mixed document", () => {
    const input = [
      "# Deploy notes",
      `ANTHROPIC_API_KEY=${SK_ANT}`,
      `GitHub: ${GHP}`,
      `Authorization: Bearer ${JWT}`,
      "db password=FakeDbPass2026",
      PEM_RSA,
      "Remember to rotate the token.",
    ].join("\n");
    const out = redactSecrets(input);
    expect(out.count).toBe(5);
    for (const secret of [SK_ANT, GHP, JWT, "FakeDbPass2026", "MIIEFAKE"]) {
      expect(out.text).not.toContain(secret);
    }
    expect(out.text).toContain("# Deploy notes");
    expect(out.text).toContain("Remember to rotate the token.");
  });

  it("is idempotent: redacting a redacted text changes nothing", () => {
    const once = redactSecrets(`token: "FAKEtoken123456"\nkey ${SK_PROJ}`);
    expect(once.count).toBe(2);
    expect(redactSecrets(once.text)).toEqual({ text: once.text, count: 0 });
  });
});
