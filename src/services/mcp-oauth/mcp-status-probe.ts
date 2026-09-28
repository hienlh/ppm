/**
 * MCP server status as a chat in a given directory would see it, for screens that have no
 * chat to ask (the AI Resources list).
 *
 * Every probe starts a Claude subprocess, which in turn connects every configured MCP
 * server — stdio ones included — so answers are cached per directory and concurrent
 * callers share one probe.
 */
import type { OpenMcpControlQuery } from "./mcp-control-query.ts";
import { openClaudeMcpControlQuery, withTimeout } from "./mcp-control-query.ts";
import type { McpServerState } from "./mcp-oauth-redirect.ts";

/**
 * Long, because a probe is not free: it starts a full CLI, which loads every plugin and
 * spawns every stdio MCP server. A sign-in invalidates it, and the list's refresh button
 * asks for a fresh answer, so nothing that changes it here goes unseen.
 */
const CACHE_MS = 5 * 60_000;
/** Servers start "pending"; wait this long for them to settle before answering anyway. */
const SETTLE_MS = 5_000;
const SETTLE_POLL_MS = 500;
/** The first read includes the subprocess starting up and loading plugins. */
const READ_TIMEOUT_MS = 30_000;

export class McpStatusProbe {
  private cache = new Map<string, { at: number; servers: McpServerState[] }>();
  private inFlight = new Map<string, Promise<McpServerState[]>>();

  constructor(
    private readonly open: OpenMcpControlQuery = openClaudeMcpControlQuery,
    private readonly timing = { cacheMs: CACHE_MS, settleMs: SETTLE_MS, pollMs: SETTLE_POLL_MS, readMs: READ_TIMEOUT_MS },
  ) {}

  async status(cwd: string, opts: { fresh?: boolean } = {}): Promise<McpServerState[]> {
    const cached = this.cache.get(cwd);
    if (!opts.fresh && cached && Date.now() - cached.at < this.timing.cacheMs) return cached.servers;
    const running = this.inFlight.get(cwd);
    if (running) return running;

    const probe = this.probe(cwd).finally(() => this.inFlight.delete(cwd));
    this.inFlight.set(cwd, probe);
    return probe;
  }

  /** Forget every cached answer — a sign-in just changed what they would say. */
  invalidate(): void {
    this.cache.clear();
  }

  private async probe(cwd: string): Promise<McpServerState[]> {
    const control = await this.open(cwd);
    // Every caller for this directory shares this probe, so it has to end even if the CLI
    // stops answering.
    const read = () => withTimeout(control.query.mcpServerStatus(), this.timing.readMs, "Claude did not report MCP status");
    try {
      const deadline = Date.now() + this.timing.settleMs;
      let servers = await read();
      while (servers.some((s) => s.status === "pending") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, this.timing.pollMs));
        servers = await read();
      }
      const slim = servers.map(({ name, status, error, scope, source }) => ({
        name, status,
        ...(error && { error }),
        ...(scope && { scope }),
        ...(source && { source }),
      }));
      this.cache.set(cwd, { at: Date.now(), servers: slim });
      return slim;
    } finally {
      control.close();
    }
  }
}

export const mcpStatusProbe = new McpStatusProbe();
