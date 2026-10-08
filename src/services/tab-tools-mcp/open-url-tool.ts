import { OPEN_URL_TOOL, type TabOpenAsk, type TabOpenUrlRequest } from "../../shared/tab-open-protocol.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { deviceError, type TabOpenOutcome } from "./tab-open-broker.ts";
import type { TabToolsBinding } from "./tab-target.ts";

/**
 * `open_url`: a web server running on the host — a dev server, typically — in a web-preview tab
 * on the user's device, the tab Port Forwarding opens.
 *
 * Only the host's own servers: the tool exists because a device cannot reach `localhost` on the
 * host, not to put arbitrary sites inside PPM. A device reaches the server through a forward the
 * user already runs for that port, else through a private Tailscale forward PPM starts (the
 * tailnet's own devices only), else directly, which works only from a browser on the host. PPM
 * never opens a public Cloudflare link for the AI: that is the user's call, in Port Forwarding.
 */

/** How long a device has to say the tab is open. */
export const OPEN_URL_WAIT_MS = 8_000;

type Via = TabOpenUrlRequest["via"];

export interface LocalUrl {
  protocol: "http:" | "https:";
  port: number;
  /** Path, query and fragment, as asked for. */
  path: string;
}

export interface OpenUrlDeps {
  request: (sessionId: string, req: TabOpenAsk, waitMs: number) => Promise<TabOpenOutcome>;
  /** Whether a server answers on this port on loopback. */
  listening: (port: number) => Promise<boolean>;
  /** The ports PPM itself answers on: a tab on PPM's own origin could read its token. */
  ownPorts: () => number[];
  /** A forward already running for this port. */
  existingForward: (port: number) => { url: string; via: "tailscale" | "cloudflare" } | null;
  /** Starts a private forward and answers its URL; throws why it could not. */
  startPrivateForward: (port: number) => Promise<string>;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"]);

/** The page asked for, when it is one on this machine. */
export function parseLocalUrl(input: unknown): { ok: true; url: LocalUrl } | { ok: false; error: string } {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, error: "`url` is required: the page on this machine, such as http://localhost:5173/." };
  }
  if (input.length > 4096) return { ok: false, error: "`url` is too long." };
  const given = input.trim();
  const raw = /^\d{1,5}$/.test(given) ? `http://localhost:${given}/` : /^[a-z][a-z\d+.-]*:\/\//i.test(given) ? given : `http://${given}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `${given} is not a URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Only an http or https page opens in a tab." };
  if (!LOOPBACK_HOSTS.has(url.hostname) && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname)) {
    return {
      ok: false,
      error: `open_url shows servers running on this machine (localhost) only, and ${url.host} is not one. Give the user that link in your reply instead.`,
    };
  }
  if (url.username || url.password) return { ok: false, error: "`url` must not carry a user name or password." };
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { ok: true, url: { protocol: url.protocol, port, path: `${url.pathname}${url.search}${url.hash}` } };
}

export function createOpenUrlTool(deps: OpenUrlDeps) {
  return async function openUrl(binding: TabToolsBinding, args: Record<string, unknown>): Promise<Json> {
    const parsed = parseLocalUrl(args.url);
    if (!parsed.ok) return textResult(parsed.error, true);
    const { protocol, port, path } = parsed.url;
    const asked = `${protocol}//localhost:${port}${path}`;
    if (deps.ownPorts().includes(port)) return textResult(`Port ${port} is PPM itself, which the user already has open.`, true);
    if (!(await deps.listening(port))) {
      return textResult(`Nothing is listening on port ${port} on this machine. Start the server first, wait until it says it is ready, then call open_url again.`, true);
    }

    let base = `${protocol}//localhost:${port}/`;
    let via: Via = "local";
    let how = "directly, which works because that device is this machine";
    let forwardFailed: string | null = null;
    const existing = deps.existingForward(port);
    if (existing) {
      ({ url: base, via } = existing);
      how = `through the ${via === "tailscale" ? "private Tailscale" : "public Cloudflare"} forward the user already has for port ${port} (${existing.url})`;
    } else {
      try {
        base = await deps.startPrivateForward(port);
        via = "tailscale";
        how = `through a private Tailscale forward PPM started for port ${port} (${base}), which only the user's own devices can open; it runs until stopped in Port Forwarding`;
      } catch (e) {
        forwardFailed = (e as Error).message;
      }
    }
    const url = via === "local" ? asked : new URL(path, base).href;

    const outcome = await deps.request(binding.sessionId, { tool: OPEN_URL_TOOL, url, port, via }, OPEN_URL_WAIT_MS);
    if (!outcome.ok) return textResult(`${outcome.message} The page is ${asked}.`, true);
    if (!outcome.result.opened) {
      const fix = forwardFailed
        ? ` PPM could not forward the port privately (${forwardFailed}); the user can forward it in Port Forwarding, or open ${asked} on this machine.`
        : "";
      return textResult(`The user's device could not open ${asked}: ${deviceError(outcome.result.error)}.${fix}`, true);
    }
    return textResult(`Opened ${asked} in a PPM tab on the user's device, ${how}. Nothing about the page comes back: check it with your own tools if you need to.`);
  };
}

export type OpenUrlTool = ReturnType<typeof createOpenUrlTool>;
