import {
  CLAUDE_TAB_TOOLS_MCP_SERVER, CODEX_TAB_TOOLS_MCP_SERVER, MAX_TAB_LINE, OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL, type TabTool,
} from "../../shared/tab-open-protocol";
import { isImagePlaceholderText } from "../../shared/tool-result-content";

/**
 * Reads a chat event as a call of the AI's tab tools, for the card that shows it
 * (`tab-tool-card.tsx`). Pure, so it is tested without the stores.
 */

export interface TabToolCall {
  tool: TabTool;
  /** As the AI passed it: absolute, `~`-relative, or relative to the chat's project. */
  path: string;
  line?: number;
}

/*
 * Claude names the tool `mcp__ppm-tabs__open_file`. Codex names it `ppm_tabs:open_file` and wraps
 * the arguments as `{ server, tool, arguments }`, live and in the history read back alike.
 */
const TOOL_NAME = new RegExp(
  `^(?:mcp__${CLAUDE_TAB_TOOLS_MCP_SERVER}__|${CODEX_TAB_TOOLS_MCP_SERVER}:)(${OPEN_FILE_TOOL}|${OPEN_PREVIEW_TOOL})$`,
);

/** How Codex's events label an image block of a result (`mcpResultText`). */
const CODEX_IMAGE_LABEL = /^\[image(?: [^\]\s]+)?\]$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The tab tool call an event is, under either provider's name, or null. */
export function tabToolCall(toolName: string, input: unknown): TabToolCall | null {
  const tool = TOOL_NAME.exec(toolName)?.[1] as TabTool | undefined;
  if (!tool || !isObj(input)) return null;
  const args = "arguments" in input ? input.arguments : input;
  if (!isObj(args) || typeof args.path !== "string" || !args.path.trim()) return null;
  const line = args.line;
  const validLine = tool === OPEN_FILE_TOOL && typeof line === "number" && Number.isInteger(line) && line >= 1 && line <= MAX_TAB_LINE;
  return { tool, path: args.path, ...(validLine ? { line } : {}) };
}

/** A tool result's text as the AI read it, without the stand-in for the screenshot. */
export function tabToolResultText(output: string): string {
  const plain = () => output.split("\n").filter((line) => !CODEX_IMAGE_LABEL.test(line)).join("\n").trimEnd();
  if (!output.startsWith("[")) return plain();
  try {
    const blocks: unknown = JSON.parse(output);
    if (!Array.isArray(blocks)) return plain();
    return blocks
      .filter((b): b is { type: "text"; text: string } => isObj(b) && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .filter((text) => !isImagePlaceholderText(text))
      .join("\n\n");
  } catch {
    return plain();
  }
}

/**
 * How many problems an `open_preview` check reported, or null for any other result. Only the
 * line `formatPreviewCheck` writes it on is read: the findings below it quote the page, which
 * could otherwise put a count of its own there.
 */
export function previewProblemCount(text: string): number | null {
  const line = text.split("\n")[1] ?? "";
  if (line.startsWith("No layout problems or runtime errors were found")) return 0;
  const match = /^(\d+) problems? found\b/.exec(line);
  return match ? Number(match[1]) : null;
}
