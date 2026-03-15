import { describe, test, expect } from "bun:test";
import { extractTunnelUrl } from "../../../src/services/tunnel.service.ts";

describe("tunnel.service", () => {
  describe("extractTunnelUrl", () => {
    test("parses URL from older banner format", () => {
      const stderr = `
2024-01-01T00:00:00Z INF +-------------------------------------------+
2024-01-01T00:00:00Z INF |  Your quick Tunnel has been created!
2024-01-01T00:00:00Z INF |  https://random-words-here.trycloudflare.com
2024-01-01T00:00:00Z INF +-------------------------------------------+
`;
      expect(extractTunnelUrl(stderr)).toBe("https://random-words-here.trycloudflare.com");
    });

    test("parses URL from newer log format", () => {
      const stderr = `2024-01-01T00:00:00Z INF Registered tunnel connection connIndex=0 connection=abc url=https://my-tunnel-name.trycloudflare.com`;
      expect(extractTunnelUrl(stderr)).toBe("https://my-tunnel-name.trycloudflare.com");
    });

    test("returns null when no URL found", () => {
      const stderr = `2024-01-01T00:00:00Z INF Starting tunnel\n2024-01-01T00:00:00Z INF Connecting...`;
      expect(extractTunnelUrl(stderr)).toBeNull();
    });

    test("returns first match when multiple URLs present", () => {
      const stderr = `
INF url=https://first-tunnel.trycloudflare.com
INF url=https://second-tunnel.trycloudflare.com
`;
      expect(extractTunnelUrl(stderr)).toBe("https://first-tunnel.trycloudflare.com");
    });

    test("handles single-word subdomain", () => {
      expect(extractTunnelUrl("url=https://abcdef.trycloudflare.com")).toBe(
        "https://abcdef.trycloudflare.com",
      );
    });

    test("handles hyphenated subdomain", () => {
      expect(extractTunnelUrl("url=https://a-b-c-d-e.trycloudflare.com")).toBe(
        "https://a-b-c-d-e.trycloudflare.com",
      );
    });
  });
});
