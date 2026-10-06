import { formatCanvasCheck } from "../../../shared/design-canvas-check-format.ts";
import { createMcpHttpHandler, imageBlock, textResult, type Json } from "../../mcp-http-endpoint.ts";
import { canvasCheckBroker, type CanvasCheckOutcome } from "../check/design-canvas-check-broker.ts";
import { designMcpTokens, type DesignMcpBinding } from "./design-mcp-tokens.ts";
import { DESIGN_CHECK_TOOL_DEFINITION } from "./design-mcp-tool.ts";

/**
 * `/api/design-mcp` — serves one tool, `design_check`, to one design session's own agent
 * (the MCP plumbing is `mcp-http-endpoint.ts`). Its token can do exactly one thing: check
 * the canvas of the design it was minted for.
 */

type Check = (projectPath: string, slug: string, options: { screenshot: boolean }) => Promise<CanvasCheckOutcome>;

const MAX_IN_FLIGHT_PER_SESSION = 2;

export function createDesignMcpHandler(deps: {
  resolveToken: (token: string | null) => DesignMcpBinding | null;
  check: Check;
}) {
  const inFlight = new Map<string, number>();

  async function callCheck(binding: DesignMcpBinding, args: unknown): Promise<Json> {
    const screenshot = !(args && typeof args === "object" && (args as Json).screenshot === false);
    const running = inFlight.get(binding.sessionId) ?? 0;
    if (running >= MAX_IN_FLIGHT_PER_SESSION) {
      return textResult("A canvas check is already running for this design; wait for it.", true);
    }
    inFlight.set(binding.sessionId, running + 1);
    try {
      const outcome = await deps.check(binding.projectPath, binding.slug, { screenshot });
      if (!outcome.ok) return textResult(outcome.error, true);
      const content: Json[] = [{ type: "text", text: formatCanvasCheck(outcome.report, binding.slug) }];
      const shot = outcome.report.screenshot;
      if (shot) content.push(imageBlock(shot.dataUrl));
      return { content };
    } finally {
      const left = (inFlight.get(binding.sessionId) ?? 1) - 1;
      if (left > 0) inFlight.set(binding.sessionId, left);
      else inFlight.delete(binding.sessionId);
    }
  }

  return createMcpHttpHandler<DesignMcpBinding>({
    serverName: "ppm-design",
    tokenRequired: "A design session token is required",
    resolveToken: deps.resolveToken,
    tools: [DESIGN_CHECK_TOOL_DEFINITION],
    callTool: (binding, _name, args) => callCheck(binding, args),
  });
}

export const designMcpHandler = createDesignMcpHandler({
  resolveToken: (token) => designMcpTokens.resolve(token),
  check: (projectPath, slug, options) => canvasCheckBroker.request(projectPath, slug, options),
});
