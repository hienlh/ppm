/**
 * Settings → PPM Assistant: the Assistant's own provider, model, effort, instructions and MCP
 * servers, kept apart from everything ordinary chats use. Shared by the server, which stores and
 * enforces them, and the settings pane, which edits them.
 *
 * An MCP server's `env` and `headers` values are secrets: the server never sends them to a
 * browser. The pane receives every value blanked (see {@link AssistantSettingsView}) and sends a
 * blank back for "keep what is saved".
 */

export const ASSISTANT_INSTRUCTIONS_MAX_CHARS = 8000;
export const ASSISTANT_MCP_MAX_SERVERS = 20;
const MAX_NAME = 48;
const MAX_COMMAND = 1024;
const MAX_ARGS = 64;
const MAX_ARG = 4096;
const MAX_PAIRS = 32;
const MAX_VALUE = 8192;
const MAX_MODEL = 200;

/** The effort levels both providers take (`xhigh` is what the UI calls "Extra"). */
export const ASSISTANT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AssistantEffort = (typeof ASSISTANT_EFFORTS)[number];

/** The Assistant's own tool server, as each provider names it. No user server may take either. */
const RESERVED_NAMES = ["ppm-assistant", "ppm_assistant"];

export interface AssistantProviderDefaults {
  /** Empty or absent: the provider's own chat default. */
  model?: string;
  effort?: AssistantEffort;
}

interface McpServerBase {
  /** Stable across renames, so a saved secret follows its server. */
  id: string;
  name: string;
  enabled: boolean;
}

export interface AssistantMcpStdioServer extends McpServerBase {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AssistantMcpHttpServer extends McpServerBase {
  transport: "http";
  url: string;
  headers: Record<string, string>;
}

export type AssistantMcpServer = AssistantMcpStdioServer | AssistantMcpHttpServer;

export interface AssistantSettings {
  /** The provider a new Assistant session starts on; null follows the chat default. */
  default_provider: string | null;
  /** Model and effort per provider id, for new Assistant sessions. */
  providers: Record<string, AssistantProviderDefaults>;
  /** The user's own instructions, added after PPM's. */
  instructions: string;
  mcp_servers: AssistantMcpServer[];
}

/**
 * What a browser is sent: every env and header value blanked. The keys stay, so the pane can
 * show which ones are saved.
 */
export type AssistantSettingsView = AssistantSettings;

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  default_provider: null,
  providers: {},
  instructions: "",
  mcp_servers: [],
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PROVIDER_ID_RE = /^[a-z0-9_-]{1,40}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Case and `-`/`_` folded, the way two names are compared for clashes. */
export function foldMcpName(name: string): string {
  return name.toLowerCase().replaceAll("_", "-");
}

/**
 * Why a server name cannot be used, or null. Only letters, digits, `-` and `_`, which both
 * providers accept as a server key; never two underscores in a row, because Claude names a tool
 * `mcp__<server>__<tool>` and a name carrying `__` could pass for another server's tool; never
 * the Assistant's own server — nor that name with `_` or `-` added at the end, since
 * `ppm-assistant_` makes tool names that begin `mcp__ppm-assistant__`, which read as the
 * Assistant's own.
 */
export function assistantMcpNameError(name: string): string | null {
  if (!name) return "Name is required";
  if (name.length > MAX_NAME) return `Name must be at most ${MAX_NAME} characters`;
  if (!NAME_RE.test(name)) return "Name must start with a letter or digit and use only letters, digits, - and _";
  if (name.includes("__")) return "Name cannot contain two underscores in a row";
  const bare = foldMcpName(name).replace(/[-_]+$/, "");
  if (RESERVED_NAMES.some((r) => foldMcpName(r) === bare)) return `"${name}" is the Assistant's own tool server`;
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readPairs(raw: unknown, keyRe: RegExp, what: string, where: string, errors: string[]): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) { errors.push(`${where}: ${what} must be an object`); return {}; }
  const out: Record<string, string> = {};
  const entries = Object.entries(raw);
  if (entries.length > MAX_PAIRS) errors.push(`${where}: at most ${MAX_PAIRS} ${what}`);
  for (const [key, value] of entries.slice(0, MAX_PAIRS)) {
    if (!keyRe.test(key)) { errors.push(`${where}: "${key}" is not a valid ${what === "headers" ? "header name" : "variable name"}`); continue; }
    if (typeof value !== "string") { errors.push(`${where}: ${key} must be text`); continue; }
    if (value.length > MAX_VALUE) { errors.push(`${where}: ${key} is too long`); continue; }
    if (what === "headers" && /[\r\n]/.test(value)) { errors.push(`${where}: ${key} cannot contain a line break`); continue; }
    out[key] = value;
  }
  return out;
}

function readServer(raw: unknown, index: number, errors: string[]): AssistantMcpServer | null {
  const where = `MCP server ${index + 1}`;
  if (!isRecord(raw)) { errors.push(`${where} is not an object`); return null; }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const nameError = assistantMcpNameError(name);
  if (nameError) { errors.push(`${where}: ${nameError}`); return null; }
  const at = `MCP server "${name}"`;
  const id = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : "";
  const enabled = raw.enabled !== false;
  if (raw.transport === "stdio") {
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!command) { errors.push(`${at}: command is required`); return null; }
    if (command.length > MAX_COMMAND) { errors.push(`${at}: command is too long`); return null; }
    const args = raw.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((a) => typeof a !== "string" || a.length > MAX_ARG)) {
      errors.push(`${at}: arguments must be at most ${MAX_ARGS} pieces of text`);
      return null;
    }
    return { id, name, enabled, transport: "stdio", command, args: args as string[], env: readPairs(raw.env, ENV_KEY_RE, "variables", at, errors) };
  }
  if (raw.transport === "http") {
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    let parsed: URL | null = null;
    try { parsed = new URL(url); } catch { /* reported below */ }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      errors.push(`${at}: URL must be an http:// or https:// address`);
      return null;
    }
    return { id, name, enabled, transport: "http", url, headers: readPairs(raw.headers, HEADER_KEY_RE, "headers", at, errors) };
  }
  errors.push(`${at}: transport must be stdio or http`);
  return null;
}

function readProviders(raw: unknown, errors: string[]): Record<string, AssistantProviderDefaults> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) { errors.push("providers must be an object"); return {}; }
  const out: Record<string, AssistantProviderDefaults> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!PROVIDER_ID_RE.test(id)) { errors.push(`"${id}" is not a provider id`); continue; }
    if (!isRecord(value)) { errors.push(`providers.${id} must be an object`); continue; }
    const entry: AssistantProviderDefaults = {};
    if (value.model !== undefined && value.model !== null && value.model !== "") {
      if (typeof value.model !== "string" || value.model.trim().length > MAX_MODEL) errors.push(`providers.${id}.model is not a model name`);
      else if (value.model.trim()) entry.model = value.model.trim();
    }
    if (value.effort !== undefined && value.effort !== null && value.effort !== "") {
      if (!ASSISTANT_EFFORTS.includes(value.effort as AssistantEffort)) errors.push(`providers.${id}.effort must be one of ${ASSISTANT_EFFORTS.join(", ")}`);
      else entry.effort = value.effort as AssistantEffort;
    }
    if (entry.model || entry.effort) out[id] = entry;
  }
  return out;
}

/**
 * Checks and normalises settings from outside (a request body, a stored row). Never throws:
 * every problem found is listed, and `value` holds what was valid. Server ids are kept only when
 * well-formed; the caller assigns fresh ones to the rest.
 */
export function readAssistantSettings(raw: unknown): { value: AssistantSettings; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { value: structuredClone(DEFAULT_ASSISTANT_SETTINGS), errors: ["settings must be an object"] };

  let defaultProvider: string | null = null;
  if (raw.default_provider !== undefined && raw.default_provider !== null && raw.default_provider !== "") {
    if (typeof raw.default_provider === "string" && PROVIDER_ID_RE.test(raw.default_provider)) defaultProvider = raw.default_provider;
    else errors.push("default_provider is not a provider id");
  }

  let instructions = "";
  if (raw.instructions !== undefined && raw.instructions !== null) {
    if (typeof raw.instructions !== "string") errors.push("instructions must be text");
    else {
      instructions = raw.instructions.trim();
      if (instructions.length > ASSISTANT_INSTRUCTIONS_MAX_CHARS) {
        errors.push(`instructions must be at most ${ASSISTANT_INSTRUCTIONS_MAX_CHARS} characters`);
        instructions = instructions.slice(0, ASSISTANT_INSTRUCTIONS_MAX_CHARS);
      }
    }
  }

  const servers: AssistantMcpServer[] = [];
  const rawServers = raw.mcp_servers ?? [];
  if (!Array.isArray(rawServers)) errors.push("mcp_servers must be a list");
  else {
    if (rawServers.length > ASSISTANT_MCP_MAX_SERVERS) errors.push(`at most ${ASSISTANT_MCP_MAX_SERVERS} MCP servers`);
    const seen = new Set<string>();
    rawServers.slice(0, ASSISTANT_MCP_MAX_SERVERS).forEach((item, i) => {
      const server = readServer(item, i, errors);
      if (!server) return;
      const folded = foldMcpName(server.name);
      if (seen.has(folded)) { errors.push(`Two MCP servers are named "${server.name}"`); return; }
      seen.add(folded);
      servers.push(server);
    });
  }

  return {
    value: { default_provider: defaultProvider, providers: readProviders(raw.providers, errors), instructions, mcp_servers: servers },
    errors,
  };
}

/** The settings with every env and header value blanked, for a browser. */
export function maskAssistantSettings(settings: AssistantSettings): AssistantSettingsView {
  const blank = (pairs: Record<string, string>) => Object.fromEntries(Object.keys(pairs).map((k) => [k, ""]));
  return {
    ...settings,
    providers: structuredClone(settings.providers),
    mcp_servers: settings.mcp_servers.map((s) => s.transport === "stdio"
      ? { ...s, args: [...s.args], env: blank(s.env) }
      : { ...s, headers: blank(s.headers) }),
  };
}
