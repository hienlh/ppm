/**
 * Whether an AI chat may use the `browser_*` tools right now. Kept apart from `browser-tools.ts`
 * so `/api/tab-tools-mcp` can hide the tools from `tools/list` without loading the browser host:
 * a chat whose user has the browser off, or has AI control off, is never offered them.
 */
import { configService } from "../config.service.ts";
import { parseWebBrowserSettings } from "../../shared/web-browser-settings.ts";
import { isWebBrowserAllowedByEnv } from "./web-browser-flag.ts";

/** Why the browser tools do nothing right now, or null when they may act. */
export function browserToolsUnavailable(): string | null {
  if (!isWebBrowserAllowedByEnv()) return "PPM's web browser is disabled on this host.";
  const s = parseWebBrowserSettings(configService.get("web_browser"));
  if (s.enabled !== true) return "PPM's web browser is turned off (Settings → Web Browser), so nothing was done.";
  if (!s.aiControl) return "The user does not let AI chats drive PPM's browser (Settings → Web Browser), so nothing was done.";
  return null;
}
