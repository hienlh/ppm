/** Ask the server for a tree item's children (handled by the extension WS bridge). */
export function requestTreeExpand(viewId: string, itemId: string): void {
  window.dispatchEvent(new CustomEvent("ext:tree:expand", { detail: { viewId, itemId } }));
}

/** Run an extension command through the WS bridge, as a click in this browser. */
export function executeExtensionCommand(command: string, args?: unknown[]): void {
  window.dispatchEvent(new CustomEvent("ext:command:execute", { detail: { command, args } }));
}

/**
 * A row's link, if it is http(s). Checked here as well as in vscode-compat because the item
 * arrives over the socket, and an `href` of `javascript:` would run in PPM's own page.
 */
export function safeRowUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
