import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { McpOAuthFlows } from "../../../src/services/mcp-oauth/mcp-oauth-flows.ts";
import { createMcpAuthCallbackHandler } from "../../../src/server/routes/mcp-auth.ts";
import type { McpAuthenticateResult } from "../../../src/services/mcp-oauth/mcp-control-query.ts";

const REDIRECT = "https://ppm.example.com/api/mcp-auth/callback";
const timing = { ttlMs: 60_000, pollMs: 60_000, retentionMs: 60_000, startMs: 5_000, requestMs: 5_000 };

let flows: McpOAuthFlows | null = null;
afterEach(() => { flows?.disposeAll(); flows = null; });

function setup(auth: Partial<McpAuthenticateResult>, submit: (url: string) => Promise<unknown> = async () => {}) {
  const submitted: string[] = [];
  flows = new McpOAuthFlows(async () => ({
    close: () => {},
    query: {
      mcpServerStatus: async () => [],
      mcpAuthenticate: async () => ({
        authUrl: "https://auth.example/authorize", requiresUserAction: true, callbackExpected: true, state: "st", ...auth,
      }),
      mcpSubmitOAuthCallbackUrl: async (_n, url) => { submitted.push(url); return submit(url); },
      reconnectMcpServer: async () => {},
    },
  }), timing);
  const app = new Hono();
  app.get("/api/mcp-auth/callback", createMcpAuthCallbackHandler(flows));
  return { app, flows, submitted };
}

describe("GET /api/mcp-auth/callback", () => {
  it("completes a custom-redirect flow, forwarding the redirect on the registered URI", async () => {
    const { app, flows, submitted } = setup({ redirectScheme: "custom" });
    const started = await flows.start("<b>vanta</b>", "/p", REDIRECT);
    const res = await app.request("http://127.0.0.1:8080/api/mcp-auth/callback?code=abc&state=st");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;vanta&lt;/b&gt; is connected");
    expect(html).not.toContain("<b>vanta</b>");
    // The local request URL names the port behind the tunnel; the CLI must get the public one.
    expect(submitted).toEqual([`${REDIRECT}?code=abc&state=st`]);
    expect(flows.get(started.id)!.status).toBe("done");

    // Single use: the same redirect again finds nothing.
    const again = await app.request("http://127.0.0.1:8080/api/mcp-auth/callback?code=abc&state=st");
    expect(again.status).toBe(404);
  });

  it("refuses an unknown state and the state of a localhost flow", async () => {
    const { app, flows, submitted } = setup({ redirectScheme: "localhost", callbackPort: 3118 });
    await flows.start("vanta", "/p");
    expect((await app.request("http://x/api/mcp-auth/callback?code=a&state=nope")).status).toBe(404);
    expect((await app.request("http://x/api/mcp-auth/callback?code=a")).status).toBe(404);
    expect((await app.request("http://x/api/mcp-auth/callback?code=a&state=st")).status).toBe(404);
    expect(submitted).toEqual([]);
  });

  it("shows the CLI's rejection escaped, and leaves the flow open for another try", async () => {
    const { app, flows } = setup({ redirectScheme: "custom" }, async () => { throw new Error("state <mismatch>"); });
    const started = await flows.start("vanta", "/p", REDIRECT);
    const res = await app.request("http://x/api/mcp-auth/callback?error=access_denied&state=st");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("state &lt;mismatch&gt;");
    expect(flows.get(started.id)!.status).toBe("waiting");
  });
});
