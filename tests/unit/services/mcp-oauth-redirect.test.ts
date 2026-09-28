import { describe, it, expect } from "bun:test";
import { callbackUrlFor, customRedirectUri, needsAuthServerNames } from "../../../src/services/mcp-oauth/mcp-oauth-redirect.ts";
import { handleMcpAuthorized, type McpSignInSession } from "../../../src/server/ws/chat-mcp-sign-in-sync.ts";

describe("customRedirectUri", () => {
  it("returns PPM's callback for an https origin that is the request's host", () => {
    expect(customRedirectUri("https://ppm.example.com", [undefined, "ppm.example.com"]))
      .toBe("https://ppm.example.com/api/mcp-auth/callback");
    // Behind a proxy the public host arrives as X-Forwarded-Host.
    expect(customRedirectUri("https://abc.trycloudflare.com", ["abc.trycloudflare.com", "localhost:8080"]))
      .toBe("https://abc.trycloudflare.com/api/mcp-auth/callback");
  });

  it("leaves plain http to the CLI's own localhost listener", () => {
    expect(customRedirectUri("http://192.168.1.5:8080", [undefined, "192.168.1.5:8080"])).toBeUndefined();
    expect(customRedirectUri("http://localhost:8080", [undefined, "localhost:8080"])).toBeUndefined();
  });

  it("refuses an origin the request did not arrive on", () => {
    expect(customRedirectUri("https://evil.example", [undefined, "ppm.example.com"])).toBeUndefined();
    expect(customRedirectUri("https://user:pw@ppm.example.com", [undefined, "ppm.example.com"])).toBeUndefined();
    expect(customRedirectUri("not a url", ["x"])).toBeUndefined();
    expect(customRedirectUri(undefined, ["x"])).toBeUndefined();
  });
});

describe("needsAuthServerNames", () => {
  it("keeps only needs-auth servers, once each, in order", () => {
    expect(needsAuthServerNames([
      { name: "vanta", status: "needs-auth" },
      { name: "blender", status: "connected" },
      { name: "plugin:marketing:slack", status: "needs-auth" },
      { name: "vanta", status: "needs-auth" },
      { status: "needs-auth" },
      null,
    ])).toEqual(["vanta", "plugin:marketing:slack"]);
    expect(needsAuthServerNames(undefined)).toEqual([]);
  });
});

describe("callbackUrlFor", () => {
  it("rebuilds the redirect on the URI the flow was started with, not the local request URL", () => {
    expect(callbackUrlFor("https://ppm.example.com/api/mcp-auth/callback", "?code=abc&state=s1"))
      .toBe("https://ppm.example.com/api/mcp-auth/callback?code=abc&state=s1");
  });
});

describe("handleMcpAuthorized", () => {
  function deps(sessions: Record<string, McpSignInSession>, reconnectStatus: string | null) {
    const events: Array<[string, unknown]> = [];
    const dropped: string[] = [];
    return {
      events, dropped,
      d: {
        sessions: () => Object.entries(sessions),
        broadcast: (id: string, ev: unknown) => { events.push([id, ev]); },
        reconnect: async () => reconnectStatus,
        canDrop: (id: string) => id !== "background",
        dropIdle: (id: string) => { dropped.push(id); },
      },
    };
  }

  it("clears the server from every chat listing it and tells their clients", async () => {
    const sessions: Record<string, McpSignInSession> = {
      a: { providerId: "claude", phase: "idle", mcpNeedsAuth: ["vanta", "slack"] },
      b: { providerId: "claude", phase: "idle", mcpNeedsAuth: ["slack"] },
    };
    const { events, dropped, d } = deps(sessions, "connected");
    await handleMcpAuthorized("vanta", d);
    expect(sessions.a!.mcpNeedsAuth).toEqual(["slack"]);
    expect(sessions.b!.mcpNeedsAuth).toEqual(["slack"]);
    expect(events).toEqual([["a", { type: "mcp_status", needsAuth: ["slack"] }]]);
    expect(dropped).toEqual([]);
  });

  it("drops an idle subprocess that still cannot see the sign-in, never one with work in it", async () => {
    const sessions: Record<string, McpSignInSession> = {
      idle: { providerId: "claude", phase: "idle", mcpNeedsAuth: ["vanta"] },
      busy: { providerId: "claude", phase: "streaming", mcpNeedsAuth: ["vanta"] },
      // Idle turn, but a background agent or shell still running inside the subprocess.
      background: { providerId: "claude", phase: "idle", mcpNeedsAuth: ["vanta"] },
    };
    const { dropped, events, d } = deps(sessions, "needs-auth");
    await handleMcpAuthorized("vanta", d);
    expect(dropped).toEqual(["idle"]);
    // The ones that keep their subprocess still cannot use the server — the bar comes back.
    expect(sessions.busy!.mcpNeedsAuth).toEqual(["vanta"]);
    expect(sessions.background!.mcpNeedsAuth).toEqual(["vanta"]);
    expect(events.filter(([id]) => id === "background").at(-1)![1]).toEqual({ type: "mcp_status", needsAuth: ["vanta"] });
  });

  it("leaves a subprocess alone when the reconnect answer is anything but needs-auth", async () => {
    for (const status of ["pending", "failed", null]) {
      const sessions: Record<string, McpSignInSession> = { idle: { providerId: "claude", phase: "idle", mcpNeedsAuth: ["vanta"] } };
      const { dropped, d } = deps(sessions, status);
      await handleMcpAuthorized("vanta", d);
      expect(dropped).toEqual([]);
      expect(sessions.idle!.mcpNeedsAuth).toEqual([]);
    }
  });
});
