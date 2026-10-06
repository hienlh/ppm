import { resolve } from "node:path";
import { configService } from "../config.service.ts";
import { formatPreviewCheck } from "../../shared/design-canvas-check-format.ts";
import { MAX_TAB_LINE, type TabOpenRequest } from "../../shared/tab-open-protocol.ts";
import { neutralizeFences } from "../../shared/untrusted-text.ts";
import { createMcpHttpHandler, imageBlock, textResult, type Json } from "../mcp-http-endpoint.ts";
import { tabOpenBroker, type TabOpenOutcome } from "./tab-open-broker.ts";
import { resolveTabTarget, type TabTarget, type TabTargetOutcome, type TabToolsBinding } from "./tab-target.ts";
import { tabToolsMcpTokens, type TabToolsTokenBinding } from "./tab-tools-mcp-tokens.ts";
import {
  OPEN_FILE_TOOL, OPEN_FILE_TOOL_DEFINITION, OPEN_FILE_WAIT_MS, OPEN_PREVIEW_TOOL_DEFINITION, OPEN_PREVIEW_WAIT_MS,
} from "./tab-tools-mcp-tool.ts";

/**
 * `/api/tab-tools-mcp` — serves `open_file` and `open_preview` to one chat session's own
 * agent (the MCP plumbing is `mcp-http-endpoint.ts`). Its token can do exactly one thing:
 * open a tab on that session's devices, for a file the agent could already read. Nothing the
 * tab shows comes back except, for an HTML page, the check of how it rendered.
 */

type Request = (sessionId: string, req: Omit<TabOpenRequest, "type" | "requestId">, waitMs: number) => Promise<TabOpenOutcome>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** What the device said went wrong; it may quote the page, which the page's scripts wrote. */
const deviceError = (error: string | undefined): string =>
  error ? neutralizeFences(error.replace(/[\u0000-\u001f\u007f]/g, " ")) : "it gave no reason";

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
  enabled: () => boolean;
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
    tools: [OPEN_FILE_TOOL_DEFINITION, OPEN_PREVIEW_TOOL_DEFINITION],
    callTool: async ({ sessionId }, name, rawArgs) => {
      // A chat keeps the tools it started with, so turning the setting off is enforced here.
      if (!deps.enabled()) {
        return textResult("The user turned off \"Let the AI open tabs in PPM\" in PPM's settings, so nothing was shown.", true);
      }
      const binding: TabToolsBinding = { sessionId, ...(await deps.sessionProject(sessionId)) };
      const args = isObj(rawArgs) ? rawArgs : {};
      const resolved = await resolveTarget(args.path, binding);
      if (!resolved.ok) return textResult(resolved.error, true);
      return name === OPEN_FILE_TOOL ? openFile(binding, resolved.target, args) : openPreview(binding, resolved.target, args);
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

export const tabToolsMcpHandler = createTabToolsMcpHandler({
  resolveToken: (token) => tabToolsMcpTokens.resolve(token),
  sessionProject,
  request: (sessionId, req, waitMs) => tabOpenBroker.request(sessionId, req, waitMs),
  enabled: () => configService.get("ai").tab_tools === true,
});
