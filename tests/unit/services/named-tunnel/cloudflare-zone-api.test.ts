import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { fetchZoneName } from "../../../../src/services/named-tunnel/cloudflare-zone-api.ts";

const originalFetch = globalThis.fetch;

describe("fetchZoneName", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("returns the zone name on success", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ success: true, result: { name: "hienle.tech" } }),
      { status: 200 },
    )) as typeof fetch;

    const name = await fetchZoneName("a".repeat(32), "fake-token");
    expect(name).toBe("hienle.tech");
  });

  test("throws a secret-free error on HTTP failure", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ success: false, errors: [{ message: "invalid token" }] }),
      { status: 403 },
    )) as typeof fetch;

    await expect(fetchZoneName("a".repeat(32), "fake-token")).rejects.toThrow(/log in again/);
  });

  test("throws when the response body is not JSON", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    await expect(fetchZoneName("a".repeat(32), "fake-token")).rejects.toThrow();
  });

  test("sends the token as a Bearer header, never in the URL", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedAuth = init?.headers?.Authorization ?? "";
      return new Response(JSON.stringify({ success: true, result: { name: "hienle.tech" } }), { status: 200 });
    }) as typeof fetch;

    await fetchZoneName("a".repeat(32), "fake-token-value");
    expect(capturedUrl).not.toContain("fake-token-value");
    expect(capturedAuth).toBe("Bearer fake-token-value");
  });
});
