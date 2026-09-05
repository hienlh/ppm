import { describe, test, expect } from "bun:test";
import { extractLoginUrl, isLoginSuccess } from "../../../../src/services/named-tunnel/login-output-parser.ts";

// Verbatim stderr captured 2026-09-05 (cloudflared 2026.3.0) — the real test fixture.
const REAL_STDERR = `A browser window should have opened at the following URL:

https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2F1234567890123456789012345678901234567890123%3D

If the browser failed to open, please visit the URL above directly in your browser.
2026-09-05T04:02:03Z INF Waiting for login...
2026-09-05T04:07:14Z INF You have successfully logged in.
If you wish to copy your credentials to a server, they have been saved to:
C:\\Users\\PC\\.cloudflared\\cert.pem`;

describe("extractLoginUrl", () => {
  test("finds the URL in the real stderr fixture", () => {
    const url = extractLoginUrl(REAL_STDERR);
    expect(url).toBe(
      "https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2F1234567890123456789012345678901234567890123%3D",
    );
  });

  test("finds nothing in a 'Waiting for login...' line alone", () => {
    expect(extractLoginUrl("2026-09-05T04:02:03Z INF Waiting for login...")).toBeNull();
  });

  test("returns null when no URL is present at all", () => {
    expect(extractLoginUrl("nothing to see here")).toBeNull();
  });

  test("fallback parser catches a differently-shaped argotunnel URL", () => {
    const text = "please visit https://dash.cloudflare.com/argotunnel/weird-shape-1234 to continue";
    expect(extractLoginUrl(text)).toBe("https://dash.cloudflare.com/argotunnel/weird-shape-1234");
  });

  test("fallback ignores an https URL on a line that does not mention argotunnel", () => {
    expect(extractLoginUrl("see https://example.com/unrelated for details")).toBeNull();
  });
});

describe("isLoginSuccess", () => {
  test("true on the real success line", () => {
    expect(isLoginSuccess(REAL_STDERR)).toBe(true);
  });

  test("false on the waiting line alone", () => {
    expect(isLoginSuccess("2026-09-05T04:02:03Z INF Waiting for login...")).toBe(false);
  });

  test("false on empty output", () => {
    expect(isLoginSuccess("")).toBe(false);
  });
});
