/**
 * A link a webview asks the app to open.
 *
 * The panel's iframe is sandboxed with `allow-scripts` and nothing else, so
 * `window.open` inside it is blocked without a word — the Git Graph's "Open on
 * GitHub" and "Create pull request" simply did nothing. The extension API has
 * no way out either (`env.openExternal` answers false). So the frame posts
 * `{ command: "__ppm.openExternal", url }` and the app opens it, the way a
 * link would: only http(s), in a new tab, with no opener.
 */
export const OPEN_EXTERNAL_COMMAND = "__ppm.openExternal";

/**
 * `undefined` when the message is anything else (forward it to the extension
 * as usual); otherwise the URL to open, or null for one that is not a web
 * address — which is swallowed rather than forwarded, since it was addressed
 * to the app.
 */
export function externalLinkRequest(data: unknown): string | null | undefined {
  if (!data || typeof data !== "object" || (data as { command?: unknown }).command !== OPEN_EXTERNAL_COMMAND) return undefined;
  const raw = (data as { url?: unknown }).url;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
