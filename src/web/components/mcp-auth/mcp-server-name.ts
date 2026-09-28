/**
 * A plugin's MCP server is named `plugin:<plugin>:<server>` by the CLI. The prefix is what
 * keeps names unique, but in a one-line bar it pushes every server after the first out of
 * view, so the bar shows the last segment and keeps the full name as the tooltip.
 */
export function shortMcpServerName(name: string): string {
  if (!name.startsWith("plugin:")) return name;
  const last = name.slice(name.lastIndexOf(":") + 1);
  return last || name;
}
