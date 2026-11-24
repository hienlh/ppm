import { describe, expect, it } from "bun:test";
import { isPublicTunnelRequest } from "../../../../src/services/web-browser/tunnel-request-guard.ts";

const check = (headers: Record<string, string>, host?: string, publicHosts: string[] = []) =>
  isPublicTunnelRequest(new Headers(headers), host, publicHosts);

describe("isPublicTunnelRequest", () => {
  it.each([
    ["cf-ray", "abc"], ["CF-Connecting-IP", "1.2.3.4"], ["cdn-loop", "cloudflare"],
    ["forwarded", "for=1.2.3.4"], ["via", "1.1 caddy"], ["x-real-ip", "1.2.3.4"],
    ["true-client-ip", "1.2.3.4"], ["x-forwarded-for", "1.2.3.4"], ["X-Forwarded-Proto", "https"],
    ["tailscale-funnel-request", "?1"],
  ])("%s marks the request public", (name, value) => {
    expect(check({ [name]: value })).toBe(true);
  });

  it("treats a tailnet member's identity headers alone as private", () => {
    expect(check({ "tailscale-user-login": "me@example.com", "tailscale-user-name": "Me" })).toBe(false);
  });

  it("treats Tailscale Serve (user headers, X-Forwarded-*, a .ts.net host) as the tailnet", () => {
    const serve = { "tailscale-user-login": "me@example.com", "x-forwarded-for": "100.64.0.7", "x-forwarded-proto": "https" };
    expect(check(serve, "ppm.tail1234.ts.net")).toBe(false);
    // The same headers on another host are a public proxy pretending to be Tailscale.
    expect(check(serve, "abc.ngrok.app")).toBe(true);
    expect(check({ ...serve, "cf-ray": "x" }, "ppm.tail1234.ts.net")).toBe(true);
  });

  it("treats a funnel request as public even with user headers", () => {
    expect(check({ "tailscale-user-login": "me@example.com", "tailscale-funnel-request": "?1" })).toBe(true);
  });

  it("matches PPM's own public hostnames by Host", () => {
    expect(check({}, "PPM.Example.com", ["ppm.example.com"])).toBe(true);
    expect(check({}, "192.168.1.50:8080", ["ppm.example.com"])).toBe(false);
  });

  it("lets a plain LAN request through", () => {
    expect(check({ accept: "*/*", "user-agent": "x" }, "localhost:8080", ["ppm.example.com"])).toBe(false);
  });
});
