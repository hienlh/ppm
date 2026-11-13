/**
 * What an extension may attach to a Claude chat session it created: instructions appended to
 * the system prompt, the ids of its MCP toolsets, and a tool policy that decides every tool
 * the chat may use. The vscode-compat package declares the same shapes for extensions
 * (`packages/vscode-compat/src/ppm/ppm-chat.ts`); it cannot import from here.
 */

/**
 * Every tool gets an explicit allow or deny, so a bound session never shows an approval card
 * and never falls into a permission mode's own auto-approvals. Roots are absolute paths;
 * protected paths are globs matched below each write root, at any depth.
 */
export interface ExtensionToolPolicy {
  readRoots: string[];
  writeRoots: string[];
  protectedPaths?: string[];
  /** Tool names allowed outright (e.g. `TodoWrite`). Cannot widen the file tools' path rules. */
  allowTools?: string[];
}

export interface ExtensionSessionBinding {
  sessionId: string;
  extensionId: string;
  instructions: string | null;
  toolsets: string[];
  toolPolicy: ExtensionToolPolicy | null;
  updatedAt: string;
}

/** A `bind` call: a field left out keeps its value, `null` clears it. */
export interface ExtensionBindingInput {
  instructions?: string | null;
  toolsets?: string[];
  toolPolicy?: ExtensionToolPolicy | null;
}

export const MAX_BINDING_INSTRUCTIONS_BYTES = 64 * 1024;
export const MAX_BINDING_TOOLSETS = 8;
export const TOOLSET_ID_RE = /^[a-z0-9]{2,16}$/;
/** The MCP server every extension toolset is served under, and its tools' name prefix. */
export const EXTENSION_MCP_SERVER = "ppm-ext";
export const EXTENSION_MCP_TOOL_PREFIX = `mcp__${EXTENSION_MCP_SERVER}__`;

const MAX_ROOTS = 32;
const MAX_PATTERNS = 256;
const MAX_ALLOW_TOOLS = 64;
const MAX_ENTRY_LENGTH = 4096;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const ABSOLUTE_RE = /^(?:[a-zA-Z]:[\\/]|[\\/])/;

function stringList(value: unknown, field: string, max: number, check: (entry: string) => boolean, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > max) throw new Error(`${field} holds at most ${max} entries`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry || entry.length > MAX_ENTRY_LENGTH || entry.includes("\0") || !check(entry)) {
      throw new Error(`${field} entries must be ${what}`);
    }
    return entry;
  });
}

export function validateToolPolicy(value: unknown): ExtensionToolPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("toolPolicy must be an object");
  const p = value as Record<string, unknown>;
  const absolute = (s: string) => ABSOLUTE_RE.test(s);
  const policy: ExtensionToolPolicy = {
    readRoots: stringList(p.readRoots, "toolPolicy.readRoots", MAX_ROOTS, absolute, "absolute paths"),
    writeRoots: stringList(p.writeRoots, "toolPolicy.writeRoots", MAX_ROOTS, absolute, "absolute paths"),
  };
  if (p.protectedPaths !== undefined) {
    policy.protectedPaths = stringList(p.protectedPaths, "toolPolicy.protectedPaths", MAX_PATTERNS, (s) => !absolute(s) && !/^[a-zA-Z]:/.test(s), "relative patterns");
  }
  if (p.allowTools !== undefined) {
    policy.allowTools = stringList(p.allowTools, "toolPolicy.allowTools", MAX_ALLOW_TOOLS, (s) => TOOL_NAME_RE.test(s), "tool names");
  }
  return policy;
}

export function validateToolsets(value: unknown): string[] {
  const ids = stringList(value, "toolsets", MAX_BINDING_TOOLSETS, (s) => TOOLSET_ID_RE.test(s), "ids of 2-16 lowercase letters or digits");
  if (new Set(ids).size !== ids.length) throw new Error("toolsets must not repeat an id");
  return ids;
}

export function validateInstructions(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("instructions must be a string or null");
  if (new TextEncoder().encode(value).length > MAX_BINDING_INSTRUCTIONS_BYTES) {
    throw new Error(`instructions exceed ${MAX_BINDING_INSTRUCTIONS_BYTES} bytes`);
  }
  return value;
}

/** Checks a `bind` call's input at the RPC boundary; throws on the first problem. */
export function validateBindingInput(value: unknown): ExtensionBindingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("binding must be an object");
  const raw = value as Record<string, unknown>;
  const input: ExtensionBindingInput = {};
  if (raw.instructions !== undefined) input.instructions = validateInstructions(raw.instructions);
  if (raw.toolsets !== undefined) input.toolsets = validateToolsets(raw.toolsets);
  if (raw.toolPolicy !== undefined) input.toolPolicy = raw.toolPolicy === null ? null : validateToolPolicy(raw.toolPolicy);
  return input;
}
