import { describe, it, expect } from "bun:test";
import { redactTruncate } from "../../../src/providers/codex-app-server/codex-redact.ts";

describe("redactTruncate", () => {
  it("truncates strings longer than max and notes the count", () => {
    const out = redactTruncate("x".repeat(100), 10);
    expect(out.startsWith("xxxxxxxxxx")).toBe(true);
    expect(out).toContain("truncated 90 chars");
  });
  it("leaves short strings untouched", () => {
    expect(redactTruncate("hello", 100)).toBe("hello");
  });
  it("serializes objects to JSON", () => {
    expect(redactTruncate({ a: 1 })).toBe('{"a":1}');
  });
  it("scrubs obvious secrets", () => {
    const out = redactTruncate("key sk-abcdef0123456789abcd here");
    expect(out).not.toContain("sk-abcdef0123456789abcd");
    expect(out).toContain("sk-***");
  });
  it("never returns full payload when over max", () => {
    const secret = "TOPSECRETVALUE";
    const out = redactTruncate(secret.repeat(2000), 50);
    expect(out.length).toBeLessThan(secret.length * 2000);
  });
});
