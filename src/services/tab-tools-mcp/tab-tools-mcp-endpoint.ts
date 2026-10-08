import { resolve } from "node:path";
import { configService } from "../config.service.ts";
import { formatPreviewCheck } from "../../shared/design-canvas-check-format.ts";
import { MAX_TAB_LINE, type TabOpenAsk } from "../../shared/tab-open-protocol.ts";
import { isPpmTool, ppmToolOffMessage, ppmToolOn } from "../../shared/ppm-tools.ts";
import { activeTunnels } from "../../server/routes/tunnel-spawn.ts";
import { createMcpHttpHandler, imageBlock, textResult, type Json } from "../mcp-http-endpoint.ts";
import { listeningLoopback } from "../port-forward/forward-hop.ts";
import { listTailscaleForwards, startTailscaleForward } from "../port-forward/tailscale-forward.ts";
import { localServerBaseUrl } from "../server-listen-address.ts";
import { terminalService } from "../terminal.service.ts";
import { createOpenUrlTool, type OpenUrlTool } from "./open-url-tool.ts";
import { canonicalTabSession, deviceError, tabOpenBroker, type TabOpenOutcome } from "./tab-open-broker.ts";
import { resolveTabTarget, type TabTarget, type TabTargetOutcome, type TabToolsBinding } from "./tab-target.ts";
import { tabToolsMcpTokens, type TabToolsTokenBinding } from "./tab-tools-mcp-tokens.ts";
import {
  OPEN_FILE_TOOL, OPEN_FILE_TOOL_DEFINITION, OPEN_FILE_WAIT_MS, OPEN_PREVIEW_TOOL, OPEN_PREVIEW_TOOL_DEFINITION,
  OPEN_PREVIEW_WAIT_MS, OPEN_URL_TOOL, OPEN_URL_TOOL_DEFINITION, READ_TERMINAL_TOOL, READ_TERMINAL_TOOL_DEFINITION,
  RUN_IN_TERMINAL_TOOL, RUN_IN_TERMINAL_TOOL_DEFINITION,
} from "./tab-tools-mcp-tool.ts";
import { createTerminalTools, type TerminalTools } from "./terminal-tools.ts";

/**
 * `/api/tab-tools-mcp` — serves the tab tools to one chat session's own agent (the MCP plumbing
 * is `mcp-http-endpoint.ts`): `open_file` and `open_preview` open a file the agent could already
 * read, `open_url` a web server on the host, and `run_in_terminal` a terminal with a command
 * typed in, all on that session's devices; `read_terminal` reads the terminals of the session's
 * project. Nothing a tab shows comes back except, for an HTML page, the check of how it rendered.
 */

type Request = (sessionId: string, req: TabOpenAsk, waitMs: number) => Promise<TabOpenOutcome>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function failure(outcome: Extract<TabOpenOutcome, { ok: false }>, target: TabTarget): Json {
  if (outcome.reason === "no-device") {
    return textResult(`${outcome.message} The file is at ${target.displayPath}; tell the user where to find it.`, true);
  }
  return textResult(outcome.message, true);
}

export function createTabToolsMcpHandler(deps: {
  resolveToken: (token: string | null) => TabToolsTokenBinding | null;
  /** The session's project as it is now; relative paths resolve against it. */
  sessionProject: (sessionId: string) => Promise<Omit<TabToolsBinding, "sessionId">>;
  request: Request;
  /** Whether the user has this tool on (Settings → Tools). */
  enabled: (tool: string) => boolean;
  terminal: TerminalTools;
  openUrl: OpenUrlTool;
  resolveTarget?: (input: unknown, binding: TabToolsBinding) => Promise<TabTargetOutcome>;
}) {
  const resolveTarget = deps.resolveTarget ?? resolveTabTarget;

  async function openFile(binding: TabToolsBinding, target: TabTarget, args: Json): Promise<Json> {
    let line: number | undefined;
    if (args.line !== undefined && args.line !== null) {
      if (typeof args.line !== "number" || !Number.isInteger(args.line) || args.line < 1 || args.line > MAX_TAB_LINE) {
        return textResult("`line` must be a whole number from 1.", true);
      }
      line = args.line;
    }
    const outcome = await deps.request(binding.sessionId, {
      tool: "open_file", filePath: target.filePath, projectName: target.projectName, ...(line ? { line } : {}),
    }, OPEN_FILE_WAIT_MS);
    if (!outcome.ok) return failure(outcome, target);
    if (!outcome.result.opened) return textResult(`The user's device could not open ${target.displayPath}: ${deviceError(outcome.result.error)}`, true);
    return textResult(`Opened ${target.displayPath}${line ? ` at line ${line}` : ""} in a PPM tab on the user's device.`);
  }

  async function openPreview(binding: TabToolsBinding, target: TabTarget, args: Json): Promise<Json> {
    const screenshot = args.screenshot !== false;
    const outcome = await deps.request(binding.sessionId, {
      tool: "open_preview", filePath: target.filePath, projectName: target.projectName,
      ...(target.html ? { check: { screenshot } } : {}),
    }, target.html ? OPEN_PREVIEW_WAIT_MS : OPEN_FILE_WAIT_MS);
    if (!outcome.ok) return failure(outcome, target);
    const { result } = outcome;
    if (!result.opened) return textResult(`The user's device could not open ${target.displayPath}: ${deviceError(result.error)}`, true);
    if (!target.html) return textResult(`Opened ${target.displayPath} in a PPM tab on the user's device.`);
    if (!result.report) {
      return textResult(`Opened ${target.displayPath} in a PPM tab on the user's device, but it could not be checked: ${deviceError(result.error)}.`);
    }
    const content: Json[] = [{ type: "text", text: formatPreviewCheck(result.report, target.displayPath) }];
    if (result.report.screenshot) content.push(imageBlock(result.report.screenshot.dataUrl));
    return { content };
  }

  return createMcpHttpHandler<TabToolsTokenBinding>({
    serverName: "ppm-tabs",
    tokenRequired: "A chat session token is required",
    resolveToken: deps.resolveToken,
    tools: [
      OPEN_FILE_TOOL_DEFINITION, OPEN_PREVIEW_TOOL_DEFINITION, OPEN_URL_TOOL_DEFINITION,
      READ_TERMINAL_TOOL_DEFINITION, RUN_IN_TERMINAL_TOOL_DEFINITION,
    ],
    unavailable: (name) => (deps.enabled(name) ? null : ppmToolOffMessage(name)),
    callTool: async ({ sessionId }, name, rawArgs) => {
      const binding: TabToolsBinding = { sessionId, ...(await deps.sessionProject(sessionId)) };
      const args = isObj(rawArgs) ? rawArgs : {};
      if (name === OPEN_URL_TOOL) return deps.openUrl(binding, args);
      if (name === READ_TERMINAL_TOOL) return deps.terminal.read(binding, args);
      if (name === RUN_IN_TERMINAL_TOOL) return deps.terminal.run(binding, args);
      const resolved = await resolveTarget(args.path, binding);
      if (!resolved.ok) return textResult(resolved.error, true);
      if (name === OPEN_FILE_TOOL) return openFile(binding, resolved.target, args);
      if (name === OPEN_PREVIEW_TOOL) return openPreview(binding, resolved.target, args);
      return textResult(`Unknown tool: ${name}`, true);
    },
  });
}

/** Where a session works: the provider's live session first, then what the database recorded. */
async function sessionProject(sessionId: string): Promise<Omit<TabToolsBinding, "sessionId">> {
  const { chatService } = await import("../chat.service.ts");
  const { getSessionProjectPath } = await import("../db.service.ts");
  const session = chatService.getSession(sessionId);
  const projectPath = session?.projectPath ?? getSessionProjectPath(sessionId) ?? null;
  const projectName = session?.projectName
    ?? (projectPath ? configService.get("projects").find((p) => resolve(p.path) === resolve(projectPath))?.name : undefined)
    ?? null;
  return { projectPath, projectName };
}

/** The ports PPM itself answers on: the configured one, and the server's own behind the supervisor. */
function ppmPorts(): number[] {
  const base = localServerBaseUrl();
  return [configService.get("port"), base ? Number(new URL(base).port) : 0].filter((port) => Number.isInteger(port) && port > 0);
}

/** The forward the user already runs for a port: a private Tailscale one before a public quick tunnel. */
export function existingForwardFor(
  port: number,
  tailscale: ReadonlyArray<{ port: number; url: string }> = listTailscaleForwards(),
  quick: ReadonlyMap<number, { url: string }> = activeTunnels,
): { url: string; via: "tailscale" | "cloudflare" } | null {
  const forward = tailscale.find((f) => f.port === port);
  if (forward) return { url: forward.url, via: "tailscale" };
  const tunnel = quick.get(port);
  return tunnel ? { url: tunnel.url, via: "cloudflare" } : null;
}

const request: Request = (sessionId, req, waitMs) => tabOpenBroker.request(sessionId, req, waitMs);
const enabled = (tool: string): boolean => isPpmTool(tool) && ppmToolOn(configService.get("ai"), tool);

export const tabToolsMcpHandler = createTabToolsMcpHandler({
  resolveToken: (token) => tabToolsMcpTokens.resolve(token),
  sessionProject,
  request,
  enabled,
  terminal: createTerminalTools({ terminals: terminalService, request, enabled, canonical: canonicalTabSession }),
  openUrl: createOpenUrlTool({
    request,
    canonical: canonicalTabSession,
    listening: async (port) => (await listeningLoopback(port)) !== null,
    ownPorts: ppmPorts,
    existingForward: (port) => existingForwardFor(port),
    startPrivateForward: async (port) => (await startTailscaleForward(port)).url,
  }),
});
