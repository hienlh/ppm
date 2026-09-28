import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { McpOAuthFlows } from "../../../src/services/mcp-oauth/mcp-oauth-flows.ts";
import { McpStatusProbe } from "../../../src/services/mcp-oauth/mcp-status-probe.ts";
import type { McpAuthenticateResult, McpControlHandle } from "../../../src/services/mcp-oauth/mcp-control-query.ts";
import type { McpServerState } from "../../../src/services/mcp-oauth/mcp-oauth-redirect.ts";

/** A stand-in for the prompt-less Claude subprocess, scripted per test. */
class FakeControl {
  closed = false;
  status: McpServerState[] = [{ name: "vanta", status: "needs-auth" }];
  authResult: McpAuthenticateResult = {
    authUrl: "https://auth.example/authorize?state=s1",
    requiresUserAction: true,
    callbackExpected: true,
    redirectScheme: "localhost",
    callbackPort: 3118,
    state: "s1",
  };
  authGate: Promise<void> = Promise.resolve();
  submitted: string[] = [];
  submitError: Error | null = null;
  authCalls: Array<{ name: string; redirectUri?: string }> = [];

  handle(): McpControlHandle {
    return {
      close: () => { this.closed = true; },
      query: {
        mcpServerStatus: async () => this.status,
        mcpAuthenticate: async (name, redirectUri) => {
          this.authCalls.push({ name, redirectUri });
          await this.authGate;
          return this.authResult;
        },
        mcpSubmitOAuthCallbackUrl: async (_name, url) => {
          if (this.submitError) throw this.submitError;
          this.submitted.push(url);
        },
        reconnectMcpServer: async () => {},
      },
    };
  }
}

const fastTiming = { ttlMs: 60_000, pollMs: 5, retentionMs: 60_000, startMs: 5_000, requestMs: 5_000 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let flows: McpOAuthFlows | null = null;
afterEach(() => { flows?.disposeAll(); flows = null; });

function setup(controls: FakeControl[] = [new FakeControl()]) {
  let i = 0;
  flows = new McpOAuthFlows(async () => controls[Math.min(i++, controls.length - 1)]!.handle(), fastTiming);
  return { flows, controls };
}

describe("McpOAuthFlows", () => {
  it("finishes a localhost flow when the server reports connected, then closes the subprocess", async () => {
    const { flows, controls: [c] } = setup();
    const authorized: string[] = [];
    flows.onAuthorized((n) => authorized.push(n));

    const started = await flows.start("vanta", "/p");
    expect(started.status).toBe("waiting");
    expect(started.authUrl).toContain("https://auth.example/");
    expect(started.redirectScheme).toBe("localhost");
    expect(JSON.stringify(started)).not.toContain("\"state\"");

    c!.status = [{ name: "vanta", status: "connected" }];
    await wait(30);
    const done = flows.get(started.id)!;
    expect(done.status).toBe("done");
    expect(done.authUrl).toBeUndefined();
    expect(c!.closed).toBe(true);
    expect(authorized).toEqual(["vanta"]);
  });

  it("submits a custom-redirect callback and matches it by state exactly once", async () => {
    const c = new FakeControl();
    c.authResult = { ...c.authResult, redirectScheme: "custom", callbackPort: undefined };
    const { flows } = setup([c]);
    const started = await flows.start("vanta", "/p", "https://ppm.example/api/mcp-auth/callback");
    expect(c.authCalls[0]!.redirectUri).toBe("https://ppm.example/api/mcp-auth/callback");

    expect(flows.findByState("wrong")).toBeNull();
    const match = flows.findByState("s1");
    expect(match?.id).toBe(started.id);
    expect(match?.redirectUri).toBe("https://ppm.example/api/mcp-auth/callback");

    const res = await flows.submitCallback(started.id, "https://ppm.example/api/mcp-auth/callback?code=x&state=s1");
    expect(res.status).toBe("done");
    expect(c.submitted).toHaveLength(1);
    // Single-use: a replayed redirect no longer finds a flow.
    expect(flows.findByState("s1")).toBeNull();
  });

  it("keeps waiting with the CLI's message when a pasted URL is rejected", async () => {
    const c = new FakeControl();
    c.submitError = new Error("Callback URL not accepted: state mismatch");
    const { flows } = setup([c]);
    const started = await flows.start("vanta", "/p");
    const res = await flows.submitCallback(started.id, "http://localhost:3118/callback?code=x&state=other");
    expect(res.status).toBe("waiting");
    expect(res.error).toContain("state mismatch");
    expect(c.closed).toBe(false);
  });

  it("settles at once when the server is already signed in", async () => {
    const c = new FakeControl();
    c.authResult = { requiresUserAction: false, callbackExpected: false };
    const { flows } = setup([c]);
    const res = await flows.start("vanta", "/p");
    expect(res.status).toBe("done");
    expect(c.closed).toBe(true);
  });

  it("cancels the previous flow for the same server, including one still waiting on the CLI", async () => {
    const first = new FakeControl();
    let release!: () => void;
    first.authGate = new Promise((r) => { release = r; });
    const second = new FakeControl();
    const { flows } = setup([first, second]);

    const pendingFirst = flows.start("vanta", "/p");
    await wait(0);
    const secondView = await flows.start("vanta", "/p");
    release();
    const firstView = await pendingFirst;

    expect(firstView.status).toBe("cancelled");
    expect(first.closed).toBe(true);
    expect(secondView.status).toBe("waiting");
    expect(second.closed).toBe(false);
    // The cancelled flow must not have started polling or an expiry of its own.
    first.status = [{ name: "vanta", status: "connected" }];
    await wait(20);
    expect(flows.get(firstView.id)!.status).toBe("cancelled");
  });

  it("confirms a claude.ai connector only once a reconnect shows it connected", async () => {
    const c = new FakeControl();
    c.authResult = { authUrl: "https://claude.ai/x", requiresUserAction: true, callbackExpected: false };
    const { flows } = setup([c]);
    const started = await flows.start("claude-connector", "/p");
    c.status = [{ name: "claude-connector", status: "needs-auth" }];
    const notYet = await flows.confirm(started.id);
    expect(notYet.status).toBe("waiting");
    expect(notYet.error).toBeTruthy();

    c.status = [{ name: "claude-connector", status: "connected" }];
    expect((await flows.confirm(started.id)).status).toBe("done");
  });

  it("gives up on a CLI that never returns a link, and closes its subprocess", async () => {
    const c = new FakeControl();
    c.authGate = new Promise(() => {});
    flows = new McpOAuthFlows(async () => c.handle(), { ...fastTiming, startMs: 20 });
    const res = await flows.start("vanta", "/p");
    expect(res.status).toBe("failed");
    expect(res.error).toContain("did not return a sign-in link");
    expect(c.closed).toBe(true);
  });

  it("reports a failed start without leaving the subprocess open", async () => {
    const c = new FakeControl();
    const h = c.handle();
    h.query.mcpAuthenticate = async () => { throw new Error("Server not found: nope"); };
    flows = new McpOAuthFlows(async () => h, fastTiming);
    const res = await flows.start("nope", "/p");
    expect(res.status).toBe("failed");
    expect(res.error).toContain("Server not found");
    expect(c.closed).toBe(true);
  });
});

describe("McpStatusProbe", () => {
  it("waits for pending servers, caches per directory and shares an in-flight probe", async () => {
    let opened = 0;
    let reads = 0;
    const probe = new McpStatusProbe(async () => {
      opened++;
      return {
        close: () => {},
        query: {
          mcpServerStatus: async () => (++reads < 3
            ? [{ name: "a", status: "pending" }]
            : [{ name: "a", status: "needs-auth", source: "user", tools: [] } as McpServerState]),
          mcpAuthenticate: async () => ({ requiresUserAction: false, callbackExpected: false }),
          mcpSubmitOAuthCallbackUrl: async () => {},
          reconnectMcpServer: async () => {},
        },
      };
    }, { cacheMs: 60_000, settleMs: 1_000, pollMs: 1, readMs: 1_000 });

    const [x, y] = await Promise.all([probe.status("/p"), probe.status("/p")]);
    expect(opened).toBe(1);
    expect(x).toEqual([{ name: "a", status: "needs-auth", source: "user" }]);
    expect(y).toBe(x);
    await probe.status("/p");
    expect(opened).toBe(1);
    probe.invalidate();
    await probe.status("/p");
    expect(opened).toBe(2);
  });
});

describe("McpStatusProbe when the CLI goes silent", () => {
  it("fails the shared probe, closes the subprocess, and lets the next call try again", async () => {
    let closed = 0;
    let opened = 0;
    const probe = new McpStatusProbe(async () => {
      opened++;
      return {
        close: () => { closed++; },
        query: {
          mcpServerStatus: () => new Promise(() => {}),
          mcpAuthenticate: async () => ({ requiresUserAction: false, callbackExpected: false }),
          mcpSubmitOAuthCallbackUrl: async () => {},
          reconnectMcpServer: async () => {},
        },
      };
    }, { cacheMs: 60_000, settleMs: 1_000, pollMs: 1, readMs: 20 });
    await expect(probe.status("/p")).rejects.toThrow("did not report");
    expect(closed).toBe(1);
    await expect(probe.status("/p")).rejects.toThrow();
    expect(opened).toBe(2);
  });
});

describe("SDK surface", () => {
  // These control requests are absent from sdk.d.ts; if an upgrade renames them the
  // sign-in button would fail at runtime, so fail here instead.
  it("still ships the undeclared MCP sign-in methods", () => {
    const src = readFileSync(require.resolve("@anthropic-ai/claude-agent-sdk"), "utf8");
    for (const method of ["mcpAuthenticate(", "mcpSubmitOAuthCallbackUrl(", "reconnectMcpServer(", "mcpServerStatus("]) {
      expect(src).toContain(`async ${method}`);
    }
  });
});
