import type { Context } from "hono";
import { createLogger } from "./logger.ts";
import { holdRequestOpen } from "../server/helpers/hold-request-open.ts";

/**
 * The smallest MCP server that speaks Streamable HTTP with plain JSON responses
 * (`initialize`, `ping`, `tools/list`, `tools/call`), for the endpoints PPM serves to a chat
 * session's own agent (`/api/design-mcp`, `/api/tab-tools-mcp`). Claude and Codex both take
 * an HTTP MCP server by URL, so one endpoint serves both providers.
 *
 * Mounted before PPM's auth: the caller is a Claude or Codex subprocess with no PPM token.
 * Its credential is a per-session capability token in `Authorization: Bearer`. A request
 * that carries an `Origin` came from a browser, never from those subprocesses, and is refused.
 */

export type Json = Record<string, unknown>;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The body as text, or null when it is over {@link MAX_BODY_BYTES}. Counted in bytes as it
 * arrives, so a body sent without a `Content-Length` (chunked) is refused without being read to
 * its end.
 */
async function readCappedBody(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function createMcpHttpHandler<B extends { sessionId: string }>(opts: {
  /** `serverInfo.name`, and the tag on a failed call's log line. */
  serverName: string;
  /** The 401 body's message when no valid token is presented. */
  tokenRequired: string;
  resolveToken: (token: string | null) => B | null;
  tools: readonly Json[];
  /** A `tools/call` result for a tool named in `tools`. */
  callTool: (binding: B, name: string, args: unknown, signal: AbortSignal) => Promise<Json>;
  /**
   * How long a `tools/call` may run before it answers, for tools that can outlast Bun.serve's
   * 10 s idle limit (a slow query, an approval the user has not answered yet); 0 lifts the limit
   * for that request altogether. Unset: the server's own limit applies, as for every other route.
   */
  holdOpenSeconds?: number;
}) {
  const names = new Set(opts.tools.map((t) => t.name));
  const log = createLogger(opts.serverName);

  /** `signal` aborts when the caller closes the request: a tool still waiting can stop. */
  async function dispatch(binding: B, msg: Json, signal: AbortSignal): Promise<Json> {
    const id = msg.id;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Json;
    switch (msg.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.serverName, version: "1.0.0" },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: opts.tools });
      case "tools/call":
        if (typeof params.name !== "string" || !names.has(params.name)) {
          return rpcError(id, -32602, `Unknown tool: ${String(params.name).slice(0, 60)}`);
        }
        return rpcResult(id, await opts.callTool(binding, params.name, params.arguments, signal));
      default:
        return rpcError(id, -32601, "Method not found");
    }
  }

  return async function handle(c: Context): Promise<Response> {
    if (c.req.header("origin")) return c.json({ error: "Browser requests are not accepted" }, 403);
    const auth = c.req.header("authorization") ?? "";
    const binding = opts.resolveToken(/^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null);
    if (!binding) return c.json({ error: opts.tokenRequired }, 401);
    if (c.req.method === "DELETE") return c.body(null, 204);
    if (c.req.method !== "POST") return c.body(null, 405, { Allow: "POST, DELETE" });
    if (Number(c.req.header("content-length") ?? "0") > MAX_BODY_BYTES) return c.json(rpcError(null, -32600, "Request too large"), 413);
    let msg: unknown;
    try {
      const raw = await readCappedBody(c.req.raw);
      if (raw === null) return c.json(rpcError(null, -32600, "Request too large"), 413);
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
    // Lifted before the tool runs: nothing is sent until it answers.
    if (message.method === "tools/call" && opts.holdOpenSeconds !== undefined) holdRequestOpen(c, opts.holdOpenSeconds);
    try {
      return c.json(await dispatch(binding, message, c.req.raw.signal));
    } catch (e) {
      // Answered as a 200, so the access log records a success.
      log.error(`${String(message.method).slice(0, 60)} failed (session ${binding.sessionId}): ${(e as Error).message}`);
      return c.json(rpcError(message.id, -32603, "Internal error"));
    }
  };
}

/** A tool result holding one text block, optionally marked as an error. */
export function textResult(text: string, isError = false): Json {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/** An MCP image block from a `data:image/...;base64,` URL. */
export function imageBlock(dataUrl: string): Json {
  const comma = dataUrl.indexOf(",");
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(";"));
  return { type: "image", data: dataUrl.slice(comma + 1), mimeType };
}
