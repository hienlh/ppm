import type { Context } from "hono";
import { formatCanvasCheck } from "../../../shared/design-canvas-check-format.ts";
import { canvasCheckBroker, type CanvasCheckOutcome } from "../check/design-canvas-check-broker.ts";
import { designMcpTokens, type DesignMcpBinding } from "./design-mcp-tokens.ts";
import { DESIGN_CHECK_TOOL, DESIGN_CHECK_TOOL_DEFINITION } from "./design-mcp-tool.ts";

/**
 * `/api/design-mcp` — the smallest MCP server that speaks Streamable HTTP with plain JSON
 * responses (`initialize`, `ping`, `tools/list`, `tools/call`), serving one tool,
 * `design_check`, to one design session's own agent. Claude and Codex both take an HTTP MCP
 * server by URL, so one endpoint serves both providers.
 *
 * Mounted before PPM's auth: the caller is a Claude or Codex subprocess with no PPM token.
 * Its credential is the per-session capability token in `Authorization: Bearer`, which can
 * do exactly one thing — check the canvas of the design it was minted for. A request that
 * carries an `Origin` came from a browser, never from those subprocesses, and is refused.
 */

type Json = Record<string, unknown>;
type Check = (projectPath: string, slug: string, options: { screenshot: boolean }) => Promise<CanvasCheckOutcome>;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 64 * 1024;
const MAX_IN_FLIGHT_PER_SESSION = 2;

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function createDesignMcpHandler(deps: {
  resolveToken: (token: string | null) => DesignMcpBinding | null;
  check: Check;
}) {
  const inFlight = new Map<string, number>();

  async function callCheck(binding: DesignMcpBinding, args: unknown): Promise<Json> {
    const screenshot = !(args && typeof args === "object" && (args as Json).screenshot === false);
    const running = inFlight.get(binding.sessionId) ?? 0;
    if (running >= MAX_IN_FLIGHT_PER_SESSION) {
      return { content: [{ type: "text", text: "A canvas check is already running for this design; wait for it." }], isError: true };
    }
    inFlight.set(binding.sessionId, running + 1);
    try {
      const outcome = await deps.check(binding.projectPath, binding.slug, { screenshot });
      if (!outcome.ok) return { content: [{ type: "text", text: outcome.error }], isError: true };
      const content: Json[] = [{ type: "text", text: formatCanvasCheck(outcome.report, binding.slug) }];
      const shot = outcome.report.screenshot;
      if (shot) {
        const comma = shot.dataUrl.indexOf(",");
        const mimeType = shot.dataUrl.slice(5, shot.dataUrl.indexOf(";"));
        content.push({ type: "image", data: shot.dataUrl.slice(comma + 1), mimeType });
      }
      return { content };
    } finally {
      const left = (inFlight.get(binding.sessionId) ?? 1) - 1;
      if (left > 0) inFlight.set(binding.sessionId, left);
      else inFlight.delete(binding.sessionId);
    }
  }

  async function dispatch(binding: DesignMcpBinding, msg: Json): Promise<Json> {
    const id = msg.id;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Json;
    switch (msg.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ppm-design", version: "1.0.0" },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: [DESIGN_CHECK_TOOL_DEFINITION] });
      case "tools/call":
        if (params.name !== DESIGN_CHECK_TOOL) return rpcError(id, -32602, `Unknown tool: ${String(params.name).slice(0, 60)}`);
        return rpcResult(id, await callCheck(binding, params.arguments));
      default:
        return rpcError(id, -32601, "Method not found");
    }
  }

  return async function handle(c: Context): Promise<Response> {
    if (c.req.header("origin")) return c.json({ error: "Browser requests are not accepted" }, 403);
    const auth = c.req.header("authorization") ?? "";
    const binding = deps.resolveToken(/^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null);
    if (!binding) return c.json({ error: "A design session token is required" }, 401);
    if (c.req.method === "DELETE") return c.body(null, 204);
    if (c.req.method !== "POST") return c.body(null, 405, { Allow: "POST, DELETE" });
    if (Number(c.req.header("content-length") ?? "0") > MAX_BODY_BYTES) return c.json(rpcError(null, -32600, "Request too large"), 413);
    let msg: unknown;
    try {
      const raw = await c.req.text();
      if (raw.length > MAX_BODY_BYTES) return c.json(rpcError(null, -32600, "Request too large"), 413);
      msg = JSON.parse(raw);
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || (msg as Json).jsonrpc !== "2.0" || typeof (msg as Json).method !== "string") {
      return c.json(rpcError(null, -32600, "Expected one JSON-RPC 2.0 message"), 400);
    }
    const message = msg as Json;
    // A notification (`notifications/initialized`) or a response to a request of ours: no body.
    if (!("id" in message) || message.id === null) return c.body(null, 202);
    try {
      return c.json(await dispatch(binding, message));
    } catch (e) {
      console.warn(`[design-mcp] ${String(message.method)} failed: ${(e as Error).message}`);
      return c.json(rpcError(message.id, -32603, "Internal error"));
    }
  };
}

export const designMcpHandler = createDesignMcpHandler({
  resolveToken: (token) => designMcpTokens.resolve(token),
  check: (projectPath, slug, options) => canvasCheckBroker.request(projectPath, slug, options),
});
