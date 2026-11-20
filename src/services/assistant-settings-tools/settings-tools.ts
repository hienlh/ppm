import type { FamilyHandler, FamilyHandlers, ToolContext } from "../assistant-mcp/assistant-tool-family.ts";
import type { Json } from "../mcp-http-endpoint.ts";
import { errorResult } from "../assistant-mcp/assistant-tool-output.ts";
import {
  SETTINGS_GET_TOOL, SETTINGS_HISTORY_TOOL, SETTINGS_INSTALL_STATUS_TOOL, SETTINGS_INSTALL_TOOL, SETTINGS_SET_TOOL, SETTINGS_UNDO_TOOL,
} from "../../shared/assistant-settings-tool-names.ts";
import { settingsGet, settingsHistory } from "./settings-read-tools.ts";
import { settingsSet, settingsUndo } from "./settings-write-tools.ts";
import { settingsInstall, settingsInstallStatus } from "./settings-install-tools.ts";
import { settingsToolsOn } from "./settings-catalog-refused.ts";

export { SETTINGS_ROUTES } from "./settings-tool-routes.ts";

/**
 * The settings family's handlers. The endpoint hides these tools while the user has not turned
 * them on; a call arriving anyway (a session started before they were turned off) is refused here.
 */

const OFF = "The settings tools are off: the user turns them on in Settings → PPM Assistant → Changes. Open that pane for them instead.";

const guard = (run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<Json>): FamilyHandler => async (ctx, args) => {
  if (!settingsToolsOn()) return errorResult(OFF);
  try {
    return await run(ctx, args);
  } catch (e) {
    return errorResult(`The settings tool failed: ${(e as Error).message}. Nothing more was done.`);
  }
};

export const SETTINGS_TOOL_HANDLERS: FamilyHandlers = {
  [SETTINGS_GET_TOOL]: guard(settingsGet),
  [SETTINGS_SET_TOOL]: guard(settingsSet),
  [SETTINGS_HISTORY_TOOL]: guard(settingsHistory),
  [SETTINGS_UNDO_TOOL]: guard(settingsUndo),
  [SETTINGS_INSTALL_TOOL]: guard(settingsInstall),
  [SETTINGS_INSTALL_STATUS_TOOL]: guard(settingsInstallStatus),
};
