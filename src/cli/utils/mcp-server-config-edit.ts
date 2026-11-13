import type { McpServerConfig } from "../../types/mcp.ts";

/**
 * The pure half of `ppm mcp add|edit|list`: an MCP server's config built from the command's
 * options, and the same config as it may be printed — env and header values are tokens more
 * often than not, so they are never shown, only their names.
 */

export interface McpEditOptions {
  command?: string;
  arg?: string[];
  url?: string;
  type?: string;
  /** Values already typed at the terminal, by name. */
  env?: Record<string, string>;
  header?: Record<string, string>;
  unsetEnv?: string[];
  unsetHeader?: string[];
}

export const REDACTED = "[REDACTED]";

const isRemote = (c: McpServerConfig): c is Extract<McpServerConfig, { url: string }> => "url" in c;

/** The new config for `existing` (null for `add`) with `opts` applied, or an error to print. */
export function buildMcpConfig(existing: McpServerConfig | null, opts: McpEditOptions): McpServerConfig | { error: string } {
  if (opts.command && opts.url) return { error: "Give --command or --url, not both" };
  if (opts.type && !["http", "sse"].includes(opts.type)) return { error: "--type is http or sse (a --command server is stdio)" };
  let next: McpServerConfig;
  if (opts.command) {
    const keep = existing && !isRemote(existing) ? existing : null;
    next = { command: opts.command, ...(opts.arg?.length ? { args: opts.arg } : keep?.args ? { args: keep.args } : {}), ...(keep?.env ? { env: { ...keep.env } } : {}) };
  } else if (opts.url) {
    const keep = existing && isRemote(existing) ? existing : null;
    next = { type: (opts.type ?? keep?.type ?? "http") as "http" | "sse", url: opts.url, ...(keep?.headers ? { headers: { ...keep.headers } } : {}) };
  } else if (existing) {
    next = structuredClone(existing);
    if (opts.arg?.length) {
      if (isRemote(next)) return { error: "--arg is for a --command server" };
      next.args = opts.arg;
    }
    if (opts.type) {
      if (!isRemote(next)) return { error: "--type is for a --url server" };
      next.type = opts.type as "http" | "sse";
    }
  } else {
    return { error: "Give --command <cmd> (a local server) or --url <url> (a remote one)" };
  }

  const remote = isRemote(next);
  if (remote && (Object.keys(opts.env ?? {}).length || opts.unsetEnv?.length)) return { error: "--env is for a --command server; a --url server takes --header" };
  if (!remote && (Object.keys(opts.header ?? {}).length || opts.unsetHeader?.length)) return { error: "--header is for a --url server; a --command server takes --env" };
  if (isRemote(next)) {
    const headers = { ...(next.headers ?? {}), ...(opts.header ?? {}) };
    for (const h of opts.unsetHeader ?? []) delete headers[h];
    if (Object.keys(headers).length) next.headers = headers; else delete next.headers;
  } else {
    const env = { ...(next.env ?? {}), ...(opts.env ?? {}) };
    for (const k of opts.unsetEnv ?? []) delete env[k];
    if (Object.keys(env).length) next.env = env; else delete next.env;
  }
  return next;
}

/** `config` with every env and header value replaced by `[REDACTED]`. */
export function redactMcpConfig(config: McpServerConfig): McpServerConfig {
  const copy = structuredClone(config) as McpServerConfig & { env?: Record<string, string>; headers?: Record<string, string> };
  for (const field of ["env", "headers"] as const) {
    const values = copy[field];
    if (values) copy[field] = Object.fromEntries(Object.keys(values).map((k) => [k, REDACTED]));
  }
  return copy;
}

/** One line for `ppm mcp list`: what runs or where it connects, and the names of its secrets. */
export function describeMcpServer(name: string, config: McpServerConfig): string {
  if (isRemote(config)) {
    const headers = Object.keys(config.headers ?? {});
    return `${name}  ${config.type} ${config.url}${headers.length ? `  headers: ${headers.join(", ")}` : ""}`;
  }
  const env = Object.keys(config.env ?? {});
  return `${name}  stdio ${[config.command, ...(config.args ?? [])].join(" ")}${env.length ? `  env: ${env.join(", ")}` : ""}`;
}

/** Valid as an env var or header name, so a typo is caught before the value is asked for. */
export function isMcpSecretName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(name);
}
