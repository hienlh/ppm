/**
 * A link that opens an extension's own command or webview panel in the app, carried by a
 * notification. It is an in-app path with query parameters, so push, Telegram and ntfy all
 * share it through `notificationPath`:
 *
 *   /project/<name>?extCommand=<command>&extArgs=<base64url(JSON args)>
 *   /?extView=<viewType>
 *
 * The browser runs it locally (see `src/web/lib/extension-deep-link-runner.ts`), because a
 * panel only gets a tab on the device that dispatched its command. Shared by the server, which
 * builds the link, and the browser, which parses it — so both sides apply the same limits.
 */

export type DeepLinkArg = string | number | boolean | null;

export type ExtensionDeepLinkTarget = { command: string; args?: DeepLinkArg[] } | { view: string };

export type ParsedExtensionDeepLink =
  | { kind: "command"; command: string; args: DeepLinkArg[]; projectName?: string }
  | { kind: "view"; view: string; projectName?: string };

export const DEEP_LINK_MAX_ARGS = 8;
export const DEEP_LINK_MAX_ARGS_BYTES = 1024;
/** Command ids and view types: what a manifest uses in practice, nothing that needs escaping. */
const ID_PATTERN = /^[\w.-]{1,200}$/;

export const DEEP_LINK_PARAMS = ["extCommand", "extArgs", "extView"] as const;

export function isDeepLinkId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Why `args` cannot ride in a link, or null when they can. */
export function deepLinkArgsProblem(args: unknown): string | null {
  if (!Array.isArray(args)) return "args must be an array";
  if (args.length > DEEP_LINK_MAX_ARGS) return `at most ${DEEP_LINK_MAX_ARGS} args`;
  for (const a of args) {
    const ok = a === null || typeof a === "string" || typeof a === "boolean" || (typeof a === "number" && Number.isFinite(a));
    if (!ok) return "args may only hold strings, finite numbers, booleans and null";
  }
  if (new TextEncoder().encode(JSON.stringify(args)).length > DEEP_LINK_MAX_ARGS_BYTES) {
    return `args must be at most ${DEEP_LINK_MAX_ARGS_BYTES} bytes as JSON`;
  }
  return null;
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The in-app path for a target. Throws when the target breaks the limits above. */
export function buildExtensionDeepLink(input: { projectName?: string; open: ExtensionDeepLinkTarget }): string {
  const params = new URLSearchParams();
  if ("view" in input.open) {
    if (!isDeepLinkId(input.open.view)) throw new Error("open.view is not a valid view type");
    params.set("extView", input.open.view);
  } else {
    if (!isDeepLinkId(input.open.command)) throw new Error("open.command is not a valid command id");
    params.set("extCommand", input.open.command);
    const args = input.open.args ?? [];
    const problem = deepLinkArgsProblem(args);
    if (problem) throw new Error(`open.${problem}`);
    if (args.length) params.set("extArgs", toBase64Url(JSON.stringify(args)));
  }
  const base = input.projectName ? `/project/${encodeURIComponent(input.projectName)}` : "/";
  return `${base}?${params.toString()}`;
}

/** The project a link is scoped to, from its `/project/<name>` path. */
function projectOf(pathname: string): string | undefined {
  const match = /^\/project\/([^/]+)/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

/**
 * The deep link a URL carries, or null when it carries none or a malformed one. Anything that
 * fails a limit is dropped whole rather than run with the part that passed.
 */
export function parseExtensionDeepLink(url: string | URL): ParsedExtensionDeepLink | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url, "http://ppm.invalid") : url;
  } catch {
    return null;
  }
  const projectName = projectOf(parsed.pathname);
  const scope = projectName ? { projectName } : {};
  const view = parsed.searchParams.get("extView");
  const command = parsed.searchParams.get("extCommand");
  if (view !== null && command !== null) return null;
  if (view !== null) return isDeepLinkId(view) ? { kind: "view", view, ...scope } : null;
  if (command === null || !isDeepLinkId(command)) return null;

  const rawArgs = parsed.searchParams.get("extArgs");
  let args: DeepLinkArg[] = [];
  if (rawArgs !== null) {
    const json = fromBase64Url(rawArgs);
    if (json === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return null;
    }
    if (deepLinkArgsProblem(value)) return null;
    args = value as DeepLinkArg[];
  }
  return { kind: "command", command, args, ...scope };
}

/** The same URL with the deep-link parameters removed, so a reload does not run it again. */
export function stripExtensionDeepLink(url: string | URL): URL {
  const next = new URL(typeof url === "string" ? url : url.href);
  for (const name of DEEP_LINK_PARAMS) next.searchParams.delete(name);
  return next;
}
