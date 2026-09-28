/**
 * MCP sign-in flows.
 *
 * Each flow owns one prompt-less Claude subprocess for its whole life, and that is not a
 * detail: when the CLI redirects to its own `http://localhost:<port>/callback`, the
 * listener runs inside that process, so closing it early strands the browser on a dead
 * page. The subprocess is closed as soon as the flow settles, or after `FLOW_TTL_MS`.
 *
 * The tokens the CLI stores are shared with every other Claude process on the machine
 * (same credential store as an interactive `claude`), which is why a sign-in finished here
 * is visible to chats — they only need to reconnect the server (see `onAuthorized`).
 */
import { randomUUID } from "node:crypto";
import type { McpControlHandle, OpenMcpControlQuery } from "./mcp-control-query.ts";
import { openClaudeMcpControlQuery, withTimeout } from "./mcp-control-query.ts";

export type McpAuthFlowStatus = "waiting" | "completing" | "done" | "failed" | "expired" | "cancelled";

/**
 * What the browser is told about a flow. The `state` is not a field of its own, though it
 * is inside `authUrl` — which only the authenticated user who started the flow can read.
 */
export interface McpAuthFlowView {
  id: string;
  serverName: string;
  status: McpAuthFlowStatus;
  authUrl?: string;
  callbackExpected: boolean;
  redirectScheme?: "localhost" | "custom";
  error?: string;
}

interface Flow extends McpAuthFlowView {
  control: McpControlHandle | null;
  state?: string;
  /** Only set for a "custom" flow: the redirect URI the authorization server was given. */
  redirectUri?: string;
  expiryTimer?: ReturnType<typeof setTimeout>;
  pollTimer?: ReturnType<typeof setInterval>;
  polling?: boolean;
}

/** Long enough to finish a real sign-in (2FA, SSO); short enough not to hoard a subprocess. */
const FLOW_TTL_MS = 10 * 60_000;
/** How often a localhost flow checks whether the CLI has finished exchanging the code. */
const POLL_MS = 2_000;
/** A settled flow stays readable this long, so a polling dialog sees how it ended. */
const SETTLED_RETENTION_MS = 5 * 60_000;
/** How long the CLI gets to produce a sign-in link (it registers a client first, over the network). */
const START_TIMEOUT_MS = 60_000;
/** Any other control request: status reads, reconnects, and exchanging the code. */
const REQUEST_TIMEOUT_MS = 45_000;

type AuthorizedListener = (serverName: string) => void;

export class McpOAuthFlows {
  private flows = new Map<string, Flow>();
  private listeners = new Set<AuthorizedListener>();

  constructor(
    private readonly open: OpenMcpControlQuery = openClaudeMcpControlQuery,
    private readonly timing = {
      ttlMs: FLOW_TTL_MS, pollMs: POLL_MS, retentionMs: SETTLED_RETENTION_MS,
      startMs: START_TIMEOUT_MS, requestMs: REQUEST_TIMEOUT_MS,
    },
  ) {}

  /** Called with a server's name each time a sign-in for it succeeds. Returns an unsubscribe. */
  onAuthorized(listener: AuthorizedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(id: string): McpAuthFlowView | null {
    const flow = this.flows.get(id);
    return flow ? view(flow) : null;
  }

  /**
   * Start signing in to `serverName` as a chat in `cwd` would see it. A flow already open
   * for the same server is cancelled: only the newest sign-in link can still succeed.
   */
  async start(serverName: string, cwd: string, redirectUri?: string): Promise<McpAuthFlowView> {
    for (const f of this.flows.values()) {
      if (f.serverName === serverName && isOpen(f.status)) this.settle(f, "cancelled");
    }

    const t0 = Date.now();
    console.log(`[mcp-oauth] ${serverName}: starting sign-in (cwd=${cwd}, redirect=${redirectUri ? "custom" : "localhost"})`);
    const control = await this.open(cwd);
    const flow: Flow = { id: randomUUID(), serverName, status: "waiting", callbackExpected: false, control };
    this.flows.set(flow.id, flow);
    try {
      // Bounded: the expiry timer only starts once there is a link, so a CLI that never
      // answers would otherwise hold its subprocess open for as long as PPM runs.
      const res = await withTimeout(
        control.query.mcpAuthenticate(serverName, redirectUri),
        this.timing.startMs,
        `${serverName} did not return a sign-in link. Try again.`,
      );
      console.log(`[mcp-oauth] ${serverName}: sign-in link ready in ${Date.now() - t0}ms (redirect=${res.redirectScheme ?? "none"}, flow=${flow.id})`);
      // A newer sign-in for this server may have cancelled this one while the CLI answered.
      if (!isOpen(flow.status)) return view(flow);
      if (!res.requiresUserAction) {
        this.settle(flow, "done");
        return view(flow);
      }
      flow.authUrl = res.authUrl;
      flow.callbackExpected = res.callbackExpected;
      flow.redirectScheme = res.redirectScheme;
      flow.state = res.state;
      if (res.redirectScheme === "custom") flow.redirectUri = redirectUri;
    } catch (e) {
      this.settle(flow, "failed", errorMessage(e));
      return view(flow);
    }

    flow.expiryTimer = setTimeout(() => this.settle(flow, "expired", "The sign-in link expired. Start again."), this.timing.ttlMs);
    // The CLI's own listener gets the code without telling anyone, so the only way to see
    // it finish is to watch the server's status change.
    if (flow.callbackExpected && flow.redirectScheme === "localhost") {
      flow.pollTimer = setInterval(() => { void this.pollStatus(flow); }, this.timing.pollMs);
    }
    return view(flow);
  }

  /**
   * Hand the redirect URL to the CLI — pasted by the user, or delivered by the public
   * callback route. The CLI validates it against this flow's `state` itself.
   */
  async submitCallback(id: string, callbackUrl: string): Promise<McpAuthFlowView> {
    const flow = this.requireFlow(id);
    if (flow.status !== "waiting") return view(flow);
    if (!flow.control) return view(flow);
    flow.status = "completing";
    flow.error = undefined;
    try {
      // The public callback page waits on this; a proxy in front (Cloudflare gives up at
      // 100 s) would otherwise show its own error page while the sign-in carries on.
      await withTimeout(
        flow.control.query.mcpSubmitOAuthCallbackUrl(flow.serverName, callbackUrl),
        this.timing.requestMs,
        `${flow.serverName} did not confirm the sign-in in time. Check the server's status, or start again.`,
      );
      this.settle(flow, "done");
    } catch (e) {
      // A mistyped or foreign URL leaves the CLI's flow open, so let the user try again.
      if (isOpen(flow.status)) {
        flow.status = "waiting";
        flow.error = errorMessage(e);
      }
    }
    return view(flow);
  }

  /** The flow a redirect's `state` parameter belongs to, if it is still waiting for one. */
  findByState(state: string | null): Flow | null {
    if (!state) return null;
    for (const f of this.flows.values()) {
      if (f.state === state && f.status === "waiting") return f;
    }
    return null;
  }

  /**
   * For a claude.ai connector, whose grant never redirects anywhere: the user says they
   * are done, and a reconnect tells whether that is true.
   */
  async confirm(id: string): Promise<McpAuthFlowView> {
    const flow = this.requireFlow(id);
    if (flow.status !== "waiting" || !flow.control) return view(flow);
    try {
      await withTimeout(flow.control.query.reconnectMcpServer(flow.serverName), this.timing.requestMs, "reconnect timed out");
    } catch { /* the status read below is what decides */ }
    const status = await this.serverStatus(flow);
    if (status === "connected") this.settle(flow, "done");
    else flow.error = "The server still needs a sign-in. Finish granting access, then try again.";
    return view(flow);
  }

  cancel(id: string): McpAuthFlowView | null {
    const flow = this.flows.get(id);
    if (!flow) return null;
    if (isOpen(flow.status)) this.settle(flow, "cancelled");
    return view(flow);
  }

  /** Close every subprocess — for server shutdown and tests. */
  disposeAll(): void {
    for (const f of this.flows.values()) {
      if (isOpen(f.status)) this.settle(f, "cancelled");
    }
    this.flows.clear();
  }

  private async pollStatus(flow: Flow): Promise<void> {
    // One read at a time: a CLI that stops answering must not collect a request per tick.
    if (flow.status !== "waiting" || flow.polling) return;
    flow.polling = true;
    try {
      const status = await this.serverStatus(flow);
      if (flow.status === "waiting" && status === "connected") this.settle(flow, "done");
    } finally {
      flow.polling = false;
    }
  }

  private async serverStatus(flow: Flow): Promise<string | null> {
    if (!flow.control) return null;
    try {
      const all = await withTimeout(flow.control.query.mcpServerStatus(), this.timing.requestMs, "status timed out");
      return all.find((s) => s.name === flow.serverName)?.status ?? null;
    } catch {
      return null;
    }
  }

  private settle(flow: Flow, status: McpAuthFlowStatus, error?: string): void {
    if (!isOpen(flow.status)) return;
    console.log(`[mcp-oauth] ${flow.serverName}: sign-in ${status}${error ? ` — ${error}` : ""} (flow=${flow.id})`);
    flow.status = status;
    flow.error = error;
    if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
    if (flow.pollTimer) clearInterval(flow.pollTimer);
    flow.expiryTimer = undefined;
    flow.pollTimer = undefined;
    try { flow.control?.close(); } catch { /* already gone */ }
    flow.control = null;
    // The state is single-use; forgetting it keeps a replayed redirect from matching.
    flow.state = undefined;
    if (status === "done") {
      for (const l of this.listeners) {
        try { l(flow.serverName); } catch (e) { console.warn(`[mcp-oauth] listener failed: ${errorMessage(e)}`); }
      }
    }
    const timer = setTimeout(() => this.flows.delete(flow.id), this.timing.retentionMs);
    (timer as { unref?: () => void }).unref?.();
  }

  private requireFlow(id: string): Flow {
    const flow = this.flows.get(id);
    if (!flow) throw new McpAuthFlowNotFoundError();
    return flow;
  }
}

export class McpAuthFlowNotFoundError extends Error {
  constructor() { super("This sign-in is no longer active. Start again."); }
}

function isOpen(status: McpAuthFlowStatus): boolean {
  return status === "waiting" || status === "completing";
}

function view(f: Flow): McpAuthFlowView {
  return {
    id: f.id,
    serverName: f.serverName,
    status: f.status,
    callbackExpected: f.callbackExpected,
    ...(f.authUrl && isOpen(f.status) && { authUrl: f.authUrl }),
    ...(f.redirectScheme && { redirectScheme: f.redirectScheme }),
    ...(f.error && { error: f.error }),
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const mcpOAuthFlows = new McpOAuthFlows();
