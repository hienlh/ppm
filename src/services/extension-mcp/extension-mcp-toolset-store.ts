/**
 * The database-backed {@link ExtensionToolsetStore}: an extension's last-known tool definitions
 * (served while it is down) and whether the user still has it turned on (served instead of
 * "starting" once it does not come back by itself).
 */
import { getExtensionById, getExtensionMcpToolsetJson, saveExtensionMcpToolsetJson } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import { toolsetKey, validateToolset } from "../../shared/extension-mcp.ts";
import type { ExtensionToolsetStore } from "./extension-mcp-registry.ts";

const log = createLogger("extension-mcp");

export const dbToolsetStore: ExtensionToolsetStore = {
  load(extensionId, toolsetId) {
    const json = getExtensionMcpToolsetJson(extensionId, toolsetId);
    if (!json) return null;
    try {
      return validateToolset({ id: toolsetId, title: toolsetId, tools: JSON.parse(json) }).tools;
    } catch (e) {
      log.warn(`ignoring unreadable saved tools of ${toolsetKey(extensionId, toolsetId)}: ${(e as Error).message}`);
      return null;
    }
  },
  save(extensionId, toolset) {
    saveExtensionMcpToolsetJson(extensionId, toolset.id, JSON.stringify(toolset.tools));
  },
  isEnabled(extensionId) {
    return getExtensionById(extensionId)?.enabled === 1;
  },
};
