/** Process-scoped mode; propagated through supervisor/server argv, never global config. */
export function isMinimalMode(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--minimal");
}

/** Services outside the chat workspace stay unavailable, even to a stale full-mode client. */
export function isMinimalPathDisabled(path: string): boolean {
  if (path.startsWith("/ws/")) {
    return !/^\/ws\/(health|global)\/?$/.test(path) && !/^\/ws\/project\/[^/]+\/chat(?:\/|$)/.test(path);
  }
  return /^\/(proxy|s)(\/|$)/.test(path)
    || /^\/api\/(db|db-tools-mcp|tab-tools-mcp|design-mcp|design-preview|design-shares|system|extensions|schedules|jira|ppmbot|group-chat|remote-desktop|android|lsp|preview|html-preview|tunnels|logs)(\/|$)/.test(path)
    || /^\/api\/settings\/(design|clawbot)(\/|$)/.test(path)
    || /^\/api\/project\/[^/]+\/(git|lsp|designs)(\/|$)/.test(path);
}
