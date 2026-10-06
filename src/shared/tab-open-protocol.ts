import { CHECK_REQUEST_ID_RE, parseCanvasCheckReport, type CanvasCheckReport } from "./design-canvas-check";

/**
 * How the AI's tab tools (`open_file`, `open_preview`) reach the user's device: over the chat
 * WebSocket, the server sends `tab_open` to the device that sent the turn's message (or, when
 * that one is gone, to every device showing the chat), and the first device to answer settles
 * the call with `tab_open_result` on the same socket — once the tab is open and, for a page
 * the AI made, once the page has loaded and been checked.
 *
 * Neither message is buffered for replay: a reconnecting device must not open the tab again.
 */

export type TabTool = "open_file" | "open_preview";

/*
 * The names each provider knows the tools by. Claude addresses MCP tools as
 * `mcp__<server>__<tool>`; Codex takes the server name from its config key, where a hyphen is
 * not a safe character, hence the separate name, and its tool cards read `<server>:<tool>`.
 * Neither is plain `ppm`, which a user may already have as an MCP server of their own.
 */
export const OPEN_FILE_TOOL = "open_file";
export const OPEN_PREVIEW_TOOL = "open_preview";
export const CLAUDE_TAB_TOOLS_MCP_SERVER = "ppm-tabs";
export const CLAUDE_OPEN_FILE_TOOL = `mcp__${CLAUDE_TAB_TOOLS_MCP_SERVER}__${OPEN_FILE_TOOL}`;
export const CLAUDE_OPEN_PREVIEW_TOOL = `mcp__${CLAUDE_TAB_TOOLS_MCP_SERVER}__${OPEN_PREVIEW_TOOL}`;
export const CODEX_TAB_TOOLS_MCP_SERVER = "ppm_tabs";

export interface TabOpenRequest {
  type: "tab_open";
  requestId: string;
  tool: TabTool;
  /** As a PPM tab names it: relative to `projectName`'s folder, or absolute outside it. */
  filePath: string;
  projectName: string | null;
  /** The 1-based line to show; the file opens as code. */
  line?: number;
  /** An HTML page shown by `open_preview`: check it once it has loaded. */
  check?: { screenshot: boolean };
}

export interface TabOpenResult {
  type: "tab_open_result";
  requestId: string;
  /** False when the device could not open the tab. */
  opened: boolean;
  /** Why the tab could not open, or why a check that was asked for did not run. */
  error?: string;
  report?: CanvasCheckReport;
}

export const MAX_TAB_OPEN_ERROR_CHARS = 300;
export const MAX_TAB_LINE = 10_000_000;

/**
 * A device's answer, validated. The report was measured inside the page, whose own scripts
 * can write anything into it, so it goes through the same parser as a design check's.
 */
export function parseTabOpenResult(raw: unknown): TabOpenResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "tab_open_result" || typeof r.requestId !== "string" || !CHECK_REQUEST_ID_RE.test(r.requestId)) return null;
  if (typeof r.opened !== "boolean") return null;
  const result: TabOpenResult = { type: "tab_open_result", requestId: r.requestId, opened: r.opened };
  if (typeof r.error === "string" && r.error) result.error = r.error.slice(0, MAX_TAB_OPEN_ERROR_CHARS);
  if (r.report !== undefined) {
    const report = parseCanvasCheckReport(r.report);
    if (report) result.report = report;
  }
  return result;
}
