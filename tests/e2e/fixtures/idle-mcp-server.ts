/**
 * A stdio MCP server with no tools: it answers the Claude CLI's handshake and then just stays
 * up, the way a browser or Slack MCP server sits beside a chat between calls.
 */
let pending = "";
const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  pending += chunk;
  for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "idle", version: "1.0.0" } },
      });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
