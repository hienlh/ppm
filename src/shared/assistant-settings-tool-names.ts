/**
 * The PPM Assistant's settings tools, in the order `tools/list` gives them. Spread into
 * `ASSISTANT_TOOLS` (`assistant-tool-names.ts`); definitions and handlers live in
 * `src/services/assistant-settings-tools/`. They are offered only while the user has turned them
 * on (`assistant.settings_tools`, the "PPM has new features" question or Settings → PPM Assistant →
 * Changes).
 */
export const SETTINGS_GET_TOOL = "settings_get";
export const SETTINGS_SET_TOOL = "settings_set";
export const SETTINGS_HISTORY_TOOL = "settings_history";
export const SETTINGS_UNDO_TOOL = "settings_undo";
export const SETTINGS_INSTALL_TOOL = "settings_install";
export const SETTINGS_INSTALL_STATUS_TOOL = "settings_install_status";

export const SETTINGS_TOOLS = [
  SETTINGS_GET_TOOL, SETTINGS_SET_TOOL, SETTINGS_HISTORY_TOOL, SETTINGS_UNDO_TOOL,
  SETTINGS_INSTALL_TOOL, SETTINGS_INSTALL_STATUS_TOOL,
] as const;

export type SettingsToolName = (typeof SETTINGS_TOOLS)[number];
