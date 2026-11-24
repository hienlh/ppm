/**
 * Names of the tools an AI chat drives PPM's browser with (`/api/tab-tools-mcp`). Shared so the
 * chat's cards and the server agree on them. They are governed by Settings → Web Browser
 * ("Let AI chats drive it"), not by Settings → Tools.
 */
export const BROWSER_TOOLS = [
  "browser_open", "browser_snapshot", "browser_screenshot", "browser_click", "browser_type",
  "browser_press", "browser_scroll", "browser_back", "browser_wait",
] as const;

export type BrowserTool = (typeof BROWSER_TOOLS)[number];

export const isBrowserTool = (name: unknown): name is BrowserTool => (BROWSER_TOOLS as readonly unknown[]).includes(name);
