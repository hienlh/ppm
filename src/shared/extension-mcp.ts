/**
 * Tools an extension serves to a chat it bound (`ppm.mcp.registerToolset`): the shapes, the
 * limits and the checks every registration passes on the main thread. The vscode-compat package
 * declares the same shapes for extensions (`packages/vscode-compat/src/ppm/ppm-mcp.ts`); it
 * cannot import from here.
 *
 * Claude sees a tool as `mcp__ppm-ext__<toolset>_<name>`, and the API refuses any tool name over
 * 64 characters — for the whole query, not just that tool. So the toolset id and the tool name
 * together are held to what fits behind the prefix.
 */
import { EXTENSION_MCP_TOOL_PREFIX, TOOLSET_ID_RE } from "./extension-session-binding.ts";

export interface ExtensionMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ExtensionMcpToolset {
  id: string;
  title: string;
  tools: ExtensionMcpToolDefinition[];
}

/** What a tool call answers; `isError` marks a failure the model should read as one. */
export interface ExtensionMcpToolResult {
  text: string;
  isError?: boolean;
}

export const EXTENSION_TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
export const MAX_EXTENSION_TOOLS = 40;
export const MAX_EXTENSION_TOOL_DESCRIPTION = 2_000;
export const MAX_EXTENSION_TOOL_SCHEMA_BYTES = 16 * 1024;
export const MAX_EXTENSION_TOOLSET_TITLE = 200;
/** The longest Claude accepts a tool's name to be. */
const MAX_PROVIDER_TOOL_NAME = 64;
/** `<toolset>_<name>`, the part after the server prefix. */
export const MAX_EXPOSED_TOOL_NAME = MAX_PROVIDER_TOOL_NAME - EXTENSION_MCP_TOOL_PREFIX.length;
/** Longest tool answer passed back to the model; the rest is cut with a note. */
export const MAX_EXTENSION_TOOL_RESULT_BYTES = 200 * 1024;
/** The per-call ceiling: long work is started by one tool and polled through another. */
export const EXTENSION_TOOL_CALL_TIMEOUT_MS = 600_000;
/** Answered for a tool whose extension has not registered it since PPM or its host started. */
export const EXTENSION_TOOLSET_STARTING = "Tiện ích đang khởi động, thử lại sau 30 giây";

/** The name the model calls a toolset's tool by, behind the `ppm-ext` server prefix. */
export const exposedToolName = (toolsetId: string, name: string): string => `${toolsetId}_${name}`;

/** Splits an exposed name; a toolset id holds no `_`, so the first one is the boundary. */
export function splitExposedToolName(exposed: string): { toolsetId: string; name: string } | null {
  const cut = exposed.indexOf("_");
  if (cut < 0) return null;
  const toolsetId = exposed.slice(0, cut);
  const name = exposed.slice(cut + 1);
  return TOOLSET_ID_RE.test(toolsetId) && EXTENSION_TOOL_NAME_RE.test(name) ? { toolsetId, name } : null;
}

/** `<extensionId>:<toolsetId>`; an extension id never holds a `:`. */
export const toolsetKey = (extensionId: string, toolsetId: string): string => `${extensionId}:${toolsetId}`;

export function splitToolsetKey(key: string): { extensionId: string; toolsetId: string } | null {
  const cut = key.lastIndexOf(":");
  if (cut <= 0) return null;
  const toolsetId = key.slice(cut + 1);
  return TOOLSET_ID_RE.test(toolsetId) ? { extensionId: key.slice(0, cut), toolsetId } : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function validateTool(raw: unknown, toolsetId: string, index: number): ExtensionMcpToolDefinition {
  const where = `tools[${index}]`;
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const { name, description, inputSchema } = raw;
  if (typeof name !== "string" || !EXTENSION_TOOL_NAME_RE.test(name)) {
    throw new Error(`${where}.name must be 2-41 lowercase letters, digits or _, starting with a letter`);
  }
  if (exposedToolName(toolsetId, name).length > MAX_EXPOSED_TOOL_NAME) {
    throw new Error(`${where}.name is too long: "${toolsetId}_${name}" must fit in ${MAX_EXPOSED_TOOL_NAME} characters`);
  }
  if (typeof description !== "string" || !description.trim() || description.length > MAX_EXTENSION_TOOL_DESCRIPTION) {
    throw new Error(`${where}.description must be 1-${MAX_EXTENSION_TOOL_DESCRIPTION} characters`);
  }
  if (!isObject(inputSchema) || inputSchema.type !== "object") throw new Error(`${where}.inputSchema must be a JSON schema of type "object"`);
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(inputSchema)).length;
  } catch {
    throw new Error(`${where}.inputSchema must be plain JSON`);
  }
  if (size > MAX_EXTENSION_TOOL_SCHEMA_BYTES) throw new Error(`${where}.inputSchema exceeds ${MAX_EXTENSION_TOOL_SCHEMA_BYTES} bytes`);
  return { name, description, inputSchema: JSON.parse(JSON.stringify(inputSchema)) as Record<string, unknown> };
}

/** Checks a registration at the RPC boundary; returns a clean copy, throws on the first problem. */
export function validateToolset(value: unknown): ExtensionMcpToolset {
  if (!isObject(value)) throw new Error("toolset must be an object");
  const { id, title, tools } = value;
  if (typeof id !== "string" || !TOOLSET_ID_RE.test(id)) throw new Error("toolset.id must be 2-16 lowercase letters or digits");
  if (typeof title !== "string" || !title.trim() || title.length > MAX_EXTENSION_TOOLSET_TITLE) {
    throw new Error(`toolset.title must be 1-${MAX_EXTENSION_TOOLSET_TITLE} characters`);
  }
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > MAX_EXTENSION_TOOLS) {
    throw new Error(`toolset.tools must hold 1-${MAX_EXTENSION_TOOLS} tools`);
  }
  const checked = tools.map((tool, i) => validateTool(tool, id, i));
  if (new Set(checked.map((t) => t.name)).size !== checked.length) throw new Error("toolset.tools must not repeat a name");
  return { id, title, tools: checked };
}

/**
 * A tool answer as the model may see it: text only, at most {@link MAX_EXTENSION_TOOL_RESULT_BYTES}.
 * Anything not shaped like a result is reported as an error rather than passed on.
 */
export function normaliseToolResult(value: unknown): ExtensionMcpToolResult {
  if (!isObject(value) || typeof value.text !== "string") {
    return { text: "The extension's tool returned no text result.", isError: true };
  }
  const bytes = new TextEncoder().encode(value.text);
  const isError = value.isError === true;
  if (bytes.length <= MAX_EXTENSION_TOOL_RESULT_BYTES) return isError ? { text: value.text, isError } : { text: value.text };
  // Cut on a byte boundary, then drop a character the cut split in half.
  const head = new TextDecoder().decode(bytes.subarray(0, MAX_EXTENSION_TOOL_RESULT_BYTES)).replace(/�$/, "");
  const text = `${head}\n\n[Truncated: the tool returned ${bytes.length} bytes; only the first ${MAX_EXTENSION_TOOL_RESULT_BYTES} are shown.]`;
  return isError ? { text, isError } : { text };
}
